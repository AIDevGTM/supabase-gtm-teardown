"""Tests for the dashboard. Run with:  python3 -m unittest -v"""
import datetime as dt
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import app
import seed

TODAY = dt.date(2026, 10, 20)


class DashboardQueryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db_path = os.path.join(cls.tmp.name, "sales.db")
        seed.seed(cls.db_path, days=400, today=TODAY)
        cls.conn = app.connect_readonly(cls.db_path)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        cls.tmp.cleanup()

    def dashboard(self, start, end, region=None):
        return app.get_dashboard(self.conn, start, end, region)

    def test_parts_add_up_to_summary(self):
        d = self.dashboard(TODAY - dt.timedelta(days=29), TODAY)
        revenue = d["summary"]["revenue"]
        self.assertGreater(revenue, 0)
        self.assertAlmostEqual(sum(p["revenue"] for p in d["timeseries"]["points"]), revenue, places=0)
        self.assertAlmostEqual(sum(r["revenue"] for r in d["by_region"]), revenue, places=0)
        self.assertAlmostEqual(sum(c["revenue"] for c in d["by_category"]), revenue, places=0)
        self.assertEqual(sum(p["orders"] for p in d["timeseries"]["points"]), d["summary"]["orders"])

    def test_daily_series_is_gap_filled(self):
        start, end = TODAY - dt.timedelta(days=29), TODAY
        pts = self.dashboard(start, end)["timeseries"]
        self.assertEqual(pts["granularity"], "day")
        self.assertEqual(len(pts["points"]), 30)
        self.assertEqual(pts["points"][0]["period"], start.isoformat())
        self.assertEqual(pts["points"][-1]["period"], end.isoformat())

    def test_long_range_uses_months(self):
        ts = self.dashboard(dt.date(2025, 11, 15), dt.date(2026, 10, 20))["timeseries"]
        self.assertEqual(ts["granularity"], "month")
        self.assertEqual(ts["points"][0]["period"], "2025-11")
        self.assertEqual(ts["points"][-1]["period"], "2026-10")
        self.assertEqual(len(ts["points"]), 12)

    def test_region_filter(self):
        start, end = TODAY - dt.timedelta(days=89), TODAY
        total = self.dashboard(start, end)
        per_region = 0.0
        for r in total["by_region"]:
            d = self.dashboard(start, end, r["id"])
            self.assertAlmostEqual(d["summary"]["revenue"], r["revenue"], delta=0.02)
            self.assertTrue(all(o["region"] == r["name"] for o in d["recent_orders"]))
            per_region += d["summary"]["revenue"]
        self.assertAlmostEqual(per_region, total["summary"]["revenue"], places=0)

    def test_revenue_excludes_refunds_and_pending(self):
        start, end = TODAY - dt.timedelta(days=29), TODAY
        expected = self.conn.execute(
            """SELECT SUM(oi.quantity * oi.unit_price) FROM orders o
               JOIN order_items oi ON oi.order_id = o.id
               WHERE o.status = 'completed' AND o.order_date BETWEEN ? AND ?""",
            (start.isoformat(), end.isoformat()),
        ).fetchone()[0]
        self.assertAlmostEqual(self.dashboard(start, end)["summary"]["revenue"], expected, delta=0.01)

    def test_previous_period_is_same_length_and_adjacent(self):
        d = self.dashboard(dt.date(2026, 10, 1), dt.date(2026, 10, 10))
        self.assertEqual(d["previous_period"], {"start": "2026-09-21", "end": "2026-09-30"})

    def test_empty_period(self):
        d = self.dashboard(dt.date(2000, 1, 1), dt.date(2000, 1, 31))
        self.assertEqual(d["summary"]["revenue"], 0)
        self.assertEqual(d["summary"]["orders"], 0)
        self.assertEqual(d["summary"]["avg_order_value"], 0)
        self.assertEqual(d["top_products"], [])
        self.assertEqual(d["recent_orders"], [])
        self.assertTrue(all(r["revenue"] == 0 for r in d["by_region"]))

    def test_meta(self):
        m = app.get_meta(self.conn)
        self.assertEqual(m["max_date"], TODAY.isoformat())
        self.assertEqual(len(m["regions"]), len(seed.REGIONS))

    def test_connection_is_read_only(self):
        with self.assertRaises(sqlite3.OperationalError):
            self.conn.execute("DELETE FROM orders")


class ParseFiltersTests(unittest.TestCase):
    def test_defaults_to_last_30_days(self):
        self.assertEqual(app.parse_filters({}, today=TODAY), (TODAY - dt.timedelta(days=29), TODAY, None))

    def test_valid(self):
        got = app.parse_filters({"start": ["2026-01-01"], "end": ["2026-01-31"], "region": ["3"]})
        self.assertEqual(got, (dt.date(2026, 1, 1), dt.date(2026, 1, 31), 3))

    def test_invalid(self):
        bad = [
            {"start": ["yesterday"]},
            {"start": ["2026-02-01"], "end": ["2026-01-01"]},
            {"start": ["2000-01-01"], "end": ["2026-01-01"]},
            {"region": ["1 OR 1=1"]},
            {"region": ["-1"]},
        ]
        for qs in bad:
            with self.subTest(qs=qs), self.assertRaises(app.BadRequest):
                app.parse_filters(qs, today=TODAY)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        db_path = os.path.join(cls.tmp.name, "sales.db")
        seed.seed(db_path, days=60, today=TODAY)
        handler = type("TestHandler", (app.Handler,), {"db_path": db_path, "log_message": lambda *a: None})
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_index_served(self):
        status, headers, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Sales Dashboard", body)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])

    def test_static_assets(self):
        for path in ("/app.js", "/style.css"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 200)

    def test_dashboard_api(self):
        status, headers, body = self.get("/api/dashboard?start=2026-10-01&end=2026-10-20")
        self.assertEqual(status, 200)
        self.assertTrue(headers["Content-Type"].startswith("application/json"))
        data = json.loads(body)
        self.assertGreater(data["summary"]["orders"], 0)

    def test_bad_request(self):
        status, _, body = self.get("/api/dashboard?start=nope")
        self.assertEqual(status, 400)
        self.assertIn("error", json.loads(body))

    def test_no_path_traversal(self):
        for path in ("/../app.py", "/app.py", "/static/../sales.db", "/%2e%2e/app.py"):
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)


if __name__ == "__main__":
    unittest.main()
