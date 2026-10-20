"""Create and populate a demo SQLite sales database.

Usage:
    python3 seed.py                 # creates ./sales.db if it doesn't exist
    python3 seed.py --force         # recreate it from scratch
    python3 seed.py --db other.db --days 730
"""
import argparse
import datetime as dt
import itertools
import math
import os
import random
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS regions (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS products (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    category   TEXT NOT NULL,
    unit_price REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL,
    region_id INTEGER NOT NULL REFERENCES regions(id)
);
CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    order_date  TEXT NOT NULL,              -- ISO 8601: YYYY-MM-DD
    status      TEXT NOT NULL CHECK (status IN ('completed', 'pending', 'refunded'))
);
CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL                -- price actually charged (after discount)
);
CREATE INDEX IF NOT EXISTS idx_orders_date       ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_customer   ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order       ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product     ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_customers_region  ON customers(region_id);
"""

REGIONS = [
    ("North America", 0.38),
    ("Europe", 0.27),
    ("Asia Pacific", 0.20),
    ("Latin America", 0.09),
    ("Middle East & Africa", 0.06),
]

# (name, category, list price, relative popularity)
PRODUCTS = [
    ("Starter Plan (annual)", "Subscriptions", 299.0, 10),
    ("Team Plan (annual)", "Subscriptions", 1199.0, 6),
    ("Enterprise Plan (annual)", "Subscriptions", 4999.0, 1.5),
    ("Onboarding Package", "Services", 1500.0, 3),
    ("Custom Integration", "Services", 3500.0, 1),
    ("Training Workshop", "Services", 800.0, 2.5),
    ("Barcode Scanner", "Hardware", 189.0, 5),
    ("Receipt Printer", "Hardware", 249.0, 4),
    ("POS Terminal", "Hardware", 899.0, 2),
    ("Card Reader", "Hardware", 79.0, 8),
    ("Extra Storage 1TB", "Add-ons", 120.0, 6),
    ("Priority Support", "Add-ons", 600.0, 3),
]

NAME_PREFIXES = [
    "Acme", "Globex", "Initech", "Umbrella", "Stark", "Wayne", "Hooli", "Vandelay",
    "Soylent", "Wonka", "Tyrell", "Cyberdyne", "Aperture", "Pied Piper", "Monarch",
    "Oscorp", "Dunder", "Bluth", "Prestige", "Nakatomi", "Massive", "Oceanic",
    "Sirius", "Gekko",
]
NAME_SUFFIXES = [
    "Industries", "Corp", "Labs", "Retail", "Group", "Holdings", "Foods",
    "Logistics", "Partners", "Systems", "Trading", "Co.",
]


def create_schema(conn):
    conn.executescript(SCHEMA)


def seed(path, days=365, num_customers=250, rng_seed=42, today=None):
    """Create the database at `path` and fill it with deterministic demo data."""
    rng = random.Random(rng_seed)
    today = today or dt.date.today()

    conn = sqlite3.connect(path)
    try:
        create_schema(conn)
        with conn:
            conn.executemany(
                "INSERT INTO regions (id, name) VALUES (?, ?)",
                [(i, name) for i, (name, _) in enumerate(REGIONS, start=1)],
            )
            conn.executemany(
                "INSERT INTO products (id, name, category, unit_price) VALUES (?, ?, ?, ?)",
                [(i, n, c, p) for i, (n, c, p, _) in enumerate(PRODUCTS, start=1)],
            )

            all_names = [f"{a} {b}" for a, b in itertools.product(NAME_PREFIXES, NAME_SUFFIXES)]
            names = rng.sample(all_names, min(num_customers, len(all_names)))
            region_ids = [i for i in range(1, len(REGIONS) + 1)]
            region_weights = [w for _, w in REGIONS]
            customers = [
                (i, name, rng.choices(region_ids, region_weights)[0])
                for i, name in enumerate(names, start=1)
            ]
            conn.executemany(
                "INSERT INTO customers (id, name, region_id) VALUES (?, ?, ?)", customers
            )

            product_ids = list(range(1, len(PRODUCTS) + 1))
            product_weights = [p[3] for p in PRODUCTS]

            orders, items = [], []
            order_id = item_id = 0
            start = today - dt.timedelta(days=days - 1)
            for i in range(days):
                day = start + dt.timedelta(days=i)
                # Q4 peak, steady growth over the period, quieter weekends.
                season = 1 + 0.25 * math.cos(2 * math.pi * (day.timetuple().tm_yday - 320) / 365)
                growth = 0.8 + 0.4 * i / max(days - 1, 1)
                weekday = 0.55 if day.weekday() >= 5 else 1.0
                mean = 9 * season * growth * weekday
                n_orders = max(0, round(rng.gauss(mean, math.sqrt(mean))))

                for _ in range(n_orders):
                    order_id += 1
                    age = (today - day).days
                    r = rng.random()
                    if age < 5 and r < 0.35:
                        status = "pending"
                    elif r > 0.96:
                        status = "refunded"
                    else:
                        status = "completed"
                    customer_id = rng.randint(1, len(customers))
                    orders.append((order_id, customer_id, day.isoformat(), status))

                    n_items = rng.choices([1, 2, 3, 4], [55, 28, 12, 5])[0]
                    chosen = set()
                    for _ in range(n_items):
                        pid = rng.choices(product_ids, product_weights)[0]
                        if pid in chosen:
                            continue
                        chosen.add(pid)
                        _, category, list_price, _ = PRODUCTS[pid - 1]
                        if category == "Hardware":
                            qty = rng.randint(1, 8)
                        elif category == "Add-ons":
                            qty = rng.randint(1, 3)
                        else:
                            qty = 1
                        discount = rng.choices([1.0, 0.9, 0.85], [80, 15, 5])[0]
                        item_id += 1
                        items.append((item_id, order_id, pid, qty, round(list_price * discount, 2)))

            conn.executemany(
                "INSERT INTO orders (id, customer_id, order_date, status) VALUES (?, ?, ?, ?)",
                orders,
            )
            conn.executemany(
                "INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) "
                "VALUES (?, ?, ?, ?, ?)",
                items,
            )
        return len(orders), len(items)
    finally:
        conn.close()


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Create a demo sales database.")
    parser.add_argument("--db", default=os.path.join(here, "sales.db"))
    parser.add_argument("--days", type=int, default=365, help="days of history (default 365)")
    parser.add_argument("--force", action="store_true", help="overwrite an existing database")
    args = parser.parse_args()

    if os.path.exists(args.db):
        if not args.force:
            print(f"{args.db} already exists; use --force to recreate it.")
            return
        os.remove(args.db)

    n_orders, n_items = seed(args.db, days=args.days)
    print(f"Created {args.db}: {n_orders} orders, {n_items} line items over {args.days} days.")


if __name__ == "__main__":
    main()
