"""Verify an edited Sync.zip before importing it into Fog of World.

Usage:
    python3 tools/check_export.py ORIGINAL.zip EDITED.zip [--ops data/edits/<name>.json]

Checks (stdlib + numpy):
  * ORIGINAL / EDITED can each be a Sync.zip or the app's Sync folder
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
        for i in z.infolist():
            f = i.filename.rsplit('/', 1)[-1]
            if i.is_dir() or '__MACOSX/' in i.filename or not f or f.startswith('.'):
                continue
            n = block_no(f)
            if n is not None:
                out[n] = (f, z.read(i))
    return out


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
    if errors:
        print('FAIL'); [print('  ' + e) for e in errors[:30]]
        sys.exit(1)
    print('OK: export is well-formed' + (' and matches the edit log' if ops else ''))


if __name__ == '__main__':
    main()
