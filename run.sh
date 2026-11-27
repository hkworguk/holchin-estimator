#!/usr/bin/env bash
# Launch the Holchin Estimator web UI.
# Usage: ./run.sh [project.yaml] [--port N] [--host H] [--no-browser]
# Defaults to examples/sample.yaml when no project file is given.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -x .venv/bin/python ]; then
    # shellcheck disable=SC1091
    source ./activate.sh
fi
PY=.venv/bin/python

if [ $# -eq 0 ] || [[ "$1" == -* ]]; then
    set -- examples/sample.yaml "$@"
fi
exec "$PY" -m holchin "$@"
