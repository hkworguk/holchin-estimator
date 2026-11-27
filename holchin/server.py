"""Local HTTP server exposing the estimation model and serving the web UI."""

from __future__ import annotations

import json
import os
import threading
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import model, yamlio

STATIC = Path(__file__).parent / "static"
CONTENT_TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}

YAML_HEADER = ("Holchin software estimation model\n"
               "tree: groups (type: group, children) and components (type: component, attributes).\n"
               "Three-point values are {low, likely, high}. 'settings' overrides model defaults.")


def to_yaml(project: dict) -> str:
    project = model.normalise_project(json.loads(json.dumps(project)))
    ordered = {"project": project.get("project", {}), "settings": project.get("settings", {}),
               "tree": project.get("tree", [])}
    for k, v in project.items():
        if k not in ordered:
            ordered[k] = v
    return yamlio.dump(ordered, header=YAML_HEADER)


def from_yaml(text: str) -> dict:
    return model.normalise_project(yamlio.load(text) or {})


class App:
    def __init__(self, path: str | None):
        self.path = Path(path).resolve() if path else None
        self.lock = threading.Lock()
        if self.path and self.path.exists():
            self.project = from_yaml(self.path.read_text(encoding="utf-8"))
        else:
            self.project = model.new_project(self.path.stem if self.path else "New estimate")


class Handler(BaseHTTPRequestHandler):
    app: App = None  # set by serve()
    server_version = "Holchin/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("HOLCHIN_DEBUG"):
            super().log_message(fmt, *args)

    # -- helpers
    def _send(self, status, body: bytes, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status=HTTPStatus.OK):
        self._send(status, json.dumps(obj, allow_nan=False, default=str).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _body_json(self):
        return json.loads(self._body() or b"{}")

    # -- routes
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        if path.startswith("/api/"):
            return self._api_get(path)
        f = (STATIC / path.lstrip("/")).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self._send(HTTPStatus.NOT_FOUND, b"not found", "text/plain")
        self._send(HTTPStatus.OK, f.read_bytes(), CONTENT_TYPES.get(f.suffix, "application/octet-stream"))

    def _api_get(self, path):
        a = self.app
        if path == "/api/project":
            with a.lock:
                return self._json({"project": a.project, "file": str(a.path) if a.path else None})
        if path == "/api/new":
            return self._json({"project": model.new_project()})
        if path == "/api/defaults":
            return self._json({"settings": model.DEFAULT_SETTINGS,
                               "size_bases": model.SIZE_BASES})
        self._json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        a = self.app
        try:
            if path == "/api/schema":
                proj = self._body_json()
                s = model.merged_settings(proj.get("settings"))
                return self._json({"parameters": model.parameter_schema(s), "settings": s,
                                   "defaults": model.default_attributes(s)})
            if path == "/api/estimate":
                proj = self._body_json()
                return self._json(model.estimate(proj))
            if path == "/api/parse":
                text = self._body().decode("utf-8")
                return self._json({"project": from_yaml(text)})
            if path == "/api/dump":
                proj = self._body_json()
                return self._send(HTTPStatus.OK, to_yaml(proj).encode(), "text/yaml; charset=utf-8")
            if path == "/api/save":
                req = self._body_json()
                proj = req["project"]
                target = req.get("path") or (str(a.path) if a.path else None)
                if not target:
                    return self._json({"error": "No file path. Enter a path in 'Save as'."},
                                      HTTPStatus.BAD_REQUEST)
                target = Path(os.path.expanduser(target)).resolve()
                if target.suffix.lower() not in (".yaml", ".yml"):
                    target = target.with_suffix(".yaml")
                text = to_yaml(proj)
                target.parent.mkdir(parents=True, exist_ok=True)
                tmp = target.with_suffix(target.suffix + ".tmp")
                tmp.write_text(text, encoding="utf-8")
                tmp.replace(target)
                with a.lock:
                    a.project, a.path = from_yaml(text), target
                return self._json({"ok": True, "file": str(target)})
            if path == "/api/open":
                req = self._body_json()
                target = Path(os.path.expanduser(req["path"])).resolve()
                proj = from_yaml(target.read_text(encoding="utf-8"))
                with a.lock:
                    a.project, a.path = proj, target
                return self._json({"project": proj, "file": str(target)})
            self._json({"error": "unknown endpoint"}, HTTPStatus.NOT_FOUND)
        except (yamlio.YAMLError, ValueError, KeyError, OSError) as e:
            self._json({"error": f"{type(e).__name__}: {e}"}, HTTPStatus.BAD_REQUEST)
        except Exception as e:  # pragma: no cover - surfaced to UI
            traceback.print_exc()
            self._json({"error": f"{type(e).__name__}: {e}"}, HTTPStatus.INTERNAL_SERVER_ERROR)


def serve(path=None, host="127.0.0.1", port=8765, open_browser=True):
    Handler.app = App(path)
    httpd = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{host}:{httpd.server_address[1]}/"
    print(f"Holchin estimator running at {url}")
    print(f"Project file: {Handler.app.path or '(unsaved - use Save as)'}")
    print("Press Ctrl+C to stop.")
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
