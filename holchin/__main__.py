"""Run the Holchin estimator: ``python -m holchin [project.yaml] [--port N]``."""

import argparse

from .server import serve


def main():
    ap = argparse.ArgumentParser(prog="holchin", description="Holchin software estimation tool (web UI)")
    ap.add_argument("file", nargs="?", help="project YAML file to open (created on first save)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    a = ap.parse_args()
    serve(a.file, a.host, a.port, not a.no_browser)


if __name__ == "__main__":
    main()
