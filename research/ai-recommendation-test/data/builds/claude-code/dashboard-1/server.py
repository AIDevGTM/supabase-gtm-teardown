#!/usr/bin/env python3
"""Internal sales dashboard server.

Zero dependencies: Python 3.9+ standard library only (http.server + sqlite3).

    python3 server.py            # serve on http://127.0.0.1:8000
    python3 server.py --reset    # delete and re-seed the demo database first

Environment variables:
    SALES_DB   path to the SQLite database (default: ./sales.db, seeded on first run)
    HOST       bind address (default: 127.0.0.1 — local only)
    PORT       port (default: 8000)
"""
import json
import os
import random
import sqlite3
import sys
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DB_PATH = Path(os.environ.get("SALES_DB", BASE_DIR / "sales.db")).resolve()
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))

# --------------------------------------------------------------------------- #
# Database schema & demo seed data
# --------------------------------------------------------------------------- #

SCHEMA = """
CREATE TABLE customers (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    region  TEXT NOT NULL
);
CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    unit_price  REAL NOT NULL
);
CREATE TABLE orders (
    id           INTEGER PRIMARY KEY,
    order_date   TEXT    NOT NULL,              -- ISO date, YYYY-MM-DD
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    product_id   INTEGER NOT NULL REFERENCES products(id),
    quantity     INTEGER NOT NULL CHECK (quantity > 0),
    unit_price   REAL    NOT NULL               -- actual price paid (after discount)
);
CREATE INDEX idx_orders_date     ON orders(order_date);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_product  ON orders(product_id);
"""

REGIONS = ["North America", "Europe", "Asia Pacific", "Latin America", "Middle East & Africa"]
REGION_WEIGHTS = [38, 27, 20, 9, 6]

# (name, category, list price, relative popularity)
PRODUCTS = [
    ("Starter Plan", "Subscriptions", 29.00, 30),
    ("Team Plan", "Subscriptions", 99.00, 22),
    ("Enterprise Plan", "Subscriptions", 499.00, 6),
    ("Analytics Add-on", "Add-ons", 49.00, 14),
    ("Storage Pack 1TB", "Add-ons", 19.00, 18),
    ("Priority Support", "Services", 199.00, 8),
    ("Onboarding Package", "Services", 1500.00, 2),
    ("Custom Integration", "Services", 3500.00, 1),
    ("Hardware Gateway", "Hardware", 349.00, 5),
    ("Sensor Kit", "Hardware", 89.00, 9),
]

# Seasonality multiplier by month (Q4 peak, summer dip).
SEASONALITY = {1: 0.85, 2: 0.85, 3: 0.95, 4: 0.95, 5: 1.0, 6: 1.0,
               7: 0.9, 8: 0.9, 9: 1.05, 10: 1.1, 11: 1.3, 12: 1.4}

NAME_A = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Vandelay",
          "Soylent", "Tyrell", "Cyberdyne", "Wonka", "Gringotts", "Oscorp", "Pied Piper",
          "Aperture", "Black Mesa", "Massive Dynamic", "Monarch", "Nakatomi"]
NAME_B = ["Industries", "Labs", "Holdings", "Systems", "Group", "Partners", "Logistics",
          "Foods", "Media", "Health", "Retail", "Energy"]


