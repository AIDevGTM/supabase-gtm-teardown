"""Internal sales dashboard: a zero-dependency Python server over a SQLite database.

Run:
    python3 app.py                       # http://127.0.0.1:8000 (creates demo data on first run)
    SALES_DB=/path/to/sales.db python3 app.py --port 9000
"""
import argparse
import datetime as dt
import json
import logging
import os
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DEFAULT_DB = BASE_DIR / "sales.db"

# Only these files are ever served from disk, so there's no path traversal to worry about.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}

MAX_RANGE_DAYS = 366 * 5
DAILY_GRANULARITY_MAX_DAYS = 92
REVENUE_STATUSES = ("completed",)  # what counts as recognised revenue

log = logging.getLogger("dashboard")


class BadRequest(Exception):
    pass


# --------------------------------------------------------------------------- filters

def parse_filters(qs, today=None):
    """Turn a parse_qs() dict into (start, end, region_id). Raises BadRequest."""
    today = today or dt.date.today()

    def get(name):
        value = qs.get(name, [""])[0].strip()
        return value or None

    try:
        end = dt.date.fromisoformat(get("end")) if get("end") else today
        start = dt.date.fromisoformat(get("start")) if get("start") else end - dt.timedelta(days=29)
    except ValueError:
        raise BadRequest("start and end must be dates in YYYY-MM-DD format")
    if start > end:
        raise BadRequest("start must be on or before end")
    if (end - start).days > MAX_RANGE_DAYS:
        raise BadRequest("date range is too large (max 5 years)")

    region = get("region")
    if region is not None:
        if not region.isdigit():
            raise BadRequest("region must be a numeric id")
        region = int(region)
    return start, end, region


def build_where(start, end, region=None, statuses=REVENUE_STATUSES):
    """WHERE clause over `orders o JOIN customers c`. End date is inclusive.

    Uses >= start AND < end+1 so it also works if order_date holds full timestamps.
    """
    clauses = ["o.order_date >= ?", "o.order_date < ?"]
    params = [start.isoformat(), (end + dt.timedelta(days=1)).isoformat()]
    if statuses:
        clauses.append(f"o.status IN ({','.join('?' * len(statuses))})")
        params.extend(statuses)
    if region is not None:
        clauses.append("c.region_id = ?")
        params.append(region)
    return " AND ".join(clauses), params


# --------------------------------------------------------------------------- queries

BASE_FROM = """
    FROM orders o
    JOIN customers c   ON c.id = o.customer_id
    JOIN order_items oi ON oi.order_id = o.id
"""


