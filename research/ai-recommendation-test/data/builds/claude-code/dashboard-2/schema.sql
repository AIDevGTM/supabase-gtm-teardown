-- Sales database schema (SQLite).
-- Money is stored as integer cents to avoid floating-point rounding errors.
-- Dates are stored as ISO-8601 text (YYYY-MM-DD) so they sort and compare correctly.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    region  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,
    category          TEXT NOT NULL,
    unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id           INTEGER PRIMARY KEY,
    customer_id  INTEGER NOT NULL REFERENCES customers(id),
    order_date   TEXT NOT NULL
                 CHECK (order_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status       TEXT NOT NULL CHECK (status IN ('completed', 'cancelled', 'refunded'))
);

-- unit_price_cents is copied onto each line item so historical revenue
-- doesn't change when a product's list price changes.
CREATE TABLE IF NOT EXISTS order_items (
    id                INTEGER PRIMARY KEY,
    order_id          INTEGER NOT NULL REFERENCES orders(id),
    product_id        INTEGER NOT NULL REFERENCES products(id),
    quantity          INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_cents  INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);

CREATE INDEX IF NOT EXISTS idx_orders_date      ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_customer  ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_items_order      ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product    ON order_items(product_id);
