/*
 * detect.js — 在浏览器里检测整份存档的断头：分窗口、Web Worker 并行、窗口结果缓存、去重、合并标记。
 * 与 tools/deadends.py 的 detect() + merge_state() 一致（算法本体在 detect-core.js）。
 *
 *   var r = await FogDetect.run({
 *     blocks: await store.loadAll(),          // FogStore 的区块（含编辑）
 *     pool: FogDetect.browserPool('src/detect-worker.js'),
 *     cache: FogDetect.memoryCache(saved),    // 可省略：窗口内容没变就直接用上次的结果
 *     onProgress: function (done, total, info) {},
 *   });
 *   var m = FogDetect.merge(state, r.dets, '存档名');   // → { state, summary }
 */
(function (global) {
  'use strict';

  var CORE = 32, MARGIN = 4, NSUB = CORE + 2 * MARGIN, SUBS = 1 << 16, WORLD = 1 << 22;
  var DEDUP_PX = 5, MATCH_PX = 6, DIR_TOL = 60;

  function core() { return global.FogDetectCore; }
  function round(x, n) { return core().round(x, n); }
  function nowIso() { return new Date().toISOString().slice(0, 19) + '+00:00'; }   // 与 Python isoformat(timespec='seconds') 同格式

  // ---------- 输入：子瓦片快照 ----------
  // 区块的子瓦片是写时复制（编辑会换成新数组），所以记下引用就是一个一致的快照
  function snapshot(blocks) {
    var map = new Map();
    blocks.forEach(function (st) {
      st.tiles.forEach(function (bits, t) {
        var j = 0;
        while (j < 512 && !bits[j]) j++;
        if (j === 512) return;
        map.set((st.by * 128 + (t >> 7)) * SUBS + st.bx * 128 + (t & 127), bits);
      });
    });
    return map;
  }

  // 有数据的窗口，按 (wx, wy) 排序（与 Python 的 sorted 相同）
  function windowsOf(map) {
    var set = new Set();
    map.forEach(function (_, key) {
      var sx = key % SUBS, sy = Math.floor(key / SUBS);
      set.add(Math.floor(sx / CORE) * 4096 + Math.floor(sy / CORE));
    });
    return Array.from(set).sort(function (a, b) { return a - b; }).map(function (k) { return [Math.floor(k / 4096), k % 4096]; });
  }

  // 一个窗口的输入：子瓦片局部编号 + 位图，以及内容哈希（缓存键）
  function pack(map, wx, wy) {
    var ox = wx * CORE - MARGIN, oy = wy * CORE - MARGIN, ij = [], list = [];
    for (var j = 0; j < NSUB; j++) {
      var sy = oy + j;
      if (sy < 0 || sy >= SUBS) continue;
      for (var i = 0; i < NSUB; i++) {
        var sx = ox + i;
        if (sx < 0 || sx >= SUBS) continue;
        var bits = map.get(sy * SUBS + sx);
        if (bits) { ij.push(i, j); list.push(bits); }
      }
    }
    var n = list.length, IJ = new Uint8Array(ij), B = new Uint8Array(512 * n);
    for (var k = 0; k < n; k++) B.set(list[k], 512 * k);
    // 两个 32 位哈希（FNV-1a + 乘法混合），按 4 字节读
    var h1 = 0x811c9dc5, h2 = 0x9747b28c ^ n, u = new Uint32Array(B.buffer);
    for (k = 0; k < IJ.length; k++) { h1 = Math.imul(h1 ^ IJ[k], 0x01000193); h2 = Math.imul(h2 ^ IJ[k], 0x5bd1e995); }
    for (k = 0; k < u.length; k++) {
      var v = u[k];
      h1 = Math.imul(h1 ^ v, 0x01000193);
      h2 = Math.imul(h2 ^ (v >>> 13 | v << 19), 0x5bd1e995); h2 ^= h2 >>> 15;
    }
    var key = 'v' + core().VERSION + ':' + wx + ',' + wy + ':' + n + ':' + (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
    return { ox: ox, oy: oy, n: n, ij: IJ, bits: B, key: key };
  }

  // ---------- 主流程 ----------
  async function run(o) {
    var t0 = Date.now(), map = snapshot(o.blocks), wins = windowsOf(map), cache = o.cache || null;
    var results = new Array(wins.length), next = 0, done = 0, computed = 0, reused = 0, failed = null;
    async function lane() {
      while (next < wins.length && !failed) {
        var k = next++, w = wins[k], task = pack(map, w[0], w[1]);
        var hit = cache && cache.get(task.key);
        if (hit) {
          results[k] = hit; reused++;
          if (reused % 64 === 0) await new Promise(function (r) { setTimeout(r, 0); });   // 让出主线程，进度条能刷新
        } else {
          try {
            results[k] = await o.pool.exec({ ox: task.ox, oy: task.oy, n: task.n, ij: task.ij, bits: task.bits }, [task.ij.buffer, task.bits.buffer]);
          } catch (e) { failed = e; return; }
          if (cache) cache.set(task.key, results[k]);
          computed++;
        }
        done++;
        if (o.onProgress) o.onProgress(done, wins.length, { computed: computed, reused: reused, seconds: (Date.now() - t0) / 1000 });
      }
    }
    var lanes = [];
    for (var i = 0; i < o.pool.size * 2; i++) lanes.push(lane());   // 每个 Worker 两个任务在途，不空等
    await Promise.all(lanes);
    if (failed) throw failed;
    var raw = [];
    results.forEach(function (r) { for (var j = 0; j < r.length; j++) raw.push(r[j]); });
    var dets = dedupe(raw).map(toPoint);
    return {
      dets: dets, raw: raw, windows: wins.length, perWindow: results, wins: wins,
      stats: { subtiles: map.size, windows: wins.length, computed: computed, reused: reused, raw: raw.length, kept: dets.length, seconds: (Date.now() - t0) / 1000 },
    };
  }

  // 同一处（≤ 5px）只留分数最高的一个
  function dedupe(raw) {
    var out = raw.slice().sort(function (a, b) { return b.score - a.score; });
    var grid = new Map(), C = DEDUP_PX;
    out.forEach(function (e, i) {
      var key = Math.floor(e.px / C) + ',' + Math.floor(e.py / C);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    });
    var dead = new Uint8Array(out.length), keep = [];
    for (var i = 0; i < out.length; i++) {
      if (dead[i]) continue;
      var e = out[i]; keep.push(e);
      var cx = Math.floor(e.px / C), cy = Math.floor(e.py / C);
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var cell = grid.get((cx + dx) + ',' + (cy + dy));
        if (!cell) continue;
        for (var k = 0; k < cell.length; k++) {
          var q = out[cell[k]], ddx = q.px - e.px, ddy = q.py - e.py;
          if (ddx * ddx + ddy * ddy <= DEDUP_PX * DEDUP_PX) dead[cell[k]] = 1;
        }
      }
    }
    return keep;
  }

  function toPoint(e) {
    var lng = e.px / WORLD * 360 - 180;
    var n = Math.PI - 2 * Math.PI * e.py / WORLD;
    var lat = Math.atan(Math.sinh(n)) * (180 / Math.PI);
    var m = 40075016.686 * Math.cos(lat * (Math.PI / 180)) / WORLD;
    var p = {};
    for (var k in e) p[k] = e[k];
    p.lng = round(lng, 6); p.lat = round(lat, 6);
    p.length_m = round(e.length_px * m); p.forward_m = round(e.forward_px * m); p.touch_m = round(e.touch_px * m);
    return p;
  }

  // ---------- 合并到标记状态（与 deadends.merge_state 相同规则） ----------
  //  * 新检测与已标记的点相距 ≤6px、方向差 ≤60°：同一端点，沿用 id 和标记，位置与分数更新；重复检测丢掉
  //  * 已标记但这次没检测到的保留，present: false
  //  * 待处理的点同样匹配并沿用 id；没再检测到的去掉
  function sameDir(a, b) {
    if (a === null || a === undefined || b === null || b === undefined) return true;
    var d = ((a - b + 180) % 360 + 360) % 360 - 180;   // Python 的 % 是向下取整取模
    return Math.abs(d) <= DIR_TOL;
  }
  function gridIndex(pts) {
    var g = new Map(), C = MATCH_PX;
    pts.forEach(function (p, i) {
      var key = Math.floor(p.px / C) + ',' + Math.floor(p.py / C);
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(i);
    });
    return g;
  }
  function nearest(g, pts, d, taken) {
    var cx = Math.floor(d.px / MATCH_PX), cy = Math.floor(d.py / MATCH_PX), best = null, bd = 0;
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      var cell = g.get((cx + dx) + ',' + (cy + dy));
      if (!cell) continue;
      for (var k = 0; k < cell.length; k++) {
        var j = cell[k], p = pts[j];
        if (taken && taken.has(j)) continue;
        var dist = Math.hypot(p.px - d.px, p.py - d.py);
        if (dist > MATCH_PX || !sameDir(p.dir, d.dir)) continue;
        if (best === null || dist < bd || (dist === bd && j < best)) { best = j; bd = dist; }
      }
    }
    return best;
  }
  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    var b = new Uint8Array(16);
    global.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.from(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function merge(state, dets, source, extra) {
    var now = nowIso(), old = (state && state.points) || [];
    var marked = old.filter(function (p) { return p.status === 'ignored' || p.status === 'done'; });
    var opened = old.filter(function (p) { return (p.status || 'open') === 'open'; });
    marked.forEach(function (m) { if (!('marked_in' in m)) m.marked_in = state.source; });
    var mg = gridIndex(marked), og = gridIndex(opened);
    var out = [], inherited = new Map(), used = new Set(), dup = 0, reused = 0;
    dets.slice().sort(function (a, b) { return b.score - a.score; }).forEach(function (d) {
      var j = nearest(mg, marked, d, null), k, p;
      if (j !== null) {
        if (inherited.has(j)) { dup++; return; }   // 用户已经处理过的端点的第二次检测
        var m = marked[j];
        p = { id: m.id, status: m.status, first_seen: m.first_seen || now, last_seen: now };
        for (k in d) p[k] = d[k];
        p.marked_at = m.marked_at; p.marked_in = m.marked_in; p.present = true;
        inherited.set(j, p); out.push(p);
        return;
      }
      var o = nearest(og, opened, d, used), id, first;
      if (o !== null) { used.add(o); id = opened[o].id; first = opened[o].first_seen || now; reused++; }
      else { id = uuid(); first = now; }
      p = { id: id, status: 'open', first_seen: first, last_seen: now };
      for (k in d) p[k] = d[k];
      out.push(p);
    });
    var missing = [];
    marked.forEach(function (m, j) {
      if (inherited.has(j)) return;
      var q = {}; for (var k in m) q[k] = m[k];
      q.present = false; missing.push(q);
    });
    var points = out.concat(missing).sort(function (a, b) { return b.score - a.score; });
    var nOpen = out.filter(function (p) { return p.status === 'open'; }).length;
    var st = { source: source, updated: now, points: points };
    if (extra) for (var k2 in extra) st[k2] = extra[k2];
    return {
      state: st,
      summary: { open: nOpen, kept: reused, fresh: nOpen - reused, gone: opened.length - used.size,
                 carried: inherited.size, missing: missing.length, dup: dup },
    };
  }

  // ---------- Worker 池（浏览器） ----------
  function browserPool(url, size) {
    size = size || Math.max(1, Math.min(8, (global.navigator && navigator.hardwareConcurrency || 4) - 1));
    var workers = [], idle = [], queue = [], pending = new Map(), seq = 0;
    function pump() {
      while (idle.length && queue.length) {
        var w = idle.pop(), q = queue.shift();
        pending.set(q.msg.id, { q: q, w: w });
        w.postMessage(q.msg, q.transfer);
      }
    }
    for (var i = 0; i < size; i++) {
      var w = new Worker(url);
      w.onmessage = function (e) {
        var p = pending.get(e.data.id);
        pending.delete(e.data.id);
        idle.push(p.w);
        if (e.data.error) p.q.reject(new Error(e.data.error)); else p.q.resolve(e.data.res);
        pump();
      };
      w.onerror = function (e) {
        e.preventDefault();
        pending.forEach(function (p) { p.q.reject(new Error('检测 Worker 出错：' + (e.message || e))); });
        pending.clear();
      };
      workers.push(w); idle.push(w);
    }
    return {
      size: size,
      exec: function (msg, transfer) {
        return new Promise(function (resolve, reject) {
          msg.id = ++seq;
          queue.push({ msg: msg, transfer: transfer, resolve: resolve, reject: reject });
          pump();
        });
      },
      terminate: function () { workers.forEach(function (w) { w.terminate(); }); },
    };
  }

  // 窗口结果缓存：键 = 算法版本 + 窗口位置 + 内容哈希，值 = 该窗口的检测结果
  function memoryCache(saved) {
    var m = new Map(saved ? Object.entries(saved) : []), used = new Set();
    return {
      get: function (k) { var v = m.get(k); if (v) used.add(k); return v; },
      set: function (k, v) { m.set(k, v); used.add(k); },
      // 存回去时只留这次用到的窗口，外加最多 limit 个旧的（换存档再换回来也能命中）
      toJSON: function (limit) {
        var o = {}, extra = 0;
        m.forEach(function (v, k) { if (used.has(k)) o[k] = v; });
        m.forEach(function (v, k) { if (!used.has(k) && extra < (limit || 4000)) { o[k] = v; extra++; } });
        return o;
      },
      size: function () { return m.size; },
    };
  }

  global.FogDetect = {
    run: run, merge: merge, dedupe: dedupe, toPoint: toPoint, snapshot: snapshot, windowsOf: windowsOf, pack: pack,
    browserPool: browserPool, memoryCache: memoryCache, nowIso: nowIso, uuid: uuid,
  };
})(typeof window !== 'undefined' ? window : globalThis);
