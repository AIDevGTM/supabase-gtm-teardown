# Sales Dashboard

Internal dashboard for sales data stored in SQLite. It has **no dependencies**: you only need Python 3.9+. There's no `pip install` and no build step.

```bash
python3 server.py          # → http://127.0.0.1:8000
python3 -m unittest -v     # smoke tests (uses a throwaway temp DB)
```

On first run, `sales.db` is created and filled with about 2 years of realistic demo data (seasonality, growth, 5 regions, 4 categories, 200 customers). To regenerate it, run `python3 server.py --reset`.

## Features

- **Filters:** date presets (30D / 90D / YTD / 12M / All), a custom date range, region and category. Every panel responds to them.
- **KPIs:** revenue, orders, average order value, units and active customers. Each shows the % change against the previous period of the same length.
- **Revenue over time:** daily, weekly or monthly. The resolution is picked automatically from the range length and can be overridden. Hover a point to see its values.
- **Revenue by region and by category:** bar charts with each item's share of the total.
- **Top 10 products** and a paginated **orders** table.

## Configuration

| Env var    | Default        | Notes                                                    |
|------------|----------------|----------------------------------------------------------|
| `SALES_DB` | `./sales.db`   | Path to the SQLite DB. Created and seeded only if it doesn't exist. |
| `HOST`     | `127.0.0.1`    | Local-only by default. Set `0.0.0.0` to expose it on your network. |
| `PORT`     | `8000`         |                                                          |

### Using your own data

Set `SALES_DB` to any SQLite file with this schema (extra columns and tables are ignored):

```sql
customers(id INTEGER PRIMARY KEY, name TEXT, region TEXT)
products (id INTEGER PRIMARY KEY, name TEXT, category TEXT, unit_price REAL)
orders   (id INTEGER PRIMARY KEY, order_date TEXT /* YYYY-MM-DD */,
          customer_id INTEGER, product_id INTEGER, quantity INTEGER, unit_price REAL)
```

The server opens the database **read-only** and never writes to an existing file. If your data lives in Postgres or MySQL, the only code to change is `connect()` in `server.py` plus the placeholder style (`?` → `%s`). All SQL is in the `api_*` functions.

## API

All endpoints accept `start`, `end` (YYYY-MM-DD), `region` and `category`. Missing dates default to the full data range.

| Endpoint                         | Returns                                     |
|----------------------------------|---------------------------------------------|
| `GET /api/filters`               | regions, categories, min/max order date     |
| `GET /api/summary`               | KPIs for the range and for the prior period |
| `GET /api/timeseries?granularity=day\|week\|month` | revenue and orders per period |
| `GET /api/breakdown?by=region\|category` | revenue and orders per group      |
| `GET /api/top-products?limit=10` | best sellers by revenue                     |
| `GET /api/orders?limit=25&offset=0` | paginated order lines, newest first      |

## Security notes

- All queries are parameterized. User input is never put directly into SQL.
- Static files are served from a fixed whitelist, so the URL never maps to a filesystem path.
- The DB connection is read-only.
- Errors return generic 500s, and details go only to the server log.
- **There is no authentication.** It binds to localhost by default. Before sharing it more widely, put it behind your SSO / reverse proxy (for example oauth2-proxy or Cloudflare Access).

## Files

```
server.py        HTTP server, API, schema and demo seed
static/          index.html, app.js (vanilla JS, SVG charts), style.css
test_server.py   end-to-end smoke tests
```
