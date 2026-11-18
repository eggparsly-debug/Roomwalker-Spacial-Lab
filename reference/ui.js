(function () {
'use strict';
const D = RoomwalkerDSP();
const $ = id => document.getElementById(id);
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const snap = (v, s) => Math.round(v / s) * s;
const INKS = ['#f4b860', '#ff9580', '#7fe3c6', '#f3a9dc', '#ece27c', '#c8c3ff'];
const SOUNDS = { drums: 'Drum loop', shaker: 'Shaker', pluck: 'Plucked strings', voice: 'Vowel voice', clicks: 'Clicks (reverb test)', noise: 'Pink noise bursts', file: 'Load audio file...' };
const PLUGIN = window.__RW_PLUGIN || null;   // set when this page is the window of the VST3 plugin
const MAX_TRACKS = PLUGIN ? 32 : 6, MAX_VERTS = 16;

const poly = (pts, mats) => pts.map((p, i) => ({ x: p[0], y: p[1], mat: Array.isArray(mats) ? mats[i % mats.length] : mats }));
const PRESETS = {
  loft: { name: 'L-shaped loft', room: { height: 3.6, decay: 1, floor: 'hardwood', ceiling: 'plaster', verts: poly([[0, 0], [12, 0], [12, 6], [6.5, 6], [6.5, 11], [0, 11]], ['brick', 'glass', 'drywall', 'drywall', 'brick', 'brick']), obstacles: [{ x: 3.4, y: 5.6, w: 0.7, d: 0.7, h: 3.6, rot: 0, mat: 'concrete' }] }, listener: { x: 3.4, y: 3, z: 1.6, yaw: 0.2 } },
  studio: { name: 'Treated studio', room: { height: 3, decay: 1, floor: 'carpet', ceiling: 'foam', verts: poly([[0, 0], [7, 0], [7, 5.5], [0, 5.5]], ['drywall', 'curtain', 'wood', 'curtain']), obstacles: [] }, listener: { x: 3.5, y: 2.6, z: 1.2, yaw: 0 } },
  chapel: { name: 'Stone chapel', room: { height: 11, decay: 1, floor: 'stone', ceiling: 'stone', verts: poly([[7, 0], [13, 0], [13, 8], [20, 8], [20, 14], [13, 14], [13, 24], [7, 24], [7, 14], [0, 14], [0, 8], [7, 8]], 'stone'), obstacles: [{ x: 7.6, y: 7.4, w: 1, d: 1, h: 11, rot: 0, mat: 'stone' }, { x: 12.4, y: 7.4, w: 1, d: 1, h: 11, rot: 0, mat: 'stone' }, { x: 7.6, y: 14.6, w: 1, d: 1, h: 11, rot: 0, mat: 'stone' }, { x: 12.4, y: 14.6, w: 1, d: 1, h: 11, rot: 0, mat: 'stone' }] }, listener: { x: 10, y: 5, z: 1.6, yaw: 1.57 } },
  cave: { name: 'Limestone cave', room: { height: 7, decay: 1, floor: 'rock', ceiling: 'rock', verts: poly([[2, 1], [9, 0], [15, 2.5], [18, 8], [14, 12], [15, 17], [8, 19], [3, 15], [5, 10], [0, 6]], 'rock'), obstacles: [{ x: 9, y: 9, w: 2.2, d: 1.5, h: 5, rot: 0.6, mat: 'rock' }] }, listener: { x: 7, y: 4.5, z: 1.6, yaw: 1 } },
  tunnel: { name: 'Tiled tunnel', room: { height: 3.2, decay: 1, floor: 'concrete', ceiling: 'tile', verts: poly([[0, 0], [30, 0], [30, 3.6], [0, 3.6]], 'tile'), obstacles: [] }, listener: { x: 8, y: 1.8, z: 1.6, yaw: 0 } }
};

const key = (t, x, y, z, ease) => ({ t, x, y, z, ease: ease || 'linear' });
function makeTrack(id, name, sound, keys, bars, extra) {
  return Object.assign({ id, name, sound, gain: 0.45, mute: false, solo: false, direct: 1, early: 1, late: 1, doppler: 0.5,
    motion: { mode: 'tempo', bars, loop: 'loop', auto: 0, curve: true, keys } }, extra);
}
function defaultScene() {
  const p = PRESETS.loft;
  return { version: 1, bpm: 112, output: 'binaural', preset: 'loft', quality: { order: 2, taps: 16 }, room: clone(p.room), listener: { ...clone(p.listener), clarity: 1, skull: 1, focus: 0.8 },
    tracks: [
      makeTrack(1, 'Shaker', 'shaker', [key(0, 5.6, 3, 2.5), key(2, 3.4, 5, 1.4), key(4, 1.2, 3, 0.8), key(6, 3.4, 1, 2)], 2, { gain: 0.4 }),
      makeTrack(2, 'Strings', 'pluck', [key(0, 10.5, 3, 1.6, 'smooth'), key(6, 6.5, 4.5, 1.8, 'smooth'), key(10, 3, 8.5, 2.2, 'smooth'), key(14, 1.5, 9.5, 1.6, 'smooth')], 4, { motion: { mode: 'tempo', bars: 4, loop: 'pingpong', auto: 0, curve: true, keys: [key(0, 10.5, 3, 1.6, 'smooth'), key(6, 6.5, 4.5, 1.8, 'smooth'), key(10, 3, 8.5, 2.2, 'smooth'), key(14, 1.5, 9.5, 1.6, 'smooth')] } }),
      makeTrack(3, 'Drums', 'drums', [key(0, 5.4, 1.6, 1)], 4, { gain: 0.36, late: 0.8 })
    ] };
}

let scene = PLUGIN ? PLUGIN.scene : defaultScene();
if (!PLUGIN) try {
  const saved = JSON.parse(localStorage.getItem('roomwalker.scene.v2') || 'null');
  if (validScene(saved)) { scene = saved; scene.listener.focus ??= 0.8; }
} catch (e) { /* storage may be unavailable */ }

let room = new D.SharedRoom(scene.room);
let selTrack = PLUGIN ? PLUGIN.ownId : scene.tracks[0].id, selKey = null, roomSel = null, tab = 'track';
let beat = 0, playing = false, dirty = true, peaks = {};
const undoStack = [];

function validScene(s) {
  return !!s && s.version === 1 && s.room && Array.isArray(s.room.verts) && s.room.verts.length >= 3 && Array.isArray(s.tracks) && s.tracks.length >= 1 && s.tracks.length <= MAX_TRACKS &&
    s.tracks.every(t => t.motion && Array.isArray(t.motion.keys) && t.motion.keys.length >= 1) && s.listener;
}
const track = () => scene.tracks.find(t => t.id === selTrack) || scene.tracks[0];
const ink = t => INKS[(t.id - 1) % INKS.length];
const pathLen = t => t.motion.bars * D.BEATS_PER_BAR;
const span = () => Math.max(4, ...scene.tracks.map(t => t.motion.bars)) * D.BEATS_PER_BAR;

function pushUndo() { undoStack.push(JSON.stringify(scene)); if (undoStack.length > 60) undoStack.shift(); }
function changed(rebuild) {
  if (rebuild) room = new D.SharedRoom(scene.room);
  dirty = true;
  audio.queueScene();
  clearTimeout(changed.t);
  if (!PLUGIN) changed.t = setTimeout(() => { try { localStorage.setItem('roomwalker.scene.v2', JSON.stringify(scene)); } catch (e) { /* optional */ } }, 400);
}
function refreshAll() { room = new D.SharedRoom(scene.room); renderHeader(); renderTracks(); renderInspector(); layoutTimeline(); fitPlan(); changed(false); audio.syncLoops(); }

/* ------------------------------------------------------------------ audio */
const audio = {
  ctx: null, node: null, engine: null, master: null, pending: false, loopKeys: {}, files: {},
  async start() {
    if (this.ctx) { await this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = +$('master').value;
    this.master.connect(this.ctx.destination);
    try {
      const code = RoomwalkerDSP.toString() + `
        const D = RoomwalkerDSP();
        const now = () => (globalThis.performance ? performance.now() : Date.now());
        class RW extends AudioWorkletProcessor {
          constructor() { super(); this.e = new D.Engine(sampleRate); this.busy = 0; this.frames = 0;
            this.port.onmessage = ev => { const m = ev.data;
              if (m.type === 'scene') this.e.setScene(m.scene);
              else if (m.type === 'loop') this.e.setLoop(m.id, m.data);
              else if (m.type === 'transport') this.e.setTransport(m.playing, m.beat); }; }
          process(i, o) { const c = o[0], t0 = now(); this.e.process(c[0], c[1] || c[0], c[0].length);
            this.busy += now() - t0; this.frames += c[0].length;
            if (this.frames >= sampleRate * 0.05) { const t = this.e.telemetry();
              this.port.postMessage({ beat: t.beat, peaks: t.voices.map(v => [v.id, v.peak]), cpu: this.busy / (this.frames / sampleRate * 1000) });
              this.busy = 0; this.frames = 0; }
            return true; }
        }
        registerProcessor('roomwalker', RW);`;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'roomwalker', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      this.node.port.onmessage = ev => this.telemetry(ev.data);
      this.post = (m, tr) => this.node.port.postMessage(m, tr || []);
    } catch (err) {
      // Sandboxed viewers can refuse worklet modules; the same engine then runs on the page
      const e = (this.engine = new D.Engine(this.ctx.sampleRate));
      this.node = this.ctx.createScriptProcessor(2048, 0, 2);
      let frames = 0, busy = 0;
      this.node.onaudioprocess = ev => {
        const t0 = performance.now();
        e.process(ev.outputBuffer.getChannelData(0), ev.outputBuffer.getChannelData(1), ev.outputBuffer.length);
        busy += performance.now() - t0; frames += ev.outputBuffer.length;
        const t = e.telemetry();
        this.telemetry({ beat: t.beat, peaks: t.voices.map(v => [v.id, v.peak]), cpu: busy / (frames / e.fs * 1000) });
        if (frames > e.fs) { frames = 0; busy = 0; }
      };
      this.post = m => { if (m.type === 'scene') e.setScene(m.scene); else if (m.type === 'loop') e.setLoop(m.id, m.data); else e.setTransport(m.playing, m.beat); };
    }
    this.node.connect(this.master);
    this.post({ type: 'scene', scene: clone(scene) });
    this.syncLoops();
    await this.ctx.resume();
  },
  telemetry(m) {
    if (playing) beat = m.beat;
    m.peaks.forEach(p => { peaks[p[0]] = Math.max(p[1], (peaks[p[0]] || 0) * 0.8); });
    $('cpu').textContent = 'CPU ' + Math.round(m.cpu * 100) + '%';
    dirty = true;
  },
  queueScene() { this.pending = true; },
  flush() { if (this.pending && this.post) { this.post({ type: 'scene', scene: clone(scene) }); this.pending = false; } },
  transport() { if (this.post) this.post({ type: 'transport', playing, beat }); },
  syncLoops() {
    if (!this.post) return;
    const sr = this.ctx.sampleRate;
    scene.tracks.forEach(t => {
      const file = t.sound === 'file' ? this.files[t.id] : null;
      const id = file ? 'file:' + file.name : t.sound === 'file' ? 'drums|' + scene.bpm : t.sound + '|' + scene.bpm;
      if (this.loopKeys[t.id] === id) return;
      this.loopKeys[t.id] = id;
      const data = file ? file.data.slice() : D.renderLoop(t.sound === 'file' ? 'drums' : t.sound, scene.bpm, sr);
      this.post({ type: 'loop', id: t.id, data });
    });
  },
  async loadFile(t, f) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = this.ctx || (this.decoder = this.decoder || new Ctx());
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const data = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) data[i] += d[i] / buf.numberOfChannels; }
    this.files[t.id] = { name: f.name, data };
    delete this.loopKeys[t.id];
    t.sound = 'file'; t.fileName = f.name;
    this.syncLoops();
  }
};

