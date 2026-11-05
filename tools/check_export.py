"""Verify an edited Sync.zip before importing it into Fog of World.

Usage:
    python3 tools/check_export.py ORIGINAL.zip EDITED.zip [--ops data/edits/<name>.json]

Checks (stdlib + numpy):
  * ORIGINAL / EDITED can each be a Sync.zip, the app's Sync folder, or an app snapshot (.fwss)
  * snapshots: for every changed block, Model/# (index + per-subtile 3-byte counts) and every Model/~ pyramid
    ancestor (level L pixel = OR of 2x2 pixels of level L-1) must match the edited Model/* exactly
  * every block file in EDITED is well-formed: zlib, index values 1..n contiguous, exact length,
    per-subtile trailer == 2*popcount+1 (big-endian 24-bit), filename == md5/table encoding of its block number
  * blocks not touched by edits are byte-identical to ORIGINAL; a missing block must have been erased to empty
  * reports per changed block how many pixels were added / removed
  * with --ops (the edit log): replays the ops independently (erase capsules -> 0, 1px pen lines /
    older thick line capsules -> 1) and compares pixel by pixel; no pixel outside the edits changed
"""
import argparse, hashlib, json, math, os, sys, zipfile, zlib
import numpy as np

T1, T2 = 'olhwjsktri', 'eizxdwknmo'
IDX, SUB, INDEX_BYTES, REC = 128, 64, 32768, 515


def expected_name(n):
    s, c = str(n), '%02d' % (n % 100)
    return hashlib.md5(s.encode()).hexdigest()[:4] + ''.join(T1[int(d)] for d in s) + ''.join(T2[int(d)] for d in c)


def block_no(name):
    core = name.split(' ')[0]
    try:
        return int(''.join(str(T1.index(c)) for c in core[4:-2]))
    except ValueError:
        return None


def blocks(path):
    """{block number: (file name, raw bytes)} of a Sync.zip or a Sync folder."""
    out = {}
    if os.path.isdir(path):
        for f in sorted(os.listdir(path)):
            n = None if f.startswith('.') else block_no(f)
            if n is not None and os.path.isfile(os.path.join(path, f)):
                out[n] = (f, open(os.path.join(path, f), 'rb').read())
        return out
    with zipfile.ZipFile(path) as z:
        snapshot = any(n.startswith('Model/*/') for n in z.namelist())
        for i in z.infolist():
            f = i.filename.rsplit('/', 1)[-1]
            if i.is_dir() or '__MACOSX/' in i.filename or not f or f.startswith('.'):
                continue
            if snapshot and not i.filename.startswith('Model/*/'):
                continue
            n = block_no(f)
            if n is not None:
                out[n] = (f, z.read(i))
    return out


def layer_name(n, k):
    m = n + k
    return hashlib.md5(str(m).encode()).hexdigest()[:4] + ''.join(T1[int(d)] for d in str(n)) + ''.join(T2[int(c)] for c in '%02d' % (m % 100))


def layer_files(path):
    """{'#': {name: raw}, '~': {name: raw}} of a snapshot zip; None for anything else."""
    if os.path.isdir(path):
        return None
    with zipfile.ZipFile(path) as z:
        if not any(n.startswith('Model/*/') for n in z.namelist()):
            return None
        out = {'#': {}, '~': {}}
        for i in z.infolist():
            parts = i.filename.split('/')
            if len(parts) == 3 and parts[0] == 'Model' and parts[1] in out:
                out[parts[1]][parts[2]] = z.read(i)
        return out


def inflate(raw):
    try:
        return zlib.decompress(raw)
    except zlib.error:
        return raw          # Model/# keeps emptied blocks as a bare (uncompressed) zero index


def records(d, size, length):
    """{tile index: bytes} of a block file (records of `size` bytes, first `length` of each)."""
    idx = np.frombuffer(d[:INDEX_BYTES], '<u2')
    return {int(t): d[INDEX_BYTES + size * (int(idx[t]) - 1): INDEX_BYTES + size * (int(idx[t]) - 1) + length] for t in np.nonzero(idx)[0]}


