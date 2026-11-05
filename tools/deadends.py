"""Find dead ends (轨迹断头) in a Fog of World Sync.zip, score them, and merge into a review state file.

Usage:
    python tools/deadends.py ~/Downloads/Sync.zip [--state data/review.json] [--workers 8]
    python tools/deadends.py "~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync"   # the app's folder (read only)
    python tools/deadends.py Sync.zip --raw raw.json     # also dump per-window results (compare with tools/detect_node.js)

This is the reference implementation; the web page runs the same algorithm in the browser
(src/detect-core.js) and produces identical results (check with tools/compare_raw.py).

Pipeline per window (32x32 subtiles core + 4 subtile margin, so window seams don't create fake ends):
    bitmap -> 1px dilation (bridges raster gaps) -> skeletonize -> prune spurs < 6px -> endpoints

Each endpoint gets three features (pixels; 1px ≈ 7.7m in Tokyo):
    length   branch length from tip back to the nearest junction (how far it sticks out)
    forward  clearance straight ahead of the tip (±35° cone) until another track
    touch    distance from the tip to any track that isn't its own branch
             (≈1px means the skeleton merely broke next to another line: not a real end)
score (0-100) = sat(length) * sat(forward) * sat(touch); see score().

State file (shared by all archives): every point has a stable uuid. On re-run -- same archive or
another one -- a detection within MATCH_PX of an existing point that points the same way is the same
end and keeps its id and its mark (ignored / done). Marks are never dropped.
"""
import sys, os, json, math, time, uuid, argparse
from datetime import datetime, timezone
from multiprocessing import Pool
import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fogdec

CORE = 32        # subtiles per window side
MARGIN = 4       # subtiles of context around each window
PRUNE = 6        # px: spurs shorter than this are skeleton artifacts
TRACE_CAP = 4000
FEAT_R = 100     # px radius used for forward/touch features
CONE_DEG = 35
DEDUP_PX = 5     # ends closer than this are one place
MATCH_PX = 6     # re-run matching radius against the state file
DIR_TOL = 60     # deg: a re-detected end must point the same way to count as the same end
K8 = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]])
OFFS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]

_SUB = None  # per-worker packed subtiles


def _init(zip_path):
    global _SUB
    _SUB = fogdec.load_subtiles(zip_path, packed=True)


def build(sub, sx0, sy0, n, packed=True):
    a = np.zeros((n * 64, n * 64), bool)
    for j in range(n):
        for i in range(n):
            t = sub.get((sx0 + i, sy0 + j))
            if t is not None:
                a[j * 64:(j + 1) * 64, i * 64:(i + 1) * 64] = fogdec.unpack(t) if packed else t
    return a


def nbcount(sk):
    return ndi.convolve(sk.astype(np.uint8), K8, mode='constant') * sk


def trace(sk, y, x, cap=TRACE_CAP):
    """Walk from an endpoint until a junction / the other end. Returns (path, end_kind)."""
    H, W = sk.shape
    path = [(y, x)]
    prev = None
    cy, cx = y, x
    while len(path) < cap:
        nxt = []
        for dy, dx in OFFS:
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < H and 0 <= nx < W and sk[ny, nx] and (ny, nx) != prev and (ny, nx) not in path[-3:]:
                nxt.append((ny, nx))
        if not nxt:
            return path, 'end'          # reached the other endpoint: isolated segment
        if len(nxt) > 1:
            # on a bend an 8-connected skeleton can offer 2 adjacent candidates; take the 4-neighbour one
            four = [p for p in nxt if abs(p[0] - cy) + abs(p[1] - cx) == 1]
            if len(nxt) == 2 and len(four) == 1 and max(abs(nxt[0][0] - nxt[1][0]), abs(nxt[0][1] - nxt[1][1])) == 1:
                nxt = four
            else:
                return path, 'junction'
        prev = (cy, cx)
        cy, cx = nxt[0]
        path.append((cy, cx))
    return path, 'cap'


def prune(sk, length, rounds=3):
    for _ in range(rounds):
        ends = np.argwhere(nbcount(sk) == 1)
        removed = 0
        for y, x in ends:
            if not sk[y, x]:
                continue
            path, kind = trace(sk, y, x, cap=length + 1)
            if kind == 'junction' and len(path) < length:
                for p in path:
                    sk[p] = False
                removed += 1
        if not removed:
            break
    return sk