if (PLUGIN) {
  // The plugin engine does the audio: this page only sends edits and shows what the engine reports
  let lastSend = 0;
  audio.start = async () => {};
  audio.transport = () => {};
  audio.syncLoops = () => {};
  audio.flush = () => {
    if (!audio.pending || applyingRemote) return;
    const now = performance.now();
    if (now - lastSend < 33) return;
    lastSend = now; audio.pending = false;
    PLUGIN.send({ type: 'scene', scene });
  };
}
let applyingRemote = false, pointerBusy = false, remoteScene = null, lastLiveRender = 0;
const sendParam = (t, name, value) => { if (PLUGIN) PLUGIN.send({ type: 'param', track: t.id, name, value }); };
function sendAllParams() {
  if (PLUGIN) scene.tracks.forEach(t => { sendParam(t, 'gain', t.gain); sendParam(t, 'direct', t.direct); sendParam(t, 'early', t.early); sendParam(t, 'late', t.late); sendParam(t, 'bend', t.doppler); sendParam(t, 'pos', t.motion.auto); });
}
function applyRemote(next) {
  if (pointerBusy) { remoteScene = next; return; }
  remoteScene = null; applyingRemote = true;
  scene = next;
  if (!scene.tracks.some(t => t.id === selTrack)) selTrack = PLUGIN.ownId;
  selKey = null; roomSel = null;
  room = new D.SharedRoom(scene.room);
  renderHeader(); renderTracks();
  if (!(document.activeElement && document.getElementById('inspector').contains(document.activeElement))) renderInspector();
  layoutTimeline(); fitPlan(); dirty = true;
  applyingRemote = false;
}
if (PLUGIN) {
  window.addEventListener('pointerdown', () => { pointerBusy = true; }, true);
  const release = () => { pointerBusy = false; if (remoteScene) applyRemote(remoteScene); };
  window.addEventListener('pointerup', release, true); window.addEventListener('pointercancel', release, true);
  PLUGIN.on('rwscene', o => applyRemote(JSON.parse(o.s)));
  PLUGIN.on('rwtele', o => {
    const m = JSON.parse(o.s);
    beat = m.beat; playing = m.playing;
    if (m.bpm && scene.bpm !== m.bpm) { scene.bpm = m.bpm; $('bpm').value = Math.round(m.bpm * 100) / 100; }
    peaks = m.peaks;
    $('cpu').textContent = 'CPU ' + Math.round(m.cpu * 100) + '%';
    let moved = false;
    scene.tracks.forEach(t => {
      const v = m.live[t.id]; if (!v || pointerBusy) return;
      if (t.id === selTrack && (t.gain !== v.gain || t.direct !== v.direct || t.early !== v.early || t.late !== v.late || t.doppler !== v.bend || t.motion.auto !== v.pos)) moved = true;
      t.gain = v.gain; t.direct = v.direct; t.early = v.early; t.late = v.late; t.doppler = v.bend; t.motion.auto = v.pos;
    });
    const now = performance.now();
    if (moved && tab === 'track' && now - lastLiveRender > 250 && !document.getElementById('inspector').contains(document.activeElement)) { lastLiveRender = now; renderInspector(); }
    dirty = true;
  });
}

async function togglePlay() {
  if (PLUGIN) return;
  try {
    await audio.start();
    playing = !playing;
    audio.transport();
    renderHeader();
  } catch (e) { hint('Audio could not start in this browser. Try the page in Chrome or Edge.'); }
}
function seek(b) { if (PLUGIN) return; beat = Math.max(0, b); audio.transport(); dirty = true; }

/* ------------------------------------------------------------------ header */
function renderHeader() {
  if (PLUGIN) { ['rewind', 'play'].forEach(id => ($(id).hidden = true)); $('bpm').disabled = true; $('masterGroup').hidden = true; }
  $('play').textContent = playing ? 'Pause' : 'Play';
  $('play').classList.toggle('on', playing);
  $('bpm').value = scene.bpm;
  const out = $('output'); out.innerHTML = '';
  [['binaural', 'Headphones'], ['speakers', 'Speakers']].forEach(([id, label]) => {
    const b = document.createElement('button'); b.textContent = label; b.classList.toggle('on', scene.output === id);
    b.setAttribute('aria-pressed', scene.output === id);
    b.onclick = () => { scene.output = id; changed(); renderHeader(); };
    out.appendChild(b);
  });
  const sel = $('preset');
  if (!sel.options.length) {
    Object.entries(PRESETS).forEach(([id, p]) => sel.add(new Option(p.name, id)));
    sel.add(new Option('Custom room', 'custom'));
  }
  sel.value = scene.preset || 'custom';
  $('undo').disabled = !undoStack.length;
}
function markCustom() { if (scene.preset !== 'custom') { scene.preset = 'custom'; $('preset').value = 'custom'; } }
function applyPreset(id) {
  const p = PRESETS[id]; if (!p) return;
  pushUndo();
  const box = v => ({ x0: Math.min(...v.map(a => a.x)), x1: Math.max(...v.map(a => a.x)), y0: Math.min(...v.map(a => a.y)), y1: Math.max(...v.map(a => a.y)) });
  const a = box(scene.room.verts), b = box(p.room.verts), H0 = scene.room.height;
  scene.room = clone(p.room); scene.listener = { ...clone(p.listener), clarity: scene.listener.clarity ?? 1, skull: scene.listener.skull ?? 1, focus: scene.listener.focus ?? 0.8 }; scene.preset = id;
  scene.tracks.forEach(t => t.motion.keys.forEach(k => {
    let x = b.x0 + ((k.x - a.x0) / Math.max(a.x1 - a.x0, 0.1)) * (b.x1 - b.x0), y = b.y0 + ((k.y - a.y0) / Math.max(a.y1 - a.y0, 0.1)) * (b.y1 - b.y0);
    for (let i = 0; i < 12 && !D.pointInPoly(x, y, p.room.verts); i++) { x += (p.listener.x - x) * 0.25; y += (p.listener.y - y) * 0.25; }
    k.x = snap(x, 0.05); k.y = snap(y, 0.05); k.z = clamp(k.z, 0.1, Math.min(p.room.height - 0.1, H0));
  }));
  roomSel = null;
  refreshAll();
}

