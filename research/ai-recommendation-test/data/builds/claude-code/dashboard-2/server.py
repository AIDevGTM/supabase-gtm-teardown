#!/usr/bin/env python3
"""Internal sales dashboard: a small JSON API over SQLite plus a single-page UI.

Standard library only, so there's nothing to install. Run with:
    python3 server.py

Environment variables:
    SALES_DB  path to the SQLite database (default: ./sales.db, sample data is created if missing)
    HOST      interface to bind (default: 127.0.0.1, which means this machine only)
    PORT      port to listen on (default: 8000)
"""
import json
import logging
import os
from contextlib import closing
from datetime import date, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import sqlite3

import seed

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SALES_DB", BASE_DIR / "sales.db")).resolve()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
INDEX_HTML = BASE_DIR / "static" / "index.html"

DEFAULT_RANGE_DAYS = 30
MAX_RANGE_DAYS = 3660        # ~10 years; guards against accidental huge queries
DAILY_BUCKET_MAX_DAYS = 92   # longer ranges are charted by month

log = logging.getLogger("dashboard")


class BadRequest(ValueError):
    """Invalid user input; reported to the client as HTTP 400."""


# --------------------------------------------------------------------------- data access

def connect():
    """Open the database read-only. The dashboard never writes."""
    conn = sqlite3.connect(DB_PATH.as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def build_where(start, end, region):
    """Return a WHERE fragment and its parameters. Expects aliases `o` (orders) and `c` (customers).

    User values go only into bound parameters, never into the SQL text.
    """
    sql = "o.order_date BETWEEN ? AND ?"
    params = [start.isoformat(), end.isoformat()]
    if region:
        sql += " AND c.region = ?"
        params.append(region)
    return sql, params


# Revenue counts only completed orders. Cancelled and refunded orders are excluded.
SALES_FROM = """
    FROM orders o
    JOIN customers c    ON c.id = o.customer_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p     ON p.id = oi.product_id
    WHERE o.status = 'completed' AND {where}
"""


def date_bounds(conn):
    lo, hi = conn.execute("SELECT MIN(order_date), MAX(order_date) FROM orders").fetchone()
    today = date.today()
    return (date.fromisoformat(lo) if lo else today,
            date.fromisoformat(hi) if hi else today)


def meta(conn):
    lo, hi = date_bounds(conn)
    regions = [row[0] for row in conn.execute("SELECT DISTINCT region FROM customers ORDER BY region")]
    return {"min_date": lo.isoformat(), "max_date": hi.isoformat(), "regions": regions}


def kpis(conn, start, end, region):
    where, params = build_where(start, end, region)
    row = conn.execute(f"""
        SELECT COUNT(DISTINCT o.id)                                  AS orders,
               COALESCE(SUM(oi.quantity * oi.unit_price_cents), 0)   AS revenue_cents,
               COALESCE(SUM(oi.quantity), 0)                         AS units,
               COUNT(DISTINCT o.customer_id)                         AS customers
        {SALES_FROM.format(where=where)}
    """, params).fetchone()
    result = dict(row)
    result["avg_order_cents"] = (
        round(result["revenue_cents"] / result["orders"]) if result["orders"] else 0
    )
    return result


def timeseries(conn, start, end, region):
    n_days = (end - start).days + 1
    monthly = n_days > DAILY_BUCKET_MAX_DAYS
    bucket = "substr(o.order_date, 1, 7)" if monthly else "o.order_date"
    where, params = build_where(start, end, region)
    rows = conn.execute(f"""
        SELECT {bucket}                                  AS bucket,
               SUM(oi.quantity * oi.unit_price_cents)    AS revenue_cents,
               COUNT(DISTINCT o.id)                      AS orders
        {SALES_FROM.format(where=where)}
        GROUP BY bucket
        ORDER BY bucket
    """, params).fetchall()
    found = {row["bucket"]: row for row in rows}

    # Fill gaps with zeros so the chart shows quiet periods instead of skipping them.
    if monthly:
        buckets = []
        y, m = start.year, start.month
        while (y, m) <= (end.year, end.month):
            buckets.append(f"{y:04d}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    else:
        buckets = [(start + timedelta(days=i)).isoformat() for i in range(n_days)]

    points = []
    for b in buckets:
        row = found.get(b)
        points.append({
            "bucket": b,
            "revenue_cents": row["revenue_cents"] if row else 0,
            "orders": row["orders"] if row else 0,
        })
    return {"granularity": "month" if monthly else "day", "points": points}


def breakdown(conn, column, start, end, region):
    """Revenue grouped by a fixed column expression (passed in by our code, never by the user)."""
    where, params = build_where(start, end, region)
    rows = conn.execute(f"""
        SELECT {column}                                AS label,
               SUM(oi.quantity * oi.unit_price_cents)  AS revenue_cents,
               COUNT(DISTINCT o.id)                    AS orders
        {SALES_FROM.format(where=where)}
        GROUP BY label
        ORDER BY revenue_cents DESC
    """, params).fetchall()
    return [dict(r) for r in rows]


def top_products(conn, start, end, region, limit=10):
    where, params = build_where(start, end, region)
    rows = conn.execute(f"""
        SELECT p.name                                  AS name,
               p.category                              AS category,
               SUM(oi.quantity)                        AS units,
               SUM(oi.quantity * oi.unit_price_cents)  AS revenue_cents
        {SALES_FROM.format(where=where)}
        GROUP BY p.id
        ORDER BY revenue_cents DESC
        LIMIT ?
    """, params + [limit]).fetchall()
    return [dict(r) for r in rows]


def recent_orders(conn, start, end, region, limit=25):
    """Most recent orders in any status, so cancellations and refunds are visible too."""
    where, params = build_where(start, end, region)
    rows = conn.execute(f"""
        SELECT o.id                                    AS id,
               o.order_date                            AS order_date,
               c.name                                  AS customer,
               c.region                                AS region,
               o.status                                AS status,
               SUM(oi.quantity * oi.unit_price_cents)  AS total_cents
        FROM orders o
        JOIN customers c    ON c.id = o.customer_id
        JOIN order_items oi ON oi.order_id = o.id
        WHERE {where}
        GROUP BY o.id
        ORDER BY o.order_date DESC, o.id DESC
        LIMIT ?
    """, params + [limit]).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- request handling

def parse_date(value, name):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise BadRequest(f"'{name}' must be a date in YYYY-MM-DD format") from None


def parse_filters(conn, qs):
    _, data_max = date_bounds(conn)
    end = parse_date(qs["end"], "end") if qs.get("end") else data_max
    start = (parse_date(qs["start"], "start") if qs.get("start")
             else end - timedelta(days=DEFAULT_RANGE_DAYS - 1))
    if start > end:
        raise BadRequest("'start' must be on or before 'end'")
    if (end - start).days + 1 > MAX_RANGE_DAYS:
        raise BadRequest(f"Date range cannot exceed {MAX_RANGE_DAYS} days")
    region = qs.get("region") or None
    return start, end, region


def dashboard(conn, qs):
    start, end, region = parse_filters(conn, qs)
    length = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length - 1)
    return {
        "filters": {"start": start.isoformat(), "end": end.isoformat(), "region": region},
        "previous_period": {"start": prev_start.isoformat(), "end": prev_end.isoformat()},
        "kpis": kpis(conn, start, end, region),
        "previous_kpis": kpis(conn, prev_start, prev_end, region),
        "timeseries": timeseries(conn, start, end, region),
        "by_region": breakdown(conn, "c.region", start, end, region),
        "by_category": breakdown(conn, "p.category", start, end, region),
        "top_products": top_products(conn, start, end, region),
        "recent_orders": recent_orders(conn, start, end, region),
    }


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data:"
    ),
}


