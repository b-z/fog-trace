/* flights-page.js — 航班页：读 Flighty CSV，预览弧线，在 Worker 里生成快照并下载 */
(function () {
  'use strict';
  var t = FogI18n.t, $ = function (id) { return document.getElementById(id); };
  var STORE_KEY = 'fog-trace-flights-last';   // { ids: [...], last: 'YYYY-MM-DD', at: ISO 时间 }
  FogI18n.apply();
  document.title = t('fl.docTitle');
  document.querySelector('meta[name=description]').content = t('fl.desc');

  var langSel = $('lang');
  FogI18n.LANGS.forEach(function (l) {
    var o = document.createElement('option');
    o.value = l; o.textContent = FogI18n.NAMES[l]; o.selected = l === FogI18n.lang;
    langSel.appendChild(o);
  });
  langSel.onchange = function () { FogI18n.set(this.value); };

  var parsed = null, fileName = '', list = [], bends = null, reqId = 0, busy = false, lastUrl = null;
  var worker = new Worker('src/flights-worker.js');
  var pending = {};
  worker.onmessage = function (e) { var h = pending[e.data.id]; if (h) h(e.data); };
  function ask(msg, onMsg) { var id = ++reqId; msg.id = id; pending[id] = onMsg; worker.postMessage(msg); return id; }

  function loadState() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; } }
  function saveState(s) { try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式：不记 */ } }
  function nextDay(d) { var x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---------- 地图预览 ----------
  var map = null, layer = null;
  function ensureMap() {
    if (map) return;
    map = L.map('map', { minZoom: 1, maxZoom: 10, worldCopyJump: true, preferCanvas: true }).setView([30, 120], 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, className: 'osm',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  var lines = [];   // 与 list 对应的预览折线（定好弯曲后才有）
  function drawPreview(fit) {
    ensureMap();
    layer.clearLayers();
    if (!bends) return;
    var draw = drawSet(), bounds = null;
    lines = list.map(function (f, i) { return FogFlights.previewLine(f, bends[i], 64); });
    // 跨太平洋的航线：整条平移 360°，让所有航线落在同一份世界里（以所有航线中点的圆周平均经度为中心）
    var sx = 0, sy = 0;
    lines.forEach(function (ln) { var m = ln[ln.length >> 1][1] * Math.PI / 180; sx += Math.cos(m); sy += Math.sin(m); });
    var centre = Math.atan2(sy, sx) * 180 / Math.PI;
    lines = lines.map(function (ln) {
      var k = 360 * Math.round((centre - ln[ln.length >> 1][1]) / 360);
      return k ? ln.map(function (p) { return [p[0], p[1] + k]; }) : ln;
    });
    var order = list.map(function (f, i) { return i; }).sort(function (a, b) { return draw.has(a) - draw.has(b); });
    order.forEach(function (i) {
      var on = draw.has(i);
      L.polyline(lines[i], { color: on ? '#50dc8c' : '#9a9a9a', weight: on ? 1.4 : 1, opacity: on ? 0.95 : 0.45, interactive: false }).addTo(layer);
      if (on) bounds = bounds ? bounds.extend(L.latLngBounds(lines[i])) : L.latLngBounds(lines[i]);
    });
    if (fit && bounds) map.fitBounds(bounds, { padding: [16, 16], maxZoom: 6 });
  }

  // ---------- 选择 ----------
  function mode() { return document.querySelector('input[name=mode]:checked').value; }
  function drawSet() {
    var s = new Set(), since = $('o-since').value;
    list.forEach(function (f, i) { if (mode() === 'all' || (since && f.date >= since)) s.add(i); });
    return s;
  }
  function fileNameFor(prefix) {
    prefix = (prefix || '').trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
    return (prefix ? prefix + '-' : '') + 'Snapshot-' + FogFlights.fileStamp(new Date()) + '.fwss';
  }
  function refresh() {
    var draw = drawSet(), st = loadState();
    $('count').textContent = t('fl.drawCount', { n: draw.size, total: list.length });
    $('fname').textContent = fileNameFor($('o-prefix').value).replace(/\d{8}T\d{6}[+-]\d{4}/, '…');
    $('last').textContent = st ? t('fl.lastExport', { date: (st.at || '').slice(0, 10), last: st.last }) : '';
    var warn = '';
    if (mode() === 'new' && st && $('o-since').value) {
      var ids = new Set(st.ids), since = $('o-since').value, n = 0;
      list.forEach(function (f) { if (f.date < since && !ids.has(f.id)) n++; });
      if (n) warn = t('fl.backfill', { n: n, date: since });
    }
    $('warn').textContent = warn;
    $('b-gen').disabled = busy || !bends || !draw.size;
    drawPreview(false);
  }

  function rebuildList(fit) {
    var up = $('o-up').checked;
    list = parsed.flights.filter(function (f) { return up || !f.upcoming; });
    bends = null;
    $('b-gen').disabled = true;
    $('count').textContent = t('fl.bends');
    var id = ask({ cmd: 'bends', flights: list }, function (m) {
      delete pending[id];
      if (id !== reqId) return;      // 已经有更新的请求
      if (m.type === 'error') { $('err').textContent = t('fl.error', { e: m.error }); return; }
      bends = m.bends;
      refresh();
      drawPreview(fit);
    });
  }

  // ---------- 读文件 ----------
  async function openFile(file) {
    $('err').textContent = '';
    $('result').hidden = true;
    var text;
    try { text = await file.text(); } catch (e) { $('err').textContent = t('fl.error', { e: e.message }); return; }
    try {
      parsed = FogFlights.readFlighty(text, new Date());
    } catch (e) {
      parsed = null; $('s-opts').hidden = true; $('summary').textContent = '';
      $('err').textContent = e.message === 'columns' || e.message === 'empty' ? t('fl.badFile') : t('fl.error', { e: e.message });
      return;
    }
    fileName = file.name;
    var fl = parsed.flights, up = fl.filter(function (f) { return f.upcoming; }).length;
    var routes = new Set(fl.map(function (f) { return FogFlights.route(f).key; })).size;
    var lines = [esc(t('fl.loaded', { file: fileName, n: fl.length, flown: fl.length - up, up: up, routes: routes }))];
    if (parsed.canceled) lines.push(esc(t('fl.canceled', { n: parsed.canceled })));
    var unk = Object.keys(parsed.unknown);
    if (unk.length) {
      var n = unk.reduce(function (s, k) { return s + parsed.unknown[k]; }, 0);
      lines.push('<span class="warn">' + esc(t('fl.unknown', { n: n, codes: unk.sort().join(', ') })) + '</span>');
    }
    $('summary').innerHTML = lines.join('<br>');
    if (!fl.length) { $('s-opts').hidden = true; $('err').textContent = t('fl.nothing'); return; }
    $('s-opts').hidden = false;
    var st = loadState(), flown = fl.filter(function (f) { return !f.upcoming; });
    var latest = (flown.length ? flown : fl)[(flown.length ? flown : fl).length - 1].date;
    if (st && st.last) {
      $('o-since').value = nextDay(st.last);
      document.querySelector('input[name=mode][value=new]').checked = true;
      $('o-prefix').value = 'Flights-new';
    } else {
      $('o-since').value = latest;
      document.querySelector('input[name=mode][value=all]').checked = true;
      $('o-prefix').value = 'Flights';
    }
    ensureMap();
    setTimeout(function () { map.invalidateSize(); }, 0);
    rebuildList(true);
  }

  $('b-pick').onclick = function () { $('f').click(); };
  $('f').onchange = function () { if (this.files[0]) openFile(this.files[0]); this.value = ''; };
  document.addEventListener('dragover', function (e) { e.preventDefault(); document.body.classList.add('drag'); });
  document.addEventListener('dragleave', function (e) { if (!e.relatedTarget) document.body.classList.remove('drag'); });
  document.addEventListener('drop', function (e) {
    e.preventDefault(); document.body.classList.remove('drag');
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) openFile(f);
  });
  $('o-up').onchange = function () { rebuildList(false); };
  document.querySelectorAll('input[name=mode]').forEach(function (r) {
    r.onchange = function () {
      var p = $('o-prefix');
      if (p.value === 'Flights' || p.value === 'Flights-new') p.value = mode() === 'all' ? 'Flights' : 'Flights-new';
      refresh(); drawPreview(true);
    };
  });
  $('o-since').onchange = function () { document.querySelector('input[name=mode][value=new]').checked = true; refresh(); drawPreview(true); };
  $('o-prefix').oninput = refresh;

  // ---------- 生成 ----------
  function progress(text, frac) {
    $('prog').classList.add('on');
    $('prog').querySelector('span').textContent = text;
    $('prog').querySelector('i').style.width = Math.round(100 * frac) + '%';
  }
  $('b-gen').onclick = function () {
    if (typeof CompressionStream === 'undefined') { $('err').textContent = t('fl.old'); return; }
    var draw = Array.from(drawSet()).sort(function (a, b) { return a - b; });
    if (!draw.length) return;
    var name = fileNameFor($('o-prefix').value), m = mode(), snapList = list.slice();
    busy = true; $('b-gen').disabled = true; $('result').hidden = true; $('err').textContent = '';
    progress(t('fl.bends'), 0);
    var id = ask({ cmd: 'build', flights: list, bends: bends, draw: draw }, function (msg) {
      if (msg.type === 'progress') {
        if (msg.phase === 'raster') progress(t('fl.raster', { done: msg.done, total: msg.total }), msg.total ? msg.done / msg.total : 0);
        else progress(t('fl.zip'), 1);
        return;
      }
      delete pending[id];
      busy = false;
      $('prog').classList.remove('on');
      if (msg.type === 'error') { $('err').textContent = t('fl.error', { e: msg.error }); refresh(); return; }
      var file = new File([msg.blob], name, { type: 'application/octet-stream' });
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(file);
      var a = $('r-dl'); a.href = lastUrl; a.download = name;
      var share = $('r-share');
      share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
      share.onclick = function () { navigator.share({ files: [file] }).catch(function () { /* 取消 */ }); };
      $('r-info').textContent = t('fl.done', { name: name, size: (file.size / 1048576).toFixed(1) + ' MB', n: draw.length, blocks: msg.blocks });
      $('result').hidden = false;
      // 记住这次快照包含的航班，下次推荐「只要新航班」的起始日期
      var st = m === 'new' ? loadState() : null, ids = new Set(st ? st.ids : []), last = st ? st.last : '';
      draw.forEach(function (i) { ids.add(snapList[i].id); if (snapList[i].date > last) last = snapList[i].date; });
      saveState({ ids: Array.from(ids), last: last, at: new Date().toISOString() });
      refresh();
    });
  };
})();