/* ------------------------------------------------------------------ track list */
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  Object.entries(props || {}).forEach(([k, v]) => { if (k === 'class') n.className = v; else if (k in n) n[k] = v; else n.setAttribute(k, v); });
  kids.forEach(c => n.append(c));
  return n;
}
function renderTracks() {
  const left = $('left'); left.innerHTML = '';
  const add = el('button', { textContent: 'Add track', disabled: scene.tracks.length >= MAX_TRACKS, onclick: addTrack });
  left.append(el('div', { class: 'head' }, el('span', { class: 'cap', textContent: 'Tracks' }), PLUGIN ? '' : add));
  if (PLUGIN) left.append(el('p', { class: 'note linknote', textContent: 'Add Roomwalker to another track and it joins this room.' }));
  scene.tracks.forEach(t => {
    const card = el('div', { class: 'track' + (t.id === selTrack ? ' sel' : '') });
    card.style.setProperty('--ink', ink(t));
    card.onclick = () => {
      if (selTrack === t.id) return;
      selTrack = t.id; selKey = null; tab = 'track';
      // keep the card in place so a dropdown or name field opened by this click stays open
      left.querySelectorAll('.track').forEach(c => c.classList.toggle('sel', c === card));
      renderInspector(); dirty = true;
    };
    const name = el('input', { class: 'name', value: t.name, 'aria-label': 'Track name', maxLength: 18, onchange: () => { t.name = name.value || 'Track'; t.hostName = false; changed(); renderInspector(); } });
    const m = el('button', { class: 'mini' + (t.mute ? ' on' : ''), textContent: 'M', title: 'Mute', 'aria-label': 'Mute ' + t.name, onclick: () => { t.mute = !t.mute; changed(); renderTracks(); } });
    const s = el('button', { class: 'mini' + (t.solo ? ' on' : ''), textContent: 'S', title: 'Solo', 'aria-label': 'Solo ' + t.name, onclick: () => { t.solo = !t.solo; changed(); renderTracks(); } });
    const sound = el('select', { 'aria-label': 'Sound for ' + t.name });
    Object.entries(SOUNDS).forEach(([id, label]) => sound.add(new Option(id === 'file' && t.fileName ? t.fileName : label, id)));
    sound.value = t.sound;
    sound.onchange = () => {
      if (sound.value === 'file') { sound.value = t.sound; pendingFileTrack = t; $('file').click(); return; }
      t.sound = sound.value; t.fileName = undefined; audio.syncLoops(); changed(); renderTracks();
    };
    const meter = el('div', { class: 'meter' }, el('i', { id: 'meter' + t.id }));
    card.append(el('div', { class: 'row' }, name, m, s));
    if (PLUGIN) { if (t.id === PLUGIN.ownId) card.append(el('span', { class: 'cap', textContent: 'This plugin' })); } else card.append(sound);
    card.append(meter);
    left.append(card);
  });
}
let pendingFileTrack = null;
function addTrack() {
  if (scene.tracks.length >= MAX_TRACKS) return;
  pushUndo();
  let id = 1; while (scene.tracks.some(t => t.id === id)) id++;
  const L = scene.listener, p = nearestInside(L.x + 1.5, L.y + 1);
  scene.tracks.push(makeTrack(id, 'Track ' + id, 'voice', [key(0, snap(p.x, 0.05), snap(p.y, 0.05), 1.6)], 4));
  selTrack = id; selKey = 0; tab = 'track';
  refreshAll();
}
function deleteTrack() {
  if (scene.tracks.length < 2) return;
  pushUndo();
  scene.tracks = scene.tracks.filter(t => t.id !== selTrack);
  delete audio.loopKeys[selTrack];
  selTrack = scene.tracks[0].id; selKey = null;
  refreshAll();
}

/* ------------------------------------------------------------------ inspector */
function slider(o) {
  const out = el('output', { textContent: o.fmt(o.get()) });
  const id = 'c' + (slider.n = (slider.n || 0) + 1);
  const r = el('input', { type: 'range', id, min: o.min, max: o.max, step: o.step, value: o.get() });
  let started = false;
  r.oninput = () => { if (!started) { pushUndo(); started = true; } o.set(+r.value); out.textContent = o.fmt(o.get()); if (o.param) sendParam(o.param[0], o.param[1], +r.value); changed(o.room); };
  r.onchange = () => { started = false; renderHeader(); if (o.after) o.after(); };
  return el('div', { class: 'ctl' }, el('div', { class: 'top' }, el('label', { htmlFor: id, textContent: o.label }), out), r);
}
function pick(label, options, value, set) {
  const id = 'c' + (slider.n = (slider.n || 0) + 1);
  const s = el('select', { id });
  options.forEach(([v, l]) => s.add(new Option(l, v)));
  s.value = value;
  s.onchange = () => { pushUndo(); set(s.value); };
  return el('div', { class: 'field' }, el('label', { htmlFor: id, textContent: label }), s);
}
const matOptions = Object.entries(D.MATERIALS).map(([id, m]) => [id, m.name]);
const dbFmt = v => (v <= 0.001 ? 'off' : (20 * Math.log10(v)).toFixed(1) + ' dB');
const pct = v => Math.round(v * 100) + '%';

