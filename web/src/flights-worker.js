/* flights-worker.js — Web Worker：排布弧线、生成快照（算法在 flights-core.js） */
importScripts('fog-store.js', 'airports.js', 'flights-core.js');
onmessage = async function (e) {
  var m = e.data;
  try {
    if (m.cmd === 'bends') {
      postMessage({ id: m.id, type: 'bends', bends: FogFlights.chooseBends(m.flights) });
    } else if (m.cmd === 'build') {
      var out = await FogFlights.buildSnapshot(m.flights, m.bends, m.draw, FogStore.deflateZlib, function (phase, done, total) {
        postMessage({ id: m.id, type: 'progress', phase: phase, done: done, total: total });
      });
      var blob = new Blob(out.parts, { type: 'application/octet-stream' });
      postMessage({ id: m.id, type: 'done', blob: blob, blocks: out.blocks, subtiles: out.subtiles, pixels: out.pixels, files: out.files });
    }
  } catch (err) {
    postMessage({ id: m.id, type: 'error', error: String((err && err.message) || err) });
  }
};