def check_snapshot(B, layers, touched, errors):
    """Model/# and Model/~ of the edited snapshot must match its Model/* for every touched block."""
    ok_hash = 0
    for n in touched:
        name = layer_name(n, 74)
        if name not in layers['#']:
            errors.append(f'block {n}: Model/#/{name} missing'); continue
        h = inflate(layers['#'][name])
        if n in B:
            d = zlib.decompress(B[n][1])
            want = {t: r[512:515] for t, r in records(d, REC, REC).items()}
        else:
            want = {}
        got = records(h, 3, 3) if len(h) >= INDEX_BYTES else None
        if got != want:
            errors.append(f'block {n}: Model/#/{name} does not match Model/*'); continue
        ok_hash += 1
    # pyramid from the edited Model/*: level L subtile (sx, sy) -> 64x64 bool
    lvl = {}
    for n, (f, raw) in B.items():
        d = zlib.decompress(raw)
        bx, by = n % 512, n // 512
        for t, r in records(d, REC, 512).items():
            if any(r):
                lvl[(bx * 128 + t % 128, by * 128 + t // 128)] = np.unpackbits(np.frombuffer(r, np.uint8)).reshape(64, 64).astype(bool)
    ok_tilde = 0
    for L in range(1, 16):
        nxt = {}
        for (sx, sy), bm in lvl.items():
            cur = nxt.setdefault((sx // 2, sy // 2), np.zeros((64, 64), bool))
            ox, oy = (sx % 2) * 32, (sy % 2) * 32
            cur[oy:oy + 32, ox:ox + 32] |= bm.reshape(32, 2, 32, 2).any(axis=(1, 3))
        lvl = {k: v for k, v in nxt.items() if v.any()}
        for X, Y in sorted({(n % 512 >> L, n // 512 >> L) for n in touched}):
            g = 2 ** max(0, 9 - L)
            name = layer_name(Y * g + X, L)
            want = {(ty * 128 + tx): lvl[(X * 128 + tx, Y * 128 + ty)] for tx in range(128) for ty in range(128) if (X * 128 + tx, Y * 128 + ty) in lvl}
            if name not in layers['~']:
                if want:
                    errors.append(f'level {L} block ({X},{Y}): Model/~/{name} missing')
                continue
            got = {t: np.unpackbits(np.frombuffer(r, np.uint8)).reshape(64, 64).astype(bool)
                   for t, r in records(zlib.decompress(layers['~'][name]), 512, 512).items() if any(r)}
            if set(got) != set(want) or any(not np.array_equal(got[t], want[t]) for t in want):
                errors.append(f'level {L} block ({X},{Y}): Model/~/{name} does not match the pyramid of Model/*')
                continue
            ok_tilde += 1
    print(f'snapshot: Model/# ok for {ok_hash}/{len(touched)} changed blocks, Model/~ ok for {ok_tilde} pyramid blocks')


def parse(raw, errors, label):
    d = zlib.decompress(raw)
    idx = np.frombuffer(d[:INDEX_BYTES], '<u2').reshape(IDX, IDX)
    nums = idx[idx > 0]
    n = len(nums)
    if sorted(nums.tolist()) != list(range(1, n + 1)):
        errors.append(f'{label}: index not contiguous 1..n')
    if len(d) != INDEX_BYTES + REC * n:
        errors.append(f'{label}: length {len(d)} != {INDEX_BYTES + REC * n}')
    bm = np.zeros((IDX * SUB, IDX * SUB), bool)
    for ty, tx in zip(*np.nonzero(idx)):
        k = int(idx[ty, tx])
        rec = d[INDEX_BYTES + REC * (k - 1):INDEX_BYTES + REC * k]
        bits = np.unpackbits(np.frombuffer(rec[:512], np.uint8)).reshape(SUB, SUB)
        v = (rec[512] << 16) | (rec[513] << 8) | rec[514]
        if v != 2 * int(bits.sum()) + 1:
            errors.append(f'{label}: subtile ({tx},{ty}) trailer {v} != 2*{int(bits.sum())}+1')
        bm[ty * SUB:(ty + 1) * SUB, tx * SUB:(tx + 1) * SUB] = bits.astype(bool)
    return bm


def capsule_mask(bn, segs, r):
    """bool mask (8192²) of pixels whose centre is within r of any segment, in block bn."""
    bx, by = bn % 512, bn // 512
    ox, oy = bx * 8192, by * 8192
    m = np.zeros((8192, 8192), bool)
    for ax, ay, cx, cy in segs:
        x0, x1 = int(max(min(ax, cx) - r - 1 - ox, 0)), int(min(max(ax, cx) + r + 2 - ox, 8192))
        y0, y1 = int(max(min(ay, cy) - r - 1 - oy, 0)), int(min(max(ay, cy) + r + 2 - oy, 8192))
        if x0 >= x1 or y0 >= y1:
            continue
        X, Y = np.meshgrid(np.arange(x0, x1) + ox + 0.5, np.arange(y0, y1) + oy + 0.5)
        dx, dy = cx - ax, cy - ay
        L = dx * dx + dy * dy
        t = np.clip(((X - ax) * dx + (Y - ay) * dy) / L, 0, 1) if L else 0
        d2 = (ax + t * dx - X) ** 2 + (ay + t * dy - Y) ** 2
        m[y0:y1, x0:x1] |= d2 <= r * r
    return m


def thin_mask(bn, pts):
    """bool mask (8192²) of a 1px pen line in block bn: one pixel per step along the major axis,
    the pixel the line passes through at that column / row centre (same arithmetic as fog-store.js)."""
    bx, by = bn % 512, bn // 512
    ox, oy = bx * 8192, by * 8192
    m = np.zeros((8192, 8192), bool)
    px = []
    if len(pts) == 1:
        px.append((math.floor(pts[0][0]), math.floor(pts[0][1])))
    for (ax, ay), (cx, cy) in zip(pts, pts[1:]):
        dx, dy = cx - ax, cy - ay
        if dx == 0 and dy == 0:
            px.append((math.floor(ax), math.floor(ay)))
        elif abs(dx) >= abs(dy):
            for i in range(math.floor(min(ax, cx)), math.floor(max(ax, cx)) + 1):
                px.append((i, math.floor(ay + (i + 0.5 - ax) * dy / dx)))
        else:
            for i in range(math.floor(min(ay, cy)), math.floor(max(ay, cy)) + 1):
                px.append((math.floor(ax + (i + 0.5 - ay) * dx / dy), i))
    for x, y in px:
        if ox <= x < ox + 8192 and oy <= y < oy + 8192:
            m[y - oy, x - ox] = True
    return m


def segs_of(pts):
    if len(pts) == 1:
        return [(pts[0][0], pts[0][1], pts[0][0], pts[0][1])]
    return [(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) for i in range(1, len(pts))]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('original')
    ap.add_argument('edited')
    ap.add_argument('--ops')
    a = ap.parse_args()
    A, B = blocks(os.path.expanduser(a.original)), blocks(os.path.expanduser(a.edited))
    errors = []
    for n, (f, raw) in B.items():
        if f.split(' ')[0] != expected_name(n):
            errors.append(f'block {n}: filename {f} != {expected_name(n)}')
    same = [n for n in B if n in A and A[n][1] == B[n][1]]
    changed = [n for n in B if n in A and A[n][1] != B[n][1]]
    created = [n for n in B if n not in A]
    removed = [n for n in A if n not in B]
    print(f'blocks: {len(same)} byte-identical, {len(changed)} changed, {len(created)} new, {len(removed)} missing')
    ops = None
    if a.ops:
        doc = json.load(open(a.ops))
        ops = doc if isinstance(doc, list) else doc['ops'][:doc.get('ptr', len(doc['ops']))]
    for n in changed + created:
        after = parse(B[n][1], errors, f'block {n}')
        before = parse(A[n][1], errors, f'orig {n}') if n in A else np.zeros_like(after)
        add, rem = int((after & ~before).sum()), int((before & ~after).sum())
        print(f'  block {n} ({n % 512},{n // 512}) {"new " if n in created else ""}+{add} -{rem} px')
        if ops is not None:
            # replay ops in order on `before` with numpy and compare exactly
            exp = before.copy()
            touched = np.zeros_like(exp)
            for op in ops:
                if op['type'] == 'line' and op['w'] <= 1:
                    m = thin_mask(n, op['pts'])            # 1px pen line
                else:
                    r = op['r'] if op['type'] == 'erase' else op['w'] / 2
                    m = capsule_mask(n, segs_of(op['pts']), r)
                touched |= m
                exp = (exp & ~m) if op['type'] == 'erase' else (exp | m)
            # pen pixels only matter inside subtiles; erase can't create; compare everywhere
            diff = int((exp != after).sum())
            outside = int(((before != after) & ~touched).sum())
            print(f'    ops replay mismatch: {diff} px, changes outside edit area: {outside} px')
            if diff or outside:
                errors.append(f'block {n}: ops replay mismatch {diff}, outside {outside}')
    for n in removed:
        # a block erased to nothing is left out (the app does the same); with --ops make sure that's what happened
        if ops is None:
            print(f'  block {n} ({n % 512},{n // 512}) removed (all {int(parse(A[n][1], errors, f"orig {n}").sum())} px gone)')
            continue
        before = parse(A[n][1], errors, f'orig {n}')
        exp = before.copy()
        for op in ops:
            if op['type'] == 'erase':
                exp &= ~capsule_mask(n, segs_of(op['pts']), op['r'])
            elif op['w'] <= 1:
                exp |= thin_mask(n, op['pts'])
            else:
                exp |= capsule_mask(n, segs_of(op['pts']), op['w'] / 2)
        left = int(exp.sum())
        print(f'  block {n} ({n % 512},{n // 512}) removed: erased to empty' + (f' -- but replay leaves {left} px!' if left else ''))
        if left:
            errors.append(f'block {n} missing from export but the edit log leaves {left} px in it')
    layers = layer_files(os.path.expanduser(a.edited))
    if layers is not None:
        check_snapshot(B, layers, changed + created + removed, errors)
    if errors:
        print('FAIL'); [print('  ' + e) for e in errors[:30]]
        sys.exit(1)
    print('OK: export is well-formed' + (' and matches the edit log' if ops else ''))


if __name__ == '__main__':
    main()
