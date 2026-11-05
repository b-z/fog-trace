/*
 * editor.js — 在 Leaflet 地图上编辑迷雾：橡皮擦、折线画笔、撤销/重做、导出存档。
 *
 *   var ed = FogEditor.attach({ map, store, layer, toast, api });
 *   await ed.ready;          // 已回放保存的编辑记录
 *
 * store  = FogStore.create(archive)；layer = createFogLayer(null, { source: store })
 * api    = { load(): Promise<{ops, ptr, exported_ptr}>, save(doc): Promise }
 * t        = function (key, params) 界面文字，默认用 FogI18n.t（src/i18n.js）
 * onChange = function ({ops, ptr, exportedPtr})  每次编辑 / 撤销 / 重做 / 导出后调用，可省略
 * snapPoints = function () → [[x, y], ...]  可吸附的端点（世界像素，像素中心 = 整数 + 0.5），可省略
 * box  = { label, hint, count(bounds) → n, apply(bounds) }  可省略；提供时多一个「框选」工具（B），
 *        拖出矩形后把 L.LatLngBounds 交给 apply，拖动中用 count 显示框内数量
 *
 * 操作方式
 *   浏览 V：拖动平移、滚轮缩放（编辑模式下滚轮也能缩放）
 *   橡皮擦 E：按住左键拖动擦除；圆圈大小是屏幕像素，[ / ] 调整；按住空格临时拖动地图；需放大到 12 级以上
 *   画笔 P：1px 线（与轨迹同宽）。单击加点，右键 / 双击 / Enter 结束，Backspace 删上一个点，Esc 取消；
 *          拖动仍是平移地图；切换到别的工具或导出时自动完成当前折线
 *          吸附：顶点自动接到附近的端点（检测出的断头、画过的线的两端），其次接到附近的轨迹像素；按住 ⌥ 不吸附
 *   框选 B（有 box 时）：按住左键拖出矩形；按住空格临时拖地图，Esc 取消
 *   撤销 ⌘Z / 重做 ⇧⌘Z：画到一半时 ⌘Z 只删上一个点
 * 每一笔（一次拖擦 / 一条折线）是一步，记录成世界像素坐标的矢量操作，存到服务器，刷新后回放。
 */