function renderInspector() {
  $('tabTrack').classList.toggle('on', tab === 'track');
  $('tabRoom').classList.toggle('on', tab === 'room');
  const box = $('inspector'); box.innerHTML = '';
  if (tab === 'track') trackPanel(box); else roomPanel(box);
}
function trackPanel(box) {
  const t = track(), m = t.motion;
  const mode = el('div', { class: 'seg' });
  [['tempo', 'Tempo sync'], ['automation', 'DAW automation']].forEach(([id, label]) => mode.append(el('button', { textContent: label, className: m.mode === id ? 'on' : '', onclick: () => { pushUndo(); m.mode = id; changed(); renderInspector(); } })));
  const sec = el('div', { class: 'sec' }, el('h2', { textContent: t.name + ' path' }), mode);
  const bars = el('input', { type: 'number', min: 1, max: 32, step: 1, value: m.bars, id: 'barsInput', onchange: () => {
    pushUndo();
    const v = clamp(Math.round(+bars.value) || m.bars, 1, 32), ratio = v / m.bars;
    m.keys.forEach(k => (k.t = snap(k.t * ratio, 0.0625)));
    m.bars = v; changed(); layoutTimeline(); renderInspector();
  } });
  sec.append(el('div', { class: 'field' }, el('label', { htmlFor: 'barsInput', textContent: 'Length (bars)' }), bars));
  if (m.mode === 'tempo') sec.append(pick('At the end', [['loop', 'Loop'], ['pingpong', 'Ping-pong'], ['once', 'Play once']], m.loop, v => { m.loop = v; changed(); }));
  else sec.append(slider({ label: 'Position along path', min: 0, max: 1, step: 0.001, param: [t, 'pos'], get: () => m.auto, set: v => (m.auto = v), fmt: pct }), el('p', { class: 'note', textContent: 'Draw the Path Position envelope for this plugin in Cakewalk to move the sound.' }));
  sec.append(slider({ label: 'Pitch bend', min: 0, max: 2, step: 0.01, param: [t, 'bend'], get: () => t.doppler, set: v => (t.doppler = v), fmt: v => (v === 0 ? 'Off' : pct(v)) }),
    el('p', { class: 'note', textContent: 'Off keeps pitch steady. 100% is physically natural. 200% exaggerates it.' }),
    el('div', { class: 'btns' }, el('button', { textContent: 'Use on all tracks', onclick: () => { pushUndo(); scene.tracks.forEach(x => { x.doppler = t.doppler; sendParam(x, 'bend', t.doppler); }); changed(); hint('Every track now uses ' + (t.doppler === 0 ? 'no pitch bend.' : pct(t.doppler) + ' pitch bend.')); renderHeader(); } })));
  sec.append(pick('Path shape', [['curve', 'Curved'], ['line', 'Straight']], m.curve === false ? 'line' : 'curve', v => { m.curve = v === 'curve'; changed(); }));
  box.append(sec);

  const k = selKey != null ? m.keys[selKey] : null;
  const ks = el('div', { class: 'sec' }, el('h2', { textContent: k ? 'Keyframe ' + (selKey + 1) + ' of ' + m.keys.length : 'Keyframes (' + m.keys.length + ')' }));
  if (k) {
    const num = (label, prop, min, max, step, after) => {
      const id = 'k' + prop;
      const i = el('input', { type: 'number', id, min, max, step, value: +k[prop].toFixed(2), onchange: () => {
        pushUndo(); k[prop] = clamp(+i.value || 0, min, max); if (after) after(); changed(); renderInspector();
      } });
      return el('label', { htmlFor: id }, label, i);
    };
    ks.append(el('div', { class: 'xyz' }, num('Beat', 't', 0, pathLen(t) - 0.25, 0.25, () => sortKeys(t, k)), num('X m', 'x', -50, 80, 0.1), num('Y m', 'y', -50, 80, 0.1), num('Height', 'z', 0.05, scene.room.height - 0.05, 0.1)));
    ks.append(pick('Ease to next', [['linear', 'Linear'], ['smooth', 'Smooth'], ['in', 'Ease in'], ['out', 'Ease out']], k.ease, v => { k.ease = v; changed(); }));
  } else ks.append(el('p', { class: 'note', textContent: 'Double-click the floor to add a keyframe at the playhead.' }));
  ks.append(el('div', { class: 'btns' },
    el('button', { textContent: 'Add at playhead', onclick: () => { const p = D.evalPath(m, beat); addKey(t, p.x, p.y, p.z); } }),
    el('button', { textContent: 'Delete keyframe', disabled: !k || m.keys.length < 2, onclick: deleteKey })));
  box.append(ks);

  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Placement tests' }),
    el('p', { class: 'note', textContent: 'Replaces this track\u2019s path. Shaker and noise show direction best.' }),
    el('div', { class: 'btns' },
      el('button', { textContent: 'Circle my head', onclick: () => placementTest(t, 'circle') }),
      el('button', { textContent: 'Front to back', onclick: () => placementTest(t, 'through') }))));

  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Levels' }),
    slider({ label: 'Input gain', min: 0, max: 1.6, step: 0.01, param: [t, 'gain'], get: () => t.gain, set: v => (t.gain = v), fmt: dbFmt }),
    slider({ label: 'Direct sound', min: 0, max: 1.6, step: 0.01, param: [t, 'direct'], get: () => t.direct, set: v => (t.direct = v), fmt: dbFmt }),
    slider({ label: 'Early reflections', min: 0, max: 1.6, step: 0.01, param: [t, 'early'], get: () => t.early, set: v => (t.early = v), fmt: dbFmt }),
    slider({ label: 'Reverb tail', min: 0, max: 1.6, step: 0.01, param: [t, 'late'], get: () => t.late, set: v => (t.late = v), fmt: dbFmt }),
    PLUGIN ? '' : el('div', { class: 'btns' }, el('button', { textContent: 'Delete track', disabled: scene.tracks.length < 2, onclick: deleteTrack }))));
}
function placementTest(t, kind) {
  pushUndo();
  const L = scene.listener, m = t.motion, dir = a => ({ x: Math.cos(L.yaw + a), y: Math.sin(L.yaw + a) });
  const reach = (a, want) => {
    const d = dir(a);
    for (let r = want; r > 0.4; r -= 0.1) if (D.pointInPoly(L.x + d.x * r, L.y + d.y * r, room.verts)) return r;
    return 0.4;
  };
  m.mode = 'tempo'; m.bars = 4;
  if (kind === 'circle') {
    m.loop = 'loop'; m.curve = true;
    let r = 2.2;
    for (let i = 0; i < 8; i++) r = Math.min(r, reach((i / 8) * Math.PI * 2, 2.2));
    m.keys = Array.from({ length: 8 }, (_, i) => { const d = dir((i / 8) * Math.PI * 2); return key(i * 2, L.x + d.x * r, L.y + d.y * r, L.z); });
    hint('The sound now circles you: ahead, left, behind, right.');
  } else {
    m.loop = 'pingpong'; m.curve = false;
    const a = dir(0), f = reach(0, 3.5), b = reach(Math.PI, 3.5);
    m.keys = [key(0, L.x + a.x * f, L.y + a.y * f, L.z), key(8, L.x, L.y, L.z), key(15.75, L.x - a.x * b, L.y - a.y * b, L.z)];
    hint('The sound now travels from ahead of you, through your head, to behind you.');
  }
  selKey = null; changed(); layoutTimeline(); renderInspector();
}
function roomPanel(box) {
  const st = room.stats, r = scene.room, LS = scene.listener;
  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Listener' }),
    slider({ label: 'Position focus', min: 0, max: 1, step: 0.01, get: () => LS.focus ?? 0.8, set: v => (LS.focus = v), fmt: pct }),
    el('p', { class: 'note', textContent: 'Higher is easier to place. 0% is the natural room balance.' }),
    slider({ label: 'Front/back clarity', min: 0, max: 1.5, step: 0.01, get: () => LS.clarity ?? 1, set: v => (LS.clarity = v), fmt: pct }),
    slider({ label: 'Inside-the-skull effect', min: 0, max: 1, step: 0.01, get: () => LS.skull ?? 1, set: v => (LS.skull = v), fmt: pct })));
  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Measured from this room' }),
    el('div', { class: 'stat' }, stat(st.rt[0].toFixed(2) + ' s', 'Decay, lows'), stat(st.rt[1].toFixed(2) + ' s', 'Decay, mids'), stat(st.rt[2].toFixed(2) + ' s', 'Decay, highs'),
      stat(Math.round(st.volume) + ' m³', 'Volume'), stat(st.critical.toFixed(2) + ' m', 'Critical dist.'), stat(((st.mfp / D.C) * 1000).toFixed(0) + ' ms', 'Mean bounce'))));
  const after = () => renderInspector();
  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Room' }),
    slider({ label: 'Ceiling height', min: 2, max: 24, step: 0.1, room: true, get: () => r.height, set: v => { r.height = v; r.obstacles.forEach(o => (o.h = Math.min(o.h, v))); markCustom(); }, fmt: v => v.toFixed(1) + ' m', after }),
    slider({ label: 'Decay trim', min: 0.25, max: 2.5, step: 0.01, room: true, get: () => r.decay ?? 1, set: v => (r.decay = v), fmt: v => '×' + v.toFixed(2), after }),
    pick('Floor', matOptions, r.floor, v => { r.floor = v; markCustom(); changed(true); renderInspector(); }),
    pick('Ceiling', matOptions, r.ceiling, v => { r.ceiling = v; markCustom(); changed(true); renderInspector(); }),
    pick('All walls', [['', 'Choose to replace...'], ...matOptions], '', v => { if (v) { r.verts.forEach(a => (a.mat = v)); markCustom(); changed(true); renderInspector(); } })));

  const s = el('div', { class: 'sec' });
  if (roomSel && roomSel.kind === 'wall') {
    const w = r.verts[roomSel.index], q = r.verts[(roomSel.index + 1) % r.verts.length];
    s.append(el('h2', { textContent: 'Wall ' + (roomSel.index + 1) + ', ' + Math.hypot(q.x - w.x, q.y - w.y).toFixed(2) + ' m' }), pick('Material', matOptions, w.mat, v => { w.mat = v; markCustom(); changed(true); renderInspector(); }),
      el('p', { class: 'note', textContent: 'Double-click a wall to add a corner.' }));
  } else if (roomSel && roomSel.kind === 'vertex') {
    s.append(el('h2', { textContent: 'Corner ' + (roomSel.index + 1) }), el('div', { class: 'btns' }, el('button', { textContent: 'Delete corner', disabled: r.verts.length <= 3, onclick: deleteVertex })));
  } else if (roomSel && roomSel.kind === 'obstacle') {
    const o = r.obstacles[roomSel.index];
    s.append(el('h2', { textContent: 'Obstacle ' + (roomSel.index + 1) }),
      slider({ label: 'Width', min: 0.2, max: 8, step: 0.05, room: true, get: () => o.w, set: v => (o.w = v), fmt: v => v.toFixed(2) + ' m' }),
      slider({ label: 'Depth', min: 0.2, max: 8, step: 0.05, room: true, get: () => o.d, set: v => (o.d = v), fmt: v => v.toFixed(2) + ' m' }),
      slider({ label: 'Height', min: 0.3, max: r.height, step: 0.05, room: true, get: () => o.h, set: v => (o.h = v), fmt: v => v.toFixed(2) + ' m' }),
      slider({ label: 'Rotation', min: 0, max: Math.PI, step: 0.01, room: true, get: () => o.rot, set: v => (o.rot = v), fmt: v => Math.round((v * 180) / Math.PI) + '°' }),
      pick('Material', matOptions, o.mat, v => { o.mat = v; changed(true); }),
      el('div', { class: 'btns' }, el('button', { textContent: 'Delete obstacle', onclick: deleteObstacle })));
  } else s.append(el('h2', { textContent: 'Selection' }), el('p', { class: 'note', textContent: 'Click a wall, corner or obstacle on the plan to edit it.' }));
  s.append(el('div', { class: 'btns' }, el('button', { textContent: 'Add obstacle', disabled: r.obstacles.length >= 6, onclick: addObstacle })));
  box.append(s);

  box.append(el('div', { class: 'sec' }, el('h2', { textContent: 'Reflection detail' }),
    pick('Bounces', [['1', '1 bounce'], ['2', '2 bounces'], ['3', '3 bounces']], String(scene.quality.order), v => { scene.quality.order = +v; changed(); }),
    pick('Paths per track', [['8', '8'], ['16', '16'], ['24', '24']], String(scene.quality.taps), v => { scene.quality.taps = +v; changed(); })));
}
const stat = (a, b) => el('div', {}, el('b', { textContent: a }), el('span', { textContent: b }));

function sortKeys(t, k) { t.motion.keys.sort((a, b) => a.t - b.t); selKey = t.motion.keys.indexOf(k); }
function addKey(t, x, y, z) {
  pushUndo();
  const len = pathLen(t); let b = snap(D.pathPhase(t.motion, beat), 0.25) % len;
  while (t.motion.keys.some(k => Math.abs(k.t - b) < 0.2)) b = (b + 0.25) % len;
  const k = key(b, snap(x, 0.05), snap(y, 0.05), clamp(z, 0.05, scene.room.height - 0.05));
  t.motion.keys.push(k); sortKeys(t, k); tab = 'track'; changed(); renderInspector();
}
function deleteKey() {
  const t = track(); if (selKey == null || t.motion.keys.length < 2) return;
  pushUndo(); t.motion.keys.splice(selKey, 1); selKey = null; changed(); renderInspector();
}
function deleteVertex() {
  if (!roomSel || roomSel.kind !== 'vertex' || scene.room.verts.length <= 3) return;
  pushUndo();
  const v = scene.room.verts.filter((_, i) => i !== roomSel.index);
  if (!simple(v)) { hint('Removing that corner would make the walls cross.'); undoStack.pop(); return; }
  scene.room.verts = v; roomSel = null; markCustom(); changed(true); renderInspector();
}
function addObstacle() {
  pushUndo();
  const c = centroidInside();
  scene.room.obstacles.push({ x: c.x, y: c.y, w: 1, d: 1, h: Math.min(2.4, scene.room.height), rot: 0, mat: 'concrete' });
  roomSel = { kind: 'obstacle', index: scene.room.obstacles.length - 1 }; markCustom(); changed(true); renderInspector();
}
function deleteObstacle() {
  if (!roomSel || roomSel.kind !== 'obstacle') return;
  pushUndo(); scene.room.obstacles.splice(roomSel.index, 1); roomSel = null; markCustom(); changed(true); renderInspector();
}
function centroidInside() {
  const v = scene.room.verts; let x = 0, y = 0; v.forEach(p => { x += p.x; y += p.y; }); x /= v.length; y /= v.length;
  return nearestInside(snap(x, 0.25), snap(y, 0.25));
}

