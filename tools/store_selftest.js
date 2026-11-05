// node tools/store_selftest.js <Sync.zip> <out.zip>
// Self-test of src/fog-store.js: filename encoding, no-op export, and a few real edits.
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
globalThis.JSZip = require(path.join(root, 'vendor/jszip.min.js'));
require(path.join(root, 'src/decoder.js'));
require(path.join(root, 'src/geo.js'));
require(path.join(root, 'src/fog-store.js'));

(async () => {
  const [zipPath, outPath] = process.argv.slice(2);
  const buf = fs.readFileSync(zipPath);
  const archive = await FogDecoder.open(buf);
  // 1. filename encoding vs every real block name
  let ok = 0, n = 0;
  for (const e of archive.entries) {
    if (e.blockNo === null) continue;
    n++;
    if (FogStore.blockFilename(e.blockNo) === e.name.split(' ')[0]) ok++;
  }
  console.log(`filenames: ${ok}/${n} match`);

  // 2. no-op re-encode of a few blocks must reproduce the original decompressed bytes
  const store = FogStore.create(archive);
  let same = 0, tried = 0;
  for (const e of archive.entries.filter(e => e.blockNo !== null).slice(0, 40)) {
    const st = await store.load(e.blockNo);
    const orig = await FogDecoder.inflateZlib(await archive.rawBytes(e.path));
    const enc = st.encode();
    tried++;
    if (enc.length === orig.length && enc.every((v, i) => v === orig[i])) same++;
  }
  console.log(`re-encode identical: ${same}/${tried}`);

  // 3. edits: erase a disc in Tokyo, draw a line through Tokyo, draw a line in the Pacific (new block)
  const W = p => [FogGeo.lngToWorldX(p[1]), FogGeo.latToWorldY(p[0])];
  const ops = [
    { type: 'erase', r: 40, pts: [W([35.6812, 139.7671])] },                              // 東京駅
    { type: 'line', w: 3, pts: [W([35.70, 139.70]), W([35.72, 139.75]), W([35.69, 139.80])] },
    { type: 'line', w: 3, pts: [W([30.0, 150.0]), W([30.05, 150.1])] },                   // open ocean
  ];
  const diffs = [];
  for (const op of ops) {
    const d = await store.applyOp(op);
    diffs.push(d);
    console.log(op.type, 'changed subtiles', d.entries.size);
  }
  // undo/redo round trip on op 2 must restore exact bytes
  const st = await store.load(diffs[1].entries.values().next().value.blockNo);
  const snap = st.encode();
  await store.applyDiff(diffs[1], 'before');
  await store.applyDiff(diffs[1], 'after');
  const snap2 = st.encode();
  console.log('undo+redo identical:', snap.length === snap2.length && snap.every((v, i) => v === snap2[i]));
  const res = await store.exportZip('uint8array');
  fs.writeFileSync(outPath, res.data);
  console.log('export', JSON.stringify({ ...res.summary, skipped: res.summary.skipped.length }), res.data.length, 'bytes');
  fs.writeFileSync(outPath + '.ops.json', JSON.stringify(ops));
})().catch(e => { console.error(e); process.exit(1); });