def features(dil, sk, path):
    """forward clearance, touch distance and direction (deg, 0=east, ccw) for the tip path[0]."""
    ty, tx = path[0]
    H, W = sk.shape
    y0, y1, x0, x1 = max(ty - FEAT_R, 0), min(ty + FEAT_R + 1, H), max(tx - FEAT_R, 0), min(tx + FEAT_R + 1, W)
    skc, dilc = sk[y0:y1, x0:x1], dil[y0:y1, x0:x1]
    bm = np.zeros_like(skc)
    for py, px in path:
        if y0 <= py < y1 and x0 <= px < x1:
            bm[py - y0, px - x0] = True
    if skc.any():
        _, (iy, ix) = ndi.distance_transform_edt(~skc, return_indices=True)
        owned = bm[iy, ix]               # pixels whose nearest skeleton pixel belongs to this branch
    else:
        owned = np.ones_like(skc)
    rest = dilc & ~owned
    pts = np.argwhere(rest).astype(float) - [ty - y0, tx - x0]
    k = min(len(path) - 1, 8)
    v = None
    if k > 0:
        v = np.array([path[0][0] - path[k][0], path[0][1] - path[k][1]], float)
        v /= np.linalg.norm(v)
    direction = math.degrees(math.atan2(-v[0], v[1])) if v is not None else None
    if not len(pts):
        return float(FEAT_R), float(FEAT_R), direction
    d = np.hypot(pts[:, 0], pts[:, 1])
    touch = float(d.min())
    if v is None:
        return touch, touch, direction
    cos = (pts @ v) / np.maximum(d, 1e-9)
    cone = cos >= math.cos(math.radians(CONE_DEG))
    forward = float(d[cone].min()) if cone.any() else float(FEAT_R)
    return min(forward, FEAT_R), min(touch, FEAT_R), direction


def score(length, forward, touch):
    """0-100. Each factor saturates; any one being small kills the score."""
    g = 1 - math.exp(-max(length - 5, 0) / 15)   # 10px≈77m -> .28, 20px -> .63, 40px -> .9
    h = 1 - math.exp(-max(forward - 3, 0) / 8)   # ≤3px -> 0, 5px -> .22, 10px -> .58, 25px -> .94
    k = 1 - math.exp(-max(touch - 1, 0) / 2)     # touching (≤1.5px) -> <.22, 5px -> .86
    return round(100 * g * h * k, 1)


def process_window(w):
    wx, wy = w
    sx0, sy0 = wx * CORE, wy * CORE
    n = CORE + 2 * MARGIN
    ox, oy = sx0 - MARGIN, sy0 - MARGIN
    a = build(_SUB, ox, oy, n)
    if not a.any():
        return []
    dil = ndi.binary_dilation(a, structure=np.ones((3, 3), bool))
    sk = prune(skeletonize(dil), PRUNE)
    nb = nbcount(sk)
    lo, hi = MARGIN * 64, (MARGIN + CORE) * 64
    res = []
    for y, x in np.argwhere((nb == 1) | ((nb == 0) & sk)):
        if not (lo <= y < hi and lo <= x < hi):
            continue
        if nb[y, x] == 0:
            path, kind = [(y, x)], 'dot'
        else:
            path, kind = trace(sk, y, x)
        fwd, touch, direction = features(dil, sk, path)
        L = len(path) if kind != 'dot' else 15
        res.append(dict(px=ox * 64 + x + 0.5, py=oy * 64 + y + 0.5, kind='junction' if kind == 'cap' else kind,
                        length_px=len(path), forward_px=round(fwd, 1), touch_px=round(touch, 1),
                        dir=None if direction is None else round(direction), score=score(L, fwd, touch)))
    return res