/* ------------------------------------------------------------------ geometry helpers */
function segCross(a, b, c, d) {
  const o = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}
function simple(v) {
  const n = v.length;
  for (let i = 0; i < n; i++) {
    const a = v[i], b = v[(i + 1) % n];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 0.4) return false;
    for (let j = i + 2; j < n; j++) { if ((j + 1) % n === i) continue; if (segCross(a, b, v[j], v[(j + 1) % n])) return false; }
  }
  return Math.abs(D.signedArea(v)) > 4;
}
function nearestInside(x, y) {
  const v = room.verts;
  if (D.pointInPoly(x, y, v)) return { x, y };
  let best = null, bd = 1e9;
  v.forEach((p, i) => {
    const q = v[(i + 1) % v.length], ex = q.x - p.x, ey = q.y - p.y, l = ex * ex + ey * ey;
    const u = clamp(((x - p.x) * ex + (y - p.y) * ey) / l, 0.02, 0.98), cx = p.x + u * ex, cy = p.y + u * ey, d = Math.hypot(x - cx, y - cy), m = Math.sqrt(l);
    if (d < bd) { bd = d; best = { x: cx - (ey / m) * 0.12, y: cy + (ex / m) * 0.12 }; }
  });
  return best;
}
function samplePath(t, n) {
  const m = t.motion, len = pathLen(t), out = [], probe = { ...m, mode: 'tempo', loop: m.loop === 'loop' ? 'loop' : 'once' };
  for (let i = 0; i <= n; i++) out.push(D.evalPath(probe, (i / n) * len * 0.9999, {}));
  return out;
}

/* ------------------------------------------------------------------ canvas setup */
function fit(c) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}
const COL = { paper: '#10294c', grid: 'rgba(160,195,235,.11)', gridB: 'rgba(160,195,235,.2)', wall: '#e9f1f8', dim: '#a5bdd8', floor: 'rgba(120,165,220,.1)', accent: '#f4b860', obstacle: 'rgba(200,220,245,.26)' };
const MAT_TINT = { foam: '#7fe3c6', curtain: '#7fe3c6', carpet: '#7fe3c6', glass: '#9fd4ff', wood: '#e6c08f', hardwood: '#e6c08f' };