def rows(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def money(x):
    return round(float(x or 0), 2)


def summary(conn, start, end, region):
    where, params = build_where(start, end, region)
    r = conn.execute(
        f"""SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS revenue,
                   COUNT(DISTINCT o.id)                        AS orders,
                   COALESCE(SUM(oi.quantity), 0)               AS units
            {BASE_FROM} WHERE {where}""",
        params,
    ).fetchone()
    revenue, orders = money(r["revenue"]), r["orders"]
    return {
        "revenue": revenue,
        "orders": orders,
        "units": r["units"],
        "avg_order_value": money(revenue / orders) if orders else 0.0,
    }


def refunds(conn, start, end, region):
    where, params = build_where(start, end, region, statuses=("refunded",))
    r = conn.execute(
        f"""SELECT COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS amount,
                   COUNT(DISTINCT o.id) AS orders
            {BASE_FROM} WHERE {where}""",
        params,
    ).fetchone()
    return {"amount": money(r["amount"]), "orders": r["orders"]}


def iter_buckets(start, end, granularity):
    if granularity == "day":
        d = start
        while d <= end:
            yield d.isoformat()
            d += dt.timedelta(days=1)
    else:
        y, m = start.year, start.month
        while (y, m) <= (end.year, end.month):
            yield f"{y:04d}-{m:02d}"
            m += 1
            if m == 13:
                y, m = y + 1, 1


def timeseries(conn, start, end, region):
    granularity = "day" if (end - start).days < DAILY_GRANULARITY_MAX_DAYS else "month"
    bucket = "date(o.order_date)" if granularity == "day" else "strftime('%Y-%m', o.order_date)"
    where, params = build_where(start, end, region)
    found = {
        r["bucket"]: r
        for r in rows(
            conn,
            f"""SELECT {bucket} AS bucket,
                       SUM(oi.quantity * oi.unit_price) AS revenue,
                       COUNT(DISTINCT o.id) AS orders
                {BASE_FROM} WHERE {where}
                GROUP BY bucket""",
            params,
        )
    }
    points = []
    for key in iter_buckets(start, end, granularity):
        r = found.get(key)
        points.append({
            "period": key,
            "revenue": money(r["revenue"]) if r else 0.0,
            "orders": r["orders"] if r else 0,
        })
    return {"granularity": granularity, "points": points}


def by_region(conn, start, end):
    # Deliberately ignores the region filter so regions can be compared side by side.
    where, params = build_where(start, end, None)
    result = rows(
        conn,
        f"""SELECT r.id, r.name,
                   COALESCE(s.revenue, 0) AS revenue,
                   COALESCE(s.orders, 0)  AS orders
            FROM regions r
            LEFT JOIN (
                SELECT c.region_id,
                       SUM(oi.quantity * oi.unit_price) AS revenue,
                       COUNT(DISTINCT o.id) AS orders
                {BASE_FROM} WHERE {where}
                GROUP BY c.region_id
            ) s ON s.region_id = r.id
            ORDER BY revenue DESC, r.name""",
        params,
    )
    for r in result:
        r["revenue"] = money(r["revenue"])
    return result


def by_category(conn, start, end, region):
    where, params = build_where(start, end, region)
    result = rows(
        conn,
        f"""SELECT p.category AS name,
                   SUM(oi.quantity * oi.unit_price) AS revenue,
                   SUM(oi.quantity) AS units
            {BASE_FROM} JOIN products p ON p.id = oi.product_id
            WHERE {where}
            GROUP BY p.category
            ORDER BY revenue DESC""",
        params,
    )
    for r in result:
        r["revenue"] = money(r["revenue"])
    return result


def top_products(conn, start, end, region, limit=10):
    where, params = build_where(start, end, region)
    result = rows(
        conn,
        f"""SELECT p.id, p.name, p.category,
                   SUM(oi.quantity) AS units,
                   SUM(oi.quantity * oi.unit_price) AS revenue,
                   COUNT(DISTINCT o.id) AS orders
            {BASE_FROM} JOIN products p ON p.id = oi.product_id
            WHERE {where}
            GROUP BY p.id, p.name, p.category
            ORDER BY revenue DESC
            LIMIT ?""",
        params + [limit],
    )
    for r in result:
        r["revenue"] = money(r["revenue"])
    return result


def recent_orders(conn, start, end, region, limit=15):
    where, params = build_where(start, end, region, statuses=None)  # every status
    result = rows(
        conn,
        f"""SELECT o.id, o.order_date, o.status,
                   c.name AS customer, r.name AS region,
                   COALESCE(SUM(oi.quantity * oi.unit_price), 0) AS total
            FROM orders o
            JOIN customers c ON c.id = o.customer_id
            JOIN regions r   ON r.id = c.region_id
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE {where}
            GROUP BY o.id
            ORDER BY o.order_date DESC, o.id DESC
            LIMIT ?""",
        params + [limit],
    )
    for r in result:
        r["total"] = money(r["total"])
    return result


def get_meta(conn):
    r = conn.execute(
        "SELECT MIN(date(order_date)) AS min_date, MAX(date(order_date)) AS max_date FROM orders"
    ).fetchone()
    return {
        "min_date": r["min_date"],
        "max_date": r["max_date"],
        "regions": rows(conn, "SELECT id, name FROM regions ORDER BY name"),
    }


def get_dashboard(conn, start, end, region):
    length = (end - start).days + 1
    prev_end = start - dt.timedelta(days=1)
    prev_start = prev_end - dt.timedelta(days=length - 1)
    return {
        "filters": {"start": start.isoformat(), "end": end.isoformat(), "region": region},
        "previous_period": {"start": prev_start.isoformat(), "end": prev_end.isoformat()},
        "summary": summary(conn, start, end, region),
        "previous_summary": summary(conn, prev_start, prev_end, region),
        "refunds": refunds(conn, start, end, region),
        "timeseries": timeseries(conn, start, end, region),
        "by_region": by_region(conn, start, end),
        "by_category": by_category(conn, start, end, region),
        "top_products": top_products(conn, start, end, region),
        "recent_orders": recent_orders(conn, start, end, region),
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
    }


# --------------------------------------------------------------------------- HTTP

def connect_readonly(db_path):
    conn = sqlite3.connect(Path(db_path).resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


class Handler(BaseHTTPRequestHandler):
    server_version = "SalesDashboard/1.0"
    db_path = str(DEFAULT_DB)  # overridden in main()

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path == "/api/health":
                self.send_json({"ok": True})
            elif url.path == "/api/meta":
                with self.db() as conn:
                    self.send_json(get_meta(conn))
            elif url.path == "/api/dashboard":
                start, end, region = parse_filters(parse_qs(url.query))
                with self.db() as conn:
                    self.send_json(get_dashboard(conn, start, end, region))
            elif url.path in STATIC_FILES:
                self.send_static(*STATIC_FILES[url.path])
            else:
                self.send_json({"error": "not found"}, status=404)
        except BadRequest as e:
            self.send_json({"error": str(e)}, status=400)
        except sqlite3.Error:
            log.exception("database error on %s", url.path)
            self.send_json({"error": "database error; see server log"}, status=500)
        except Exception:
            log.exception("unhandled error on %s", url.path)
            self.send_json({"error": "internal server error"}, status=500)

    def db(self):
        conn = connect_readonly(self.db_path)
        return _Closing(conn)

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        )

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_static(self, filename, content_type):
        body = (STATIC_DIR / filename).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        log.info("%s - %s", self.address_string(), fmt % args)


class _Closing:
    """Context manager that closes (not commits) a sqlite3 connection."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self.conn

    def __exit__(self, *exc):
        self.conn.close()


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description="Internal sales dashboard")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"),
                        help="bind address (default 127.0.0.1; there is no auth, see README)")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8000")))
    parser.add_argument("--db", default=os.environ.get("SALES_DB"),
                        help="path to SQLite database (default ./sales.db, or $SALES_DB)")
    args = parser.parse_args()

    if args.db:
        db_path = Path(args.db)
        if not db_path.exists():
            sys.exit(f"Database not found: {db_path}")
    else:
        db_path = DEFAULT_DB
        if not db_path.exists():
            import seed
            log.info("No database found; creating demo data at %s", db_path)
            n_orders, _ = seed.seed(str(db_path))
            log.info("Seeded %d orders", n_orders)

    Handler.db_path = str(db_path)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("Sales dashboard on http://%s:%d  (db: %s)", args.host, args.port, db_path)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
