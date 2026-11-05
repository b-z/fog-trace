"""Compare two per-window detection dumps field by field (browser port vs Python reference).

    python3 tools/deadends.py Sync.zip --state /tmp/st.json --raw py.json
    node tools/detect_node.js Sync.zip --raw js.json
    python3 tools/compare_raw.py py.json js.json
"""
import json, sys

a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
n = same = 0
diffs = []
for k in sorted(set(a) | set(b)):
    ra, rb = a.get(k, []), b.get(k, [])
    if len(ra) != len(rb):
        diffs.append(f'window {k}: {len(ra)} vs {len(rb)} detections')
        continue
    for x, y in zip(ra, rb):
        n += 1
        if x == y:
            same += 1
        else:
            diffs.append(f'window {k}: ' + ', '.join(f'{f} {x[f]!r} vs {y.get(f)!r}' for f in x if x[f] != y.get(f)))
print(f'windows: {len(a)} vs {len(b)}; detections compared: {n}, identical: {same}, differing: {len(diffs)}')
for d in diffs[:20]:
    print('  ' + d)
sys.exit(1 if diffs else 0)
