/*
 * detect-core.js — 断头检测的核心算法（一个窗口），与 tools/deadends.py 逐步一致。
 *
 * 浏览器 Web Worker（detect-worker.js）和 Node（tools/detect_node.js）共用。
 * 一个窗口 = 32×32 个子瓦片（每个 64×64 像素）+ 四周各 4 个子瓦片的边距，共 2560×2560 像素：
 *   位图 → 膨胀 1px（补栅格缝）→ 骨架化 → 剪掉 < 6px 的毛刺 → 骨架端点 → 打分
 *
 * 为了和 Python 结果逐点一致，两个关键步骤照搬了参考实现：
 *   骨架化：scikit-image skeletonize（Zhang-Suen 查表法，两个子迭代，并行删除）
 *   最近骨架像素：scipy.ndimage.distance_transform_edt(return_indices=True)
 *     的精确欧氏特征变换（Maurer 等 2003，可分离、逐行逐列的 Voronoi 下包络），包括等距时取哪一个
 * 只扫有像素的地方，结果与整幅扫描相同。
 *
 * 这两部分移植自 scikit-image（© the scikit-image team）与 SciPy（© Enthought, Inc., SciPy Developers），
 * 均为 BSD-3-Clause 许可，全文见 THIRD_PARTY_NOTICES.md。
 */
