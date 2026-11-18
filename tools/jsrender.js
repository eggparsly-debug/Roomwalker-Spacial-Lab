// Renders tools/scenarios.json through the browser engine (reference/dsp.js).
// usage: node tools/jsrender.js <outDir>
const fs = require('fs'), path = require('path');
const DSP = require('../reference/dsp.js')();
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.json')));
const out = process.argv[2];
function input(id, sc) {
  const sr = sc.fs, n = Math.round(sc.seconds * sr), x = new Float32Array(n + sr); let s = (id * 1000 + 7) % 2147483647;
  for (let i = 0; i < x.length; i++) {
    s = (s * 16807) % 2147483647;
    const t = i / sr, ph = t * 2 % 1, env = Math.exp(-ph * 7);
    let v = 0.35 * env * (s / 1073741823.5 - 1) + 0.3 * env * Math.sin(2 * Math.PI * (220 * id) * t);
    if (sc.gap && t >= sc.gap[0] && t < sc.gap[1]) v = 0;
    x[i] = v;
  }
  return x;
}
function apply(scene, set) { for (const [k, v] of Object.entries(set)) { const p = k.split('.'); let o = scene; for (let i = 0; i < p.length - 1; i++) o = o[p[i]]; o[p[p.length - 1]] = v; } }
for (const sc of scenarios) {
  const scene = JSON.parse(JSON.stringify(sc.scene)), e = new DSP.Engine(sc.fs); e.setScene(JSON.parse(JSON.stringify(scene)));
  scene.tracks.forEach(t => e.setLoop(t.id, input(t.id, sc))); e.setTransport(true, 0);
  const N = Math.round(sc.seconds * sc.fs), L = new Float32Array(N), R = new Float32Array(N), ev = (sc.events || []).map(x => ({ at: Math.round(x.at * sc.fs), set: x.set }));
  let off = 0, bi = 0, ei = 0;
  while (off < N) {
    let n = Math.min(sc.blocks[bi++ % sc.blocks.length], N - off);
    if (ei < ev.length && off >= ev[ei].at) { apply(scene, ev[ei].set); e.setScene(JSON.parse(JSON.stringify(scene))); ei++; }
    e.process(L.subarray(off, off + n), R.subarray(off, off + n), n); off += n;
  }
  const b = new Float32Array(N * 2); for (let i = 0; i < N; i++) { b[i * 2] = L[i]; b[i * 2 + 1] = R[i]; }
  fs.writeFileSync(path.join(out, sc.name + '.js.f32'), Buffer.from(b.buffer));
}
