#!/usr/bin/env python3
"""Create a SQLite sales database populated with realistic sample data.

Usage:
    python3 seed.py                    # creates ./sales.db
    python3 seed.py --db other.db --days 365 --force
"""
import argparse
import random
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
SCHEMA = BASE_DIR / "schema.sql"

REGIONS = ["North America", "Europe", "Asia Pacific", "Latin America"]
REGION_WEIGHTS = [45, 30, 17, 8]

# (name, category, unit price in cents)
PRODUCTS = [
    ("Starter Plan (annual)", "Subscriptions", 49_900),
    ("Team Plan (annual)", "Subscriptions", 149_900),
    ("Enterprise Plan (annual)", "Subscriptions", 499_900),
    ("Onboarding Package", "Services", 250_000),
    ("Custom Integration", "Services", 750_000),
    ("Training Workshop", "Services", 120_000),
    ("Barcode Scanner", "Hardware", 18_900),
    ("Receipt Printer", "Hardware", 29_900),
    ("Point-of-Sale Terminal", "Hardware", 89_900),
    ("Extra Storage (1 TB)", "Add-ons", 9_900),
    ("Priority Support", "Add-ons", 39_900),
    ("Analytics Module", "Add-ons", 59_900),
]

NAME_PREFIXES = ["Blue", "North", "Bright", "Summit", "Pioneer",
                 "Silver", "Granite", "Harbor", "Evergreen", "Redwood"]
NAME_SUFFIXES = ["Analytics", "Logistics", "Foods", "Health", "Systems",
                 "Retail", "Energy", "Media", "Labs", "Partners"]
NUM_CUSTOMERS = 80


def create_database(path, days=730, rng_seed=42):
    """Create a new database at `path` with `days` of order history ending today.

    Returns the number of orders generated. Refuses to overwrite an existing file.
    If anything fails, the partially written file is removed.
    """
    path = Path(path)
    if path.exists():
        raise FileExistsError(f"{path} already exists")

    rng = random.Random(rng_seed)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(SCHEMA.read_text())

        conn.executemany(
            "INSERT INTO products (name, category, unit_price_cents) VALUES (?, ?, ?)",
            PRODUCTS,
        )
        all_names = [f"{a} {b}" for a in NAME_PREFIXES for b in NAME_SUFFIXES]
        customers = [
            (name, rng.choices(REGIONS, REGION_WEIGHTS)[0])
            for name in rng.sample(all_names, NUM_CUSTOMERS)
        ]
        conn.executemany("INSERT INTO customers (name, region) VALUES (?, ?)", customers)

        products = conn.execute("SELECT id, unit_price_cents FROM products").fetchall()
        customer_ids = [row[0] for row in conn.execute("SELECT id FROM customers")]

        start = date.today() - timedelta(days=days - 1)
        orders, items = [], []
        order_id = 0
        for i in range(days):
            day = start + timedelta(days=i)
            growth = 1 + i / days                      # business roughly doubles over the period
            weekday = 0.6 if day.weekday() >= 5 else 1.0
            seasonal = 1.25 if day.month in (11, 12) else 1.0
            n_orders = max(0, round(rng.gauss(8, 2.5) * growth * weekday * seasonal))
            for _ in range(n_orders):
                order_id += 1
                status = rng.choices(["completed", "cancelled", "refunded"], [92, 5, 3])[0]
                orders.append((order_id, rng.choice(customer_ids), day.isoformat(), status))
                for product_id, price in rng.sample(products, rng.randint(1, 4)):
                    items.append((order_id, product_id, rng.randint(1, 5), price))

        conn.executemany(
            "INSERT INTO orders (id, customer_id, order_date, status) VALUES (?, ?, ?, ?)",
            orders,
        )
        conn.executemany(
            "INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents) "
            "VALUES (?, ?, ?, ?)",
            items,
        )
        conn.commit()
    except BaseException:
        conn.close()
        path.unlink(missing_ok=True)
        raise
    conn.close()
    return len(orders)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", default=str(BASE_DIR / "sales.db"), help="database file path")
    parser.add_argument("--days", type=int, default=730, help="days of history (default 730)")
    parser.add_argument("--seed", type=int, default=42, help="random seed (default 42)")
    parser.add_argument("--force", action="store_true", help="replace the file if it exists")
    args = parser.parse_args()

    if args.days < 1:
        parser.error("--days must be at least 1")
    db = Path(args.db)
    if db.exists():
        if not args.force:
            sys.exit(f"{db} already exists (use --force to replace it)")
        db.unlink()

    count = create_database(db, days=args.days, rng_seed=args.seed)
    print(f"Created {db} with {count:,} orders over {args.days} days")


if __name__ == "__main__":
    main()
