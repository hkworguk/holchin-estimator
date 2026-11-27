#!/usr/bin/env bash
# Create (if needed) and activate the project virtualenv, then install requirements.txt.
# Use:  source ./activate.sh     (sourcing keeps the venv active in your shell)
#  or:  ./activate.sh            (sets up the venv only)

_holchin_setup() {
    local dir venv py
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    venv="$dir/.venv"
    py="${PYTHON:-python3}"

    if ! command -v "$py" >/dev/null 2>&1; then
        echo "error: $py not found (set PYTHON=/path/to/python3)" >&2; return 1
    fi

    if [ ! -x "$venv/bin/python" ]; then
        echo "Creating virtualenv in $venv ..."
        if ! "$py" -m venv "$venv" >/dev/null 2>&1; then
            # Debian/Ubuntu without python3-venv: ensurepip is missing. Fall back to a
            # venv without pip (fine while requirements.txt has no packages).
            rm -rf "$venv"
            "$py" -m venv --without-pip "$venv" || { echo "error: could not create venv" >&2; return 1; }
            echo "note: created venv without pip (install python3-venv to enable pip)"
        fi
    fi

    # shellcheck disable=SC1091
    source "$venv/bin/activate"

    # Only install when requirements.txt lists real packages (ignores comments/blank lines).
    if [ -f "$dir/requirements.txt" ] && grep -qvE '^[[:space:]]*(#|$)' "$dir/requirements.txt"; then
        if ! python -m pip --version >/dev/null 2>&1; then
            echo "error: requirements.txt lists packages but pip is unavailable in the venv." >&2
            echo "       Install it with: sudo apt install python3-venv  (then: rm -rf .venv; source ./activate.sh)" >&2
            return 1
        fi
        python -m pip install --quiet --upgrade pip
        python -m pip install --quiet -r "$dir/requirements.txt" || { echo "error: pip install failed" >&2; return 1; }
        echo "Installed requirements.txt"
    else
        echo "No third-party requirements to install (standard library only)."
    fi
    echo "Virtualenv ready: $(python --version) at $venv"
}

_holchin_setup
_holchin_rc=$?
unset -f _holchin_setup
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    [ $_holchin_rc -eq 0 ] && echo "Tip: run 'source ./activate.sh' to keep the venv active in this shell."
    exit $_holchin_rc
fi
return $_holchin_rc 2>/dev/null || true
