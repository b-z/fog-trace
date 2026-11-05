// 在 Node 里跑浏览器版的断头检测（同一份 src/detect-core.js + src/detect.js），用来和 Python 版对比。
//   node tools/detect_node.js ARCHIVE.zip [--raw raw.json] [--out dets.json] [--workers N]
// --raw：每个窗口去重前的结果，格式与 python3 tools/deadends.py ARCHIVE --raw 相同
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const root = path.join(__dirname, '..');

if (!isMainThread) {
  require(path.join(root, 'src/detect-core.js'));
  parentPort.on('message', (m) => {
    const subs = [];
    for (let k = 0; k < m.n; k++) subs.push([m.ij[2 * k], m.ij[2 * k + 1], m.bits.subarray(512 * k, 512 * k + 512)]);
    parentPort.postMessage({ id: m.id, res: FogDetectCore.processWindow(subs, m.ox, m.oy) });
  });
  return;
}

globalThis.JSZip = require(path.join(root, 'vendor/jszip.min.js'));
for (const f of ['decoder', 'geo', 'fog-store', 'detect-core', 'detect']) require(path.join(root, 'src', f + '.js'));

function nodePool(size) {
  const idle = [], queue = [], pending = new Map();
  let seq = 0;
  const workers = Array.from({ length: size }, () => {
    const w = new Worker(__filename);
    w.on('message', (d) => { const p = pending.get(d.id); pending.delete(d.id); idle.push(p.w); p.resolve(d.res); pump(); });
    idle.push(w);
    return w;
  });
  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop(), q = queue.shift();
      pending.set(q.msg.id, { w, resolve: q.resolve });
      w.postMessage(q.msg, q.transfer);
    }
  }
  return {
    size,
    exec: (msg, transfer) => new Promise((resolve) => { msg.id = ++seq; queue.push({ msg, transfer, resolve }); pump(); }),
    terminate: () => workers.forEach((w) => w.terminate()),
  };
}

(async () => {
  const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const zip = args[0];
  if (!zip) { console.error('usage: node tools/detect_node.js ARCHIVE.zip [--raw raw.json] [--out dets.json] [--workers N]'); process.exit(2); }
  const t0 = Date.now();
  const store = FogStore.create(await FogDecoder.open(fs.readFileSync(zip)));
  const blocks = await store.loadAll();
  const pool = nodePool(+(opt('--workers') || Math.max(1, os.cpus().length - 1)));
  let last = 0;
  const r = await FogDetect.run({
    blocks, pool,
    onProgress: (done, total, info) => {
      if (Date.now() - last > 15000 || done === total) { last = Date.now(); console.error(`  ${done}/${total}  ${info.seconds.toFixed(0)}s`); }
    },
  });
  pool.terminate();
  console.error(`${r.stats.subtiles} subtiles, ${r.stats.windows} windows, ${pool.size} workers: ${r.stats.raw} -> ${r.stats.kept} after dedupe in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (opt('--raw')) {
    const raw = {};
    r.wins.forEach((w, k) => { if (r.perWindow[k].length) raw[w[0] + ',' + w[1]] = r.perWindow[k]; });
    fs.writeFileSync(opt('--raw'), JSON.stringify(raw));
  }
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(r.dets));
})().catch((e) => { console.error(e); process.exit(1); });
