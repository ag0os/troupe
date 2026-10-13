"""Print the native log's own usage summary per run; no estimates."""
import json, sys
for path in sys.argv[1:]:
    found = []
    for line in open(path):
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        def walk(v, trail):
            if isinstance(v, dict):
                if 'modelUsage' in v:
                    found.append((e.get('type'), trail, v['modelUsage'], {k: v.get(k) for k in ('totalDuration', 'totalToolDuration')}))
                for k, w in v.items():
                    walk(w, trail + [k])
        walk(e, [])
    print(path)
    for f in found:
        print('  ', json.dumps(f))
    if not found:
        print('   no modelUsage record')