(function (global) {
  'use strict';

  var MIN_ERASE_ZOOM = 12;
  var PEN_W = 1;                 // 画笔线宽（世界像素）= 原轨迹宽度
  var SNAP_END_PX = 14;          // 吸附半径（屏幕像素）：端点
  var SNAP_TRACK_PX = 8;         //                     轨迹像素

  function attach(o) {
    var map = o.map, store = o.store, layer = o.layer, api = o.api;
    var toast = o.toast || function () {};
    var t = o.t || (global.FogI18n ? global.FogI18n.t : function (k) { return k; });   // 界面文字（src/i18n.js）
    var G = global.FogGeo;
    var container = map.getContainer();

    var ops = [], ptr = 0, diffs = [], exportedPtr = null;
    var tool = 'pan', eraserPx = 16;
    var queue = Promise.resolve(), busy = 0;
    var stroke = null, spaceDown = false;                       // 橡皮擦状态
    var penPts = [], penLine = null, penRubber = null, mouseLL = null;  // 画笔状态
    var snapMark = null, lastMouse = null;                               // 吸附提示
    var box = null, boxRect = null;                                      // 框选状态

    function enqueue(fn) {
      busy++; render();
      queue = queue.then(fn).catch(function (e) {
        console.error(e); toast(t('e.error', { e: e.message }));
      }).then(function () { busy--; render(); });
      return queue;
    }
    var saving = Promise.resolve();
    function save() {
      var doc = { ops: ops, ptr: ptr, exported_ptr: exportedPtr };
      if (o.onChange) o.onChange({ ops: ops.length, ptr: ptr, exportedPtr: exportedPtr });
      saving = saving.then(function () { return api.save(doc); }).catch(function (e) { toast(t('e.saveFail', { e: e.message })); });
    }

    function world(latlng) {
      return [Math.round(G.lngToWorldX(latlng.lng) * 100) / 100, Math.round(G.latToWorldY(latlng.lat) * 100) / 100];
    }
    function wpp() { return Math.pow(2, 14 - map.getZoom()); }   // 每个屏幕 (CSS) 像素 = 多少世界像素
    function mpp(lat) { return 40075016.686 * Math.cos(lat * Math.PI / 180) / G.WORLD_PX; }
    function refresh(rect) { if (rect) layer.refreshRect(rect); }
    function segRect(a, b, r) {
      return [Math.min(a[0], b[0]) - r - 1, Math.min(a[1], b[1]) - r - 1, Math.max(a[0], b[0]) + r + 1, Math.max(a[1], b[1]) + r + 1];
    }

    // ---------- 工具栏 ----------
    var bar = L.DomUtil.create('div', 'fog-edit-bar', container);
    bar.innerHTML =
      '<div class="seg">' +
      '<button data-tool="pan" title="' + t('e.pan') + ' (V)">' + t('e.pan') + '<kbd>V</kbd></button>' +
      '<button data-tool="erase" title="' + t('e.erase') + ' (E)">' + t('e.erase') + '<kbd>E</kbd></button>' +
      '<button data-tool="pen" title="' + t('e.pen') + ' (P)">' + t('e.pen') + '<kbd>P</kbd></button>' +
      (o.box ? '<button data-tool="box" title="' + o.box.label + ' (B)">' + o.box.label + '<kbd>B</kbd></button>' : '') +
      '</div>' +
      '<label class="opt opt-erase">' + t('e.size') + ' <input type="range" min="4" max="80" step="2" value="' + eraserPx + '"><span></span></label>' +
      '<span class="opt opt-pen">' + t('e.penHint') + '</span>' +
      (o.box ? '<span class="opt opt-box">' + (o.box.hint || '') + '</span>' : '') +
      '<div class="seg"><button data-act="undo" title="' + t('e.undo') + '">↶</button><button data-act="redo" title="' + t('e.redo') + '">↷</button></div>' +
      '<span class="edit-status"></span>' +
      '<button data-act="export" class="export" title="' + t('e.exportTitle') + '">' + t('e.export') + '</button>';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.disableScrollPropagation(bar);
    var sizeIn = bar.querySelector('.opt-erase input'), sizeLbl = bar.querySelector('.opt-erase span');
    var statusEl = bar.querySelector('.edit-status');
    bar.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tool) setTool(b.dataset.tool);
      else if (b.dataset.act === 'undo') undo();
      else if (b.dataset.act === 'redo') redo();
      else if (b.dataset.act === 'export') exportZip();
    });
    sizeIn.addEventListener('input', function () { eraserPx = +sizeIn.value; render(); });

    var cursor = L.DomUtil.create('div', 'fog-eraser-cursor', container);
    var boxTip = L.DomUtil.create('div', 'fog-box-tip', container);

    function render() {
      bar.querySelectorAll('[data-tool]').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === tool); });
      bar.querySelector('.opt-erase').style.display = tool === 'erase' ? '' : 'none';
      bar.querySelector('.opt-pen').style.display = tool === 'pen' ? '' : 'none';
      if (o.box) bar.querySelector('.opt-box').style.display = tool === 'box' ? '' : 'none';
      var lat = map.getCenter().lat;
      sizeLbl.textContent = '≈' + Math.round(eraserPx * wpp() * mpp(lat)) + ' m';
      bar.querySelector('[data-act="undo"]').disabled = !(ptr > 0 || penPts.length);
      bar.querySelector('[data-act="redo"]').disabled = ptr >= ops.length;
      var s = busy ? t('e.busy') : ptr === 0 ? t('e.none') :
        t('e.steps', { n: ptr }) + ' · ' + (exportedPtr === ptr ? t('e.exported') : t('e.notExported'));
      if (tool === 'erase' && map.getZoom() < MIN_ERASE_ZOOM) s = t('e.zoomIn', { z: MIN_ERASE_ZOOM });
      statusEl.textContent = s;
      statusEl.classList.toggle('warn', ptr > 0 && exportedPtr !== ptr);
      cursor.style.width = cursor.style.height = (2 * eraserPx) + 'px';
      container.classList.toggle('fog-tool-erase', tool === 'erase' && !spaceDown);
      container.classList.toggle('fog-tool-pen', tool === 'pen');
      container.classList.toggle('fog-tool-box', tool === 'box' && !spaceDown);
      container.classList.toggle('fog-editing', tool !== 'pan');
    }
    map.on('zoomend moveend', render);

    function setTool(t) {
      if (t === tool) return;
      if (tool === 'pen') { finishPen(true); showSnap(null); }
      if (tool === 'erase') endStroke();
      if (tool === 'box') cancelBox();
      tool = t;
      if (t === 'erase' || t === 'box') map.dragging.disable(); else map.dragging.enable();
      if (t === 'pen') map.doubleClickZoom.disable(); else map.doubleClickZoom.enable();
      if (t === 'box') map.boxZoom.disable(); else map.boxZoom.enable();
      cursor.style.display = 'none';
      render();
    }

    // ---------- 提交 / 撤销 / 重做 ----------
    function commit(op, diff) {
      ops.length = ptr; diffs.length = ptr;
      ops.push(op); diffs.push(diff); ptr++;
      save(); render();
    }
    function undo() {
      if (tool === 'pen' && penPts.length) { penPts.pop(); drawPen(); render(); return; }
      enqueue(async function () {
        if (ptr === 0) return;
        ptr--;
        var d = diffs[ptr];
        await store.applyDiff(d, 'before');
        refresh(d.rect); save();
        toast(t('e.undone'));
      });
    }
    function redo() {
      enqueue(async function () {
        if (ptr >= ops.length) return;
        var d = diffs[ptr];
        if (d) await store.applyDiff(d, 'after');
        else d = diffs[ptr] = await store.applyOp(ops[ptr]);
        ptr++;
        refresh(d.rect); save();
        toast(t('e.redone'));
      });
    }

    // ---------- 橡皮擦 ----------
    function moveCursor(e) {
      if (tool !== 'erase' || spaceDown) { cursor.style.display = 'none'; return; }
      var p = map.mouseEventToContainerPoint(e);
      cursor.style.display = 'block';
      cursor.style.left = p.x + 'px'; cursor.style.top = p.y + 'px';
    }
    container.addEventListener('mousemove', function (e) {
      moveCursor(e);
      if (box) moveBox(e);
      if (!stroke) return;
      var w = world(map.mouseEventToLatLng(e)), last = stroke.pts[stroke.pts.length - 1];
      if (Math.hypot(w[0] - last[0], w[1] - last[1]) < Math.max(0.5, stroke.r * 0.25)) return;
      stroke.pts.push(w);
      var s = stroke;
      enqueue(function () {
        return store.paintSegment([last[0], last[1], w[0], w[1]], s.r, 0, s.diff).then(function () { refresh(segRect(last, w, s.r)); });
      });
    });
    container.addEventListener('mouseleave', function () { cursor.style.display = 'none'; });
    container.addEventListener('mousedown', function (e) {
      if (tool !== 'erase' || spaceDown || e.button !== 0) return;
      e.preventDefault();
      if (map.getZoom() < MIN_ERASE_ZOOM) { toast(t('e.zoomIn', { z: MIN_ERASE_ZOOM })); return; }
      var w = world(map.mouseEventToLatLng(e)), r = Math.round(eraserPx * wpp() * 100) / 100;
      stroke = { r: r, pts: [w], diff: store.newDiff() };
      var s = stroke;
      enqueue(function () {
        return store.paintSegment([w[0], w[1], w[0], w[1]], r, 0, s.diff).then(function () { refresh(segRect(w, w, r)); });
      });
    });
    function endStroke() {
      if (!stroke) return;
      var s = stroke; stroke = null;
      enqueue(function () {
        if (!s.diff.entries.size) return;          // 没擦到任何像素：不记一步
        commit({ type: 'erase', r: s.r, pts: s.pts }, s.diff);
      });
    }
    document.addEventListener('mouseup', endStroke);

    // ---------- 折线画笔 ----------
    var BLOCK = G.BLOCK_PX, NB = G.N;
    function toLL(w) { return L.latLng(G.worldYToLat(w[1]), G.worldXToLng(w[0])); }
    function center(w) { return [Math.floor(w[0]) + 0.5, Math.floor(w[1]) + 0.5]; }
    // 遍历世界像素矩形 [x0,x1)×[y0,y1) 内的轨迹像素（只看已载入的区块，同步）
    function forEachTrackPixel(x0, y0, x1, y1, cb) {
      for (var by = Math.floor(y0 / BLOCK); by <= Math.floor((y1 - 1) / BLOCK); by++) {
        for (var bx = Math.floor(x0 / BLOCK); bx <= Math.floor((x1 - 1) / BLOCK); bx++) {
          var st = store.peek(by * NB + bx);
          if (!st) continue;
          var ox = bx * BLOCK, oy = by * BLOCK;
          st.forEachSetPixelInRect(x0 - ox, y0 - oy, x1 - ox, y1 - oy, function (x, y) { cb(x + ox, y + oy); });
        }
      }
    }
    // 端点所在处还有轨迹吗（被擦掉的断头不再吸附）；区块没载入时当作有
    function trackNear(p) {
      var x = Math.floor(p[0]), y = Math.floor(p[1]);
      var bx = Math.floor(x / BLOCK), by = Math.floor(y / BLOCK);
      if (!store.peek(by * NB + bx)) return true;
      var hit = false;
      forEachTrackPixel(x - 1, y - 1, x + 2, y + 2, function () { hit = true; });
      return hit;
    }
    function endpoints() {
      var out = o.snapPoints ? o.snapPoints().slice() : [];
      for (var i = 0; i < ptr; i++) {
        var op = ops[i];
        if (op.type === 'line') { out.push(op.pts[0]); out.push(op.pts[op.pts.length - 1]); }
      }
      return out;
    }
    // 鼠标位置 → 顶点：优先最近的端点，其次最近的轨迹像素，否则所在像素的中心
    function snapAt(w, off) {
      if (off) return { w: center(w), kind: null };
      var k = wpp();
      var rEnd = Math.min(Math.max(SNAP_END_PX * k, 2), 256), rTrk = Math.min(Math.max(SNAP_TRACK_PX * k, 1.5), 64);
      var cands = [];
      endpoints().forEach(function (p) {
        var d = Math.hypot(p[0] - w[0], p[1] - w[1]);
        if (d <= rEnd) cands.push([d, p]);
      });
      cands.sort(function (a, b) { return a[0] - b[0]; });
      for (var i = 0; i < cands.length; i++) {
        if (trackNear(cands[i][1])) return { w: center(cands[i][1]), kind: 'end' };
      }
      var best = null, bd = rTrk * rTrk;
      forEachTrackPixel(Math.floor(w[0] - rTrk), Math.floor(w[1] - rTrk), Math.ceil(w[0] + rTrk), Math.ceil(w[1] + rTrk), function (x, y) {
        var dx = x + 0.5 - w[0], dy = y + 0.5 - w[1], d = dx * dx + dy * dy;
        if (d <= bd) { bd = d; best = [x + 0.5, y + 0.5]; }
      });
      if (best) return { w: best, kind: 'track' };
      return { w: center(w), kind: null };
    }
    function showSnap(sn) {
      if (!sn || !sn.kind) { if (snapMark) { map.removeLayer(snapMark); snapMark = null; } return; }
      var half = Math.pow(2, map.getZoom() - 14) / 2;   // 半个像素的屏幕尺寸：圈要套住整个像素
      var style = sn.kind === 'end' ? { radius: Math.max(8, half * 1.5 + 5), color: '#4df0ff', weight: 2.5, fill: false } :
                                      { radius: Math.max(5, half * 1.5 + 3), color: '#4df0ff', weight: 1.5, dashArray: '3 3', fill: false };
      if (snapMark && (snapMark.options.radius !== style.radius || snapMark.options.weight !== style.weight)) { map.removeLayer(snapMark); snapMark = null; }
      if (!snapMark) snapMark = L.circleMarker(toLL(sn.w), L.extend({ interactive: false }, style)).addTo(map);
      else snapMark.setLatLng(toLL(sn.w));
      snapMark.bringToFront();
    }

    var penDots = L.layerGroup().addTo(map);
    function drawPen() {
      var lls = penPts.map(function (p) { return p.ll; });
      var weight = Math.max(2, Math.pow(2, map.getZoom() - 14) * PEN_W);   // 与将画出的像素同宽，至少 2 屏幕像素
      if (!penLine) penLine = L.polyline([], { color: '#ffd34d', interactive: false }).addTo(map);
      if (!penRubber) penRubber = L.polyline([], { color: '#ffd34d', dashArray: '4 5', interactive: false }).addTo(map);
      penLine.setStyle({ weight: weight });
      penLine.setStyle({ opacity: 0.85 });
      penRubber.setStyle({ weight: Math.max(1.5, weight * 0.5), opacity: 0.7 });
      penLine.setLatLngs(lls);
      penRubber.setLatLngs(lls.length && mouseLL ? [lls[lls.length - 1], mouseLL] : []);
      penDots.clearLayers();
      lls.forEach(function (ll) { L.circleMarker(ll, { radius: 3, color: '#ffd34d', fillOpacity: 1, interactive: false }).addTo(penDots); });
      if (snapMark) snapMark.bringToFront();
    }
    map.on('zoomend', function () { if (penPts.length) drawPen(); });
    function cancelPen() {
      penPts = []; mouseLL = null;
      if (penLine) { map.removeLayer(penLine); penLine = null; }
      if (penRubber) { map.removeLayer(penRubber); penRubber = null; }
      penDots.clearLayers(); render();
    }
    // auto = 切换工具 / 导出时自动完成：不足两个点就丢弃
    function finishPen(auto) {
      if (!penPts.length) return;
      if (penPts.length < 2) {
        if (auto) cancelPen(); else toast(t('e.twoPoints'));
        return;
      }
      var pts = penPts.map(function (p) { return p.w; }), op = { type: 'line', w: PEN_W, pts: pts };
      cancelPen();
      enqueue(async function () {
        var d = await store.applyOp(op);
        if (!d.entries.size) { toast(t('e.noChange')); return; }
        refresh(d.rect);
        commit(op, d);
      });
    }
    function hover(latlng, alt) {
      lastMouse = { latlng: latlng, alt: alt };
      var sn = snapAt(world(latlng), alt);
      showSnap(sn);
      mouseLL = toLL(sn.w);
      if (penPts.length) drawPen();
      return sn;
    }
    map.on('click', function (e) {
      if (tool !== 'pen') return;
      var sn = snapAt(world(e.latlng), e.originalEvent.altKey), last = penPts[penPts.length - 1];
      if (last) {   // 双击的第二下、或吸附到同一点：不重复加点
        var a = map.latLngToContainerPoint(last.ll), b = map.latLngToContainerPoint(toLL(sn.w));
        if ((sn.w[0] === last.w[0] && sn.w[1] === last.w[1]) || a.distanceTo(b) < 3) return;
      }
      penPts.push({ w: sn.w, ll: toLL(sn.w) });
      drawPen(); render();
    });
    map.on('dblclick', function () { if (tool === 'pen') finishPen(); });
    container.addEventListener('contextmenu', function (e) {
      if (tool !== 'pen') return;
      e.preventDefault();
      finishPen();
    });
    map.on('mousemove', function (e) { if (tool === 'pen') hover(e.latlng, e.originalEvent.altKey); });
    map.on('mouseout', function () { showSnap(null); });

    // ---------- 框选 ----------
    function boxBounds(e) { return L.latLngBounds(box.start, map.mouseEventToLatLng(e)); }
    container.addEventListener('mousedown', function (e) {
      if (tool !== 'box' || spaceDown || e.button !== 0 || e.target.closest('.fog-edit-bar')) return;
      e.preventDefault();
      box = { start: map.mouseEventToLatLng(e), p0: map.mouseEventToContainerPoint(e) };
    });
    function moveBox(e) {
      var p = map.mouseEventToContainerPoint(e), b = boxBounds(e);
      if (!boxRect) boxRect = L.rectangle(b, { color: '#ffd34d', weight: 1.5, dashArray: '5 4', fillOpacity: 0.08, interactive: false }).addTo(map);
      else boxRect.setBounds(b);
      boxTip.style.display = 'block';
      boxTip.style.left = (p.x + 14) + 'px'; boxTip.style.top = (p.y + 14) + 'px';
      boxTip.textContent = o.box.count(b);
    }
    function cancelBox() {
      box = null;
      if (boxRect) { map.removeLayer(boxRect); boxRect = null; }
      boxTip.style.display = 'none';
    }
    document.addEventListener('mouseup', function (e) {
      if (!box) return;
      var p = map.mouseEventToContainerPoint(e), small = p.distanceTo(box.p0) < 5, b = boxBounds(e);
      cancelBox();
      if (!small) o.box.apply(b);     // 只是点一下（没拖出矩形）就什么都不做
    });

    // ---------- 导出 ----------
    function stamp() {
      var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
    }
    function exportZip() {
      if (tool === 'pen') finishPen(true);
      enqueue(async function () {
        toast(t('e.packing'));
        var res = await store.exportZip('blob'), s = res.summary;
        var name = 'Sync-edited-' + stamp() + '.zip';
        var a = document.createElement('a');
        a.href = URL.createObjectURL(res.data); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
        exportedPtr = ptr; save();
        toast(t('e.exportDone', { name: name, changed: s.changed, created: s.created, emptied: s.emptied, copied: s.copied }));
      });
    }

    // ---------- 键盘 ----------
    document.addEventListener('keydown', function (e) {
      var tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      var k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Alt' && tool === 'pen' && lastMouse) { hover(lastMouse.latlng, true); return; }
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (mod && k === 'y') { e.preventDefault(); redo(); return; }
      if (mod || e.altKey) return;
      if (k === 'v') setTool('pan');
      else if (k === 'e') setTool('erase');
      else if (k === 'p') setTool('pen');
      else if (k === 'b' && o.box) setTool('box');
      else if (k === 'escape') { if (penPts.length) cancelPen(); else if (box) cancelBox(); else setTool('pan'); }
      else if (k === 'enter' && tool === 'pen') { e.preventDefault(); finishPen(); }
      else if (k === 'backspace' && tool === 'pen' && penPts.length) { e.preventDefault(); penPts.pop(); drawPen(); render(); }
      else if ((k === '[' || k === ']') && tool === 'erase') {
        eraserPx = Math.max(4, Math.min(80, eraserPx + (k === ']' ? 4 : -4))); sizeIn.value = eraserPx; render();
      } else if (k === ' ' && (tool === 'erase' || tool === 'box')) {
        e.preventDefault();
        if (!spaceDown) { spaceDown = true; endStroke(); cancelBox(); map.dragging.enable(); cursor.style.display = 'none'; render(); }
      }
    });
    document.addEventListener('keyup', function (e) {
      if (e.key === 'Alt' && tool === 'pen' && lastMouse) hover(lastMouse.latlng, false);
      if (e.key === ' ' && spaceDown) { spaceDown = false; if (tool === 'erase' || tool === 'box') map.dragging.disable(); render(); }
    });

    // ---------- 载入并回放已保存的编辑 ----------
    var ready = (async function () {
      var doc = await api.load();
      ops = doc.ops || []; ptr = Math.min(doc.ptr == null ? ops.length : doc.ptr, ops.length);
      exportedPtr = doc.exported_ptr == null ? null : doc.exported_ptr;
      for (var i = 0; i < ptr; i++) diffs[i] = await store.applyOp(ops[i]);
      render();
      return { ops: ops.length, ptr: ptr };
    })();
    render();

    return {
      ready: ready,
      setTool: setTool, undo: undo, redo: redo, exportZip: exportZip,
      store: store, snapAt: function (w, off) { return snapAt(w, off); },
      get state() { return { tool: tool, ops: ops.length, ptr: ptr, exportedPtr: exportedPtr, busy: busy, penPts: penPts.length }; },
      idle: function () { return queue; },
    };
  }

  global.FogEditor = { attach: attach };
})(typeof window !== 'undefined' ? window : globalThis);
