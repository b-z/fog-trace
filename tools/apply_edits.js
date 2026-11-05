// Apply a saved edit log to a Sync.zip and write the edited archive (same code path as the page's 导出存档).
//   node tools/apply_edits.js ORIGINAL.zip data/edits/<name>.json OUT.zip
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
globalThis.JSZip = require(path.join(root, 'vendor/jszip.min.js'));
require(path.join(root, 'src/decoder.js'));
require(path.join(root, 'src/geo.js'));
require(path.join(root, 'src/fog-store.js'));

(async () => {
  const [zipPath, editsPath, outPath] = process.argv.slice(2);
  if (!outPath) { console.error('usage: node tools/apply_edits.js ORIGINAL.zip EDITS.json OUT.zip'); process.exit(2); }
  const doc = JSON.parse(fs.readFileSync(editsPath, 'utf8'));
  const ops = Array.isArray(doc) ? doc : doc.ops.slice(0, doc.ptr == null ? doc.ops.length : doc.ptr);
  const store = FogStore.create(await FogDecoder.open(fs.readFileSync(zipPath)));
  for (const op of ops) await store.applyOp(op);
  const res = await store.exportZip('uint8array');
  fs.writeFileSync(outPath, res.data);
  console.log(`applied ${ops.length} ops -> ${outPath} (${res.data.length} bytes)`, JSON.stringify({ ...res.summary, skipped: res.summary.skipped.length }));
})().catch(e => { console.error(e); process.exit(1); });
