# Holchin Estimator

A software estimation tool with an interactive web UI. It is written in pure Python
(3.9+) using only the standard library, with no third-party packages. The UI is plain
HTML/CSS/JS with hand-drawn SVG charts and no CDN downloads, so it works offline.

```bash
source ./activate.sh     # creates .venv and installs requirements.txt (currently nothing to install)
./run.sh                 # launches with examples/sample.yaml; sets up .venv automatically if missing
./run.sh my_project.yaml --port 9000 --no-browser
```

Or, without the scripts:

```bash
python3 -m holchin examples/sample.yaml          # opens http://127.0.0.1:8765/
python3 -m holchin my_project.yaml --port 9000   # a new file is created on first Save
python3 -m holchin --no-browser
```

## Using it

**Tree (left).** Groups can be nested to any depth. Components are the leaves, and only
components hold estimates. Each group shows the roll-up of everything beneath it.

| Action | How |
|---|---|
| Expand / collapse | chevron, double-click a group, ←/→ keys, ⊞ / ⊟ for everything |
| Move | drag onto a group (into it) or onto the top/bottom edge of a row (before/after it); the **Parent** dropdown on the detail page; right-click → *Move to…* |
| Move several | Ctrl/⌘-click or Shift-click to multi-select, then drag or right-click |
| Rename | F2, or double-click the name |
| Other | right-click: duplicate, put in a new group, delete; Ctrl+Z / Ctrl+Shift+Z for undo/redo |

Each row's badge shows effort P50 and a bar for its share of the total project effort.

**Component editor.** The form is generated from the parameter registry. It has these sections:

- *General*: language, programme maturity (selects the Holchin growth range), sizing basis
- *Existing baseline*: existing SLOC, requirements and use cases
- *Modification of existing*: % design / code / integration modified, % requirements / use cases modified (three-point)
- *New development*: new SLOC, requirements and use cases (three-point low / most likely / high). The **spread** button fills low and high as −20% / +50% of the most likely value.
- *Effort adjustment*: language factor, cost drivers (complexity, reliability, ...) and a free extra factor
- *Custom attributes*: any extra key/value fields you want saved with the component

**Charts.** KPI tiles; group contribution (P50 with P10–P90 whiskers, click to drill down);
three-point strip (low / likely / PERT / high against the Monte Carlo P5–P95 and P10–P90 bands);
histogram; S-curve with a hover crosshair; size composition (new / adapted / growth);
a size cross-check by basis; effort multipliers; and a full table of estimates.
You can switch the distribution charts between Effort, Cost, Schedule and Size.

**Files.** *Save* writes back to the file the server was started with (or the last
*Save as* path). *Open…* takes either a path on the server machine or a file uploaded
through the browser. *Download* gives you a YAML copy.

## The model

For each component, for every Monte Carlo run and for the low / likely / PERT / high points:

1. **Size (ESLOC)**, from the selected *sizing basis*:
   - `sloc`: `new SLOC + existing SLOC × AAF`, where `AAF = 0.4·DM + 0.3·CM + 0.3·IM` (the weights are configurable)
   - `requirements`: `(new reqs + existing reqs × %modified) × SLOC/requirement`
   - `use_cases`: `(new UCs + existing UCs × %modified) × SLOC/use case`
   - `max` / `average`: of whichever bases have data
2. **Holchin growth**: new and adapted ESLOC are each grown by a three-point % range that depends on programme maturity (Concept → SRR → SDR → PDR → CDR → TRR → Delivered).
3. **Effort** `PM = A × KESLOC^B × language factor × Π multipliers`
4. **Schedule** `months = C × PM^D`. **Cost** `= PM × hours/PM × rate`.

Groups add their components run by run. A **correlation** setting (a Gaussian-copula
common factor) controls how much components move together. Use 0 for independent and 1
for fully correlated. Growth is always at least 0.5 correlated because it is a
programme-wide risk. Group percentiles are true percentiles of the total, not sums of
percentiles. Results are reproducible because the random seed is fixed.

> **Calibrate before relying on the numbers.** The Holchin growth ranges, the A/B/C/D
> coefficients (COCOMO II nominal values), the language factors and the multipliers are
> reasonable starting points, not organisational data. Edit them in **Settings**. They
> are saved in the project YAML so each estimate keeps its own calibration.

## YAML format

```yaml
project: {name: Mission System Upgrade, description: ..., version: 1}
settings: {}            # overrides of the defaults (Settings dialog writes the full set)
tree:
  - id: 2f24b8f426
    type: group
    name: Ground Segment
    expanded: true
    children:
      - id: e71f7538fb
        type: component
        name: Planner core
        attributes:
          language: Java
          maturity: SRR
          size_basis: sloc
          existing_sloc: 85000
          pct_code_modified: {low: 15, likely: 25, high: 45}
          new_sloc: {low: 12000, likely: 18000, high: 30000}
          mult_complexity: High
          safety_level: DAL-B     # custom attributes round-trip untouched
```

Missing ids and attributes are filled in on load, so hand-written files only need the
fields you care about.

## Adding parameters

- **New effort driver (no code change):** *Settings → Effort drivers → Add*, or add an
  entry under `settings.multipliers` in the YAML. It appears on every component and
  multiplies effort.
- **New captured field:** append a dict to `BASE_PARAMETERS` in
  [holchin/model.py](holchin/model.py), with `key`, `label`, `type`, `section` and
  `default`. The types are `text`, `textarea`, `number`, `int`, `percent`, `select`,
  `tri` and `tri_percent`. The UI form and the YAML pick it up automatically.
- **Use it in the maths:** read `self.a["your_key"]` in `ComponentModel` and fold it
  into `evaluate()`. Three-point inputs go in `TRI_KEYS` so that they are sampled.

## Layout and tests

```
holchin/model.py     parameter registry, defaults, estimation and Monte Carlo
holchin/yamlio.py    dependency-free YAML reader/writer
holchin/server.py    http.server JSON API + static files
holchin/static/      single-page UI (index.html, app.js, app.css)
examples/sample.yaml worked example
```

```bash
python3 -m unittest discover -s tests            # YAML, model, and HTTP API tests
# UI self-test: start with examples/sample.yaml, then open http://127.0.0.1:8765/selftest.html
```
