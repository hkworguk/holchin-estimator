"""Holchin-style software estimation model.

Pipeline for each component (applied to every Monte Carlo iteration and to the
deterministic low / likely / high / PERT cases):

1.  **Size** in equivalent SLOC (ESLOC), from the component's sizing basis:

    * ``sloc``         new SLOC + existing SLOC x AAF, where
                       AAF = wDM*DM + wCM*CM + wIM*IM  (COCOMO-style adaptation)
    * ``requirements`` (new reqs + existing reqs x %modified) x SLOC/requirement
    * ``use_cases``    (new UCs + existing UCs x %modified) x SLOC/use case
    * ``max`` / ``average`` of the three bases above (bases with no data are ignored)

2.  **Holchin code growth**: new and adapted ESLOC are grown separately by the
    growth percentage for the component's programme maturity, which is itself
    a three-point range that narrows as the programme matures.

3.  **Effort** (person-months) = A x KESLOC^B x language factor x product of
    effort multipliers (complexity, capability, ...).

4.  **Schedule** (months) = C x PM^D; **cost** = PM x hours/PM x labour rate.

Groups are the roll-up of their descendant components: Monte Carlo samples are
summed iteration-by-iteration (with an optional common-cause correlation), so
group percentiles are true percentiles of the total, not sums of percentiles.

Adding parameters
-----------------
* Data-capture parameters: append to ``BASE_PARAMETERS``. Anything stored in a
  component's attributes round-trips through YAML even if unused by the maths.
* Effort multipliers: add an entry under ``settings.multipliers`` (in code
  defaults or directly in the YAML file). It appears in the UI automatically and
  multiplies effort. No code change needed.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import random
import uuid

# --------------------------------------------------------------------------- defaults

DEFAULT_SETTINGS = {
    "currency": "$",
    "labour_rate_per_hour": 120.0,
    "hours_per_pm": 152.0,
    "effort": {"A": 2.94, "B": 1.10},
    "schedule": {"C": 3.67, "D": 0.318},
    "adaptation_weights": {"design": 0.4, "code": 0.3, "integration": 0.3},
    "sizing": {"sloc_per_requirement": 120.0, "sloc_per_use_case": 900.0},
    "monte_carlo": {"iterations": 3000, "seed": 1234, "correlation": 0.3},
    # Illustrative Holchin growth ranges (% growth from current estimate to
    # delivered size). Calibrate these to your organisation's growth tables.
    "maturity": [
        {"name": "Concept / Proposal", "growth_new": {"low": 20, "likely": 55, "high": 100},
         "growth_reused": {"low": 10, "likely": 30, "high": 60}},
        {"name": "SRR", "growth_new": {"low": 15, "likely": 40, "high": 80},
         "growth_reused": {"low": 8, "likely": 25, "high": 50}},
        {"name": "SDR / SFR", "growth_new": {"low": 10, "likely": 30, "high": 60},
         "growth_reused": {"low": 5, "likely": 18, "high": 40}},
        {"name": "PDR", "growth_new": {"low": 5, "likely": 20, "high": 45},
         "growth_reused": {"low": 3, "likely": 12, "high": 30}},
        {"name": "CDR", "growth_new": {"low": 3, "likely": 12, "high": 30},
         "growth_reused": {"low": 2, "likely": 8, "high": 20}},
        {"name": "TRR / Code complete", "growth_new": {"low": 0, "likely": 5, "high": 15},
         "growth_reused": {"low": 0, "likely": 3, "high": 10}},
        {"name": "Delivered", "growth_new": {"low": 0, "likely": 0, "high": 0},
         "growth_reused": {"low": 0, "likely": 0, "high": 0}},
    ],
    "languages": [
        {"name": "C", "effort_factor": 1.00},
        {"name": "C++", "effort_factor": 1.00},
        {"name": "C#", "effort_factor": 0.95},
        {"name": "Java", "effort_factor": 0.95},
        {"name": "Python", "effort_factor": 0.90},
        {"name": "JavaScript / TypeScript", "effort_factor": 0.95},
        {"name": "Ada", "effort_factor": 1.05},
        {"name": "Rust", "effort_factor": 1.00},
        {"name": "Go", "effort_factor": 0.92},
        {"name": "Fortran", "effort_factor": 1.05},
        {"name": "SQL", "effort_factor": 0.85},
        {"name": "VHDL / Verilog", "effort_factor": 1.20},
        {"name": "Assembly", "effort_factor": 1.40},
        {"name": "Other", "effort_factor": 1.00},
    ],
    # Each multiplier becomes a dropdown in the "Effort adjustment" section.
    "multipliers": {
        "complexity": {"label": "Product complexity", "default": "Nominal",
                       "options": {"Very Low": 0.73, "Low": 0.87, "Nominal": 1.0, "High": 1.17,
                                   "Very High": 1.34, "Extra High": 1.74}},
        "reliability": {"label": "Required reliability", "default": "Nominal",
                        "options": {"Very Low": 0.82, "Low": 0.92, "Nominal": 1.0, "High": 1.10,
                                    "Very High": 1.26}},
        "team_capability": {"label": "Team capability", "default": "Nominal",
                            "options": {"Very Low": 1.34, "Low": 1.15, "Nominal": 1.0, "High": 0.88,
                                        "Very High": 0.76}},
        "platform_volatility": {"label": "Platform volatility", "default": "Nominal",
                                "options": {"Low": 0.87, "Nominal": 1.0, "High": 1.15, "Very High": 1.30}},
        "process_maturity": {"label": "Process maturity (CMMI)", "default": "Level 3",
                             "options": {"Level 1": 1.20, "Level 2": 1.08, "Level 3": 1.0, "Level 4": 0.93,
                                         "Level 5": 0.87}},
    },
}

SIZE_BASES = {
    "sloc": "SLOC (new + adapted)",
    "requirements": "Requirements",
    "use_cases": "Use cases",
    "max": "Max of available bases",
    "average": "Average of available bases",
}

# Parameter registry. Types:
#   text, textarea, number, int, percent, select, tri (three-point number),
#   tri_percent (three-point percentage)
# ``options_from`` names a settings list whose ``name`` fields populate a select.
BASE_PARAMETERS = [
    # -- General
    {"key": "description", "label": "Description", "type": "textarea", "section": "General", "default": ""},
    {"key": "owner", "label": "Owner / team", "type": "text", "section": "General", "default": ""},
    {"key": "language", "label": "Primary language", "type": "select", "section": "General",
     "options_from": "languages", "default": "C++"},
    {"key": "maturity", "label": "Programme maturity (Holchin growth)", "type": "select", "section": "General",
     "options_from": "maturity", "default": "SRR",
     "help": "Selects the code-growth range applied to new and adapted code."},
    {"key": "size_basis", "label": "Sizing basis", "type": "select", "section": "General",
     "options": list(SIZE_BASES), "option_labels": SIZE_BASES, "default": "sloc",
     "help": "Which measure drives ESLOC. Other bases are still shown as cross-checks."},

    # -- Existing baseline
    {"key": "existing_sloc", "label": "Existing SLOC", "type": "int", "section": "Existing baseline",
     "default": 0, "min": 0, "unit": "SLOC"},
    {"key": "existing_requirements", "label": "Existing requirements", "type": "int",
     "section": "Existing baseline", "default": 0, "min": 0},
    {"key": "existing_use_cases", "label": "Existing use cases", "type": "int",
     "section": "Existing baseline", "default": 0, "min": 0},

    # -- Modification of existing
    {"key": "pct_design_modified", "label": "Design modified (DM)", "type": "tri_percent",
     "section": "Modification of existing", "default": {"low": 0, "likely": 0, "high": 0},
     "help": "% of the existing design that must change."},
    {"key": "pct_code_modified", "label": "Code modified (CM)", "type": "tri_percent",
     "section": "Modification of existing", "default": {"low": 0, "likely": 0, "high": 0},
     "help": "% of the existing code that must change."},
    {"key": "pct_integration", "label": "Integration & test (IM)", "type": "tri_percent",
     "section": "Modification of existing", "default": {"low": 0, "likely": 0, "high": 0},
     "help": "% of the integration and test effort of new code needed to integrate the existing code."},
    {"key": "pct_requirements_modified", "label": "Requirements modified", "type": "tri_percent",
     "section": "Modification of existing", "default": {"low": 0, "likely": 0, "high": 0}},
    {"key": "pct_use_cases_modified", "label": "Use cases modified", "type": "tri_percent",
     "section": "Modification of existing", "default": {"low": 0, "likely": 0, "high": 0}},

    # -- New development
    {"key": "new_sloc", "label": "New SLOC", "type": "tri", "section": "New development",
     "default": {"low": 0, "likely": 0, "high": 0}, "unit": "SLOC"},
    {"key": "new_requirements", "label": "New requirements", "type": "tri", "section": "New development",
     "default": {"low": 0, "likely": 0, "high": 0}},
    {"key": "new_use_cases", "label": "New use cases", "type": "tri", "section": "New development",
     "default": {"low": 0, "likely": 0, "high": 0}},

    # -- Overrides
    {"key": "sloc_per_requirement", "label": "SLOC per requirement (override)", "type": "number",
     "section": "Sizing overrides", "default": None, "min": 0,
     "help": "Leave blank to use the project setting."},
    {"key": "sloc_per_use_case", "label": "SLOC per use case (override)", "type": "number",
     "section": "Sizing overrides", "default": None, "min": 0,
     "help": "Leave blank to use the project setting."},
    {"key": "extra_effort_factor", "label": "Additional effort factor", "type": "number",
     "section": "Effort adjustment", "default": 1.0, "min": 0, "step": 0.05,
     "help": "Free multiplier for anything not covered by the drivers above."},
]


def new_id() -> str:
    return uuid.uuid4().hex[:10]


def merged_settings(settings: dict | None) -> dict:
    """Overlay user settings on defaults (deep for dicts, replace for lists)."""
    out = copy.deepcopy(DEFAULT_SETTINGS)

    def deep(dst, src):
        for k, v in (src or {}).items():
            if isinstance(v, dict) and isinstance(dst.get(k), dict) and k != "multipliers":
                deep(dst[k], v)
            else:
                dst[k] = copy.deepcopy(v)

    deep(out, settings)
    return out


def parameter_schema(settings: dict) -> list[dict]:
    """Full parameter list (base + effort multipliers) with options resolved."""
    params = []
    for p in BASE_PARAMETERS:
        p = dict(p)
        if p.get("options_from"):
            p["options"] = [x["name"] for x in settings.get(p["options_from"], [])]
        params.append(p)
    # multipliers are inserted before the free factor
    mults = []
    for key, m in settings.get("multipliers", {}).items():
        opts = list(m.get("options", {}))
        mults.append({"key": f"mult_{key}", "label": m.get("label", key), "type": "select",
                      "section": "Effort adjustment", "options": opts,
                      "option_labels": {o: f"{o} (×{m['options'][o]:g})" for o in opts},
                      "default": m.get("default", opts[0] if opts else None)})
    idx = next(i for i, p in enumerate(params) if p["key"] == "extra_effort_factor")
    return params[:idx] + mults + params[idx:]


def default_attributes(settings: dict) -> dict:
    return {p["key"]: copy.deepcopy(p["default"]) for p in parameter_schema(settings)}


# --------------------------------------------------------------------------- project helpers

def new_project(name="New estimate") -> dict:
    s = merged_settings(None)
    return {
        "project": {"name": name, "description": "", "version": 1},
        "settings": {},
        "tree": [
            {"id": new_id(), "type": "group", "name": "System", "expanded": True, "children": [
                {"id": new_id(), "type": "component", "name": "Component 1",
                 "attributes": default_attributes(s)},
            ]},
        ],
    }


def normalise_project(data: dict) -> dict:
    """Make a loaded project structurally valid (ids, types, attribute defaults)."""
    if not isinstance(data, dict):
        raise ValueError("project file must contain a mapping at the top level")
    data.setdefault("project", {"name": "Untitled"})
    data.setdefault("settings", {})
    if data["settings"] is None:
        data["settings"] = {}
    data.setdefault("tree", [])
    s = merged_settings(data["settings"])
    defaults = default_attributes(s)
    seen = set()

    def walk(nodes):
        out = []
        for n in nodes or []:
            if not isinstance(n, dict):
                continue
            nid = str(n.get("id") or new_id())
            while nid in seen:
                nid = new_id()
            seen.add(nid)
            n["id"] = nid
            n.setdefault("name", "Unnamed")
            n["name"] = str(n["name"])
            if n.get("type") not in ("group", "component"):
                n["type"] = "group" if "children" in n else "component"
            if n["type"] == "group":
                n["children"] = walk(n.get("children"))
                n.pop("attributes", None)
            else:
                attrs = n.get("attributes") or {}
                for k, v in defaults.items():
                    attrs.setdefault(k, copy.deepcopy(v))
                n["attributes"] = attrs
                n.pop("children", None)
            out.append(n)
        return out

    data["tree"] = walk(data["tree"])
    return data


# --------------------------------------------------------------------------- numeric helpers

def _num(v, default=0.0) -> float:
    try:
        if v is None or v == "":
            return default
        f = float(v)
        return f if math.isfinite(f) else default
    except (TypeError, ValueError):
        return default


def tri_values(v) -> tuple[float, float, float]:
    """Return (low, likely, high), sorted, from a 3-point dict or scalar."""
    if isinstance(v, dict):
        lk = _num(v.get("likely"))
        lo = _num(v.get("low"), lk)
        hi = _num(v.get("high"), lk)
    elif isinstance(v, (list, tuple)) and len(v) == 3:
        lo, lk, hi = (_num(x) for x in v)
    else:
        lo = lk = hi = _num(v)
    a, b, c = sorted((lo, lk, hi))
    return a, b, c


def pert_mean(t):
    lo, lk, hi = t
    return (lo + 4 * lk + hi) / 6.0


def tri_inv(u, t):
    """Inverse CDF of the triangular distribution."""
    a, m, b = t
    if b <= a:
        return a
    fc = (m - a) / (b - a)
    if u < fc:
        return a + math.sqrt(u * (b - a) * (m - a))
    return b - math.sqrt((1 - u) * (b - a) * (b - m))


def _phi(z):
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def percentile(sorted_vals, p):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * p
    f = math.floor(k)
    c = min(f + 1, len(sorted_vals) - 1)
    return sorted_vals[f] + (sorted_vals[c] - sorted_vals[f]) * (k - f)


# --------------------------------------------------------------------------- component model

class ComponentModel:
    """Evaluates one component for a given choice of input values."""

    TRI_KEYS = ["new_sloc", "new_requirements", "new_use_cases", "pct_design_modified",
                "pct_code_modified", "pct_integration", "pct_requirements_modified",
                "pct_use_cases_modified"]

    def __init__(self, attrs: dict, settings: dict):
        self.s = settings
        self.a = attrs
        self.tri = {k: tri_values(attrs.get(k)) for k in self.TRI_KEYS}
        mat_name = attrs.get("maturity")
        mats = settings.get("maturity") or [{"name": "-", "growth_new": 0, "growth_reused": 0}]
        mat = next((m for m in mats if m.get("name") == mat_name), mats[0])
        self.maturity = mat.get("name")
        self.tri["growth_new"] = tri_values(mat.get("growth_new", 0))
        self.tri["growth_reused"] = tri_values(mat.get("growth_reused", 0))

        lang = next((l for l in settings.get("languages", []) if l.get("name") == attrs.get("language")), None)
        self.lang_factor = _num(lang.get("effort_factor"), 1.0) if lang else 1.0
        em = self.lang_factor * _num(attrs.get("extra_effort_factor"), 1.0)
        self.multipliers = {"language": self.lang_factor}
        for key, m in settings.get("multipliers", {}).items():
            choice = attrs.get(f"mult_{key}", m.get("default"))
            f = _num(m.get("options", {}).get(choice), 1.0)
            self.multipliers[m.get("label", key)] = f
            em *= f
        self.em = em
        self.existing_sloc = max(0.0, _num(attrs.get("existing_sloc")))
        self.existing_req = max(0.0, _num(attrs.get("existing_requirements")))
        self.existing_uc = max(0.0, _num(attrs.get("existing_use_cases")))
        sz = settings.get("sizing", {})
        self.sloc_per_req = _num(attrs.get("sloc_per_requirement"), _num(sz.get("sloc_per_requirement"), 120))
        self.sloc_per_uc = _num(attrs.get("sloc_per_use_case"), _num(sz.get("sloc_per_use_case"), 900))
        self.basis = attrs.get("size_basis") or "sloc"
        w = settings.get("adaptation_weights", {})
        self.w = (_num(w.get("design"), 0.4), _num(w.get("code"), 0.3), _num(w.get("integration"), 0.3))
        e = settings.get("effort", {})
        self.A, self.B = _num(e.get("A"), 2.94), _num(e.get("B"), 1.1)
        sc = settings.get("schedule", {})
        self.C, self.D = _num(sc.get("C"), 3.67), _num(sc.get("D"), 0.318)
        self.hours = _num(settings.get("hours_per_pm"), 152)
        self.rate = _num(settings.get("labour_rate_per_hour"), 100)

    def evaluate(self, v: dict) -> dict:
        """v maps TRI_KEYS (+ growth) to scalar values."""
        dm, cm, im = (max(0.0, min(100.0, v[k])) / 100.0 for k in
                      ("pct_design_modified", "pct_code_modified", "pct_integration"))
        aaf = self.w[0] * dm + self.w[1] * cm + self.w[2] * im
        bases = {}
        new_s, adapt_s = max(0.0, v["new_sloc"]), self.existing_sloc * aaf
        if new_s or adapt_s:
            bases["sloc"] = (new_s, adapt_s)
        rq_new = max(0.0, v["new_requirements"]) * self.sloc_per_req
        rq_ad = self.existing_req * max(0.0, v["pct_requirements_modified"]) / 100.0 * self.sloc_per_req
        if rq_new or rq_ad:
            bases["requirements"] = (rq_new, rq_ad)
        uc_new = max(0.0, v["new_use_cases"]) * self.sloc_per_uc
        uc_ad = self.existing_uc * max(0.0, v["pct_use_cases_modified"]) / 100.0 * self.sloc_per_uc
        if uc_new or uc_ad:
            bases["use_cases"] = (uc_new, uc_ad)

        if self.basis in ("sloc", "requirements", "use_cases"):
            new, adapted = bases.get(self.basis, (0.0, 0.0))
        elif bases:
            if self.basis == "max":
                new, adapted = max(bases.values(), key=lambda p: p[0] + p[1])
            else:
                n = len(bases)
                new = sum(p[0] for p in bases.values()) / n
                adapted = sum(p[1] for p in bases.values()) / n
        else:
            new = adapted = 0.0

        g_new = new * max(0.0, v["growth_new"]) / 100.0
        g_ad = adapted * max(0.0, v["growth_reused"]) / 100.0
        esloc = new + adapted + g_new + g_ad
        ksloc = esloc / 1000.0
        pm = self.A * (ksloc ** self.B) * self.em if ksloc > 0 else 0.0
        return {
            "esloc": esloc,
            "new_esloc": new,
            "adapted_esloc": adapted,
            "growth_esloc": g_new + g_ad,
            "aaf": aaf,
            "effort_pm": pm,
            "effort_hours": pm * self.hours,
            "cost": pm * self.hours * self.rate,
            "schedule_months": schedule_months(pm, self.C, self.D),
            "bases": {k: p[0] + p[1] for k, p in bases.items()},
        }

    def point(self, which: str) -> dict:
        if which == "pert":
            return self.evaluate({k: pert_mean(t) for k, t in self.tri.items()})
        i = {"low": 0, "likely": 1, "high": 2}[which]
        return self.evaluate({k: t[i] for k, t in self.tri.items()})


def schedule_months(pm, C, D):
    return C * (pm ** D) if pm > 0 else 0.0


# --------------------------------------------------------------------------- estimation engine

METRICS = ["esloc", "effort_pm", "cost", "schedule_months", "growth_esloc"]
_CACHE: dict[str, dict] = {}
_CACHE_MAX = 2000


def _common_normals(n, seed):
    rng = random.Random(f"common-{seed}")
    return [rng.gauss(0, 1) for _ in range(n)]


def simulate_component(node_id, attrs, settings, common):
    """Monte Carlo samples (lists) for a component; cached on its inputs."""
    mc = settings.get("monte_carlo", {})
    n = len(common)
    rho = max(0.0, min(1.0, _num(mc.get("correlation"), 0.0)))
    key = hashlib.sha1(json.dumps([node_id, attrs, settings], sort_keys=True, default=str)
                       .encode()).hexdigest()
    if key in _CACHE:
        return _CACHE[key]
    model = ComponentModel(attrs, settings)
    rng = random.Random(f"{mc.get('seed', 0)}-{node_id}")
    a, b = math.sqrt(rho), math.sqrt(1 - rho)
    keys = list(model.tri)
    out = {m: [0.0] * n for m in METRICS}
    out["new_esloc"] = [0.0] * n
    out["adapted_esloc"] = [0.0] * n
    for i in range(n):
        zc = common[i]
        v = {}
        for k in keys:
            t = model.tri[k]
            if t[0] == t[2]:
                v[k] = t[0]
            else:
                # growth is a programme-level risk: fully tied to the common factor
                u = _phi(a * zc + b * rng.gauss(0, 1)) if not k.startswith("growth") \
                    else _phi(math.sqrt(max(rho, 0.5)) * zc + math.sqrt(1 - max(rho, 0.5)) * rng.gauss(0, 1))
                v[k] = tri_inv(u, t)
        r = model.evaluate(v)
        for m in out:
            out[m][i] = r[m]
    if len(_CACHE) > _CACHE_MAX:
        _CACHE.clear()
    _CACHE[key] = out
    return out


def summarise(samples: list[float], bins=30) -> dict:
    s = sorted(samples)
    n = len(s)
    if n == 0:
        return {}
    mean = sum(s) / n
    var = sum((x - mean) ** 2 for x in s) / max(1, n - 1)
    stats = {"min": s[0], "max": s[-1], "mean": mean, "sd": math.sqrt(var)}
    for p in (5, 10, 20, 50, 70, 80, 90, 95):
        stats[f"p{p}"] = percentile(s, p / 100)
    lo, hi = s[0], s[-1]
    if hi - lo < 1e-9:
        edges = [lo, lo + 1e-9]
        counts = [n]
    else:
        width = (hi - lo) / bins
        edges = [lo + i * width for i in range(bins + 1)]
        counts = [0] * bins
        for x in s:
            counts[min(bins - 1, int((x - lo) / width))] += 1
    cdf = [[percentile(s, p / 100), p / 100] for p in range(0, 101, 2)]
    return {"stats": stats, "hist": {"edges": edges, "counts": counts}, "cdf": cdf}


def estimate(project: dict) -> dict:
    """Estimate every node in the tree. Returns {node_id: result}."""
    settings = merged_settings(project.get("settings"))
    n = max(100, min(50000, int(_num(settings["monte_carlo"].get("iterations"), 3000))))
    common = _common_normals(n, settings["monte_carlo"].get("seed", 0))
    C, D = _num(settings["schedule"]["C"], 3.67), _num(settings["schedule"]["D"], 0.318)
    hours, rate = _num(settings["hours_per_pm"], 152), _num(settings["labour_rate_per_hour"], 100)
    results = {}

    def finish(node, samples, points, extra):
        res = {"id": node["id"], "type": node["type"], "name": node.get("name"),
               "points": points, "mc": {}, **extra}
        for m in ("esloc", "effort_pm", "cost", "schedule_months"):
            res["mc"][m] = summarise(samples[m])
        res["mc"]["effort_hours"] = {"stats": {k: v * hours for k, v in res["mc"]["effort_pm"]["stats"].items()
                                               if k != "sd"}}
        results[node["id"]] = res

    def walk(node):
        if node["type"] == "component":
            attrs = node.get("attributes") or {}
            model = ComponentModel(attrs, settings)
            points = {w: model.point(w) for w in ("low", "likely", "pert", "high")}
            samples = simulate_component(node["id"], attrs, settings, common)
            warnings = []
            if points["likely"]["esloc"] == 0:
                warnings.append("No size entered for the selected sizing basis.")
            if model.basis not in points["likely"]["bases"] and points["likely"]["bases"] \
                    and model.basis in ("sloc", "requirements", "use_cases"):
                warnings.append(f"Sizing basis '{model.basis}' has no data, but other bases do.")
            finish(node, samples, points, {
                "multipliers": model.multipliers, "em": model.em, "maturity": model.maturity,
                "components": 1, "warnings": warnings,
                "breakdown": {k: points["likely"][k] for k in ("new_esloc", "adapted_esloc", "growth_esloc")},
            })
            return samples, points, 1
        tot = {m: [0.0] * n for m in METRICS + ["new_esloc", "adapted_esloc"]}
        pts = {w: {"esloc": 0.0, "effort_pm": 0.0, "new_esloc": 0.0, "adapted_esloc": 0.0,
                   "growth_esloc": 0.0, "bases": {}} for w in ("low", "likely", "pert", "high")}
        count = 0
        children = []
        for ch in node.get("children", []):
            s, p, c = walk(ch)
            count += c
            for m in tot:
                if m == "schedule_months":
                    continue
                sm, tm = s[m], tot[m]
                for i in range(n):
                    tm[i] += sm[i]
            for w in pts:
                for k in ("esloc", "effort_pm", "new_esloc", "adapted_esloc", "growth_esloc"):
                    pts[w][k] += p[w][k]
            r = results[ch["id"]]
            children.append({"id": ch["id"], "name": ch.get("name"), "type": ch["type"],
                             "p10": r["mc"]["effort_pm"]["stats"]["p10"],
                             "p50": r["mc"]["effort_pm"]["stats"]["p50"],
                             "p90": r["mc"]["effort_pm"]["stats"]["p90"],
                             "mean": r["mc"]["effort_pm"]["stats"]["mean"],
                             "likely": r["points"]["likely"]["effort_pm"]})
        tot["schedule_months"] = [schedule_months(x, C, D) for x in tot["effort_pm"]]
        for w, p in pts.items():
            p["effort_hours"] = p["effort_pm"] * hours
            p["cost"] = p["effort_hours"] * rate
            p["schedule_months"] = schedule_months(p["effort_pm"], C, D)
        finish(node, tot, pts, {"components": count, "children": children, "warnings": [],
                                "breakdown": {k: pts["likely"][k] for k in
                                              ("new_esloc", "adapted_esloc", "growth_esloc")}})
        return tot, pts, count

    root = {"id": "__root__", "type": "group", "name": project.get("project", {}).get("name", "Project"),
            "children": project.get("tree", [])}
    walk(root)
    return {"settings": settings, "iterations": n, "results": results}