def seed(conn, days=730, seed_value=42):
    """Populate an empty database with ~2 years of realistic-looking sales."""
    rng = random.Random(seed_value)

    names = rng.sample([f"{a} {b}" for a in NAME_A for b in NAME_B], 200)
    customers = [(i + 1, name, rng.choices(REGIONS, REGION_WEIGHTS)[0]) for i, name in enumerate(names)]
    conn.executemany("INSERT INTO customers VALUES (?, ?, ?)", customers)
    conn.executemany(
        "INSERT INTO products VALUES (?, ?, ?, ?)",
        [(i + 1, n, c, p) for i, (n, c, p, _w) in enumerate(PRODUCTS)],
    )

    product_weights = [p[3] for p in PRODUCTS]
    end = date.today()
    start = end - timedelta(days=days)
    rows = []
    d = start
    while d <= end:
        growth = 1 + 0.6 * (d - start).days / days          # ~60% growth over the period
        weekday = 0.55 if d.weekday() >= 5 else 1.0          # quieter weekends
        expected = 9 * growth * SEASONALITY[d.month] * weekday
        n = max(0, round(rng.gauss(expected, expected ** 0.5)))
        for _ in range(n):
            pid = rng.choices(range(len(PRODUCTS)), product_weights)[0]
            qty = rng.choices([1, 2, 3, 5, 10], [60, 20, 10, 7, 3])[0]
            discount = rng.choice([1.0, 1.0, 1.0, 0.9, 0.85])
            price = round(PRODUCTS[pid][2] * discount, 2)
            rows.append((d.isoformat(), rng.randint(1, len(customers)), pid + 1, qty, price))
        d += timedelta(days=1)

    conn.executemany(
        "INSERT INTO orders (order_date, customer_id, product_id, quantity, unit_price) "
        "VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    return len(rows)


def init_db(reset=False):
    """Create & seed the demo DB if it doesn't exist. Never modifies an existing DB."""
    if reset and DB_PATH.exists():
        DB_PATH.unlink()
    if DB_PATH.exists():
        conn = connect()
        try:
            tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            conn.close()
        missing = {"customers", "products", "orders"} - tables
        if missing:
            sys.exit(f"Database {DB_PATH} is missing tables: {', '.join(sorted(missing))}")
        return
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        with conn:
            conn.executescript(SCHEMA)
            count = seed(conn)
        print(f"Created demo database {DB_PATH} with {count:,} orders")
    finally:
        conn.close()


def connect():
    """Open a read-only connection — the dashboard never writes."""
    return sqlite3.connect(DB_PATH.as_uri() + "?mode=ro", uri=True)


# --------------------------------------------------------------------------- #
# Query helpers
# --------------------------------------------------------------------------- #

REVENUE = "o.quantity * o.unit_price"
FROM = (" FROM orders o"
        " JOIN customers c ON c.id = o.customer_id"
        " JOIN products p ON p.id = o.product_id")


class BadRequest(Exception):
    pass


def parse_date(value, name):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise BadRequest(f"Invalid '{name}': expected YYYY-MM-DD") from None


def parse_int(qs, name, default, lo, hi):
    raw = qs.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise BadRequest(f"Invalid '{name}': expected an integer") from None
    if not lo <= value <= hi:
        raise BadRequest(f"Invalid '{name}': must be between {lo} and {hi}")
    return value


def data_bounds(conn):
    lo, hi = conn.execute("SELECT MIN(order_date), MAX(order_date) FROM orders").fetchone()
    return lo, hi


def get_range(conn, qs):
    lo, hi = data_bounds(conn)
    today = date.today().isoformat()
    start = parse_date(qs["start"], "start") if qs.get("start") else date.fromisoformat(lo or today)
    end = parse_date(qs["end"], "end") if qs.get("end") else date.fromisoformat(hi or today)
    if start > end:
        raise BadRequest("'start' must be on or before 'end'")
    return start, end


def build_where(qs, start, end):
    clauses = ["o.order_date BETWEEN ? AND ?"]
    params = [start.isoformat(), end.isoformat()]
    if qs.get("region"):
        clauses.append("c.region = ?")
        params.append(qs["region"])
    if qs.get("category"):
        clauses.append("p.category = ?")
        params.append(qs["category"])
    return " WHERE " + " AND ".join(clauses), params


def totals(conn, qs, start, end):
    where, params = build_where(qs, start, end)
    revenue, orders, units, customers = conn.execute(
        f"SELECT COALESCE(SUM({REVENUE}), 0), COUNT(*), COALESCE(SUM(o.quantity), 0),"
        f" COUNT(DISTINCT o.customer_id){FROM}{where}",
        params,
    ).fetchone()
    return {
        "revenue": round(revenue, 2),
        "orders": orders,
        "units": units,
        "customers": customers,
        "avg_order_value": round(revenue / orders, 2) if orders else 0,
    }


# --------------------------------------------------------------------------- #
# API endpoints  (all accept ?start=YYYY-MM-DD&end=YYYY-MM-DD&region=&category=)
# --------------------------------------------------------------------------- #

def api_filters(conn, qs):
    lo, hi = data_bounds(conn)
    return {
        "regions": [r[0] for r in conn.execute("SELECT DISTINCT region FROM customers ORDER BY region")],
        "categories": [r[0] for r in conn.execute("SELECT DISTINCT category FROM products ORDER BY category")],
        "min_date": lo,
        "max_date": hi,
    }


def api_summary(conn, qs):
    """KPIs for the selected range plus the equal-length period immediately before it."""
    start, end = get_range(conn, qs)
    length = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length - 1)
    return {
        "range": {"start": start.isoformat(), "end": end.isoformat()},
        "previous_range": {"start": prev_start.isoformat(), "end": prev_end.isoformat()},
        "current": totals(conn, qs, start, end),
        "previous": totals(conn, qs, prev_start, prev_end),
    }