/* ------------------------------------------------------------------ plan view */
const plan = { s: 30, ox: 0, oy: 0, c: $('plan'), drag: null };
const toX = x => plan.ox + x * plan.s, toY = y => plan.oy - y * plan.s;
const fromX = x => (x - plan.ox) / plan.s, fromY = y => (plan.oy - y) / plan.s;
function fitPlan() {
  const v = scene.room.verts, w = plan.c.clientWidth, h = plan.c.clientHeight; if (!w) return;
  const x0 = Math.min(...v.map(p => p.x)), x1 = Math.max(...v.map(p => p.x)), y0 = Math.min(...v.map(p => p.y)), y1 = Math.max(...v.map(p => p.y));
  plan.s = Math.min((w - 84) / Math.max(x1 - x0, 1), (h - 84) / Math.max(y1 - y0, 1));
  plan.ox = w / 2 - ((x0 + x1) / 2) * plan.s; plan.oy = h / 2 + 6 + ((y0 + y1) / 2) * plan.s;
  dirty = true;
}
function drawPlan() {
  const { g, w, h } = fit(plan.c);
  g.fillStyle = COL.paper; g.fillRect(0, 0, w, h);
  const x0 = Math.floor(fromX(0)), x1 = Math.ceil(fromX(w)), y0 = Math.floor(fromY(h)), y1 = Math.ceil(fromY(0));
  g.lineWidth = 1;
  for (let x = x0; x <= x1; x++) { g.strokeStyle = x % 5 ? COL.grid : COL.gridB; g.beginPath(); g.moveTo(toX(x) + 0.5, 0); g.lineTo(toX(x) + 0.5, h); g.stroke(); }
  for (let y = y0; y <= y1; y++) { g.strokeStyle = y % 5 ? COL.grid : COL.gridB; g.beginPath(); g.moveTo(0, toY(y) + 0.5); g.lineTo(w, toY(y) + 0.5); g.stroke(); }
  const v = scene.room.verts;
  g.beginPath(); v.forEach((p, i) => (i ? g.lineTo(toX(p.x), toY(p.y)) : g.moveTo(toX(p.x), toY(p.y)))); g.closePath(); g.fillStyle = COL.floor; g.fill();

  scene.room.obstacles.forEach((o, i) => {
    const c = D.obstacleCorners(o);
    g.beginPath(); c.forEach((p, j) => (j ? g.lineTo(toX(p.x), toY(p.y)) : g.moveTo(toX(p.x), toY(p.y)))); g.closePath();
    g.fillStyle = COL.obstacle; g.fill();
    const on = roomSel && roomSel.kind === 'obstacle' && roomSel.index === i;
    g.strokeStyle = on ? COL.accent : COL.wall; g.lineWidth = on ? 2 : 1.2; g.stroke();
  });

  drawRays(g, p => [toX(p.x), toY(p.y)]);

  v.forEach((p, i) => {
    const q = v[(i + 1) % v.length], on = roomSel && roomSel.kind === 'wall' && roomSel.index === i;
    g.strokeStyle = on ? COL.accent : MAT_TINT[p.mat] || COL.wall; g.lineWidth = on ? 4 : 2.5; g.lineCap = 'round';
    g.beginPath(); g.moveTo(toX(p.x), toY(p.y)); g.lineTo(toX(q.x), toY(q.y)); g.stroke();
    const len = Math.hypot(q.x - p.x, q.y - p.y), px = len * plan.s;
    if (px > 46) {
      // dimension string set just outside the wall, as on a drawing
      const mx = (toX(p.x) + toX(q.x)) / 2, my = (toY(p.y) + toY(q.y)) / 2;
      const signed = D.signedArea(v) > 0 ? 1 : -1, nx = ((q.y - p.y) / len) * signed, ny = ((q.x - p.x) / len) * signed;
      g.save(); g.translate(mx + nx * 13, my + ny * 13);
      let a = Math.atan2(toY(q.y) - toY(p.y), toX(q.x) - toX(p.x)); if (a > Math.PI / 2 || a < -Math.PI / 2) a += Math.PI;
      g.rotate(a); g.fillStyle = COL.dim; g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(len.toFixed(2) + ' m', 0, 0); g.restore();
    }
  });
  v.forEach((p, i) => {
    const on = roomSel && roomSel.kind === 'vertex' && roomSel.index === i;
    g.fillStyle = on ? COL.accent : COL.paper; g.strokeStyle = on ? COL.accent : COL.wall; g.lineWidth = 1.5;
    g.fillRect(toX(p.x) - 4, toY(p.y) - 4, 8, 8); g.strokeRect(toX(p.x) - 4, toY(p.y) - 4, 8, 8);
  });

  scene.tracks.forEach(t => {
    const on = t.id === selTrack, pts = samplePath(t, t.motion.keys.length > 1 ? 90 : 1), c = ink(t);
    if (t.motion.keys.length > 1) {
      g.strokeStyle = c; g.globalAlpha = on ? 0.95 : 0.42; g.lineWidth = on ? 2 : 1.3; g.setLineDash(on ? [] : [5, 4]);
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(toX(p.x), toY(p.y)) : g.moveTo(toX(p.x), toY(p.y)))); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    }
    t.motion.keys.forEach((k, i) => {
      const x = toX(k.x), y = toY(k.y), r = on ? 6 : 4.5, chosen = on && selKey === i;
      g.save(); g.translate(x, y); g.rotate(Math.PI / 4);
      g.fillStyle = chosen ? '#fff' : on ? c : COL.paper; g.strokeStyle = c; g.lineWidth = 1.6;
      g.fillRect(-r, -r, r * 2, r * 2); g.strokeRect(-r, -r, r * 2, r * 2); g.restore();
    });
    const p = D.evalPath(t.motion, beat), lvl = clamp((peaks[t.id] || 0) * 1.6, 0, 1);
    g.fillStyle = c; g.globalAlpha = 0.22; g.beginPath(); g.arc(toX(p.x), toY(p.y), 11 + lvl * 15, 0, 7); g.fill(); g.globalAlpha = 1;
    g.beginPath(); g.arc(toX(p.x), toY(p.y), 7, 0, 7); g.fill(); g.strokeStyle = COL.paper; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = COL.wall; g.font = '600 12px "IBM Plex Sans Condensed", sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(t.name, toX(p.x) + 11, toY(p.y) - 11);
  });

  const L = scene.listener, lx = toX(L.x), ly = toY(L.y), hx = lx + Math.cos(L.yaw) * 27, hy = ly - Math.sin(L.yaw) * 27;
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(lx, ly); g.lineTo(hx, hy); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.arc(hx, hy, 4.5, 0, 7); g.fill();
  g.fillStyle = COL.paper; g.beginPath(); g.arc(lx, ly, 10, 0, 7); g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke();
  [1, -1].forEach(s => { g.beginPath(); g.arc(lx - Math.sin(L.yaw) * 10 * s, ly - Math.cos(L.yaw) * 10 * s, 3, 0, 7); g.fillStyle = '#fff'; g.fill(); });

  // scale bar
  const bar = plan.s * (plan.s < 22 ? 5 : 2), label = plan.s < 22 ? '5 m' : '2 m';
  g.strokeStyle = COL.dim; g.lineWidth = 1.5; g.beginPath(); g.moveTo(w - 14 - bar, h - 14); g.lineTo(w - 14, h - 14); g.moveTo(w - 14 - bar, h - 18); g.lineTo(w - 14 - bar, h - 10); g.moveTo(w - 14, h - 18); g.lineTo(w - 14, h - 10); g.stroke();
  g.fillStyle = COL.dim; g.font = '11px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.fillText(label, w - 14 - bar / 2, h - 25);
}
function drawRays(g, map) {
  const t = track(), S = D.evalPath(t.motion, beat), L = scene.listener, c = ink(t), out = [];
  room.findReflections(S, L, Math.min(scene.quality.order, 2), out);
  out.sort((a, b) => b.rank - a.rank);
  out.slice(0, 10).forEach(r => {
    g.strokeStyle = c; g.globalAlpha = clamp(r.rank * 1.5, 0.08, 0.4); g.lineWidth = r.order === 1 ? 1.1 : 0.7;
    g.beginPath(); g.moveTo(...map(L));
    for (let i = 0; i < r.pts.length; i += 3) g.lineTo(...map({ x: r.pts[i], y: r.pts[i + 1], z: r.pts[i + 2] }));
    g.lineTo(...map(S)); g.stroke();
  });
  g.globalAlpha = 1;
  const blocked = room.detour(S, L) > 0.01;
  g.strokeStyle = blocked ? '#ff8d7a' : c; g.lineWidth = 1.5; g.setLineDash(blocked ? [3, 5] : []);
  g.globalAlpha = blocked ? 0.95 : 0.7; g.beginPath(); g.moveTo(...map(L)); g.lineTo(...map(S)); g.stroke();
  g.setLineDash([]); g.globalAlpha = 1;
}
function planPick(x, y) {
  const L = scene.listener, near = (a, b, r) => Math.hypot(a - x, b - y) <= r;
  if (near(toX(L.x) + Math.cos(L.yaw) * 27, toY(L.y) - Math.sin(L.yaw) * 27, 10)) return { type: 'yaw' };
  if (near(toX(L.x), toY(L.y), 13)) return { type: 'listener' };
  const order = [track(), ...scene.tracks.filter(t => t.id !== selTrack)];
  for (const t of order) for (let i = 0; i < t.motion.keys.length; i++) { const k = t.motion.keys[i]; if (near(toX(k.x), toY(k.y), 10)) return { type: 'key', track: t, index: i }; }
  const v = scene.room.verts;
  for (let i = 0; i < v.length; i++) if (near(toX(v[i].x), toY(v[i].y), 9)) return { type: 'vertex', index: i };
  const wx = fromX(x), wy = fromY(y);
  for (let i = scene.room.obstacles.length - 1; i >= 0; i--) if (D.pointInPoly(wx, wy, D.obstacleCorners(scene.room.obstacles[i]))) return { type: 'obstacle', index: i, dx: wx - scene.room.obstacles[i].x, dy: wy - scene.room.obstacles[i].y };
  for (let i = 0; i < v.length; i++) {
    const p = v[i], q = v[(i + 1) % v.length], ex = toX(q.x) - toX(p.x), ey = toY(q.y) - toY(p.y), l = ex * ex + ey * ey;
    const u = clamp(((x - toX(p.x)) * ex + (y - toY(p.y)) * ey) / l, 0, 1);
    if (near(toX(p.x) + u * ex, toY(p.y) + u * ey, 7)) return { type: 'wall', index: i };
  }
  return null;
}
const local = (e, c) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
plan.c.addEventListener('pointerdown', e => {
  const [x, y] = local(e, plan.c), hit = planPick(x, y);
  plan.c.focus({ preventScroll: true });
  if (!hit) { roomSel = null; selKey = null; renderInspector(); dirty = true; return; }
  if (hit.type === 'key') { selTrack = hit.track.id; selKey = hit.index; tab = 'track'; renderTracks(); }
  else if (['wall', 'vertex', 'obstacle'].includes(hit.type)) { roomSel = { kind: hit.type, index: hit.index }; tab = 'room'; }
  renderInspector(); dirty = true;
  if (hit.type !== 'wall') { pushUndo(); plan.drag = hit; plan.c.setPointerCapture(e.pointerId); renderHeader(); }
});
plan.c.addEventListener('pointermove', e => {
  const [x, y] = local(e, plan.c), d = plan.drag;
  if (!d) { const h = planPick(x, y); plan.c.style.cursor = h ? (h.type === 'wall' ? 'pointer' : 'grab') : 'crosshair'; return; }
  const wx = fromX(x), wy = fromY(y), L = scene.listener;
  if (d.type === 'yaw') { L.yaw = Math.atan2(wy - L.y, wx - L.x); changed(); }
  else if (d.type === 'listener') { const p = nearestInside(snap(wx, 0.05), snap(wy, 0.05)); L.x = p.x; L.y = p.y; changed(); }
  else if (d.type === 'key') { const k = d.track.motion.keys[d.index], p = nearestInside(snap(wx, 0.05), snap(wy, 0.05)); k.x = p.x; k.y = p.y; changed(); renderInspector(); }
  else if (d.type === 'vertex') {
    const v = scene.room.verts.map(p => ({ ...p })); v[d.index].x = snap(wx, 0.25); v[d.index].y = snap(wy, 0.25);
    if (simple(v)) { scene.room.verts = v; markCustom(); changed(true); }
  } else if (d.type === 'obstacle') { const o = scene.room.obstacles[d.index]; o.x = snap(wx - d.dx, 0.05); o.y = snap(wy - d.dy, 0.05); markCustom(); changed(true); }
});
const endPlan = () => { if (plan.drag) { plan.drag = null; if (tab === 'room') renderInspector(); renderHeader(); fitPlanIfNeeded(); } };
plan.c.addEventListener('pointerup', endPlan); plan.c.addEventListener('pointercancel', endPlan);
function fitPlanIfNeeded() {
  const v = scene.room.verts, out = v.some(p => toX(p.x) < 30 || toX(p.x) > plan.c.clientWidth - 30 || toY(p.y) < 30 || toY(p.y) > plan.c.clientHeight - 30);
  if (out) fitPlan();
}
plan.c.addEventListener('dblclick', e => {
  const [x, y] = local(e, plan.c), hit = planPick(x, y), wx = fromX(x), wy = fromY(y);
  if (hit && hit.type === 'wall') {
    if (scene.room.verts.length >= MAX_VERTS) { hint('A room can have up to ' + MAX_VERTS + ' corners.'); return; }
    pushUndo();
    const p = scene.room.verts[hit.index], v = { x: snap(wx, 0.25), y: snap(wy, 0.25), mat: p.mat };
    const next = scene.room.verts.slice(); next.splice(hit.index + 1, 0, v);
    if (!simple(next)) { undoStack.pop(); hint('That corner sits too close to another one.'); return; }
    scene.room.verts = next; roomSel = { kind: 'vertex', index: hit.index + 1 }; markCustom(); changed(true); renderInspector();
  } else if (!hit && D.pointInPoly(wx, wy, room.verts)) {
    const t = track(), z = D.evalPath(t.motion, beat).z; addKey(t, wx, wy, z);
  }
});

