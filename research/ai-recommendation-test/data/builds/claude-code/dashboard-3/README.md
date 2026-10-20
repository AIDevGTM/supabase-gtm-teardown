# Sales Dashboard

An internal dashboard for sales data stored in a SQLite database. It uses only the Python standard library
and plain HTML/JS/CSS, with no npm, no pip and no CDN, so it also runs on machines without internet access.

## Quick start

```bash
python3 app.py            # → http://127.0.0.1:8000
```

The first run creates `sales.db` with 12 months of realistic demo data (fixed seed, so it's reproducible).

Requires Python 3.8+.

## What it shows

- **KPIs:** revenue, orders, average order value and units sold, each compared with the previous period of the same length
- **Revenue over time:** daily for ranges up to 92 days, monthly for longer ones, with gaps filled and a hover tooltip
- **Revenue by region:** always shows all regions; the selected region is highlighted
- **Revenue by category, top 10 products, and the 15 most recent orders** (orders of every status)
- **Filters:** presets (7d / 30d / 90d / 12m), custom date range, region. Filter state is kept in the URL, so you can share a link.

**Revenue = completed orders only.** Pending and refunded orders don't count; the refund total for the period is
shown in the footer. Change `REVENUE_STATUSES` in `app.py` if your definition is different.

## Using your own database

```bash
SALES_DB=/path/to/sales.db python3 app.py
# or
python3 app.py --db /path/to/sales.db --port 9000
```

The database is opened **read-only**. It must use this schema (see `seed.py` for the full DDL):

| table         | columns                                                          |
|---------------|------------------------------------------------------------------|
| `regions`     | `id`, `name`                                                     |
| `products`    | `id`, `name`, `category`, `unit_price`                           |
| `customers`   | `id`, `name`, `region_id`                                        |
| `orders`      | `id`, `customer_id`, `order_date` (ISO text), `status` (`completed`/`pending`/`refunded`) |
| `order_items` | `id`, `order_id`, `product_id`, `quantity`, `unit_price` (price actually charged) |

`order_date` can be `YYYY-MM-DD` or a full ISO timestamp. Date presets are anchored to the latest order date in the
database rather than to today, so a snapshot that's a few weeks old still shows data.

If your data lives in Postgres or MySQL, the SQL in `app.py` is plain enough to port (`date()` and `strftime()` are the only
SQLite-specific functions). You could also export a nightly SQLite snapshot.

Regenerate demo data: `python3 seed.py --force` (options: `--days 730`, `--db path`).

## API

| endpoint | description |
|---|---|
| `GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD&region=<id>` | everything the page needs, in one response (all params optional; default is the last 30 days) |
| `GET /api/meta` | available date range and regions |
| `GET /api/health` | liveness check |

## Security notes

- **There is no authentication.** By default the server binds to `127.0.0.1`. To share it, put it behind your existing
  SSO or VPN reverse proxy (e.g. oauth2-proxy or Cloudflare Access) instead of binding it to `0.0.0.0` on an open network.
- Read-only DB connection, parameterized SQL, and validated query parameters.
- Static files come from a fixed allow-list (no path traversal). Responses set a strict CSP (`default-src 'self'`) and the
  frontend never inserts data as HTML.
- `http.server` is fine for a small internal tool. If you have heavy traffic, run it behind a reverse proxy.

## Tests

```bash
python3 -m unittest -v
```

The tests check that the numbers agree with each other (time series, regions and categories each sum to the headline
revenue), that the region filter works, that refunded and pending orders are excluded, that the previous period is
computed correctly, that input is validated, that the connection is read-only, and that the HTTP layer behaves
(including blocking path traversal).

## Files

```
app.py          HTTP server + SQL queries
seed.py         schema + demo data generator
static/         index.html, app.js (SVG charts, no libraries), style.css
test_app.py     unit + HTTP tests
```