PERIOD_EXPR = {
    "day": "o.order_date",
    "week": "date(o.order_date, '-6 days', 'weekday 1')",  # Monday of that week
    "month": "strftime('%Y-%m', o.order_date)",
}


def api_timeseries(conn, qs):
    granularity = qs.get("granularity", "month")
    if granularity not in PERIOD_EXPR:
        raise BadRequest("Invalid 'granularity': expected day, week or month")
    start, end = get_range(conn, qs)
    where, params = build_where(qs, start, end)
    rows = conn.execute(
        f"SELECT {PERIOD_EXPR[granularity]} AS period, SUM({REVENUE}), COUNT(*)"
        f"{FROM}{where} GROUP BY period ORDER BY period",
        params,
    ).fetchall()
    return {
        "granularity": granularity,
        "rows": [{"period": p, "revenue": round(r, 2), "orders": n} for p, r, n in rows],
    }


BREAKDOWN_DIMS = {"region": "c.region", "category": "p.category"}


def api_breakdown(conn, qs):
    dim = qs.get("by", "region")
    if dim not in BREAKDOWN_DIMS:
        raise BadRequest("Invalid 'by': expected region or category")
    start, end = get_range(conn, qs)
    where, params = build_where(qs, start, end)
    col = BREAKDOWN_DIMS[dim]
    rows = conn.execute(
        f"SELECT {col}, SUM({REVENUE}), COUNT(*)"
        f"{FROM}{where} GROUP BY 1 ORDER BY 2 DESC",
        params,
    ).fetchall()
    return {"by": dim, "rows": [{"name": n, "revenue": round(r, 2), "orders": c} for n, r, c in rows]}


def api_top_products(conn, qs):
    limit = parse_int(qs, "limit", 10, 1, 100)
    start, end = get_range(conn, qs)
    where, params = build_where(qs, start, end)
    rows = conn.execute(
        f"SELECT p.name, p.category, SUM(o.quantity), SUM({REVENUE}) AS revenue, COUNT(*)"
        f"{FROM}{where} GROUP BY p.id ORDER BY revenue DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    return {"rows": [
        {"name": n, "category": c, "units": u, "revenue": round(r, 2), "orders": o}
        for n, c, u, r, o in rows
    ]}


def api_orders(conn, qs):
    limit = parse_int(qs, "limit", 25, 1, 500)
    offset = parse_int(qs, "offset", 0, 0, 10_000_000)
    start, end = get_range(conn, qs)
    where, params = build_where(qs, start, end)
    total = conn.execute(f"SELECT COUNT(*){FROM}{where}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT o.id, o.order_date, c.name, c.region, p.name, p.category,"
        f" o.quantity, o.unit_price, {REVENUE}"
        f"{FROM}{where} ORDER BY o.order_date DESC, o.id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()
    keys = ["id", "date", "customer", "region", "product", "category", "quantity", "unit_price", "total"]
    out = []
    for row in rows:
        item = dict(zip(keys, row))
        item["total"] = round(item["total"], 2)
        out.append(item)
    return {"total": total, "limit": limit, "offset": offset, "rows": out}


ROUTES = {
    "/api/filters": api_filters,
    "/api/summary": api_summary,
    "/api/timeseries": api_timeseries,
    "/api/breakdown": api_breakdown,
    "/api/top-products": api_top_products,
    "/api/orders": api_orders,
}

# Explicit whitelist — no filesystem path is ever derived from the URL.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
}


# --------------------------------------------------------------------------- #
# HTTP server
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "SalesDashboard/1.0"

    def do_GET(self):
        url = urlparse(self.path)
        if url.path in ROUTES:
            self.handle_api(url)
        elif url.path in STATIC_FILES:
            filename, ctype = STATIC_FILES[url.path]
            try:
                body = (STATIC_DIR / filename).read_bytes()
            except FileNotFoundError:
                self.send_json(404, {"error": "Not found"})
                return
            self.send_body(200, body, ctype)
        else:
            self.send_json(404, {"error": "Not found"})

    def handle_api(self, url):
        qs = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            conn = connect()
            try:
                data = ROUTES[url.path](conn, qs)
            finally:
                conn.close()
        except BadRequest as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # don't leak internals to the client
            self.log_error("API error on %s: %r", url.path, exc)
            self.send_json(500, {"error": "Internal server error"})
        else:
            self.send_json(200, data)

    def send_json(self, status, payload):
        self.send_body(status, json.dumps(payload).encode("utf-8"), "application/json")

    def send_body(self, status, body, ctype):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)


def main():
    init_db(reset="--reset" in sys.argv[1:])
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Sales dashboard running at http://{HOST}:{PORT}  (db: {DB_PATH})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