(function (global) {
  'use strict';

  var CORE = 32, MARGIN = 4, SUB = 64;
  var NSUB = CORE + 2 * MARGIN;          // 40 个子瓦片
  var W = NSUB * SUB;                     // 2560 像素
  var P = W + 2;                          // 带 1 像素空白边框的行宽（省掉越界判断）
  var PRUNE = 6, TRACE_CAP = 4000, FEAT_R = 100, CONE_DEG = 35;
  var COS_CONE = Math.cos(CONE_DEG * (Math.PI / 180));
  var LO = MARGIN * SUB, HI = (MARGIN + CORE) * SUB;

  // scikit-image _fast_skeletonize 的查表：1 = 第一子迭代可删，2 = 第二子迭代可删，3 = 都可删
  // 邻居编码：1 左上 2 上 4 右上 8 右 16 右下 32 下 64 左下 128 左
  var LUT = new Uint8Array([0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0,
    1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0,
    3, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 0, 0, 0, 3, 0, 2, 2, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0,
    0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0,
    3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0,
    2, 0, 0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0,
    0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 1, 3, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 1, 3,
    0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0,
    2, 0, 0, 0]);
  // 8 邻域，顺序与 deadends.py 的 OFFS 一致：(-1,-1) (-1,0) (-1,1) (0,-1) (0,1) (1,-1) (1,0) (1,1)
  var OFF = [-P - 1, -P, -P + 1, -1, 1, P - 1, P, P + 1];
  var FOUR = [false, true, false, true, true, false, true, false];

  // Python 的 round(x, n)（n ≥ 1：toFixed 按二进制精确值舍入，与 CPython 一致；正好落在 .5 上的情况这里不会出现）
  function round(x, n) {
    if (!n) {
      var r = Math.round(x);
      if (Math.abs(x % 1) === 0.5) r = 2 * Math.round(x / 2);   // 四舍六入五成双
      return r;
    }
    return Number(x.toFixed(n));
  }

  // ---------- 工作区（每个 Worker 一份，窗口之间复用） ----------
  var dil = new Uint8Array(P * P);   // 膨胀后的位图（带边框）
  var sk = new Uint8Array(P * P);    // 骨架
  var occ = new Uint8Array(NSUB * NSUB);
  var listA = new Int32Array(1 << 20), listB = new Int32Array(1 << 20);

  function grow(arr, n) {
    if (n <= arr.length) return arr;
    var b = new Int32Array(Math.max(n, arr.length * 2)); b.set(arr); return b;
  }

  /*
   * 处理一个窗口。
   * subs = [[i, j, bits(Uint8Array 512)], ...]：窗口内（含边距）的子瓦片，i/j 是 0..39 的局部编号
   * ox, oy = 窗口左上角的世界子瓦片坐标（wx*32-4, wy*32-4）
   * 返回与 deadends.process_window 相同字段的检测结果数组
   */
  function processWindow(subs, ox, oy) {
    if (!subs.length) return [];
    dil.fill(0); sk.fill(0); occ.fill(0);
    var any = false;
    // 1. 位图 + 3×3 膨胀（scipy binary_dilation，边界外当 0）
    for (var s = 0; s < subs.length; s++) {
      var i = subs[s][0], j = subs[s][1], bits = subs[s][2];
      var x0 = i * SUB, y0 = j * SUB;
      for (var r = 0; r < SUB; r++) {
        for (var bb = 0; bb < 8; bb++) {
          var b = bits[r * 8 + bb];
          if (!b) continue;
          for (var bit = 0; bit < 8; bit++) {
            if (!(b & (0x80 >> bit))) continue;
            any = true;
            var y = y0 + r, x = x0 + bb * 8 + bit;
            var ya = y > 0 ? y - 1 : 0, yb = y < W - 1 ? y + 1 : W - 1;
            var xa = x > 0 ? x - 1 : 0, xb = x < W - 1 ? x + 1 : W - 1;
            for (var yy = ya; yy <= yb; yy++) {
              var row = (yy + 1) * P + 1;
              for (var xx = xa; xx <= xb; xx++) dil[row + xx] = 1;
            }
          }
        }
      }
      // 膨胀会溢出 1 像素到相邻子瓦片
      for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
        var ii = i + di, jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < NSUB && jj < NSUB) occ[jj * NSUB + ii] = 1;
      }
    }
    if (!any) return [];
    // 有像素的位置，按行优先排序（与 numpy 的 argwhere 顺序一致）
    var n = 0;
    for (var y = 0; y < W; y++) {
      var orow = (y >> 6) * NSUB, prow = (y + 1) * P + 1;
      for (var ti = 0; ti < NSUB; ti++) {
        if (!occ[orow + ti]) continue;
        var xs = ti * SUB, base = prow + xs;
        for (var x = 0; x < SUB; x++) {
          if (dil[base + x]) { if (n >= listA.length) listA = grow(listA, n + 1); listA[n++] = base + x; }
        }
      }
    }
    sk.set(dil);
    n = skeletonize(n);
    n = prune(n, PRUNE);
    // 2. 端点：邻居数 1（线段端头）或 0（孤立点），只取核心区
    var res = [];
    var act = listA;
    for (var k = 0; k < n; k++) {
      var idx = act[k];
      if (!sk[idx]) continue;
      var yy = ((idx / P) | 0) - 1, xx = (idx % P) - 1;
      if (yy < LO || yy >= HI || xx < LO || xx >= HI) continue;
      var nb = nbcount(idx);
      if (nb > 1) continue;
      var path, kind;
      if (nb === 0) { path = [idx]; kind = 'dot'; }
      else { var t = trace(idx, TRACE_CAP); path = t.path; kind = t.kind; }
      var f = features(path);
      var L = kind !== 'dot' ? path.length : 15;
      res.push({
        px: (ox * SUB + xx) + 0.5, py: (oy * SUB + yy) + 0.5,
        kind: kind === 'cap' ? 'junction' : kind,
        length_px: path.length, forward_px: round(f.forward, 1), touch_px: round(f.touch, 1),
        dir: f.dir === null ? null : round(f.dir), score: score(L, f.forward, f.touch),
      });
    }
    return res;
  }

  function nbcount(idx) {
    return sk[idx - P - 1] + sk[idx - P] + sk[idx - P + 1] + sk[idx - 1] + sk[idx + 1] + sk[idx + P - 1] + sk[idx + P] + sk[idx + P + 1];
  }

  // scikit-image _fast_skeletonize：每轮两个子迭代，每个子迭代先按当前骨架判定、再统一删除
  function skeletonize(n) {
    var rem = listB;
    for (;;) {
      var removedAny = false;
      for (var pass = 0; pass < 2; pass++) {
        var m = 0;
        for (var k = 0; k < n; k++) {
          var idx = listA[k];
          var v = LUT[sk[idx - P - 1] + 2 * sk[idx - P] + 4 * sk[idx - P + 1] + 8 * sk[idx + 1] +
                      16 * sk[idx + P + 1] + 32 * sk[idx + P] + 64 * sk[idx + P - 1] + 128 * sk[idx - 1]];
          if (v === 3 || (v === 1 && pass === 0) || (v === 2 && pass === 1)) {
            if (m >= rem.length) { rem = grow(rem, m + 1); listB = rem; }
            rem[m++] = idx;
          }
        }
        if (!m) continue;
        removedAny = true;
        for (k = 0; k < m; k++) sk[rem[k]] = 0;
        var w = 0;
        for (k = 0; k < n; k++) if (sk[listA[k]]) listA[w++] = listA[k];
        n = w;
      }
      if (!removedAny) return n;
    }
  }

  // 从端点沿骨架走，直到分叉 / 另一端 / 达到上限。与 deadends.trace 相同的走法
  function trace(idx, cap) {
    var path = [idx], prev = -1, cur = idx;
    var nxt = [0, 0], nk = [0, 0];
    while (path.length < cap) {
      var cnt = 0, L = path.length;
      for (var o = 0; o < 8; o++) {
        var q = cur + OFF[o];
        if (!sk[q] || q === prev) continue;
        if ((L >= 1 && path[L - 1] === q) || (L >= 2 && path[L - 2] === q) || (L >= 3 && path[L - 3] === q)) continue;
        if (cnt < 2) { nxt[cnt] = q; nk[cnt] = o; }
        cnt++;
      }
      if (!cnt) return { path: path, kind: 'end' };
      var pick = nxt[0];
      if (cnt > 1) {
        // 拐角处 8 连通骨架可能给出两个相邻的候选：取 4 邻域那个
        var adjacent = false;
        if (cnt === 2) {
          var ay = (nxt[0] / P) | 0, ax = nxt[0] % P, by = (nxt[1] / P) | 0, bx = nxt[1] % P;
          adjacent = Math.max(Math.abs(ay - by), Math.abs(ax - bx)) === 1;
        }
        var f0 = FOUR[nk[0]], f1 = FOUR[nk[1]];
        if (cnt === 2 && adjacent && f0 !== f1) pick = f0 ? nxt[0] : nxt[1];
        else return { path: path, kind: 'junction' };
      }
      prev = cur; cur = pick; path.push(cur);
    }
    return { path: path, kind: 'cap' };
  }

  // 剪毛刺：最多 3 轮，每轮先取所有端点（按当前骨架），再逐个回溯，短于 length 且止于分叉的整段删掉
  function prune(n, length) {
    for (var round_ = 0; round_ < 3; round_++) {
      var ends = [];
      for (var k = 0; k < n; k++) { var idx = listA[k]; if (sk[idx] && nbcount(idx) === 1) ends.push(idx); }
      var removed = 0;
      for (k = 0; k < ends.length; k++) {
        if (!sk[ends[k]]) continue;
        var t = trace(ends[k], length + 1);
        if (t.kind === 'junction' && t.path.length < length) {
          for (var q = 0; q < t.path.length; q++) sk[t.path[q]] = 0;
          removed++;
        }
      }
      var w = 0;
      for (k = 0; k < n; k++) if (sk[listA[k]]) listA[w++] = listA[k];
      n = w;
      if (!removed) break;
    }
    return n;
  }

  // ---------- 特征 ----------
  var CR = 2 * FEAT_R + 1;
  var cSk = new Uint8Array(CR * CR), cDil = new Uint8Array(CR * CR), cBm = new Uint8Array(CR * CR);
  var fr = new Int32Array(CR * CR), fc = new Int32Array(CR * CR);
  var lf0 = new Float64Array(CR), lf1 = new Float64Array(CR), lg = new Int32Array(CR);

  // scipy _VoronoiFT 的一条线（长度 len），d = 沿哪一维（0 行 / 1 列），co = 另一维的坐标
  // 读写 fr/fc 中从 start 开始、步长 stride 的元素
  function voronoiLine(start, stride, len, d, co) {
    var l = -1, ii, idx1, idx2;
    for (ii = 0; ii < len; ii++) { lf0[ii] = fr[start + ii * stride]; lf1[ii] = fc[start + ii * stride]; }
    // fd = 沿线坐标，fo = 另一维坐标
    var fdArr = d === 0 ? lf0 : lf1, foArr = d === 0 ? lf1 : lf0;
    for (ii = 0; ii < len; ii++) {
      if (lf0[ii] >= 0) {
        var fd = fdArr[ii];
        var tw = foArr[ii] - co, wR = tw * tw;
        while (l >= 1) {
          idx1 = lg[l]; idx2 = lg[l - 1];
          var f1 = fdArr[idx1];
          var a = f1 - fdArr[idx2], b = fd - f1, c = a + b;
          var tu = foArr[idx2] - co, tv = foArr[idx1] - co;
          var uR = tu * tu, vR = tv * tv;
          if (c * vR - b * uR - a * wR - a * b * c <= 0.0) break;
          --l;
        }
        ++l;
        lg[l] = ii;
      }
    }
    var maxl = l;
    if (maxl >= 0) {
      l = 0;
      for (ii = 0; ii < len; ii++) {
        var t0 = fdArr[lg[l]] - ii, t1 = foArr[lg[l]] - co;
        var delta1 = t0 * t0 + t1 * t1;
        while (l < maxl) {
          var u0 = fdArr[lg[l + 1]] - ii, u1 = foArr[lg[l + 1]] - co;
          var delta2 = u0 * u0 + u1 * u1;
          if (delta1 <= delta2) break;
          delta1 = delta2;
          ++l;
        }
        idx1 = lg[l];
        fr[start + ii * stride] = lf0[idx1]; fc[start + ii * stride] = lf1[idx1];
      }
    }
  }

  // 特征变换：cSk（h×w）里每个像素最近的骨架像素 → fr/fc（先逐列、再逐行）
  function featureTransform(h, w) {
    var N = h * w, r, c, k;
    for (k = 0; k < N; k++) { fr[k] = 0; fc[k] = 0; }
    for (c = 0; c < w; c++) {
      for (r = 0; r < h; r++) {
        var q = r * w + c;
        if (cSk[q]) { fr[q] = r; fc[q] = c; } else fr[q] = -1;
      }
      voronoiLine(c, w, h, 0, c);
    }
    for (r = 0; r < h; r++) voronoiLine(r * w, 1, w, 1, r);
  }

  // 前方空旷、离别的轨迹、方向（度，0 = 东，逆时针）；与 deadends.features 一致
  function features(path) {
    var tip = path[0];
    var ty = ((tip / P) | 0) - 1, tx = (tip % P) - 1;
    var y0 = Math.max(ty - FEAT_R, 0), y1 = Math.min(ty + FEAT_R + 1, W);
    var x0 = Math.max(tx - FEAT_R, 0), x1 = Math.min(tx + FEAT_R + 1, W);
    var h = y1 - y0, w = x1 - x0, N = h * w, r, c, k;
    var anySk = false;
    for (r = 0; r < h; r++) {
      var src = (y0 + r + 1) * P + (x0 + 1), dst = r * w;
      for (c = 0; c < w; c++) {
        var s = sk[src + c];
        cSk[dst + c] = s; cDil[dst + c] = dil[src + c]; cBm[dst + c] = 0;
        if (s) anySk = true;
      }
    }
    for (k = 0; k < path.length; k++) {
      var py = ((path[k] / P) | 0) - 1, px = (path[k] % P) - 1;
      if (py >= y0 && py < y1 && px >= x0 && px < x1) cBm[(py - y0) * w + (px - x0)] = 1;
    }
    if (anySk) featureTransform(h, w);
    // 方向：端点指向回溯 8 步处的反方向
    var kk = Math.min(path.length - 1, 8), vy = 0, vx = 0, dir = null, hasV = kk > 0;
    if (hasV) {
      var ay = ((path[0] / P) | 0) - ((path[kk] / P) | 0), ax = (path[0] % P) - (path[kk] % P);
      var nrm = Math.sqrt(ay * ay + ax * ax);
      vy = ay / nrm; vx = ax / nrm;
      dir = Math.atan2(-vy, vx) * (180 / Math.PI);
    }
    var cy = ty - y0, cx = tx - x0, touch = Infinity, fwd = Infinity, found = false;
    for (r = 0; r < h; r++) {
      for (c = 0; c < w; c++) {
        var q2 = r * w + c;
        if (!cDil[q2]) continue;
        if (anySk ? cBm[fr[q2] * w + fc[q2]] : true) continue;   // 属于这条支线自己的像素
        found = true;
        var dy = r - cy, dx = c - cx, d = Math.hypot(dy, dx);
        if (d < touch) touch = d;
        if (hasV) {
          var cs = (dy * vy + dx * vx) / Math.max(d, 1e-9);
          if (cs >= COS_CONE && d < fwd) fwd = d;
        }
      }
    }
    if (!found) return { forward: FEAT_R, touch: FEAT_R, dir: dir };
    if (!hasV) return { forward: touch, touch: touch, dir: dir };
    if (fwd === Infinity) fwd = FEAT_R;
    return { forward: Math.min(fwd, FEAT_R), touch: Math.min(touch, FEAT_R), dir: dir };
  }

  function score(length, forward, touch) {
    var g = 1 - Math.exp(-Math.max(length - 5, 0) / 15);
    var h = 1 - Math.exp(-Math.max(forward - 3, 0) / 8);
    var k = 1 - Math.exp(-Math.max(touch - 1, 0) / 2);
    return round(100 * g * h * k, 1);
  }

  global.FogDetectCore = {
    processWindow: processWindow,
    round: round,
    CORE: CORE, MARGIN: MARGIN, SUB: SUB, NSUB: NSUB,
    VERSION: 1,
    // 测试用：单独跑骨架化 / 特征变换，和 scikit-image / scipy 对比（tools/detect_selftest.js）
    _skeletonize: function (img, h, w) {
      sk.fill(0);
      var n = 0;
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) if (img[y * w + x]) { sk[(y + 1) * P + x + 1] = 1; listA[n++] = (y + 1) * P + x + 1; }
      skeletonize(n);
      var out = new Uint8Array(h * w);
      for (y = 0; y < h; y++) for (x = 0; x < w; x++) out[y * w + x] = sk[(y + 1) * P + x + 1];
      return out;
    },
    _featureTransform: function (mask, h, w) {
      cSk.set(mask.subarray(0, h * w)); featureTransform(h, w);
      return [fr.slice(0, h * w), fc.slice(0, h * w)];
    },          // 算法有改动时加一，浏览器里的窗口缓存随之失效
  };
})(typeof window !== 'undefined' ? window : globalThis);
