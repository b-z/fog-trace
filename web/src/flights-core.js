/*
 * flights-core.js — Flighty 导出的 CSV → 《世界迷雾》快照（.fwss），每个航班一条 1 像素的大圆弧线。
 * 不依赖 DOM：页面、Web Worker 和 Node（tools/flights_selftest.js）都能用。需要先加载 airports.js。
 *
 * 弯曲：同一条航线（不分方向）飞过多次时，弧线向两侧错开；不同航线挨得太近时，后出现的那条稍微弯开。
 *   每班的弯曲只取决于它之前（按时间顺序）的航班，所以「以后新飞的航班」单独生成、合并进 App 里已有的存档，
 *   和整份重新生成的结果一模一样。
 *   bend c：航线中点向一侧偏 c × BEND × 航线长度（沿球面转动，c = 0 是大圆）。
 *   新航线第一次出现时，在 -2 … 2（半步）里选代价最小的「中心」：CURVE_COST × c² + 与之前每条弧线
 *   贴在一起的部分（超过 TOLERATED 的比例）。同一航线第 k 次：中心 + FAN[k]，FAN = 0, 1, -1, 0.5, -0.5,
 *   0.25, -0.25, 0.75, -0.75, …，飞得越多排得越密，总宽度不超过 ±1。
 *
 * 光栅化与快照格式与 snapshot.js 相同（见那里的说明）：Model/* 区块 + Model/# 统计 + 区块位图 + Model/~ 金字塔。
 * 按 Z 序逐个区块生成、压缩，随即丢掉，金字塔也是边走边合并，内存只和压缩后的大小有关。
 * 不写 Model/#2（按行政区的面积，只有 App 能算）：恢复或合并后 App 会要求重新构建数据库。
 */