/* ------------------------------------------------------------------ 3D view */
const cam = { az: -0.75, el: 0.62, zoom: 1, c: $('persp'), drag: null };
function projector(w, h) {
  const v = scene.room.verts, H = scene.room.height;
  const x0 = Math.min(...v.map(p => p.x)), x1 = Math.max(...v.map(p => p.x)), y0 = Math.min(...v.map(p => p.y)), y1 = Math.max(...v.map(p => p.y));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = H / 2, radius = Math.hypot(x1 - x0, y1 - y0, H) / 2 || 1;
  const dist = radius * 3.1, f = (0.47 * Math.min(w, h) * cam.zoom * dist) / radius;
  const ca = Math.cos(cam.az), sa = Math.sin(cam.az), ce = Math.cos(cam.el), se = Math.sin(cam.el);
  return p => {
    const x = p.x - cx, y = p.y - cy, z = p.z - cz;
    const xr = x * ca - y * sa, yr = x * sa + y * ca;
    const depth = dist + yr * ce - z * se, up = z * ce + yr * se;
    const k = f / Math.max(depth, 0.1);
    return [w / 2 + xr * k, h / 2 + 8 - up * k, depth];
  };
}
function drawPersp() {
  const { g, w, h } = fit(cam.c);
  g.fillStyle = COL.paper; g.fillRect(0, 0, w, h);
  const P = projector(w, h), map = p => P(p).slice(0, 2), v = scene.room.verts, H = scene.room.height;
  const loop = (pts, fill, stroke, lw) => { g.beginPath(); pts.forEach((p, i) => { const q = P(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.closePath(); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw || 1; g.stroke(); } };
  loop(v.map(p => ({ x: p.x, y: p.y, z: 0 })), 'rgba(120,165,220,.16)', COL.wall, 1.6);
  const faces = v.map((p, i) => { const q = v[(i + 1) % v.length]; const pts = [{ x: p.x, y: p.y, z: 0 }, { x: q.x, y: q.y, z: 0 }, { x: q.x, y: q.y, z: H }, { x: p.x, y: p.y, z: H }]; return { pts, depth: pts.reduce((s, a) => s + P(a)[2], 0) / 4 }; }).sort((a, b) => b.depth - a.depth);
  faces.forEach(f => loop(f.pts, 'rgba(170,205,245,.05)', 'rgba(205,225,247,.34)', 1));
  loop(v.map(p => ({ x: p.x, y: p.y, z: H })), null, 'rgba(233,241,248,.62)', 1.2);
  scene.room.obstacles.forEach(o => {
    const c = D.obstacleCorners(o), hgt = Math.min(o.h, H);
    c.forEach((p, i) => { const q = c[(i + 1) % 4]; loop([{ x: p.x, y: p.y, z: 0 }, { x: q.x, y: q.y, z: 0 }, { x: q.x, y: q.y, z: hgt }, { x: p.x, y: p.y, z: hgt }], 'rgba(200,220,245,.16)', 'rgba(233,241,248,.7)', 1); });
  });
  drawRays(g, map);
  scene.tracks.forEach(t => {
    const on = t.id === selTrack, c = ink(t);
    if (t.motion.keys.length > 1) {
      const pts = samplePath(t, 90);
      g.strokeStyle = c; g.globalAlpha = 0.2; g.lineWidth = 1; g.beginPath(); pts.forEach((p, i) => { const q = P({ x: p.x, y: p.y, z: 0 }); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke();
      g.globalAlpha = on ? 1 : 0.5; g.lineWidth = on ? 2 : 1.3; g.beginPath(); pts.forEach((p, i) => { const q = P(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]); }); g.stroke(); g.globalAlpha = 1;
    }
    t.motion.keys.forEach((k, i) => {
      const q = P(k), b = P({ x: k.x, y: k.y, z: 0 });
      g.strokeStyle = c; g.globalAlpha = 0.5; g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      g.fillStyle = on && selKey === i ? '#fff' : c; g.save(); g.translate(q[0], q[1]); g.rotate(Math.PI / 4); g.fillRect(-4.5, -4.5, 9, 9); g.restore();
    });
    const p = D.evalPath(t.motion, beat), q = P(p), s = P({ x: p.x, y: p.y, z: 0 }), lvl = clamp((peaks[t.id] || 0) * 1.6, 0, 1), r = clamp(1300 / q[2] / 10, 5, 11);
    g.strokeStyle = c; g.lineWidth = 1.2; g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(s[0], s[1]); g.stroke();
    g.fillStyle = 'rgba(5,14,28,.55)'; g.beginPath(); g.ellipse(s[0], s[1], r, r * 0.45, 0, 0, 7); g.fill();
    g.fillStyle = c; g.globalAlpha = 0.24; g.beginPath(); g.arc(q[0], q[1], r + 5 + lvl * 13, 0, 7); g.fill(); g.globalAlpha = 1;
    g.beginPath(); g.arc(q[0], q[1], r, 0, 7); g.fill();
  });
  const L = scene.listener, q = P(L), n = P({ x: L.x + Math.cos(L.yaw) * 0.55, y: L.y + Math.sin(L.yaw) * 0.55, z: L.z }), s = P({ x: L.x, y: L.y, z: 0 });
  g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(s[0], s[1]); g.stroke(); g.setLineDash([]);
  g.lineWidth = 2; g.beginPath(); g.moveTo(q[0], q[1]); g.lineTo(n[0], n[1]); g.stroke();
  g.fillStyle = COL.paper; g.beginPath(); g.arc(q[0], q[1], 8, 0, 7); g.fill(); g.stroke();
  drawRadar(g, w);
}
function placeWords(t, p) {
  const L = scene.listener, dx = p.x - L.x, dy = p.y - L.y, dz = p.z - L.z, d = Math.hypot(dx, dy, dz);
  const f = dx * Math.cos(L.yaw) + dy * Math.sin(L.yaw), l = -dx * Math.sin(L.yaw) + dy * Math.cos(L.yaw);
  if (d < 0.26) return { f, l, d, text: 'Inside your head', inside: true };
  const names = ['Ahead', 'Ahead left', 'Left', 'Behind left', 'Behind', 'Behind right', 'Right', 'Ahead right'];
  const sector = ((Math.round(Math.atan2(l, f) / (Math.PI / 4)) % 8) + 8) % 8;
  const el = (Math.atan2(dz, Math.hypot(f, l)) * 180) / Math.PI;
  const height = el > 20 ? ', above' : el < -20 ? ', below' : '';
  return { f, l, d, text: names[sector] + height + ', ' + d.toFixed(1) + ' m', inside: false };
}
function drawRadar(g, w) {
  const R = 54, cx = w - R - 14, cy = R + 14, scale = d => R * Math.pow(Math.min(d / 8, 1), 0.55);
  g.fillStyle = 'rgba(11,30,58,.9)'; g.beginPath(); g.arc(cx, cy, R + 6, 0, 7); g.fill();
  g.strokeStyle = 'rgba(160,195,235,.32)'; g.lineWidth = 1;
  [1, 3, 8].forEach(d => { g.beginPath(); g.arc(cx, cy, scale(d), 0, 7); g.stroke(); });
  g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  g.fillStyle = COL.dim; g.font = '10px "IBM Plex Mono", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('FRONT', cx, cy - R + 7); g.fillText('BACK', cx, cy + R - 7);
  g.fillStyle = '#fff'; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fill();
  g.beginPath(); g.moveTo(cx - 3, cy - 4); g.lineTo(cx + 3, cy - 4); g.lineTo(cx, cy - 10); g.fill();
  let selected = null;
  scene.tracks.forEach(t => {
    const p = D.evalPath(t.motion, beat), info = placeWords(t, p), on = t.id === selTrack, r = scale(info.d), a = Math.atan2(info.l, info.f);
    g.fillStyle = ink(t); g.globalAlpha = on ? 1 : 0.65;
    g.beginPath(); g.arc(cx - Math.sin(a) * r, cy - Math.cos(a) * r, on ? 5 : 3.5, 0, 7); g.fill(); g.globalAlpha = 1;
    if (on) selected = { t, info };
  });
  if (selected) {
    g.font = '600 13px "IBM Plex Sans Condensed", sans-serif'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
    g.fillStyle = selected.info.inside ? COL.accent : COL.wall;
    g.fillText(selected.t.name + ': ' + selected.info.text, w - 12, cy + R + 24);
  }
}
function perspPick(x, y) {
  const P = projector(cam.c.clientWidth, cam.c.clientHeight);
  let best = null, bd = 13;
  [track(), ...scene.tracks.filter(t => t.id !== selTrack)].forEach(t => t.motion.keys.forEach((k, i) => { const q = P(k), d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = { track: t, index: i }; } }));
  return best;
}
cam.c.addEventListener('pointerdown', e => {
  const [x, y] = local(e, cam.c), hit = perspPick(x, y);
  cam.c.setPointerCapture(e.pointerId);
  if (hit) { pushUndo(); selTrack = hit.track.id; selKey = hit.index; tab = 'track'; renderTracks(); renderInspector(); renderHeader(); cam.drag = { type: 'height', hit, y, z: hit.track.motion.keys[hit.index].z }; }
  else cam.drag = { type: 'orbit', x, y, az: cam.az, el: cam.el };
  dirty = true;
});
cam.c.addEventListener('pointermove', e => {
  const [x, y] = local(e, cam.c), d = cam.drag;
  if (!d) { cam.c.style.cursor = perspPick(x, y) ? 'ns-resize' : 'move'; return; }
  if (d.type === 'orbit') { cam.az = d.az + (x - d.x) * 0.008; cam.el = clamp(d.el + (y - d.y) * 0.006, 0.08, 1.45); dirty = true; }
  else {
    const P = projector(cam.c.clientWidth, cam.c.clientHeight), k = d.hit.track.motion.keys[d.hit.index];
    const perMetre = Math.max(4, Math.abs(P({ x: k.x, y: k.y, z: 1 })[1] - P({ x: k.x, y: k.y, z: 0 })[1]));
    k.z = clamp(snap(d.z - (y - d.y) / perMetre, 0.05), 0.05, scene.room.height - 0.05); changed(); renderInspector();
  }
});
const endCam = () => { cam.drag = null; };
cam.c.addEventListener('pointerup', endCam); cam.c.addEventListener('pointercancel', endCam);
cam.c.addEventListener('wheel', e => { e.preventDefault(); cam.zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.001), 0.5, 3); dirty = true; }, { passive: false });

