"""Run with: python -m unittest discover -s tests"""

import json
import math
import sys
import threading
import unittest
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from holchin import model, server, yamlio  # noqa: E402


class YamlTests(unittest.TestCase):
    def rt(self, obj):
        text = yamlio.dump(obj)
        self.assertEqual(yamlio.load(text), obj, msg=text)

    def test_scalars(self):
        self.rt({"a": 1, "b": -2.5, "c": True, "d": None, "e": "hello world", "f": "",
                 "g": "123", "h": "true", "i": "null", "j": "a: b", "k": "# not comment",
                 "l": "x #y", "m": "quote \"me\"", "n": "it's", "o": " padded ", "p": "-dash",
                 "q": "1e5", "r": 1e-7, "s": "yes", "t": "[x]", "u": "tab\there", "v": "ünïcødé"})

    def test_multiline(self):
        self.rt({"a": "line1\nline2", "b": "trailing\n", "c": "x\n\ny", "d": "  indented\nfirst",
                 "e": "two trailing\n\n"})

    def test_nested(self):
        self.rt({"tree": [{"id": "x", "children": [{"id": "y", "v": {"low": 1, "likely": 2, "high": 3}},
                                                    {"id": "z", "children": []}]}],
                 "list": [[1, 2], [3, [4, 5]]], "empty": {}, "el": [],
                 "deep": {"a": {"b": {"c": [{"d": 1, "e": [1, {"f": 2}]}]}}}})

    def test_hand_written(self):
        text = """
# comment
project:
  name: "Demo"   # trailing comment
  tags: [a, 'b c', "d"]
tree:
- type: group
  name: G
  children:
    - type: component
      name: C
      attributes: {new_sloc: {low: 1, likely: 2, high: 3}, language: C++}
      notes: >
        folded
        text
---
"""
        d = yamlio.load(text)
        self.assertEqual(d["project"]["name"], "Demo")
        self.assertEqual(d["project"]["tags"], ["a", "b c", "d"])
        c = d["tree"][0]["children"][0]
        self.assertEqual(c["attributes"]["new_sloc"]["likely"], 2)
        self.assertEqual(c["notes"], "folded text\n")

    def test_sample_file_roundtrip(self):
        data = yamlio.load((ROOT / "examples" / "sample.yaml").read_text())
        self.rt(data)


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.s = model.merged_settings(None)

    def comp(self, **kw):
        a = model.default_attributes(self.s)
        a.update(kw)
        return {"id": model.new_id(), "type": "component", "name": "c", "attributes": a}

    def test_esloc_and_effort(self):
        attrs = self.comp(new_sloc={"low": 10000, "likely": 10000, "high": 10000}, existing_sloc=10000,
                          percent_design_modified={"low": 50, "likely": 50, "high": 50},
                          percent_code_modified={"low": 50, "likely": 50, "high": 50},
                          percent_integration={"low": 50, "likely": 50, "high": 50},
                          maturity="Delivered", language="C")["attributes"]
        r = model.ComponentModel(attrs, self.s).point("likely")
        self.assertAlmostEqual(r["adapted_esloc"], 5000)
        self.assertAlmostEqual(r["esloc"], 15000)
        self.assertAlmostEqual(r["effort_pm"], 2.94 * 15 ** 1.10, places=6)

    def test_growth_applied(self):
        attrs = self.comp(new_sloc={"low": 1000, "likely": 1000, "high": 1000}, maturity="SRR")["attributes"]
        r = model.ComponentModel(attrs, self.s).point("likely")
        self.assertAlmostEqual(r["esloc"], 1400)

    def test_requirements_basis(self):
        attrs = self.comp(size_basis="requirements", new_requirements={"low": 10, "likely": 10, "high": 10},
                          maturity="Delivered", sloc_per_requirement=50)["attributes"]
        self.assertAlmostEqual(model.ComponentModel(attrs, self.s).point("likely")["esloc"], 500)

    def test_rollup_and_ordering(self):
        c1 = self.comp(new_sloc={"low": 5000, "likely": 8000, "high": 15000})
        c2 = self.comp(new_sloc={"low": 1000, "likely": 2000, "high": 6000})
        g = {"id": "g", "type": "group", "name": "g", "children": [c1, c2]}
        proj = {"settings": {"monte_carlo": {"iterations": 800}}, "tree": [g]}
        res = model.estimate(proj)["results"]
        rg, r1, r2 = res["g"], res[c1["id"]], res[c2["id"]]
        self.assertAlmostEqual(rg["mc"]["effort_pm"]["stats"]["mean"],
                               r1["mc"]["effort_pm"]["stats"]["mean"] + r2["mc"]["effort_pm"]["stats"]["mean"], places=6)
        st = rg["mc"]["effort_pm"]["stats"]
        self.assertTrue(st["p10"] <= st["p50"] <= st["p80"] <= st["p90"])
        p = r1["points"]
        self.assertTrue(p["low"]["effort_pm"] <= p["likely"]["effort_pm"] <= p["high"]["effort_pm"])
        self.assertEqual(res["__root__"]["components"], 2)
        json.dumps(res, allow_nan=False)

    def test_empty_project(self):
        res = model.estimate({"tree": []})["results"]
        self.assertEqual(res["__root__"]["mc"]["effort_pm"]["stats"]["mean"], 0)

    def test_normalise_fills_defaults_and_keeps_custom(self):
        p = model.normalise_project({"tree": [{"name": "x", "attributes": {"my_field": 7}},
                                              {"name": "g", "children": [{"name": "y"}]}]})
        a = p["tree"][0]["attributes"]
        self.assertEqual(a["my_field"], 7)
        self.assertIn("new_sloc", a)
        self.assertEqual(p["tree"][1]["type"], "group")
        self.assertTrue(p["tree"][1]["children"][0]["id"])

    def test_legacy_pct_keys_migrated(self):
        p = model.normalise_project({"tree": [{"name": "x", "attributes": {
            "pct_code_modified": {"low": 5, "likely": 10, "high": 20}}}]})
        a = p["tree"][0]["attributes"]
        self.assertNotIn("pct_code_modified", a)
        self.assertEqual(a["percent_code_modified"], {"low": 5, "likely": 10, "high": 20})

    def test_custom_multiplier_in_settings(self):
        s = {"multipliers": {"security": {"label": "Security", "default": "High",
                                          "options": {"Nominal": 1.0, "High": 1.5}}}}
        merged = model.merged_settings(s)
        keys = [p["key"] for p in model.parameter_schema(merged)]
        self.assertIn("mult_security", keys)
        attrs = model.default_attributes(merged)
        attrs.update(new_sloc={"low": 1000, "likely": 1000, "high": 1000}, maturity="Delivered", language="C")
        self.assertAlmostEqual(model.ComponentModel(attrs, merged).em, 1.5)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.Handler.app = server.App(str(ROOT / "examples" / "sample.yaml"))
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def req(self, path, body=None, raw=False):
        data = None if body is None else (body.encode() if raw else json.dumps(body).encode())
        with urllib.request.urlopen(urllib.request.Request(self.base + path, data=data)) as r:
            return r.read().decode()

    def test_static_and_api(self):
        self.assertIn("Holchin", self.req("/"))
        self.assertIn("renderTree", self.req("/app.js"))
        proj = json.loads(self.req("/api/project"))["project"]
        est = json.loads(self.req("/api/estimate", proj))
        self.assertGreater(est["results"]["__root__"]["mc"]["effort_pm"]["stats"]["p50"], 0)
        y = self.req("/api/dump", proj)
        back = json.loads(self.req("/api/parse", y, raw=True))["project"]
        self.assertEqual(back["tree"], proj["tree"])
        schema = json.loads(self.req("/api/schema", proj))
        self.assertTrue(any(p["key"] == "new_sloc" for p in schema["parameters"]))

    def test_save(self):
        import tempfile
        proj = json.loads(self.req("/api/project"))["project"]
        with tempfile.TemporaryDirectory() as d:
            target = Path(d) / "out.yaml"
            r = json.loads(self.req("/api/save", {"project": proj, "path": str(target)}))
            self.assertTrue(r["ok"])
            self.assertEqual(yamlio.load(target.read_text())["tree"], proj["tree"])


if __name__ == "__main__":
    unittest.main()
