/*
 * snapshot.js — App 快照（.fwss）的派生图层：改了 Model/* 之后，同步更新 Model/# 和 Model/~。
 *
 * .fwss 是一个 zip，里面三层，文件都是 zlib 压缩的区块（前 32768 字节是 128×128 的 uint16 索引）：
 *   Model/*  轨迹本身，与 Sync 文件夹完全相同（每个子瓦片 515 字节 = 512 字节位图 + 3 字节 2×像素数+1）
 *   Model/#  每个区块的统计：同一份索引 + 每个子瓦片 3 字节（就是 * 的尾 3 字节）；区块被擦空后是 32768 字节全 0（不压缩）
 *   Model/~  缩放金字塔：第 L 层（1–15）每个像素 = 第 L-1 层 2×2 个像素的 OR；第 0 层就是 *。
 *            每层世界 2^(22-L) 像素，区块仍是 8192 像素，每个子瓦片 512 字节（只有位图）
 * 文件名都是 md5(m)[:4] + 表1(n) + 表2(m % 100 两位)，m = n + k：
 *   *：n = 区块号，k = 0；#：n = 区块号，k = 74；~：n = 该层的区块号（Y × 每行区块数 + X），k = 层号 L
 * 这些规律都用真实快照逐字节核对过（tools/check_export.py 会验证导出的快照）。
 */
