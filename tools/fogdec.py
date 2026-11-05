"""Fog of World Sync.zip decoder (same format as ../src/decoder.js).

An archive is either a Sync.zip or the app's Sync folder itself
(iCloud: ~/Library/Mobile Documents/iCloud~com~ollix~FogOfWorld/Documents/Sync). Folders are only read.
"""
import os, zipfile, zlib, math
import numpy as np

T1 = 'olhwjsktri'
WORLD_PX = 1 << 22  # world bitmap side; equals OSM zoom 14 at 256px tiles
SUB = 64            # subtile px
IDX = 128           # subtiles per block side


def decode_filename(name):
    core = name.split(' ')[0]
    if len(core) < 7:
        return None
    digits = core[4:-2]
    try:
        n = int(''.join(str(T1.index(c)) for c in digits))
    except ValueError:
        return None
    x, y = n % 512, n // 512
    if not (0 <= x < 512 and 0 <= y < 512):
        return None
    return x, y


def archive_label(path):
    """short name of an archive, used as the state 'source' and to key the edit log."""
    path = os.path.abspath(os.path.expanduser(path))
    if os.path.isdir(path):
        return 'iCloud Sync' if 'iCloud~com~ollix~FogOfWorld' in path else os.path.basename(path.rstrip('/')) + '/'
    return os.path.basename(path)


def iter_files(path):
    """yield (name, raw bytes) for every block file of a Sync.zip or a Sync folder."""
    path = os.path.expanduser(path)
    if os.path.isdir(path):
        for name in sorted(os.listdir(path)):
            f = os.path.join(path, name)
            if name.startswith('.') or not os.path.isfile(f) or decode_filename(name) is None:
                continue
            with open(f, 'rb') as fh:
                yield name, fh.read()
        return
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            name = info.filename.rsplit('/', 1)[-1]
            if info.is_dir() or '__MACOSX/' in info.filename or not name or name.startswith('.'):
                continue
            if decode_filename(name) is None:
                continue
            yield name, z.read(info)


def load_subtiles(path, packed=False):
    """Return {(wsx, wsy): bitmap} in world-subtile coords (2^16 grid).

    packed=False -> 64x64 bool arrays; packed=True -> 512-byte uint8 rows (unpack with unpack()).
    """
    out = {}
    for name, blob in iter_files(path):
        bx, by = decode_filename(name)
        data = zlib.decompress(blob)
        index = np.frombuffer(data[:IDX * IDX * 2], dtype='<u2').reshape(IDX, IDX)  # [ty, tx]
        for ty, tx in zip(*np.nonzero(index)):
            n = int(index[ty, tx])
            base = IDX * IDX * 2 + 515 * (n - 1)
            raw = np.frombuffer(data[base:base + 512], dtype=np.uint8)
            if not raw.any():
                continue
            key = (bx * IDX + int(tx), by * IDX + int(ty))
            if key in out:
                out[key] = out[key] | (raw if packed else unpack(raw))
            else:
                out[key] = raw.copy() if packed else unpack(raw)
    return out


def unpack(raw):
    return np.unpackbits(raw).reshape(SUB, SUB).astype(bool)


def px_to_lnglat(px, py):
    lng = px / WORLD_PX * 360.0 - 180.0
    n = math.pi - 2 * math.pi * py / WORLD_PX
    lat = math.degrees(math.atan(math.sinh(n)))
    return lng, lat


def lnglat_to_px(lng, lat):
    x = (lng + 180) / 360 * WORLD_PX
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * WORLD_PX
    return x, y


def meters_per_px(lat):
    return 40075016.686 * math.cos(math.radians(lat)) / WORLD_PX
