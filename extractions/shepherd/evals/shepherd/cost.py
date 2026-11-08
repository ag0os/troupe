#!/usr/bin/env python3
"""A session's own cost from its native log; no estimates.

Usage: cost.py <claude.jsonl>... Prints one JSON object per log. Claude's
`cost-state` records are cumulative, so the session cost is the last one,
never their sum. Unknown cost is null with a reason, never zero.
"""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def subject_cost(path):
    path = Path(path)
    try:
        lines = path.read_text().splitlines()
    except (OSError, UnicodeDecodeError) as error:
        return {'usd': None, 'reason': f'unreadable log: {error}', 'usage': None, 'source': path.name}
    last = None
    for number, line in enumerate(lines, 1):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and event.get('type') == 'cost-state':
            last = (number, event)
    if last is None:
        return {'usd': None, 'reason': 'no cost-state record in the log', 'usage': None, 'source': path.name}
    number, event = last
    usage = event.get('modelUsage') if isinstance(event.get('modelUsage'), dict) else None
    source = f'{path.name} cost-state line {number}'
    usd = event.get('totalCostUSD')
    if event.get('hasUnknownModelCost') or not isinstance(usd, (int, float)) or isinstance(usd, bool):
        return {'usd': None, 'reason': 'the log marks the model cost unknown', 'usage': usage, 'source': source}
    return {'usd': usd, 'reason': None, 'usage': usage, 'source': source}


if __name__ == '__main__':
    for log in sys.argv[1:]:
        print(json.dumps(subject_cost(log)))