(function (global) {
  'use strict';

  var R_KM = 6371.0, WORLD = 4194304, BLOCK = 8192, BLOCKS = 512, IDX = 128, INDEX_BYTES = 32768, BITMAP = 512, LEVELS = 15;
  var BEND = 0.03;
  var CENTRES = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2];
  var CURVE_COST = 0.2, NEAR_KM = 10.0, NEAR_FRAC = 0.015, TOLERATED = 0.15, SAMPLES = 64;
  var T1 = 'olhwjsktri', T2 = 'eizxdwknmo';

  // ---------- CSV ----------
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [], row = [], field = '', q = false, i = 0, n = text.length;
    for (; i < n; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function localStamp(d) {   // 2026-11-27T10:07（本地时间），与 CSV 里的时刻比较用
    function p(v) { return (v < 10 ? '0' : '') + v; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /*
   * 读 Flighty 的导出。返回 { flights（按时间排好）, canceled, unknown: {代码: 班数}, total }
   * flight = { id, date, when, flight, a, b, upcoming }；改降的航班画到实际降落的机场。
   */
  function readFlighty(text, now) {
    var rows = parseCSV(text);
    if (!rows.length) throw new Error('empty');
    var head = rows[0].map(function (s) { return s.trim(); }), col = {};
    head.forEach(function (h, k) { col[h] = k; });
    if (col.Date == null || col.From == null || col.To == null) throw new Error('columns');
    function get(r, name) { var k = col[name]; return k == null ? '' : (r[k] || '').trim(); }
    var nowS = localStamp(now || new Date()), out = [], unknown = {}, canceled = 0, same = 0;
    for (var k = 1; k < rows.length; k++) {
      var r = rows[k];
      if (!get(r, 'Date')) continue;
      if (get(r, 'Canceled').toLowerCase() === 'true') { canceled++; continue; }
      var a = get(r, 'From').toUpperCase(), b = (get(r, 'Diverted To') || get(r, 'To')).toUpperCase();
      if (a === b) { same++; continue; }
      var miss = [a, b].filter(function (c) { return !global.FogAirports[c]; });
      if (miss.length) { miss.forEach(function (c) { unknown[c] = (unknown[c] || 0) + 1; }); continue; }
      var arr = get(r, 'Gate Arrival (Actual)') || get(r, 'Landing (Actual)');
      var dep = get(r, 'Gate Departure (Actual)') || get(r, 'Take off (Actual)') || get(r, 'Gate Departure (Scheduled)') || get(r, 'Date');
      var when = get(r, 'Gate Departure (Scheduled)') || get(r, 'Take off (Scheduled)') || dep;
      out.push({
        id: get(r, 'Flight Flighty ID') || [get(r, 'Date'), get(r, 'Airline') + get(r, 'Flight'), a, b].join('|'),
        date: get(r, 'Date'), when: when, flight: get(r, 'Airline') + get(r, 'Flight'), a: a, b: b,
        upcoming: !arr && dep >= nowS
      });
    }
    sortFlights(out);
    return { flights: out, canceled: canceled, unknown: unknown, total: rows.length - 1 };
  }

  function sortFlights(list) {
    return list.sort(function (p, q) {
      return p.date < q.date ? -1 : p.date > q.date ? 1 : p.when < q.when ? -1 : p.when > q.when ? 1 :
        p.flight < q.flight ? -1 : p.flight > q.flight ? 1 : p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
    });
  }

  // ---------- 球面几何（单位向量）----------
  function unit(lat, lng) {
    var p = lat * (Math.PI / 180), l = lng * (Math.PI / 180);
    return [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // 航线：机场代码排好序，弯曲方向与飞行方向无关
  function route(f) {
    var lo = f.a < f.b ? f.a : f.b, hi = f.a < f.b ? f.b : f.a;
    var A = unit(global.FogAirports[lo][0], global.FogAirports[lo][1]), B = unit(global.FogAirports[hi][0], global.FogAirports[hi][1]);
    var L = R_KM * Math.acos(Math.max(-1, Math.min(1, dot(A, B))));
    return { key: lo + '-' + hi, A: A, B: B, L: L };
  }

  // A→B 的大圆按 bend c 弯开后，参数 t（0..1）处的点：Float64Array(3 × t.length)
  function curve(A, B, c, ts) {
    var th = Math.acos(Math.max(-1, Math.min(1, dot(A, B))));
    var n0 = A[1] * B[2] - A[2] * B[1], n1 = A[2] * B[0] - A[0] * B[2], n2 = A[0] * B[1] - A[1] * B[0];
    var nn = Math.sqrt(n0 * n0 + n1 * n1 + n2 * n2);
    n0 /= nn; n1 /= nn; n2 /= nn;
    var st = Math.sin(th), out = new Float64Array(3 * ts.length);
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i], s1 = Math.sin((1 - t) * th), s2 = Math.sin(t * th);
      var off = c * BEND * th * Math.sin(Math.PI * t), co = Math.cos(off), so = Math.sin(off);
      out[3 * i] = (s1 * A[0] + s2 * B[0]) / st * co + n0 * so;
      out[3 * i + 1] = (s1 * A[1] + s2 * B[1]) / st * co + n1 * so;
      out[3 * i + 2] = (s1 * A[2] + s2 * B[2]) / st * co + n2 * so;
    }
    return out;
  }
  function linspace(n) {
    var t = new Float64Array(n), step = 1 / (n - 1);
    for (var i = 0; i < n; i++) t[i] = i * step;
    t[n - 1] = 1;
    return t;
  }
  function latLng(P, i) {
    return [Math.asin(Math.max(-1, Math.min(1, P[3 * i + 2]))) * (180 / Math.PI), Math.atan2(P[3 * i + 1], P[3 * i]) * (180 / Math.PI)];
  }

  // ---------- 弯曲 ----------
  var FAN = (function () {          // 0, 1, -1, 0.5, -0.5, 0.25, -0.25, 0.75, -0.75, …（够 1000 次）
    var f = [0, 1, -1];
    for (var d = 2; f.length < 1024; d *= 2) {
      for (var k = 1; k < d; k += 2) f.push(k / d, -k / d);
    }
    return f;
  })();

  var INNER = (function () {        // 起降附近可以重叠：只看 6%–94%
    var t = linspace(SAMPLES), out = [];
    for (var i = 0; i < SAMPLES; i++) if (t[i] > 0.06 && t[i] < 0.94) out.push(t[i]);
    return Float64Array.from(out);
  })();

  function shape(r, c) {           // 一条弧线的采样点 + 外接球冠（快速排除离得远的）
    var P = curve(r.A, r.B, c, INNER), n = INNER.length, cx = 0, cy = 0, cz = 0, i;
    for (i = 0; i < n; i++) { cx += P[3 * i]; cy += P[3 * i + 1]; cz += P[3 * i + 2]; }
    var cn = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1, C = [cx / cn, cy / cn, cz / cn], minDot = 1;
    for (i = 0; i < n; i++) minDot = Math.min(minDot, P[3 * i] * C[0] + P[3 * i + 1] * C[1] + P[3 * i + 2] * C[2]);
    return { P: P, C: C, rad: Math.acos(Math.max(-1, Math.min(1, minDot))), L: r.L };
  }

  // 两条弧线互相贴着走的程度：各自有多大比例的点离对方不到 T，超过 TOLERATED 的部分相加
  function pairCost(s, u) {
    var T = Math.max(NEAR_KM, NEAR_FRAC * Math.min(s.L, u.L)) / R_KM;
    var cd = Math.max(-1, Math.min(1, dot(s.C, u.C)));
    if (Math.acos(cd) > s.rad + u.rad + T) return 0;
    var cosT = 1 - T * T / 2, P = s.P, Q = u.P, n = P.length / 3, m = Q.length / 3;
    var hitQ = new Uint8Array(m), ni = 0, i, j;
    for (i = 0; i < n; i++) {
      var x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2], hit = false;
      for (j = 0; j < m; j++) {
        if (x * Q[3 * j] + y * Q[3 * j + 1] + z * Q[3 * j + 2] > cosT) { hit = true; hitQ[j] = 1; }
      }
      if (hit) ni++;
    }
    var nj = 0;
    for (j = 0; j < m; j++) nj += hitQ[j];
    return Math.max(ni / n - TOLERATED, 0) + Math.max(nj / m - TOLERATED, 0);
  }

  /*
   * 按列表顺序给每班定 bend。返回 Float64Array（与 flights 一一对应）。
   * progress(done, total) 可选。
   */
  function chooseBends(flights, progress) {
    var groups = new Map(), placed = [], seen = new Set(), bends = new Float64Array(flights.length);
    for (var i = 0; i < flights.length; i++) {
      var r = route(flights[i]), g = groups.get(r.key);
      if (!g) {
        var best = null;
        for (var k = 0; k < CENTRES.length; k++) {
          var b = CENTRES[k], s = shape(r, b), cost = CURVE_COST * b * b;
          for (var p = 0; p < placed.length; p++) cost += pairCost(s, placed[p]);
          var key = [cost, Math.abs(b), -b];
          if (!best || key[0] < best.key[0] - 1e-12 || (Math.abs(key[0] - best.key[0]) <= 1e-12 &&
              (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { key: key, b: b };
        }
        g = { centre: best.b, n: 0 };
        groups.set(r.key, g);
      }
      var c = g.centre + FAN[Math.min(g.n, FAN.length - 1)];
      g.n++;
      bends[i] = c;
      var id = r.key + '|' + c;
      if (!seen.has(id)) { seen.add(id); placed.push(shape(r, c)); }
      if (progress && i % 20 === 0) progress(i, flights.length);
    }
    return bends;
  }

  // 预览用：每班 n 个 [lat, lng]，经度连续（跨 180° 不跳）
  function previewLine(f, c, n) {
    var r = route(f), P = curve(r.A, r.B, c, linspace(n || 96)), out = [], prev = null;
    for (var i = 0; i < P.length / 3; i++) {
      var ll = latLng(P, i);
      if (prev !== null) ll[1] += 360 * Math.round((prev - ll[1]) / 360);
      prev = ll[1];
      out.push(ll);
    }
    if (f.a > f.b) out.reverse();
    return out;
  }

  // ---------- 光栅化 ----------
  // 一班航班的折线（世界像素坐标，x 已展开不跳变），顶点间距 ≤ 128 像素
  function polyline(f, c) {
    var r = route(f), th = r.L / R_KM;
    var n = Math.floor(th * WORLD / (2 * Math.PI) / 128) + 2;
    var P = curve(r.A, r.B, c, linspace(n)), xs = new Float64Array(n), ys = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var lat = Math.asin(Math.max(-1, Math.min(1, P[3 * i + 2]))) * (180 / Math.PI);
      var lng = Math.atan2(P[3 * i + 1], P[3 * i]) * (180 / Math.PI);
      var rl = lat * (Math.PI / 180);
      xs[i] = (lng + 180) / 360 * WORLD;
      ys[i] = (1 - Math.log(Math.tan(rl) + 1 / Math.cos(rl)) / Math.PI) / 2 * WORLD;
    }
    var x0 = xs[0], acc = 0, prev = xs[0];
    for (i = 1; i < n; i++) {
      var d = xs[i] - prev;
      prev = xs[i];
      d -= WORLD * roundHalfEven(d / WORLD);
      acc += d;
      xs[i] = x0 + acc;
    }
    return { x: xs, y: ys };
  }
  function roundHalfEven(v) {
    var r = Math.round(v);
    if (Math.abs(v % 1) === 0.5 && r % 2 !== 0) r -= 1;
    return r;
  }

  // 第 k 段的像素：沿主轴每列（行）恰好一个，取线在该列（行）中心处所在的格子。emit(x, y)，x 未取模
  function segPixels(xs, ys, k, emit) {
    var ax = xs[k], ay = ys[k], dx = xs[k + 1] - ax, dy = ys[k + 1] - ay, i, lo, hi;
    if (Math.abs(dx) >= Math.abs(dy)) {
      lo = Math.floor(Math.min(ax, ax + dx)); hi = Math.floor(Math.max(ax, ax + dx));
      for (i = lo; i <= hi; i++) emit(i, Math.floor(ay + (dx !== 0 ? (i + 0.5 - ax) * dy / dx : 0)));
    } else {
      lo = Math.floor(Math.min(ay, ay + dy)); hi = Math.floor(Math.max(ay, ay + dy));
      for (i = lo; i <= hi; i++) emit(Math.floor(ax + (dy !== 0 ? (i + 0.5 - ay) * dx / dy : 0)), i);
    }
  }

  // ---------- 快照文件 ----------
  function layerName(n, k) {
    var m = n + k, s = String(n), out = global.FogStore.md5hex(String(m)).slice(0, 4);
    for (var i = 0; i < s.length; i++) out += T1[+s[i]];
    var t = ('0' + (m % 100)).slice(-2);
    return out + T2[+t[0]] + T2[+t[1]];
  }
  var POP = new Uint8Array(256);
  for (var b = 1; b < 256; b++) POP[b] = POP[b >> 1] + (b & 1);
  var HALF = new Uint8Array(256);   // 一个字节 8 个像素 → 4 个（相邻两个 OR），高位在前
  for (b = 0; b < 256; b++) { var v = 0; for (var q = 0; q < 4; q++) if ((b >> (6 - 2 * q)) & 3) v |= 8 >> q; HALF[b] = v; }
  function downInto(dst, src, qx, qy) {
    for (var r = 0; r < 32; r++) {
      var a = 16 * r, c = a + 8, o = (qy * 32 + r) * 8 + qx * 4;
      for (var j = 0; j < 4; j++) dst[o + j] |= (HALF[src[a + 2 * j] | src[c + 2 * j]] << 4) | HALF[src[a + 2 * j + 1] | src[c + 2 * j + 1]];
    }
  }
  function sortedKeys(tiles) { return Array.from(tiles.keys()).sort(function (p, q) { return p - q; }); }
  function encode(tiles, withBits, withTail) {   // 索引（uint16 LE，记录号从 1 起，按子瓦片编号排）+ 记录
    var keys = sortedKeys(tiles), rec = (withBits ? BITMAP : 0) + (withTail ? 3 : 0);
    var out = new Uint8Array(INDEX_BYTES + rec * keys.length);
    for (var k = 0; k < keys.length; k++) {
      var t = keys[k], bits = tiles.get(t), o = INDEX_BYTES + rec * k;
      out[2 * t] = (k + 1) & 255; out[2 * t + 1] = (k + 1) >> 8;
      if (withBits) out.set(bits, o);
      if (withTail) {
        var px = 0;
        for (var j = 0; j < BITMAP; j++) px += POP[bits[j]];
        var val = 2 * px + 1, e = o + (withBits ? BITMAP : 0);
        out[e] = (val >> 16) & 255; out[e + 1] = (val >> 8) & 255; out[e + 2] = val & 255;
      }
    }
    return out;
  }
  function morton(bx, by) {
    var m = 0;
    for (var i = 0; i < 9; i++) m += (((bx >> i) & 1) * Math.pow(2, 2 * i)) + (((by >> i) & 1) * Math.pow(2, 2 * i + 1));
    return m;
  }

  // ---------- zip（不压缩：里面的文件本身已经是 zlib）----------
  var CRC = new Int32Array(256);
  for (b = 0; b < 256; b++) { var cr = b; for (q = 0; q < 8; q++) cr = cr & 1 ? 0xedb88320 ^ (cr >>> 1) : cr >>> 1; CRC[b] = cr; }
  function crc32(d) { var c = -1; for (var i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
  function zipParts(entries) {   // entries: [{name, data}] → Uint8Array 片段（拼起来就是 zip）
    var parts = [], central = [], offset = 0, DATE = 0x21;   // 1980-01-01 00:00
    entries.forEach(function (e) {
      var name = new TextEncoder().encode(e.name), crc = crc32(e.data), n = e.data.length;
      var h = new Uint8Array(30 + name.length), dv = new DataView(h.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true); dv.setUint16(12, DATE, true); dv.setUint32(14, crc, true);
      dv.setUint32(18, n, true); dv.setUint32(22, n, true); dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
      h.set(name, 30);
      var c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, DATE, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, n, true); cv.setUint32(24, n, true); cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      c.set(name, 46);
      parts.push(h, e.data); central.push(c);
      offset += h.length + n;
    });
    var csize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, csize, true); ev.setUint32(16, offset, true);
    return parts.concat(central, [end]);
  }

  /*
   * 生成快照。
   *   flights  航班（顺序 = 定弯曲的顺序）
   *   bends    chooseBends 的结果
   *   draw     要画的航班下标（省略 = 全部）
   *   deflate  async (Uint8Array) → zlib 压缩后的 Uint8Array
   *   progress(phase, done, total)
   * 返回 { parts（zip 片段）, blocks, subtiles, pixels, files }
   */
  async function buildSnapshot(flights, bends, draw, deflate, progress) {
    progress = progress || function () {};
    if (!draw) draw = flights.map(function (f, i) { return i; });
    // 1. 折线；每段登记到它碰到的区块
    var lines = [], segs = new Map();
    draw.forEach(function (fi, li) {
      var pl = polyline(flights[fi], bends[fi]);
      lines.push(pl);
      for (var k = 0; k + 1 < pl.x.length; k++) {
        var x0 = Math.min(pl.x[k], pl.x[k + 1]) - 1, x1 = Math.max(pl.x[k], pl.x[k + 1]) + 1;
        var y0 = Math.max(0, Math.min(pl.y[k], pl.y[k + 1]) - 1), y1 = Math.min(WORLD - 1, Math.max(pl.y[k], pl.y[k + 1]) + 1);
        for (var by = Math.floor(y0 / BLOCK); by <= Math.floor(y1 / BLOCK); by++) {
          for (var bxr = Math.floor(x0 / BLOCK); bxr <= Math.floor(x1 / BLOCK); bxr++) {
            var bx = ((bxr % BLOCKS) + BLOCKS) % BLOCKS, key = by * BLOCKS + bx, a = segs.get(key);
            if (!a) { a = []; segs.set(key, a); }
            a.push(li * 1048576 + k);
          }
        }
      }
    });
    var order = Array.from(segs.keys()).map(function (n) { return [morton(n % BLOCKS, Math.floor(n / BLOCKS)), n]; })
      .sort(function (p, q) { return p[0] - q[0]; }).map(function (e) { return e[1]; });

    var star = [], hash = [], tilde = [], present = new Uint8Array(BLOCKS * BLOCKS / 8);
    var nBlocks = 0, nTiles = 0, nPx = 0;
    var cur = [];   // cur[L] = { X, Y, tiles }：金字塔第 L 层正在拼的区块（Z 序，每层只有一个）
    async function flush(L) {
      var c = cur[L]; cur[L] = null;
      var g = Math.pow(2, Math.max(0, 9 - L));
      tilde.push({ L: L, n: c.Y * g + c.X, name: 'Model/~/' + layerName(c.Y * g + c.X, L), data: await deflate(encode(c.tiles, true, false)) });
      if (L < LEVELS) await addTo(L + 1, c.X, c.Y, c.tiles);
    }
    async function addTo(L, BX, BY, tiles) {   // 第 L-1 层区块 (BX, BY) 的子瓦片缩小一半，OR 进第 L 层
      var X = BX >> 1, Y = BY >> 1;
      if (cur[L] && (cur[L].X !== X || cur[L].Y !== Y)) await flush(L);
      if (!cur[L]) cur[L] = { X: X, Y: Y, tiles: new Map() };
      var dst = cur[L].tiles;
      tiles.forEach(function (bits, t) {
        var sx = BX * IDX + (t & 127), sy = BY * IDX + (t >> 7), px = sx >> 1, py = sy >> 1, pt = ((py & 127) << 7) | (px & 127);
        var d = dst.get(pt);
        if (!d) { d = new Uint8Array(BITMAP); dst.set(pt, d); }
        downInto(d, bits, sx & 1, sy & 1);
      });
    }

    // 2. 逐个区块（Z 序）光栅化、写文件、并入金字塔
    for (var oi = 0; oi < order.length; oi++) {
      var n = order[oi], bx = n % BLOCKS, by = Math.floor(n / BLOCKS), tiles = new Map();
      var setPx = function (x, y) {
        if (y < 0) y = 0; else if (y > WORLD - 1) y = WORLD - 1;
        x = ((x % WORLD) + WORLD) % WORLD;
        if ((x >> 13) !== bx || (y >> 13) !== by) return;
        var lx = x & 8191, ly = y & 8191, t = (ly >> 6) * IDX + (lx >> 6), bits = tiles.get(t);
        if (!bits) { bits = new Uint8Array(BITMAP); tiles.set(t, bits); }
        bits[(ly & 63) * 8 + ((lx & 63) >> 3)] |= 0x80 >> (lx & 7);
      };
      segs.get(n).forEach(function (ref) {
        var pl = lines[Math.floor(ref / 1048576)];
        segPixels(pl.x, pl.y, ref % 1048576, setPx);
      });
      if (!tiles.size) continue;      // 包围盒碰到了，线其实没进来
      var full = encode(tiles, true, true), cnt = tiles.size, h = new Uint8Array(INDEX_BYTES + 3 * cnt);
      h.set(full.subarray(0, INDEX_BYTES));
      for (var k = 0; k < cnt; k++) {
        var e = INDEX_BYTES + (BITMAP + 3) * (k + 1) - 3;
        h.set(full.subarray(e, e + 3), INDEX_BYTES + 3 * k);
        nPx += ((full[e] << 16 | full[e + 1] << 8 | full[e + 2]) - 1) / 2;
      }
      star.push({ name: 'Model/*/' + layerName(n, 0), data: await deflate(full) });
      hash.push({ name: 'Model/#/' + layerName(n, 74), data: await deflate(h) });
      present[n >> 3] |= 1 << (n & 7);
      nBlocks++; nTiles += cnt;
      await addTo(1, bx, by, tiles);
      if (oi % 16 === 0) progress('raster', oi, order.length);
    }
    for (var L = 1; L <= LEVELS; L++) if (cur[L]) await flush(L);
    progress('raster', order.length, order.length);

    tilde.sort(function (p, q) { return p.L - q.L || p.n - q.n; });
    var entries = star.concat(hash, [{ name: 'Model/#/' + global.FogStore.md5hex('*').slice(0, 10), data: await deflate(present) }], tilde);
    progress('zip', 0, 1);
    var parts = zipParts(entries);
    return { parts: parts, blocks: nBlocks, subtiles: nTiles, pixels: nPx, files: entries.length };
  }

  function fileStamp(d) {   // 20261127T101500+0900（本地时间，与 App 的快照文件名同格式）
    function p(v) { return (v < 10 ? '0' : '') + v; }
    var o = -d.getTimezoneOffset(), s = o < 0 ? '-' : '+';
    o = Math.abs(o);
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + 'T' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      s + p(Math.floor(o / 60)) + p(o % 60);
  }

  global.FogFlights = {
    readFlighty: readFlighty, sortFlights: sortFlights, chooseBends: chooseBends, buildSnapshot: buildSnapshot,
    previewLine: previewLine, route: route, fileStamp: fileStamp, localStamp: localStamp, FAN: FAN, polyline: polyline
  };
})(typeof window !== 'undefined' ? window : globalThis);
