# Sales Dashboard

An internal dashboard for sales data stored in SQLite. It uses only the Python
standard library, so there is nothing to install and no external CDN.

## Run it

Requires Python 3.8 or newer.

```bash
python3 server.py
```

Then open http://127.0.0.1:8000.

On first run, if there's no `sales.db`, the server creates one with two years of
realistic sample data. The data has growth, weekend dips and a Q4 seasonal bump.

## What it shows

- **KPIs:** revenue, orders, average order value, units sold and active customers,
  each with the % change against the previous period of the same length
- **Revenue over time:** daily for ranges up to 92 days, monthly for longer ranges
- **Revenue by region** and **by product category**
- **Top 10 products** by revenue
- **25 most recent orders**, in every status

Filters: presets (7D, 30D, 90D, 1Y), a custom date range and a region. The filters
are saved in the URL, so you can share or bookmark a view.

**Definition:** revenue and the other KPIs count `completed` orders only.
Cancelled and refunded orders appear in *Recent orders* but aren't counted as sales.

## Configuration

| Env var    | Default       | Purpose                                       |
|------------|---------------|-----------------------------------------------|
| `SALES_DB` | `./sales.db`  | Path to the SQLite database                   |
| `HOST`     | `127.0.0.1`   | Interface to bind (this machine only by default) |
| `PORT`     | `8000`        | Port                                          |

## Using your own data

The server opens the database **read-only**. To use real data, point `SALES_DB` at
a SQLite file that follows `schema.sql` (customers, products, orders, order_items,
with money in integer cents and dates as `YYYY-MM-DD`).

If your data is somewhere else, such as Postgres or MySQL, the SQL is all in
`server.py`. Swap `connect()` for your database driver and change the `?`
placeholders to the driver's style (for example `%s` for psycopg).

To regenerate the sample data:

```bash
python3 seed.py --force               # 730 days ending today
python3 seed.py --days 365 --force    # shorter history
```

## API

- `GET /api/meta`: available date range and regions
- `GET /api/dashboard?start=YYYY-MM-DD&end=YYYY-MM-DD&region=Europe`: all dashboard
  data. Every parameter is optional; the default is the last 30 days of data.
- `GET /healthz`: liveness check

Bad input returns HTTP 400 with `{"error": "..."}`.

## Security notes

- There is **no login**. By default the server listens only on localhost. Before
  exposing it to a network (`HOST=0.0.0.0`), put it behind your company's SSO or
  authenticating reverse proxy.
- All user input goes into bound SQL parameters, and the database connection is read-only.
- Database text is HTML-escaped before rendering. Responses include CSP and `nosniff` headers.

## Files

```
server.py          HTTP server, JSON API and SQL queries
seed.py            Sample database generator (also usable as a CLI)
schema.sql         Database schema
static/index.html  Dashboard UI (vanilla JS, SVG charts)
```
