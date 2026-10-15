#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd -P)
child=''
cleanup() {
	if [[ -n $child ]]; then
		kill -TERM "$child" 2>/dev/null || :
		wait "$child" 2>/dev/null || :
	fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
[[ $# -ge 3 ]] || { echo 'Usage: run-trial.sh <run-config.json> <trial> <claude|codex> [--rerun|--before] [--attempt <n>]' >&2; exit 2; }
config=$1
shift
# Python handles the session timeout and terminates the full backend process
# group on signals or exit. The shell trap also covers exit of this wrapper.
python3 -I "$here/harness.py" --config "$config" run "$@" &
child=$!
set +e
wait "$child"
status=$?
child=''
exit "$status"
