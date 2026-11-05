/* detect-worker.js — Web Worker：收一个窗口的子瓦片，返回该窗口的断头（算法在 detect-core.js） */
importScripts('detect-core.js');
onmessage = function (e) {
  var m = e.data;
  try {
    var subs = [];
    for (var k = 0; k < m.n; k++) subs.push([m.ij[2 * k], m.ij[2 * k + 1], m.bits.subarray(512 * k, 512 * k + 512)]);
    postMessage({ id: m.id, res: FogDetectCore.processWindow(subs, m.ox, m.oy) });
  } catch (err) {
    postMessage({ id: m.id, error: String((err && err.stack) || err) });
  }
};
