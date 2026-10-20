"""Smoke tests for the dashboard server.  Run:  python3 -m unittest -v"""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

_tmp = tempfile.TemporaryDirectory()
os.environ["SALES_DB"] = str(Path(_tmp.name) / "test.db")

import server  # noqa: E402  (must import after SALES_DB is set)


class DashboardTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        _tmp.cleanup()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def get_json(self, path, expect=200):
        status, body = self.get(path)
        self.assertEqual(status, expect, body)
        return json.loads(body)

    def test_static_pages(self):
        for path in ["/", "/app.js", "/style.css"]:
            status, body = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertTrue(body)

    def test_unknown_and_traversal_paths_404(self):
        for path in ["/nope", "/../server.py", "/static/../server.py", "/sales.db"]:
            self.assertEqual(self.get(path)[0], 404, path)

    def test_filters(self):
        f = self.get_json("/api/filters")
        self.assertEqual(len(f["regions"]), 5)
        self.assertIn("Subscriptions", f["categories"])
        self.assertLess(f["min_date"], f["max_date"])

    def test_summary_consistent_with_breakdowns(self):
        f = self.get_json("/api/filters")
        q = f"start={f['min_date']}&end={f['max_date']}"
        s = self.get_json(f"/api/summary?{q}")
        self.assertGreater(s["current"]["orders"], 1000)
        for by in ["region", "category"]:
            b = self.get_json(f"/api/breakdown?by={by}&{q}")
            self.assertAlmostEqual(sum(r["revenue"] for r in b["rows"]), s["current"]["revenue"], delta=1)
        for g in ["day", "week", "month"]:
            ts = self.get_json(f"/api/timeseries?granularity={g}&{q}")
            self.assertEqual(sum(r["orders"] for r in ts["rows"]), s["current"]["orders"])

    def test_filters_narrow_results(self):
        everything = self.get_json("/api/summary")["current"]["orders"]
        eu = self.get_json("/api/summary?region=Europe")["current"]["orders"]
        eu_hw = self.get_json("/api/summary?region=Europe&category=Hardware")["current"]["orders"]
        self.assertGreater(everything, eu)
        self.assertGreater(eu, eu_hw)
        rows = self.get_json("/api/orders?region=Europe&limit=50")["rows"]
        self.assertTrue(all(r["region"] == "Europe" for r in rows))

    def test_orders_pagination(self):
        p1 = self.get_json("/api/orders?limit=10&offset=0")
        p2 = self.get_json("/api/orders?limit=10&offset=10")
        self.assertEqual(len(p1["rows"]), 10)
        self.assertFalse({r["id"] for r in p1["rows"]} & {r["id"] for r in p2["rows"]})

    def test_sql_injection_is_inert(self):
        s = self.get_json("/api/summary?region=%27%20OR%201%3D1%20--")
        self.assertEqual(s["current"]["orders"], 0)

    def test_bad_input_returns_400(self):
        for path in [
            "/api/summary?start=yesterday",
            "/api/summary?start=2025-02-01&end=2025-01-01",
            "/api/timeseries?granularity=hour",
            "/api/breakdown?by=customer",
            "/api/orders?limit=abc",
            "/api/orders?limit=100000",
        ]:
            self.assertIn("error", self.get_json(path, expect=400), path)


if __name__ == "__main__":
    unittest.main()
