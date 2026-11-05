/*
 * fog-store.js — 可编辑的迷雾存档：在内存里改「走过像素」，撤销/重做，导出回 Sync.zip。
 *
 * 写回格式（用真实存档 622 个区块 / 148682 个子瓦片逐一校验过）：
 *   区块文件 = zlib( 索引头 32768 字节 + n 条 515 字节记录 )，无尾随字节。
 *     索引头：128×128 个 uint16 小端，tileIdx = ty*128 + tx，值为记录号 1..n（连续），0 = 空。
 *     记录：512 字节位图（64 行 × 8 字节，高位在左）+ 3 字节大端整数 = 2 × 走过像素数 + 1。
 *   文件名 = md5(String(blockNo)).slice(0,4) + 表1(blockNo 各位) + 表2(blockNo % 100，两位)，
 *     blockNo = 512*by + bx，表1 = "olhwjsktri"，表2 = "eizxdwknmo"。
 *
 * 编辑操作都是矢量的（世界像素坐标，2^22 宽）：
 *   { type: 'erase', r, pts: [[x,y],...] }   半径 r 的胶囊链，清掉像素
 *   { type: 'line',  w, pts: [[x,y],...] }   线宽 w 的折线，置上像素
 * 每次操作返回按子瓦片记录的 diff（before/after），撤销/重做直接套 diff。
 * 导出时只重新编码改过的区块，其余 zip 条目原样拷贝（跳过 __MACOSX 与隐藏文件）。
 */
