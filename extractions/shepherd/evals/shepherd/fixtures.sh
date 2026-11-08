#!/usr/bin/env bash
set -euo pipefail
[[ $# = 3 ]] || { echo 'Usage: fixtures.sh <run-config.json> <A|B|C|D|E|F1|F2|G|I|E-neg|G-neg> <empty-dir>' >&2; exit 2; }
case $2 in A|B|C|D|E|F1|F2|G|I|E-neg|G-neg) ;; *) exit 2 ;; esac
here=$(cd -- "$(dirname -- "$0")" && pwd -P)
# The helper checks isolation before any binary invocation or fixture write.
python3 -I "$here/harness.py" --config "$1" fixture "$2" "$3"
