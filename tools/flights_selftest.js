// node tools/flights_selftest.js FlightyExport.csv OUT.fwss [--now 2026-11-20T15:09] [--upcoming] [--since 2026-11-01] [--bends preview.json] [--airports airports.json]
// Runs web/src/flights-core.js outside the browser: reads a Flighty CSV, chooses the bends, writes the snapshot.
//   --since    only draw the flights from this date on (bends still from every flight), as the page's "new flights" mode
//   --airports a JSON {IATA: [lat, lng]} that replaces the built-in table (to compare with another implementation)
//   --bends    take the bends from a JSON list [{d, f, a, b, c}, ...] (e.g. another implementation's output), to compare
//              the raster and the files byte for byte
// Check the result with: python3 tools/check_export.py EMPTY.fwss OUT.fwss
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = path.join(__dirname, '..');
require(path.join(root, 'web/src/fog-store.js'));
require(path.join(root, 'web/src/airports.js'));
require(path.join(root, 'web/src/flights-core.js'));

const args = process.argv.slice(2), opt = {};
const pos = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); opt[k] = (k === 'upcoming') ? true : args[++i]; } else pos.push(args[i]);
}
const [csvPath, outPath] = pos;

(async () => {
  if (opt.airports) globalThis.FogAirports = JSON.parse(fs.readFileSync(opt.airports, 'utf8'));
  const now = opt.now ? new Date(opt.now) : new Date();
  const res = FogFlights.readFlighty(fs.readFileSync(csvPath, 'utf8'), now);
  let fl = res.flights.filter(f => opt.upcoming || !f.upcoming);
  console.log(`${res.total} rows: ${fl.length} flights, ${res.canceled} canceled, unknown airports ${JSON.stringify(res.unknown)}`);
  let t = Date.now(), bends;
  if (opt.bends) {
    const ref = JSON.parse(fs.readFileSync(opt.bends, 'utf8')), pool = new Map();
    for (const r of ref) { const k = [r.d, r.f, r.a, r.b].join('|'); (pool.get(k) || pool.set(k, []).get(k)).push(r.c); }
    bends = Float64Array.from(fl.map(f => { const a = pool.get([f.date, f.flight, f.a, f.b].join('|')); if (!a || !a.length) throw new Error('no bend for ' + f.id); return a.shift(); }));
  } else {
    if (opt.since) fl = fl.filter(f => f.date < opt.since).concat(fl.filter(f => f.date >= opt.since));
    bends = FogFlights.chooseBends(fl);
  }
  console.log(`bends: ${Date.now() - t} ms`);
  const groups = new Map();
  fl.forEach((f, i) => { const k = FogFlights.route(f).key; (groups.get(k) || groups.set(k, []).get(k)).push(bends[i]); });
  [...groups].sort((p, q) => q[1].length - p[1].length).slice(0, 12).forEach(([k, v]) => console.log(`  ${k} x${v.length} ${v.join(' ')}`));
  const draw = opt.since && !opt.bends ? fl.map((f, i) => f.date >= opt.since ? i : -1).filter(i => i >= 0) : null;
  t = Date.now();
  const deflate = async b => new Uint8Array(zlib.deflateSync(b, { level: 6 }));
  const out = await FogFlights.buildSnapshot(fl, bends, draw, deflate);
  fs.writeFileSync(outPath, Buffer.concat(out.parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
  console.log(`${draw ? draw.length : fl.length} flights drawn: ${out.subtiles} subtiles in ${out.blocks} blocks, ${out.pixels} px, ${out.files} files -> ${outPath} (${Date.now() - t} ms, heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB)`);
})().catch(e => { console.error(e); process.exit(1); });