(function (global) {
  'use strict';

  var N = 512, BLOCK_PX = 8192, SUB = 64, IDX = 128, INDEX_BYTES = 32768, REC = 515, BITMAP = 512;
  var T1 = 'olhwjsktri', T2 = 'eizxdwknmo';
  var POP = new Uint8Array(256);
  for (var i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];

  // ---------- MD5（只用于文件名前缀；ASCII 输入）----------
  var MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  var MD5_K = [];
  for (i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  function md5hex(str) {
    var bytes = [], j;
    for (j = 0; j < str.length; j++) bytes.push(str.charCodeAt(j) & 255);
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (j = 0; j < 8; j++) bytes.push(j < 4 ? (bitLen >>> (8 * j)) & 255 : 0);
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (var off = 0; off < bytes.length; off += 64) {
      var M = [];
      for (j = 0; j < 16; j++) {
        var p = off + 4 * j;
        M[j] = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      }
      var A = a0, B = b0, C = c0, D = d0;
      for (j = 0; j < 64; j++) {
        var F, g, r = j >> 4;
        if (r === 0) { F = (B & C) | (~B & D); g = j; }
        else if (r === 1) { F = (D & B) | (~D & C); g = (5 * j + 1) % 16; }
        else if (r === 2) { F = B ^ C ^ D; g = (3 * j + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * j) % 16; }
        F = (F + A + MD5_K[j] + M[g]) | 0;
        A = D; D = C; C = B;
        var s = MD5_S[r * 4 + (j & 3)];
        B = (B + ((F << s) | (F >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    var hex = '';
    [a0, b0, c0, d0].forEach(function (w) {
      for (var k = 0; k < 4; k++) hex += ('0' + ((w >>> (8 * k)) & 255).toString(16)).slice(-2);
    });
    return hex;
  }

  function blockFilename(blockNo) {
    var s = String(blockNo), c = ('0' + (blockNo % 100)).slice(-2), out = md5hex(s).slice(0, 4), k;
    for (k = 0; k < s.length; k++) out += T1.charAt(+s.charAt(k));
    for (k = 0; k < 2; k++) out += T2.charAt(+c.charAt(k));
    return out;
  }

  async function deflateZlib(bytes) {
    var cs = new CompressionStream('deflate'); // zlib 包装 (RFC1950)
    var stream = new Response(bytes).body.pipeThrough(cs);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------- 单个区块 ----------
  function BlockState(blockNo, path) {
    this.blockNo = blockNo;
    this.bx = blockNo % N;
    this.by = Math.floor(blockNo / N);
    this.path = path;            // 原 zip 里的路径；新建区块为 null
    this.tiles = new Map();      // tileIdx -> Uint8Array(512)
    this.order = [];             // 记录顺序（保持原顺序，新子瓦片追加在后）
    this.inOrder = new Set();
    this.dirty = false;
  }
  BlockState.fromData = function (blockNo, path, data) {
    var st = new BlockState(blockNo, path), byRec = [];
    for (var t = 0; t < IDX * IDX; t++) {
      var n = data[2 * t] | (data[2 * t + 1] << 8);
      if (n) byRec.push([n, t]);
    }
    byRec.sort(function (a, b) { return a[0] - b[0]; });
    byRec.forEach(function (e) {
      var base = INDEX_BYTES + REC * (e[0] - 1);
      st.tiles.set(e[1], data.slice(base, base + BITMAP));
      st.order.push(e[1]); st.inOrder.add(e[1]);
    });
    return st;
  };
  BlockState.prototype.setTile = function (tileIdx, bits) {
    if (bits) {
      this.tiles.set(tileIdx, bits);
      if (!this.inOrder.has(tileIdx)) { this.order.push(tileIdx); this.inOrder.add(tileIdx); }
    } else {
      this.tiles.delete(tileIdx);
    }
    this.dirty = true;
  };
  BlockState.prototype.encode = function () {
    var self = this, order = this.order.filter(function (t) { return self.tiles.has(t); });
    var out = new Uint8Array(INDEX_BYTES + REC * order.length);
    order.forEach(function (t, k) {
      var n = k + 1, base = INDEX_BYTES + REC * k, bits = self.tiles.get(t), pop = 0;
      out[2 * t] = n & 255; out[2 * t + 1] = n >> 8;
      out.set(bits, base);
      for (var j = 0; j < BITMAP; j++) pop += POP[bits[j]];
      var v = 2 * pop + 1;
      out[base + 512] = (v >>> 16) & 255; out[base + 513] = (v >>> 8) & 255; out[base + 514] = v & 255;
    });
    return out;
  };
  // 与 decoder.js 的 block 接口一致，供 fog-layer 渲染
  BlockState.prototype.forEachSetPixelInRect = function (x0, y0, x1, y1, cb) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(BLOCK_PX, Math.ceil(x1)); y1 = Math.min(BLOCK_PX, Math.ceil(y1));
    if (x0 >= x1 || y0 >= y1) return;
    var tx0 = (x0 / SUB) | 0, tx1 = ((x1 - 1) / SUB) | 0, ty0 = (y0 / SUB) | 0, ty1 = ((y1 - 1) / SUB) | 0;
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        var bits = this.tiles.get(ty * IDX + tx);
        if (!bits) continue;
        var ox = tx * SUB, oy = ty * SUB;
        for (var by = 0; by < SUB; by++) {
          var y = oy + by;
          if (y < y0 || y >= y1) continue;
          for (var bb = 0; bb < 8; bb++) {
            var b = bits[by * 8 + bb];
            if (!b) continue;
            for (var bit = 0; bit < 8; bit++) {
              if (b & (128 >> bit)) {
                var x = ox + bb * 8 + bit;
                if (x >= x0 && x < x1) cb(x, y);
              }
            }
          }
        }
      }
    }
  };

  // ---------- 几何 ----------
  function segDist2(px, py, s) {
    var ax = s[0], ay = s[1], dx = s[2] - ax, dy = s[3] - ay, L = dx * dx + dy * dy, t = 0;
    if (L > 0) { t = ((px - ax) * dx + (py - ay) * dy) / L; t = t < 0 ? 0 : t > 1 ? 1 : t; }
    var ex = ax + t * dx - px, ey = ay + t * dy - py;
    return ex * ex + ey * ey;
  }
  function ptsToSegs(pts) {
    var segs = [];
    if (pts.length === 1) segs.push([pts[0][0], pts[0][1], pts[0][0], pts[0][1]]);
    for (var k = 1; k < pts.length; k++) segs.push([pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]]);
    return segs;
  }

  // 1px 细线（画笔）：每段沿主轴每走一个像素恰好取一个像素（同 Bresenham），像素 = 线在该列/行中心处
  // 所在的那一格。check_export.py 用同一个公式（同样的浮点运算顺序）独立重放。
  var WORLD = N * IDX * SUB;
  function thinLinePixels(pts) {
    var out = new Map();
    function add(x, y) { out.set(y * WORLD + x, [x, y]); }
    if (pts.length === 1) add(Math.floor(pts[0][0]), Math.floor(pts[0][1]));
    for (var k = 1; k < pts.length; k++) {
      var ax = pts[k - 1][0], ay = pts[k - 1][1], cx = pts[k][0], cy = pts[k][1], dx = cx - ax, dy = cy - ay, i;
      if (dx === 0 && dy === 0) { add(Math.floor(ax), Math.floor(ay)); continue; }
      if (Math.abs(dx) >= Math.abs(dy)) {
        for (i = Math.floor(Math.min(ax, cx)); i <= Math.floor(Math.max(ax, cx)); i++) add(i, Math.floor(ay + (i + 0.5 - ax) * dy / dx));
      } else {
        for (i = Math.floor(Math.min(ay, cy)); i <= Math.floor(Math.max(ay, cy)); i++) add(Math.floor(ax + (i + 0.5 - ay) * dx / dy), i);
      }
    }
    return Array.from(out.values());
  }

  // ---------- 存档 ----------
  function createStore(archive) {
    var loading = new Map();   // blockNo -> Promise<BlockState|null>
    var loaded = new Map();    // blockNo -> BlockState

    function load(blockNo) {
      if (!loading.has(blockNo)) {
        var path = archive.pathForBlock(blockNo);
        var p = !path ? Promise.resolve(null) :
          archive.rawBytes(path).then(global.FogDecoder.inflateZlib).then(function (data) {
            var st = BlockState.fromData(blockNo, path, data);
            loaded.set(blockNo, st);
            return st;
          });
        loading.set(blockNo, p);
      }
      return loading.get(blockNo);
    }
    async function loadOrCreate(blockNo) {
      var st = await load(blockNo);
      if (!st) {
        st = loaded.get(blockNo);
        if (!st) {
          st = new BlockState(blockNo, null);
          loaded.set(blockNo, st);
          loading.set(blockNo, Promise.resolve(st));
        }
      }
      return st;
    }

    function newDiff() { return { entries: new Map(), rect: null }; }
    function growRect(diff, x0, y0, x1, y1) {
      var r = diff.rect;
      diff.rect = r ? [Math.min(r[0], x0), Math.min(r[1], y0), Math.max(r[2], x1), Math.max(r[3], y1)] : [x0, y0, x1, y1];
    }

    // 把胶囊链 (segs, 半径 r) 覆盖的像素设为 value（1 画 / 0 擦），改动并入 diff。
    async function paint(segs, r, value, diff) {
      var r2 = r * r, cand = new Map(), reach = r + SUB * 0.7072;
      segs.forEach(function (s) {
        var sx0 = Math.floor((Math.min(s[0], s[2]) - r) / SUB), sx1 = Math.floor((Math.max(s[0], s[2]) + r) / SUB);
        var sy0 = Math.floor((Math.min(s[1], s[3]) - r) / SUB), sy1 = Math.floor((Math.max(s[1], s[3]) + r) / SUB);
        for (var wy = sy0; wy <= sy1; wy++) {
          for (var wx = sx0; wx <= sx1; wx++) {
            if (wx < 0 || wy < 0 || wx >= N * IDX || wy >= N * IDX) continue;
            if (segDist2((wx + 0.5) * SUB, (wy + 0.5) * SUB, s) > reach * reach) continue;
            var key = wy * N * IDX + wx;
            if (!cand.has(key)) cand.set(key, []);
            cand.get(key).push(s);
          }
        }
      });
      var changed = 0;
      for (var entry of cand) {
        var key = entry[0], ss = entry[1];
        var wx = key % (N * IDX), wy = Math.floor(key / (N * IDX));
        if (await editTile(wx, wy, value, diff, function (set, ox, oy) {
          for (var yy = 0; yy < SUB; yy++) {
            for (var xx = 0; xx < SUB; xx++) {
              var px = ox + xx + 0.5, py = oy + yy + 0.5;
              for (var k = 0; k < ss.length; k++) if (segDist2(px, py, ss[k]) <= r2) { set(xx, yy); break; }
            }
          }
        })) changed++;
      }
      return changed;
    }

    // 把给定的世界像素设为 value，改动并入 diff
    async function paintPixels(pixels, value, diff) {
      var bySub = new Map(), changed = 0;
      pixels.forEach(function (p) {
        if (p[0] < 0 || p[1] < 0 || p[0] >= WORLD || p[1] >= WORLD) return;
        var key = Math.floor(p[1] / SUB) * N * IDX + Math.floor(p[0] / SUB);
        if (!bySub.has(key)) bySub.set(key, []);
        bySub.get(key).push(p);
      });
      for (var entry of bySub) {
        var key = entry[0], ps = entry[1];
        var wx = key % (N * IDX), wy = Math.floor(key / (N * IDX));
        if (await editTile(wx, wy, value, diff, function (set, ox, oy) {
          ps.forEach(function (p) { set(p[0] - ox, p[1] - oy); });
        })) changed++;
      }
      return changed;
    }

    // 改一个子瓦片：fill(set, ox, oy) 对要改的像素调用 set(局部x, 局部y)；有变化则写回并记 diff
    async function editTile(wx, wy, value, diff, fill) {
      var blockNo = (wy >> 7) * N + (wx >> 7), tileIdx = (wy & 127) * IDX + (wx & 127);
      var st = value ? await loadOrCreate(blockNo) : await load(blockNo);
      if (!st) return false;
      var cur = st.tiles.get(tileIdx);
      if (!cur && !value) return false;
      var bits = cur ? cur.slice() : new Uint8Array(BITMAP), hit = false;
      var ox = wx * SUB, oy = wy * SUB;
      fill(function (xx, yy) {
        var bi = yy * 8 + (xx >> 3), m = 128 >> (xx & 7);
        if (value ? !(bits[bi] & m) : (bits[bi] & m)) { bits[bi] ^= m; hit = true; }
      }, ox, oy);
      if (!hit) return false;
      var dkey = blockNo * IDX * IDX + tileIdx;
      if (!diff.entries.has(dkey)) diff.entries.set(dkey, { blockNo: blockNo, tileIdx: tileIdx, before: cur || null, after: null });
      var empty = true;
      for (var j = 0; j < BITMAP; j++) if (bits[j]) { empty = false; break; }
      st.setTile(tileIdx, empty ? null : bits);
      diff.entries.get(dkey).after = empty ? null : bits;
      growRect(diff, ox, oy, ox + SUB, oy + SUB);
      return true;
    }

    async function applyOp(op, diff) {
      diff = diff || newDiff();
      if (op.type === 'erase') await paint(ptsToSegs(op.pts), op.r, 0, diff);
      else if (op.type === 'line' && op.w <= 1) await paintPixels(thinLinePixels(op.pts), 1, diff);   // 画笔：1px 细线
      else if (op.type === 'line') await paint(ptsToSegs(op.pts), op.w / 2, 1, diff);                 // 旧版粗线
      else throw new Error('unknown op ' + op.type);
      return diff;
    }

    // 撤销：which='before'；重做（套已有 diff）：which='after'
    async function applyDiff(diff, which) {
      for (var e of diff.entries.values()) {
        var st = await loadOrCreate(e.blockNo), v = e[which];
        st.setTile(e.tileIdx, v ? v.slice() : null);
      }
    }

    function blocksOf(blockNo) {
      return archive.entries.filter(function (e) { return e.blockNo === blockNo; });
    }

    // 导出：返回 { blob(或 uint8array), summary }
    async function exportZip(type) {
      var JSZipCtor = global.JSZip, out = new JSZipCtor();
      var dirty = [];
      loaded.forEach(function (st) { if (st.dirty) dirty.push(st); });
      var dirtyNos = new Set(dirty.map(function (s) { return s.blockNo; }));
      var prefix = 'Sync/';
      archive.entries.forEach(function (e) { if (e.blockNo !== null) prefix = e.path.slice(0, e.path.length - e.name.length); });
      var copied = 0, summary = { changed: 0, created: 0, emptied: 0, copied: 0, skipped: [] };
      for (var k = 0; k < archive.entries.length; k++) {
        var e = archive.entries[k];
        if (/(^|\/)__MACOSX\//.test(e.path)) { summary.skipped.push(e.path); continue; }
        if (e.blockNo !== null && dirtyNos.has(e.blockNo)) continue;   // 改过的区块下面重写
        out.file(e.path, await archive.rawBytes(e.path), { binary: true });
        copied++;
      }
      summary.copied = copied;
      for (k = 0; k < dirty.length; k++) {
        var st = dirty[k];
        var path = st.path || (prefix + blockFilename(st.blockNo));
        // 整块擦空：不写这个文件（与 App 同步文件夹里看到的一致：被擦空的区块，文件直接没有了）
        if (!st.tiles.size) { if (st.path) summary.emptied++; continue; }
        out.file(path, await deflateZlib(st.encode()), { binary: true });
        if (!st.path) summary.created++;
        else summary.changed++;
        if (st.path && blocksOf(st.blockNo).length > 1) summary.skipped.push('(重复副本) ' + st.blockNo);
      }
      var data = await out.generateAsync({ type: type || 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      return { data: data, summary: summary };
    }

    return {
      load: load,                 // 渲染用：Promise<BlockState|null>
      getBlock: load,
      peek: function (blockNo) { return loaded.get(blockNo) || null; },   // 同步：已载入的区块（吸附用）
      // 载入全部区块（含编辑后新建的），返回 BlockState 数组：检测用
      loadAll: async function (onProgress) {
        var nos = Object.keys(archive.byBlockNo).map(Number);
        for (var i = 0; i < nos.length; i++) {
          await load(nos[i]);
          if (onProgress && i % 20 === 0) onProgress(i, nos.length);
        }
        return Array.from(loaded.values());
      },
      applyOp: applyOp,
      applyDiff: applyDiff,
      newDiff: newDiff,
      paintSegment: function (seg, r, value, diff) { return paint([seg], r, value, diff); },
      exportZip: exportZip,
      dirtyCount: function () { var n = 0; loaded.forEach(function (s) { if (s.dirty) n++; }); return n; },
    };
  }

  global.FogStore = {
    create: createStore,
    blockFilename: blockFilename,
    md5hex: md5hex,
    deflateZlib: deflateZlib,
    thinLinePixels: thinLinePixels,
  };
})(typeof window !== 'undefined' ? window : globalThis);