/* ------------------------------------------------------------------ timeline */
const tl = { c: $('timeline'), drag: null, left: 86, ruler: 22, lane: 24 };
function layoutTimeline() { tl.c.style.height = tl.ruler + tl.lane * scene.tracks.length + 4 + 'px'; dirty = true; }
const beatX = (b, w) => tl.left + (b / span()) * (w - tl.left - 10);
const xBeat = (x, w) => ((x - tl.left) / (w - tl.left - 10)) * span();
function drawTimeline() {
  const { g, w, h } = fit(tl.c);
  g.fillStyle = '#0b1e3a'; g.fillRect(0, 0, w, h);
  const sp = span(), bars = sp / D.BEATS_PER_BAR, every = bars > 16 ? 4 : bars > 8 ? 2 : 1;
  g.font = '11px "IBM Plex Mono", monospace'; g.textBaseline = 'middle'; g.textAlign = 'left';
  for (let b = 0; b <= sp; b++) {
    const x = Math.round(beatX(b, w)) + 0.5, bar = b % D.BEATS_PER_BAR === 0;
    if (!bar && bars > 12) continue;
    g.strokeStyle = bar ? 'rgba(160,195,235,.32)' : 'rgba(160,195,235,.1)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, bar ? 3 : tl.ruler - 5); g.lineTo(x, h); g.stroke();
    if (bar && (b / D.BEATS_PER_BAR) % every === 0 && b < sp) { g.fillStyle = COL.dim; g.fillText(String(b / D.BEATS_PER_BAR + 1), x + 4, 11); }
  }
  scene.tracks.forEach((t, i) => {
    const y = tl.ruler + i * tl.lane, on = t.id === selTrack, c = ink(t), m = t.motion, len = pathLen(t);
    if (on) { g.fillStyle = 'rgba(160,195,235,.12)'; g.fillRect(0, y, w, tl.lane); }
    g.strokeStyle = 'rgba(160,195,235,.16)'; g.beginPath(); g.moveTo(0, y + tl.lane + 0.5); g.lineTo(w, y + tl.lane + 0.5); g.stroke();
    g.fillStyle = on ? COL.wall : COL.dim; g.font = '600 12px "IBM Plex Sans Condensed", sans-serif'; g.textAlign = 'left';
    g.fillText(t.name.slice(0, 12), 8, y + tl.lane / 2);
    const mid = y + tl.lane / 2;
    if (m.mode === 'automation') {
      const x = beatX(m.auto * sp, w);
      g.fillStyle = c; g.globalAlpha = 0.25; g.fillRect(tl.left, y + 5, x - tl.left, tl.lane - 10); g.globalAlpha = 1;
      g.fillRect(x - 2, y + 3, 4, tl.lane - 6);
      g.font = '11px "IBM Plex Mono", monospace'; g.fillStyle = COL.dim; g.textAlign = 'right'; g.fillText('AUTOMATION ' + Math.round(m.auto * 100) + '%', w - 16, mid);
      return;
    }
    const reps = m.loop === 'once' ? 1 : Math.ceil(sp / len);
    for (let r = 0; r < reps; r++) {
      const back = m.loop === 'pingpong' && r % 2 === 1, off = r * len, x0 = beatX(off, w), x1 = beatX(Math.min(off + len, sp), w);
      g.strokeStyle = c; g.globalAlpha = r ? 0.3 : 0.65; g.lineWidth = 2; g.beginPath(); g.moveTo(x0, mid); g.lineTo(x1, mid); g.stroke();
      m.keys.forEach((k, j) => {
        const tb = off + (back ? len - k.t : k.t); if (tb > sp) return;
        const x = beatX(tb, w), sz = r ? 3 : 5;
        g.globalAlpha = r ? 0.4 : 1; g.fillStyle = on && selKey === j && !r ? '#fff' : c;
        g.save(); g.translate(x, mid); g.rotate(Math.PI / 4); g.fillRect(-sz, -sz, sz * 2, sz * 2); g.restore();
      });
      g.globalAlpha = 1;
    }
  });
  const x = beatX(beat % sp, w);
  g.strokeStyle = COL.accent; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
  g.fillStyle = COL.accent; g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 8); g.fill();
}
tl.c.addEventListener('pointerdown', e => {
  const [x, y] = local(e, tl.c), w = tl.c.clientWidth;
  tl.c.setPointerCapture(e.pointerId);
  if (y < tl.ruler) { tl.drag = { type: 'seek' }; seek(clamp(xBeat(x, w), 0, span())); return; }
  const lane = Math.floor((y - tl.ruler) / tl.lane), t = scene.tracks[lane]; if (!t) return;
  if (selTrack !== t.id) { selTrack = t.id; selKey = null; renderTracks(); }
  tab = 'track';
  if (t.motion.mode === 'automation') { pushUndo(); tl.drag = { type: 'auto', t }; t.motion.auto = clamp(xBeat(x, w) / span(), 0, 1); sendParam(t, 'pos', t.motion.auto); changed(); renderInspector(); return; }
  const idx = t.motion.keys.findIndex(k => Math.abs(beatX(k.t, w) - x) < 9);
  if (idx >= 0) { pushUndo(); selKey = idx; tl.drag = { type: 'key', t, k: t.motion.keys[idx] }; }
  renderInspector(); renderHeader(); dirty = true;
});
tl.c.addEventListener('pointermove', e => {
  const d = tl.drag; if (!d) return;
  const [x] = local(e, tl.c), w = tl.c.clientWidth;
  if (d.type === 'seek') seek(clamp(xBeat(x, w), 0, span()));
  else if (d.type === 'auto') { d.t.motion.auto = clamp(xBeat(x, w) / span(), 0, 1); sendParam(d.t, 'pos', d.t.motion.auto); changed(); renderInspector(); }
  else {
    const b = clamp(snap(xBeat(x, w), 0.25), 0, pathLen(d.t) - 0.25);
    if (!d.t.motion.keys.some(k => k !== d.k && Math.abs(k.t - b) < 0.2)) { d.k.t = b; sortKeys(d.t, d.k); changed(); renderInspector(); }
  }
});
const endTl = () => { tl.drag = null; };
tl.c.addEventListener('pointerup', endTl); tl.c.addEventListener('pointercancel', endTl);

/* ------------------------------------------------------------------ chrome */
function hint(text) { $('hint').textContent = text; clearTimeout(hint.t); hint.t = setTimeout(setHint, 3500); }
function setHint() { $('hint').textContent = 'Drag anything on the plan. Double-click a wall to add a corner, or the floor to add a keyframe. In 3D, drag a keyframe to set its height.'; }
$('play').onclick = togglePlay;
$('rewind').onclick = () => seek(0);
$('bpm').onchange = () => { pushUndo(); scene.bpm = clamp(Math.round(+$('bpm').value) || scene.bpm, 40, 240); renderHeader(); audio.syncLoops(); changed(); };
$('preset').onchange = () => { if ($('preset').value === 'custom') return; applyPreset($('preset').value); };
$('master').oninput = () => { if (audio.master) audio.master.gain.setTargetAtTime(+$('master').value, audio.ctx.currentTime, 0.02); };
$('tabTrack').onclick = () => { tab = 'track'; renderInspector(); };
$('tabRoom').onclick = () => { tab = 'room'; renderInspector(); };
function undo() { const s = undoStack.pop(); if (!s) return; scene = JSON.parse(s); if (!scene.tracks.some(t => t.id === selTrack)) selTrack = scene.tracks[0].id; selKey = null; roomSel = null; refreshAll(); sendAllParams(); }
$('undo').onclick = undo;
$('file').onchange = async () => {
  const f = $('file').files[0], t = pendingFileTrack; $('file').value = '';
  if (!f || !t) return;
  try { await audio.loadFile(t, f); changed(); renderTracks(); }
  catch (e) { hint('That audio file could not be decoded. Try a WAV or MP3.'); renderTracks(); }
};
$('sceneBtn').onclick = () => { $('sceneText').value = JSON.stringify(scene, null, 1); $('sceneMsg').textContent = ''; $('overlay').classList.add('open'); $('sceneText').focus(); };
$('sceneClose').onclick = () => $('overlay').classList.remove('open');
$('sceneCopy').onclick = async () => { try { await navigator.clipboard.writeText($('sceneText').value); $('sceneMsg').textContent = 'Scene copied.'; } catch (e) { $('sceneText').select(); $('sceneMsg').textContent = 'Press Ctrl+C to copy the selected text.'; } };
$('sceneApply').onclick = () => {
  try {
    const s = JSON.parse($('sceneText').value);
    if (!validScene(s)) throw new Error('shape');
    s.listener.focus ??= 0.8;
    pushUndo(); scene = s; selTrack = PLUGIN ? PLUGIN.ownId : s.tracks[0].id; selKey = null; roomSel = null; refreshAll(); sendAllParams(); $('overlay').classList.remove('open');
  } catch (e) { $('sceneMsg').textContent = 'That text is not a Roomwalker scene. Check that the whole file was pasted.'; }
};
window.addEventListener('keydown', e => {
  const typing = /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.type !== 'range';
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
  if (typing) return;
  if (!PLUGIN && e.code === 'Space' && e.target.tagName !== 'BUTTON') { e.preventDefault(); togglePlay(); }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selKey != null) deleteKey();
    else if (roomSel?.kind === 'vertex') deleteVertex();
    else if (roomSel?.kind === 'obstacle') deleteObstacle();
  }
});
new ResizeObserver(() => { fitPlan(); dirty = true; }).observe($('views'));
new ResizeObserver(() => { dirty = true; }).observe(tl.c);

function frame() {
  audio.flush();
  if (dirty || playing) {
    dirty = false;
    drawPlan(); drawPersp(); drawTimeline();
    const b = Math.max(beat, 0), bar = Math.floor(b / 4) + 1, bt = Math.floor(b % 4) + 1, tick = Math.floor((b % 1) * 100);
    $('clock').textContent = bar + '.' + bt + '.' + String(tick).padStart(2, '0');
    scene.tracks.forEach(t => { const m = $('meter' + t.id); if (m) m.style.width = clamp((peaks[t.id] || 0) * 100, 0, 100) + '%'; });
  }
  requestAnimationFrame(frame);
}
if (PLUGIN) PLUGIN.send({ type: 'hello' });
setHint(); renderHeader(); renderTracks(); renderInspector(); layoutTimeline(); fitPlan();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { dirty = true; });
requestAnimationFrame(frame);
window.__rw = { get scene() { return scene; }, get beat() { return beat; }, get playing() { return playing; }, audio, applyPreset };
})();
