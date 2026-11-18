// Writes tools/selftest.json: the scenarios plus the browser engine's level envelope for each.
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process'), os = require('os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-'));
execFileSync('node', [path.join(__dirname, 'jsrender.js'), dir]);
const list = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json')));
for (const sc of list) {
  const b = fs.readFileSync(path.join(dir, sc.name + '.js.f32')), x = new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  const W = Math.round(sc.fs * 0.05), N = Math.floor(x.length / 2 / W); sc.window = W; sc.envelope = [[], []];
  for (let c = 0; c < 2; c++) for (let k = 0; k < N; k++) { let e = 0; for (let i = 0; i < W; i++) { const v = x[(k * W + i) * 2 + c]; e += v * v; } sc.envelope[c].push(+(10 * Math.log10(e / W + 1e-12)).toFixed(4)); }
}
fs.writeFileSync(path.join(__dirname, 'selftest.json'), JSON.stringify(list));