def detect(zip_path, workers, raw_path=None):
    t = time.time()
    sub = fogdec.load_subtiles(zip_path, packed=True)
    wins = sorted({(sx // CORE, sy // CORE) for sx, sy in sub})
    print(f'{len(sub)} subtiles, {len(wins)} windows, {workers} workers', file=sys.stderr)
    out, raw = [], {}
    with Pool(workers, initializer=_init, initargs=(zip_path,)) as pool:
        for i, (w, r) in enumerate(zip(wins, pool.imap(process_window, wins, chunksize=4))):
            out += r
            if r:
                raw['%d,%d' % w] = r
            if i % 500 == 0:
                print(f'  {i}/{len(wins)}  {len(out)} ends  {time.time() - t:.0f}s', file=sys.stderr)
    if raw_path:
        json.dump(raw, open(raw_path, 'w'))
    # dedupe: one place -> keep the best-scored detection
    out.sort(key=lambda e: -e['score'])
    P = np.array([[e['px'], e['py']] for e in out])
    tree, dead, keep = cKDTree(P), set(), []
    for i, e in enumerate(out):
        if i in dead:
            continue
        keep.append(e)
        dead.update(tree.query_ball_point(P[i], DEDUP_PX))
    for e in keep:
        lng, lat = fogdec.px_to_lnglat(e['px'], e['py'])
        m = fogdec.meters_per_px(lat)
        e.update(lng=round(lng, 6), lat=round(lat, 6), length_m=round(e['length_px'] * m),
                 forward_m=round(e['forward_px'] * m), touch_m=round(e['touch_px'] * m))
    print(f'detected {len(out)} -> {len(keep)} after dedupe in {time.time() - t:.0f}s', file=sys.stderr)
    return keep


def same_dir(a, b):
    return a is None or b is None or abs((a - b + 180) % 360 - 180) <= DIR_TOL


def nearest(tree, pts, d, taken=()):
    """index of the closest point within MATCH_PX of detection d that points the same way, else None."""
    if tree is None:
        return None
    best = None
    for j in tree.query_ball_point([d['px'], d['py']], MATCH_PX):
        if j in taken or not same_dir(pts[j].get('dir'), d.get('dir')):
            continue
        dist = math.hypot(pts[j]['px'] - d['px'], pts[j]['py'] - d['py'])
        if best is None or dist < best[0]:
            best = (dist, j)
    return None if best is None else best[1]


def merge_state(dets, state_path, source):
    """Merge one archive's detections into the shared state file.

    The state file is shared by every archive (default data/review.json), so marks carry over:
      * a detection within MATCH_PX of a marked point that points the same way (±DIR_TOL) is the same
        end: it takes over that point's id and mark (ignored / done) with fresh position and score;
        more detections of that same end are dropped as duplicates
      * marked points not found in this archive are kept (present=False), so they still apply to
        other archives later
      * open points: same matching, id reused; open points no longer detected are dropped
    """
    now = datetime.now(timezone.utc).isoformat(timespec='seconds')
    state = {'points': []}
    if os.path.exists(state_path):
        state = json.load(open(state_path))
    old = state['points']
    marked = [p for p in old if p.get('status') in ('ignored', 'done')]
    opened = [p for p in old if p.get('status', 'open') == 'open']
    for m in marked:
        m.setdefault('marked_in', state.get('source'))
    mtree = cKDTree([[p['px'], p['py']] for p in marked]) if marked else None
    otree = cKDTree([[p['px'], p['py']] for p in opened]) if opened else None
    out, inherited, used, dup, reused = [], {}, set(), 0, 0
    for d in sorted(dets, key=lambda d: -d['score']):
        j = nearest(mtree, marked, d)
        if j is not None:
            if j in inherited:
                dup += 1                     # a second detection of an end the user already decided about
                continue
            m = marked[j]
            p = dict(id=m['id'], status=m['status'], first_seen=m.get('first_seen', now), last_seen=now, **d)
            p.update(marked_at=m.get('marked_at'), marked_in=m.get('marked_in'), present=True)
            inherited[j] = p
            out.append(p)
            continue
        k = nearest(otree, opened, d, used)
        if k is not None:
            used.add(k)
            pid, first_seen = opened[k]['id'], opened[k].get('first_seen', now)
            reused += 1
        else:
            pid, first_seen = str(uuid.uuid4()), now
        out.append(dict(id=pid, status='open', first_seen=first_seen, last_seen=now, **d))
    missing = [dict(m, present=False) for j, m in enumerate(marked) if j not in inherited]
    points = sorted(out + missing, key=lambda p: -p['score'])
    state = {'source': source, 'updated': now, 'points': points}
    os.makedirs(os.path.dirname(os.path.abspath(state_path)), exist_ok=True)
    tmp = state_path + '.tmp'
    json.dump(state, open(tmp, 'w'), ensure_ascii=False)
    os.replace(tmp, state_path)
    n_open = sum(p['status'] == 'open' for p in out)
    print(f'state: {n_open} open ({reused} kept id, {n_open - reused} new, {len(opened) - len(used)} no longer detected); '
          f'marks: {len(inherited)} carried over to this archive, {len(missing)} not in this archive (kept), '
          f'{dup} duplicate detections dropped -> {state_path}', file=sys.stderr)
    return state


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('zip')
    ap.add_argument('--state', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'review.json'))
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument('--raw', help='write per-window detections (before dedupe) to this JSON file')
    a = ap.parse_args()
    dets = detect(os.path.expanduser(a.zip), a.workers, a.raw)
    merge_state(dets, a.state, fogdec.archive_label(a.zip))


if __name__ == '__main__':
    main()