(function (global) {
  'use strict';

  var T1 = 'olhwjsktri', T2 = 'eizxdwknmo';
  var IDX = 128, INDEX_BYTES = 32768, BITMAP = 512, REC = 515, SUBS = 65536, LEVELS = 15;
  var HASH_K = 74;

  function layerName(n, k) {
    var m = n + k, s = String(n), out = global.FogStore.md5hex(String(m)).slice(0, 4);
    for (var i = 0; i < s.length; i++) out += T1[+s[i]];
    var t = ('0' + (m % 100)).slice(-2);
    return out + T2[+t[0]] + T2[+t[1]];
  }

  // 半分辨率查表：一个字节的 8 个像素 → 4 个像素（相邻两个 OR），高位在前
  var HALF = new Uint8Array(256);
  for (var b = 0; b < 256; b++) {
    var v = 0;
    for (var i = 0; i < 4; i++) if ((b >> (6 - 2 * i)) & 3) v |= 8 >> i;
    HALF[b] = v;
  }
  // 把 src（64×64）缩成 32×32，OR 到 dst 的 (qx, qy) 象限
  function downInto(dst, src, qx, qy) {
    for (var r = 0; r < 32; r++) {
      var a = 2 * r * 8, c = a + 8, o = (qy * 32 + r) * 8 + qx * 4;
      for (var j = 0; j < 4; j++) {
        dst[o + j] |= (HALF[src[a + 2 * j] | src[c + 2 * j]] << 4) | HALF[src[a + 2 * j + 1] | src[c + 2 * j + 1]];
      }
    }
  }

  // 全部区块 → 金字塔：levels[L] = Map(sy * 65536 + sx → 512 字节位图)
  function pyramid(blocks) {
    var cur = new Map();
    blocks.forEach(function (st) {
      st.tiles.forEach(function (bits, t) {
        cur.set((st.by * IDX + (t >> 7)) * SUBS + st.bx * IDX + (t & 127), bits);
      });
    });
    var levels = [cur];
    for (var L = 1; L <= LEVELS; L++) {
      var next = new Map();
      cur.forEach(function (bits, key) {
        var sx = key % SUBS, sy = Math.floor(key / SUBS), pk = (sy >> 1) * SUBS + (sx >> 1);
        var d = next.get(pk);
        if (!d) { d = new Uint8Array(BITMAP); next.set(pk, d); }
        downInto(d, bits, sx & 1, sy & 1);
      });
      next.forEach(function (d, k) { var j = 0; while (j < BITMAP && !d[j]) j++; if (j === BITMAP) next.delete(k); });
      levels.push(next);
      cur = next;
    }
    return levels;
  }

  // 解出一个区块文件的子瓦片：tileIdx → 位图（按记录顺序）
  function readTiles(data, rec, len) {
    len = len || BITMAP;
    var byRec = [];
    for (var t = 0; t < IDX * IDX; t++) {
      var n = data[2 * t] | (data[2 * t + 1] << 8);
      if (n) byRec.push([n, t]);
    }
    byRec.sort(function (a, b) { return a[0] - b[0]; });
    var out = new Map();
    byRec.forEach(function (e) { out.set(e[1], data.subarray(INDEX_BYTES + rec * (e[0] - 1), INDEX_BYTES + rec * (e[0] - 1) + len)); });
    return out;
  }
  // 原文件的子瓦片（old，可能带 App 留下的空记录）和新算出来的（neu，没有空的）内容是否相同
  function sameTiles(old, neu) {
    var n = 0, ok = true;
    old.forEach(function (bits, t) {
      if (!ok) return;
      var j = 0;
      while (j < bits.length && !bits[j]) j++;
      if (j === bits.length) return;     // 空记录不算差别
      n++;
      var o = neu.get(t);
      if (!o || o.length !== bits.length) { ok = false; return; }
      for (j = 0; j < bits.length; j++) if (bits[j] !== o[j]) { ok = false; return; }
    });
    return ok && n === neu.size;
  }
  // 一个 ~ 区块文件：保留原文件里的记录顺序，新出现的子瓦片接在后面
  function encodeTilde(tiles, order) {
    var keys = [];
    order.forEach(function (t) { if (tiles.has(t)) keys.push(t); });
    var seen = new Set(keys);
    Array.from(tiles.keys()).sort(function (a, b) { return a - b; }).forEach(function (t) { if (!seen.has(t)) keys.push(t); });
    var out = new Uint8Array(INDEX_BYTES + BITMAP * keys.length);
    keys.forEach(function (t, k) {
      out[2 * t] = (k + 1) & 255; out[2 * t + 1] = (k + 1) >> 8;
      out.set(tiles.get(t), INDEX_BYTES + BITMAP * k);
    });
    return out;
  }

  /*
   * 导出快照时要替换 / 新增的派生文件。
   *   blocks   全部 * 区块（BlockState，含编辑）
   *   dirty    改过的 * 区块
   *   archive  FogDecoder.open 的结果（找原文件、读原内容）
   * 返回 { files: Map(path → Uint8Array | null(删除)), stats: { hash, tilde } }
   * 内容没变的文件不放进去（原样保留）。
   */
  async function derive(blocks, dirty, archive) {
    var byPath = new Map();
    archive.entries.forEach(function (e) { byPath.set(e.path, e); });
    var files = new Map(), stats = { hash: 0, tilde: 0 };
    var inflate = global.FogDecoder.inflateZlib, deflate = global.FogStore.deflateZlib;
    async function original(path) {
      if (!byPath.has(path)) return null;
      var raw = await archive.rawBytes(path);
      try { return await inflate(raw); } catch (e) { return raw; }   // # 层的空区块是不压缩的
    }

    // Model/#：索引 + 每个子瓦片的尾 3 字节
    for (var i = 0; i < dirty.length; i++) {
      var st = dirty[i], path = 'Model/#/' + layerName(st.blockNo, HASH_K), want;
      if (st.tiles.size) {
        var enc = st.encode(), cnt = (enc.length - INDEX_BYTES) / REC;
        want = new Uint8Array(INDEX_BYTES + 3 * cnt);
        want.set(enc.subarray(0, INDEX_BYTES));
        for (var k = 0; k < cnt; k++) want.set(enc.subarray(INDEX_BYTES + REC * k + BITMAP, INDEX_BYTES + REC * (k + 1)), INDEX_BYTES + 3 * k);
      } else {
        want = new Uint8Array(INDEX_BYTES);
      }
      var old = await original(path);
      // 只比内容：统计相同就不动（App 写的和我们写的可能只是记录顺序不同）
      if (old && old.length >= INDEX_BYTES && sameTiles(readTiles(old, 3, 3), readTiles(want, 3, 3))) continue;
      files.set(path, st.tiles.size ? await deflate(want) : want);
      stats.hash++;
    }

    // Model/~：受影响的祖先区块，从金字塔重新生成
    var levels = pyramid(blocks), need = new Set();
    dirty.forEach(function (st) {
      for (var L = 1; L <= LEVELS; L++) need.add(L + ':' + (st.bx >> L) + ':' + (st.by >> L));
    });
    for (var key of need) {
      var p = key.split(':'), L2 = +p[0], X = +p[1], Y = +p[2];
      var g = Math.pow(2, Math.max(0, 9 - L2)), x = Y * g + X;
      var tpath = 'Model/~/' + layerName(x, L2);
      var tiles = new Map(), lv = levels[L2];
      for (var ty = 0; ty < IDX; ty++) {
        for (var tx = 0; tx < IDX; tx++) {
          var bits = lv.get((Y * IDX + ty) * SUBS + X * IDX + tx);
          if (bits) tiles.set(ty * IDX + tx, bits);
        }
      }
      var oldT = await original(tpath), oldTiles = oldT ? readTiles(oldT, BITMAP) : new Map();
      if (oldT && sameTiles(oldTiles, tiles)) continue;
      if (!tiles.size) { if (oldT) { files.set(tpath, null); stats.tilde++; } continue; }
      files.set(tpath, await deflate(encodeTilde(tiles, Array.from(oldTiles.keys()))));
      stats.tilde++;
    }
    return { files: files, stats: stats };
  }

  global.FogSnapshot = { derive: derive, layerName: layerName, pyramid: pyramid, HASH_K: HASH_K };
})(typeof window !== 'undefined' ? window : globalThis);