class Handler(BaseHTTPRequestHandler):
    server_version = "SalesDashboard/1.0"

    def do_GET(self):
        url = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path in ("/", "/index.html"):
                self.send_body(INDEX_HTML.read_bytes(), "text/html; charset=utf-8")
            elif url.path == "/healthz":
                self.send_json({"ok": True})
            elif url.path == "/api/meta":
                with closing(connect()) as conn:
                    self.send_json(meta(conn))
            elif url.path == "/api/dashboard":
                with closing(connect()) as conn:
                    self.send_json(dashboard(conn, qs))
            else:
                self.send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except BadRequest as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception:
            log.exception("Unhandled error serving %s", self.path)
            self.send_json({"error": "Internal server error"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def send_json(self, payload, status=HTTPStatus.OK):
        self.send_body(json.dumps(payload).encode("utf-8"), "application/json", status)

    def send_body(self, body, content_type, status=HTTPStatus.OK):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.info("%s %s", self.address_string(), fmt % args)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not DB_PATH.exists():
        log.info("No database at %s, creating one with sample data", DB_PATH)
        count = seed.create_database(DB_PATH)
        log.info("Sample database created with %d orders", count)

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log.info("Sales dashboard running at http://%s:%d  (database: %s)", HOST, PORT, DB_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
