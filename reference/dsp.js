/* Roomwalker DSP core.
   Written with no DOM or Web Audio dependencies so that it runs unchanged in an
   AudioWorklet, in Node for measurement, and maps one-to-one onto the JUCE port:
     SharedRoom   -> process-wide singleton shared by linked plugin instances
     Voice        -> one plugin instance (one track, one moving sound)
     Engine       -> stands in for the DAW: transport plus a mix of all instances */
function RoomwalkerDSP() {
  'use strict';

  const C = 343;
  const TAU = Math.PI * 2;
  const HEAD_RADIUS = 0.0875;
  const SUB = 32;            // audio-rate parameter ramps
  const CONTROL = 256;       // motion and direct-path update interval, samples
  const POOL = 34;           // tap slots per voice, including ones fading out
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const MIN_DELAY = 9;       // samples; keeps every interpolator reading written audio

  /* 12-point Kaiser-windowed sinc used for the direct path: flat treble at any fractional delay */
  const SINC_TAPS = 12, SINC_PHASES = 256, SINC = (() => {
    const bessel = x => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
    const beta = 6.5, h = new Float64Array((SINC_PHASES + 1) * SINC_TAPS);
    for (let p = 0; p <= SINC_PHASES; p++) {
      const f = p / SINC_PHASES; let sum = 0;
      for (let k = 0; k < SINC_TAPS; k++) {
        const x = k - 5 - f, r = x / 6;
        const win = Math.abs(r) >= 1 ? 0 : bessel(beta * Math.sqrt(1 - r * r)) / bessel(beta);
        const v = (Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * win;
        h[p * SINC_TAPS + k] = v; sum += v;
      }
      for (let k = 0; k < SINC_TAPS; k++) h[p * SINC_TAPS + k] /= sum;
    }
    return h;
  })();

  /* Absorption coefficients: low (<300 Hz), mid, high (>2.5 kHz) */
  const MATERIALS = {
    concrete: { name: 'Concrete', a: [0.02, 0.03, 0.05] },
    brick: { name: 'Brick', a: [0.03, 0.04, 0.07] },
    stone: { name: 'Dressed stone', a: [0.02, 0.03, 0.04] },
    rock: { name: 'Rough rock', a: [0.05, 0.08, 0.14] },
    tile: { name: 'Glazed tile', a: [0.01, 0.015, 0.02] },
    glass: { name: 'Window glass', a: [0.2, 0.05, 0.03] },
    plaster: { name: 'Plaster', a: [0.12, 0.06, 0.04] },
    drywall: { name: 'Drywall', a: [0.2, 0.06, 0.05] },
    wood: { name: 'Wood panel', a: [0.2, 0.1, 0.08] },
    hardwood: { name: 'Hardwood floor', a: [0.12, 0.08, 0.08] },
    carpet: { name: 'Carpet', a: [0.08, 0.35, 0.6] },
    curtain: { name: 'Heavy curtain', a: [0.1, 0.5, 0.65] },
    foam: { name: 'Acoustic foam', a: [0.2, 0.75, 0.95] }
  };
  const AIR = [0.0001, 0.0006, 0.0045];
  const matOf = id => MATERIALS[id] || MATERIALS.plaster;

  /* ------------------------------------------------------------------ geometry */
  function signedArea(v) {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      const a = v[i], b = v[(i + 1) % v.length];
      s += a.x * b.y - b.x * a.y;
    }
    return s / 2;
  }
  function pointInPoly(x, y, v) {
    let inside = false;
    for (let i = 0, j = v.length - 1; i < v.length; j = i++) {
      const a = v[i], b = v[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  function obstacleCorners(o) {
    const c = Math.cos(o.rot || 0), s = Math.sin(o.rot || 0), w = o.w / 2, d = o.d / 2;
    return [[-w, -d], [w, -d], [w, d], [-w, d]].map(p => ({ x: o.x + p[0] * c - p[1] * s, y: o.y + p[0] * s + p[1] * c }));
  }

  class SharedRoom {
    constructor(desc) {
      this.desc = desc;
      const H = (this.height = Math.max(1.5, desc.height));
      let verts = desc.verts.map(v => ({ x: v.x, y: v.y, mat: v.mat }));
      if (signedArea(verts) < 0) {
        // keep each wall's material attached to the wall when the winding flips
        const n = verts.length, r = [];
        for (let i = 0; i < n; i++) r.push({ x: verts[(n - i) % n].x, y: verts[(n - i) % n].y, mat: verts[(2 * n - i - 1) % n].mat });
        verts = r;
      }
      this.verts = verts;
      this.surfaces = [];
      this.blockers = [];
      this.obstacles = [];
      const refl = m => matOf(m).a.map(a => Math.sqrt(1 - a));

      verts.forEach((p, i) => {
        const q = verts[(i + 1) % verts.length];
        const ex = q.x - p.x, ey = q.y - p.y, len = Math.hypot(ex, ey) || 1;
        const nx = -ey / len, ny = ex / len;
        const s = { kind: 'wall', px: p.x, py: p.y, qx: q.x, qy: q.y, ex, ey, len, nx, ny, nz: 0, d: nx * p.x + ny * p.y, zmax: H, R: refl(p.mat), obs: -1 };
        this.surfaces.push(s);
        this.blockers.push(s);
      });
      this.surfaces.push({ kind: 'floor', nx: 0, ny: 0, nz: 1, d: 0, R: refl(desc.floor), obs: -1 });
      this.surfaces.push({ kind: 'ceil', nx: 0, ny: 0, nz: -1, d: -H, R: refl(desc.ceiling), obs: -1 });

      (desc.obstacles || []).forEach((o, oi) => {
        const cs = obstacleCorners(o), h = Math.min(o.h, H);
        this.obstacles.push({ corners: cs, h, desc: o });
        // corners run counter-clockwise, so the right-hand normal faces outward
        cs.forEach((p, i) => {
          const q = cs[(i + 1) % 4];
          const ex = q.x - p.x, ey = q.y - p.y, len = Math.hypot(ex, ey) || 1;
          const nx = ey / len, ny = -ex / len;
          const s = { kind: 'obs', px: p.x, py: p.y, qx: q.x, qy: q.y, ex, ey, len, nx, ny, nz: 0, d: nx * p.x + ny * p.y, zmax: h, R: refl(o.mat), obs: oi };
          this.surfaces.push(s);
          this.blockers.push(s);
        });
      });
      this.surfaces.forEach((s, i) => (s.id = i));
      this.stats = analyzeRoom(desc);
    }

    inPlan(x, y) { return pointInPoly(x, y, this.verts); }

    /* Parameter along segment a->b where it crosses vertical surface s, or -1 */
    hit(ax, ay, az, bx, by, bz, s) {
      const dx = bx - ax, dy = by - ay;
      const den = dx * s.ey - dy * s.ex;
      if (den > -1e-10 && den < 1e-10) return -1;
      const rx = s.px - ax, ry = s.py - ay;
      const t = (rx * s.ey - ry * s.ex) / den;
      if (t <= 1e-4 || t >= 0.9999) return -1;
      const u = (rx * dy - ry * dx) / den;
      if (u < 0 || u > 1) return -1;
      if (az + t * (bz - az) > s.zmax) return -1;
      return t;
    }

    blocked(ax, ay, az, bx, by, bz, skipA, skipB) {
      const list = this.blockers;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.id === skipA || s.id === skipB) continue;
        if (this.hit(ax, ay, az, bx, by, bz, s) >= 0) return true;
      }
      return false;
    }

    /* Extra path length needed to get around whatever blocks a->b. It reaches
       zero exactly as the line of sight opens, so occlusion never clicks. */
    detour(a, b) {
      const direct = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      let wall = 0, obstacle = 0;
      const seen = new Set();
      const via = (x, y, z) => Math.hypot(x - a.x, y - a.y, z - a.z) + Math.hypot(x - b.x, y - b.y, z - b.z) - direct;
      for (const s of this.blockers) {
        const t = this.hit(a.x, a.y, a.z, b.x, b.y, b.z, s);
        if (t < 0) continue;
        const z = a.z + t * (b.z - a.z);
        if (s.kind === 'wall') {
          wall = Math.max(wall, Math.min(via(s.px, s.py, z), via(s.qx, s.qy, z)));
        } else if (!seen.has(s.obs)) {
          seen.add(s.obs);
          const o = this.obstacles[s.obs];
          let best = via(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), o.h);
          for (const c of o.corners) best = Math.min(best, via(c.x, c.y, z));
          obstacle += Math.max(0, best);
        }
      }
      return wall + obstacle;
    }

    onSurface(s, x, y, z) {
      if (s.kind === 'floor' || s.kind === 'ceil') return pointInPoly(x, y, this.verts);
      const u = ((x - s.px) * s.ex + (y - s.py) * s.ey) / (s.len * s.len);
      return u >= 0 && u <= 1 && z >= 0 && z <= s.zmax;
    }

    /* Image-source search through the custom room. Returns audible specular paths. */
    findReflections(S, L, order, out) {
      out.length = 0;
      const surfaces = this.surfaces, self = this;
      const chain = [], images = [];
      let budget = 5000;

      function trace(depth) {
        const pts = [];
        let tx = L.x, ty = L.y, tz = L.z, prev = -1;
        let gl = 1, gm = 1, gh = 1;
        for (let j = depth - 1; j >= 0; j--) {
          const s = surfaces[chain[j]], I = images[j];
          const dx = I.x - tx, dy = I.y - ty, dz = I.z - tz;
          const den = s.nx * dx + s.ny * dy + s.nz * dz;
          if (den > -1e-9 && den < 1e-9) return;
          const t = (s.d - (s.nx * tx + s.ny * ty + s.nz * tz)) / den;
          if (t <= 1e-4 || t >= 0.9999) return;
          const px = tx + t * dx, py = ty + t * dy, pz = tz + t * dz;
          if (!self.onSurface(s, px, py, pz)) return;
          if (self.blocked(tx, ty, tz, px, py, pz, prev, s.id)) return;
          pts.push(px, py, pz);
          gl *= s.R[0]; gm *= s.R[1]; gh *= s.R[2];
          tx = px; ty = py; tz = pz; prev = s.id;
        }
        if (self.blocked(tx, ty, tz, S.x, S.y, S.z, prev, -1)) return;
        const I = images[depth - 1];
        const dist = Math.hypot(I.x - L.x, I.y - L.y, I.z - L.z);
        let key = 0;
        for (let j = 0; j < depth; j++) key = key * 64 + chain[j] + 1;
        out.push({ key, dist, gl, gm, gh, order: depth, ax: pts[0], ay: pts[1], az: pts[2], pts, rank: gm / Math.max(dist, 0.3) });
      }

      function descend(depth, from) {
        for (let i = 0; i < surfaces.length; i++) {
          if (depth > 0 && chain[depth - 1] === i) continue;
          if (--budget < 0) return;
          const s = surfaces[i];
          const side = s.nx * from.x + s.ny * from.y + s.nz * from.z - s.d;
          if (side <= 0) continue;
          if (s.nx * L.x + s.ny * L.y + s.nz * L.z - s.d <= 0 && depth + 1 === order) continue;
          const img = { x: from.x - 2 * side * s.nx, y: from.y - 2 * side * s.ny, z: from.z - 2 * side * s.nz };
          chain[depth] = i;
          images[depth] = img;
          trace(depth + 1);
          if (depth + 1 < order) descend(depth + 1, img);
        }
      }
      descend(0, S);
      return out;
    }
  }

  /* Volume, surface area and Eyring decay time for each band */
  function analyzeRoom(desc) {
    const H = Math.max(1.5, desc.height), v = desc.verts;
    const planArea = Math.abs(signedArea(v));
    let perim = 0;
    const absorb = [0, 0, 0];
    const add = (mat, area) => matOf(mat).a.forEach((a, b) => (absorb[b] += area * a));
    v.forEach((p, i) => {
      const q = v[(i + 1) % v.length], len = Math.hypot(q.x - p.x, q.y - p.y);
      perim += len;
      add(p.mat, len * H);
    });
    add(desc.floor, planArea);
    add(desc.ceiling, planArea);
    let volume = planArea * H, surface = 2 * planArea + perim * H;
    (desc.obstacles || []).forEach(o => {
      const h = Math.min(o.h, H);
      volume -= o.w * o.d * h;
      const area = 2 * (o.w + o.d) * h;
      surface += area;
      add(o.mat, area);
    });
    volume = Math.max(1, volume);
    const scale = desc.decay == null ? 1 : desc.decay;
    const rt = absorb.map((A, b) => {
      const mean = clamp(A / surface, 0.001, 0.98);
      return clamp((scale * 0.161 * volume) / (-surface * Math.log(1 - mean) + 4 * AIR[b] * volume), 0.05, 20);
    });
    const equivalent = (0.161 * volume) / rt[1];
    return { volume, surface, planArea, rt, mfp: (4 * volume) / surface, absorption: equivalent, critical: Math.sqrt(equivalent / (16 * Math.PI)) };
  }

  /* ---------------------------------------------------------------- motion path */
  const EASE = {
    linear: u => u,
    smooth: u => u * u * (3 - 2 * u),
    in: u => u * u,
    out: u => 1 - (1 - u) * (1 - u)
  };
  const BEATS_PER_BAR = 4;

  function pathPhase(m, beat) {
    const len = Math.max(1, m.bars * BEATS_PER_BAR);
    if (m.mode === 'automation') return clamp(m.auto, 0, 1) * len;
    if (m.loop === 'once') return clamp(beat, 0, len);
    if (m.loop === 'pingpong') {
      const p = ((beat % (2 * len)) + 2 * len) % (2 * len);
      return p > len ? 2 * len - p : p;
    }
    return ((beat % len) + len) % len;
  }

  function evalPath(m, beat, out) {
    out = out || { x: 0, y: 0, z: 0 };
    const k = m.keys, n = k.length;
    if (!n) return out;
    if (n === 1) { out.x = k[0].x; out.y = k[0].y; out.z = k[0].z; return out; }
    const len = Math.max(1, m.bars * BEATS_PER_BAR);
    const closed = m.loop === 'loop';
    const p = pathPhase(m, beat);
    let i0;
    if (p < k[0].t) {
      if (!closed) { out.x = k[0].x; out.y = k[0].y; out.z = k[0].z; return out; }
      i0 = n - 1;
    } else {
      i0 = n - 1;
      for (let i = 0; i < n - 1; i++) if (p < k[i + 1].t) { i0 = i; break; }
      if (i0 === n - 1 && !closed) { out.x = k[n - 1].x; out.y = k[n - 1].y; out.z = k[n - 1].z; return out; }
    }
    const i1 = (i0 + 1) % n;
    let t0 = k[i0].t, t1 = k[i1].t;
    let q = p;
    if (i1 <= i0) { t1 += len; if (q < t0) q += len; }
    const raw = t1 > t0 ? clamp((q - t0) / (t1 - t0), 0, 1) : 0;
    const u = (EASE[k[i0].ease] || EASE.linear)(raw);
    const a = k[i0], b = k[i1];
    if (m.curve === false) {
      out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u;
      return out;
    }
    const before = closed ? k[(i0 - 1 + n) % n] : k[Math.max(0, i0 - 1)];
    const after = closed ? k[(i1 + 1) % n] : k[Math.min(n - 1, i1 + 1)];
    const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
    out.x = cr(before.x, a.x, b.x, after.x);
    out.y = cr(before.y, a.y, b.y, after.y);
    out.z = cr(before.z, a.z, b.z, after.z);
    return out;
  }

  /* --------------------------------------------------------------- late reverb */
  const LINES = 16;
  const LINE_RATIO = Array.from({ length: LINES }, (_, i) => 0.55 * Math.pow(1.75 / 0.55, i / (LINES - 1)));
  const walsh = (row, i) => { let n = row & i, c = 0; while (n) { c ^= n & 1; n >>= 1; } return c ? -1 : 1; };
  const SIGN_L = Array.from({ length: LINES }, (_, i) => walsh(5, i));
  const SIGN_R = Array.from({ length: LINES }, (_, i) => walsh(10, i));
  const SIGN_IN = Array.from({ length: LINES }, (_, i) => walsh(15, i));
  const isPrime = n => { for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false; return n % 2 === 1; };
  const nextPrime = n => { n |= 1; while (!isPrime(n)) n += 2; return n; };

  class LateReverb {
    constructor(fs) {
      this.fs = fs;
      let size = 1 << 12;
      while (size < fs * 0.36) size <<= 1;
      this.mask = size - 1;
      this.lines = LINE_RATIO.map(() => new Float32Array(size));
      this.cur = LINE_RATIO.map(r => r * 0.03 * fs);
      this.target = this.cur.slice();
      this.w = 0;
      // Per-line damping: broadband gain plus low and high first-order shelves.
      // Shelves add in decibels, so each band decays at its own rate.
      this.gm = new Float64Array(LINES).fill(0.8);
      this.ls = LINE_RATIO.map(() => ({ b0: 1, b1: 0, a1: 0, x: 0, y: 0 }));
      this.hs = LINE_RATIO.map(() => ({ b0: 1, b1: 0, a1: 0, x: 0, y: 0 }));
      this.kLow = Math.tan((Math.PI * 400) / fs);
      this.kHigh = Math.tan((Math.PI * 3000) / fs);
      this.tuned = false; this.apG = 0.5;
      this.phase = LINE_RATIO.map((_, i) => i * 0.83);
      this.rate = LINE_RATIO.map((_, i) => (TAU * (0.07 + i * 0.019)) / fs);
      this.modDepth = fs * 0.0001;
      this.loopAP = LINE_RATIO.map((r, i) => ({ b: new Float32Array(nextPrime(Math.round(fs * (0.0031 + 0.00083 * i)))), i: 0 }));
      this.y = new Float64Array(LINES);
      this.diff = [1.3, 2.1, 3.1, 4.7, 7.3, 11.9, 17.3, 26.9].map(ms => ({ b: new Float32Array(Math.ceil((ms * fs) / 1000)), i: 0, ms, g: 0.6 }));
      this.gain = 0;
      this.gainTarget = 0;
      this.tiltL = 1; this.tiltR = 1;
      this.sideLP = 0; this.sideLP2 = 0;
      this.bassMono = 0;
      this.sideC = 1 - Math.exp((-TAU * 220) / fs);
    }
    design(fl, fh, lowDb, highDb) {
      const low = Math.pow(10, lowDb / 40), high = Math.pow(10, highDb / 40);
      let K = this.kLow, a0 = 1 + K / low;
      fl.b0 = (1 + K * low) / a0; fl.b1 = (K * low - 1) / a0; fl.a1 = (K / low - 1) / a0;
      K = this.kHigh; a0 = 1 / high + K;
      fh.b0 = (high + K) / a0; fh.b1 = (K - high) / a0; fh.a1 = (K - 1 / high) / a0;
    }
    setRoom(st, binaural) {
      const PROBE = [150, 1000, 6000].map(f => (TAU * f) / this.fs);
      const response = (f, w) => {
        const c = Math.cos(w), s = Math.sin(w);
        const num = (f.b0 + f.b1 * c) ** 2 + (f.b1 * s) ** 2, den = (1 + f.a1 * c) ** 2 + (f.a1 * s) ** 2;
        return 10 * Math.log10(num / den);
      };
      // Long decays need more total delay, or the tail rings at individual pitches
      const base = clamp(Math.max(st.mfp / C, (0.15 * st.rt[1]) / LINES), 0.0105, 0.05) * this.fs;
      let total = 0;
      for (let i = 0; i < LINES; i++) {
        this.target[i] = nextPrime(Math.round(base * LINE_RATIO[i]));
        const loopLen = this.target[i] + this.loopAP[i].b.length;   // the in-loop allpass adds to the path
        total += loopLen;
        // Solve the three gains so the loop hits each band's target at 150 Hz, 1 kHz and 6 kHz
        const want = st.rt.map(rt => (-60 * loopLen) / (this.fs * rt));
        let mid = want[1], low = want[0] - want[1], high = want[2] - want[1];
        const fl = this.ls[i], fh = this.hs[i];
        for (let it = 0; it < 6; it++) {
          this.design(fl, fh, low, high);
          const err = PROBE.map((w, b) => want[b] - (mid + response(fl, w) + response(fh, w)));
          mid += err[1];
          low = clamp(low + (err[0] - err[1]) * 1.3, -60, 60);
          high = clamp(high + (err[2] - err[1]) * 1.3, -60, 60);
        }
        this.design(fl, fh, low, high);
        // Guarantee the loop loses energy at every frequency, in every room
        let top = -999;
        for (let k = 0; k <= 48; k++) {
          const w = (TAU * 4 * Math.pow(this.fs / 8.2, k / 48)) / this.fs;
          top = Math.max(top, mid + response(fl, w) + response(fh, w));
        }
        const ceiling = (-60 * loopLen) / (this.fs * 30);
        if (top > ceiling) mid -= top - ceiling;
        this.gm[i] = Math.pow(10, mid / 20);
      }
      if (!this.tuned) { this.cur = this.target.slice(); this.tuned = true; }
      // The input diffusers must never ring longer than the room itself
      const spread = clamp(st.rt[1] / 0.9, 0.62, 1);   // short rooms get less smear so they stay tight
      for (const a of this.diff) a.g = (a.ms < 8 ? 1 : spread) * Math.min(0.6, Math.pow(10, (-3 * a.ms) / (1000 * st.rt[1])));
      this.apG = 0.5 * spread;
      // Scale so the steady reverberant field matches the room's critical distance
      const ratio = Math.min(16, (16 * Math.PI) / st.absorption);
      const impulseEnergy = (this.fs * st.rt[1]) / (13.8 * total);
      this.gainTarget = Math.sqrt(ratio / impulseEnergy);
      this.bassMono = binaural ? 1 : 0;
    }
    process(input, outL, outR, n, level, tiltDb = 0) {
      const mask = this.mask, lines = this.lines;
      const tl0 = this.tiltL, tr0 = this.tiltR;
      this.tiltL += (Math.pow(10, tiltDb / 20) - this.tiltL) * 0.02; this.tiltR += (Math.pow(10, -tiltDb / 20) - this.tiltR) * 0.02;
      const dtl = (this.tiltL - tl0) / n, dtr = (this.tiltR - tr0) / n; let tl = tl0, tr = tr0;
      const y = this.y, depth = this.modDepth, margin = depth + 4;
      for (let i = 0; i < LINES; i++) this.cur[i] += clamp(this.target[i] - this.cur[i], -2, 2);
      const g0 = this.gain;
      this.gain += (this.gainTarget * level - this.gain) * 0.02;
      const dg = (this.gain - g0) / n;
      let g = g0;
      for (let s = 0; s < n; s++) {
        let x = input[s];
        for (const a of this.diff) {
          const d = a.b[a.i], v = x + a.g * d;
          a.b[a.i] = v;
          x = d - a.g * v;
          if (++a.i >= a.b.length) a.i = 0;
        }
        let sum = 0, L = 0, R = 0;
        for (let i = 0; i < LINES; i++) {
          this.phase[i] += this.rate[i];
          if (this.phase[i] > TAU) this.phase[i] -= TAU;
          const rd = this.w - this.cur[i] - depth * Math.sin(this.phase[i]) - margin;
          const idx = Math.floor(rd), f = rd - idx, b = lines[i];
          const xm = b[(idx - 1) & mask], x0 = b[idx & mask], x1 = b[(idx + 1) & mask], x2 = b[(idx + 2) & mask];
          const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
          const v = ((c3 * f + c2) * f + c1) * f + x0;
          const fl = this.ls[i], fh = this.hs[i];
          const o1 = fl.b0 * v + fl.b1 * fl.x - fl.a1 * fl.y; fl.x = v; fl.y = o1;
          const o2 = fh.b0 * o1 + fh.b1 * fh.x - fh.a1 * fh.y; fh.x = o1; fh.y = o2;
          const ap = this.loopAP[i], z = ap.b[ap.i], u = o2 + this.apG * z;
          ap.b[ap.i] = u; if (++ap.i >= ap.b.length) ap.i = 0;
          const o = this.gm[i] * (z - this.apG * u);
          y[i] = o; sum += o;
          L += SIGN_L[i] * v; R += SIGN_R[i] * v;
        }
        sum *= 2 / LINES;
        const inj = x * 0.25;
        for (let i = 0; i < LINES; i++) lines[i][this.w & mask] = y[i] - sum + SIGN_IN[i] * inj;
        this.w = (this.w + 1) & mask;
        L *= 0.25; R *= 0.25;
        if (this.bassMono) {
          // Real rooms are coherent at the two ears below roughly 200 Hz
          const side = 0.5 * (L - R), mid = 0.5 * (L + R);
          this.sideLP += this.sideC * (side - this.sideLP);
          const hp1 = side - this.sideLP;
          this.sideLP2 += this.sideC * (hp1 - this.sideLP2);
          const sh = hp1 - this.sideLP2;
          L = mid + sh; R = mid - sh;
        }
        g += dg;
        tl += dtl; tr += dtr;
        outL[s] += L * g * tl; outR[s] += R * g * tr;
      }
    }
  }

  /* ---------------------------------------------------------------- render taps */
  class Ear {
    constructor() {
      this.lp1 = 0; this.lp2 = 0; this.shX = 0; this.shY = 0;
      this.amp = 0; this.ampT = 0; this.ampM = 0; this.b0 = 1; this.b1 = 0; this.b0T = 1; this.b1T = 0; this.b0M = 1; this.b1M = 0; this.b00 = 1; this.b10 = 0;
      this.extra = 0; this.extraT = 0; this.extraM = 0;
      // direct path only
      this.s1 = 0; this.s2 = 0; this.s3 = 0; this.s4 = 0; this.rear = 0;
      this.eq = new Float64Array(6);    // directional bands
      this.sk = new Float64Array(8);    // skull path
    }
  }
  class Tap {
    constructor() {
      this.active = false; this.key = -1; this.dying = false;
      this.d = 0; this.dT = 0; this.tM = 0; this.tS = 0; this.anchor = 0; this.xf = 0; this.xf0 = 0; this.off = 0;
      this.gl = 1; this.gm = 1; this.gh = 1; this.glT = 1; this.gmT = 1; this.ghT = 1; this.glM = 1; this.gmM = 1; this.ghM = 1; this.gl0 = 1; this.gm0 = 1; this.gh0 = 1;
      this.L = new Ear(); this.R = new Ear();
      this.order = 1; this.pts = null; this.level = 0;
      this.spL = 1; this.spM = 1; this.spH = 1; this.scL = 0; this.scM = 0; this.scH = 0;
      this.spLT = 1; this.spMT = 1; this.spHT = 1; this.scLT = 0; this.scMT = 0; this.scHT = 0;
    }
  }

  /* Head-relative cues: spherical-head delay and shadow after Woodworth and Brown-Duda.
     These mirror front to back, so the directional bands in the direct path separate them. */
  function headCues(fx, fy, fz, listener, binaural, fs, r) {
    const yaw = listener.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
    const m = Math.hypot(fx, fy, fz) || 1;
    const x = fx / m, y = fy / m, z = fz / m;
    const front = x * cy + y * sy, left = -x * sy + y * cy, up = z;
    r.front = front; r.left = left; r.up = up;
    const K = (fs * HEAD_RADIUS) / C, a1 = (1 - K) / (1 + K);
    if (!binaural) {
      const a = (Math.PI / 4) * (1 + clamp(left, -1, 1));
      r.itdL = 0; r.itdR = 0; r.panL = Math.sin(a); r.panR = Math.cos(a);
      r.b0L = 1; r.b1L = a1; r.b0R = 1; r.b1R = a1;   // zero cancels the pole: flat
      r.maxItd = 0; r.itd = 0;
      return r;
    }
    const axis = clamp(left, -1, 1);
    const lat = Math.asin(axis), abs = Math.abs(lat);
    const itd = ((HEAD_RADIUS / C) * (abs + Math.sin(abs)) * fs) / 2;
    const maxItd = ((HEAD_RADIUS / C) * (Math.PI / 2 + 1) * fs) / 2;
    r.maxItd = maxItd; r.itd = axis >= 0 ? itd : -itd;
    r.itdL = maxItd - r.itd;
    r.itdR = maxItd + r.itd;
    r.panL = 1; r.panR = 1;
    const zero = cosine => {
      const deg = (Math.acos(clamp(cosine, -1, 1)) * 180) / Math.PI;
      const alpha = 1.05 + 0.95 * Math.cos((Math.min(deg, 150) / 150) * Math.PI);
      return [(1 + alpha * K) / (1 + K), (1 - alpha * K) / (1 + K)];
    };
    const zl = zero(left), zr = zero(-left);
    r.b0L = zl[0]; r.b1L = zl[1]; r.b0R = zr[0]; r.b1R = zr[1];
    return r;
  }

  /* ---------------------------------------------------------------- one track */
  class Voice {
    constructor(fs, id) {
      this.fs = fs; this.id = id;
      let size = 1 << 16;
      while (size < fs * 2.8) size <<= 1;
      this.size = size; this.mask = size - 1;
      this.maxDelay = size - 2048;
      this.buf = new Float32Array(size);
      this.w = 0;
      this.pool = [];
      for (let i = 0; i < POOL; i++) this.pool.push(new Tap());
      this.direct = new Tap();
      this.direct.active = true; this.direct.key = 0;
      this.late = new LateReverb(fs);
      this.lateIn = new Float32Array(SUB);
      this.lateD = fs * 0.03; this.lateDT = this.lateD;
      this.pos = { x: 0, y: 0, z: 1.5 };
      this.c1 = 1 - Math.exp((-TAU * 300) / fs);
      this.c2 = 1 - Math.exp((-TAU * 2500) / fs);
      this.cRear = 1 - Math.exp((-TAU * 3500) / fs);
      const tanF = f => Math.tan((Math.PI * Math.min(f, fs * 0.45)) / fs);
      this.g3 = tanF(3200); this.g10 = tanF(1050); this.g8 = tanF(8000);
      this.cSk1 = 1 - Math.exp((-TAU * 1500) / fs);
      this.cSk2 = 1 - Math.exp((-TAU * 320) / fs);
      this.gSkA1 = tanF(610); this.gSkA2 = tanF(640); this.gSkB1 = tanF(1420); this.gSkB2 = tanF(1510);
      this.a1 = (1 - (2 * fs * HEAD_RADIUS) / (2 * C)) / (1 + (2 * fs * HEAD_RADIUS) / (2 * C));
      this.anchorRange = fs * 0.008;   // how far timing may drift before a hidden crossfade
      this.jumpRange = fs * 0.006;     // anything faster than this is a teleport, not motion
      this.xfLen = Math.round(fs * 0.02);
      this.inF = new Float32Array(SUB); this.outFL = new Float32Array(SUB); this.outFR = new Float32Array(SUB);
      this.fifo = 0; this.dcX = 0; this.dcY = 0; this.dcR = Math.exp((-TAU * 8) / fs);
      this.busL = new Float32Array(SUB); this.busR = new Float32Array(SUB);
      const stages = list => list.map(ms => ({ b: new Float32Array(Math.round((ms * fs) / 1000)), i: 0 }));
      this.scatterL = stages([1.7, 3.1, 5.3, 8.9, 13.7]); this.scatterR = stages([2.3, 3.7, 6.1, 10.1, 15.1]);
      this.quietIn = 0; this.quietOut = 0; this.sleeping = false; this.outGain = 1; this.outGainT = 1; this.last = null;
      this.kDelay = 1 - Math.exp(-SUB / (fs * 0.03));
      this.kPath = 1 - Math.exp(-SUB / (fs * 0.015));   // two stages hide the control-rate steps
      this.kGain = 1 - Math.exp(-SUB / (fs * 0.012));
      this.kSoft = 1 - Math.exp(-SUB / (fs * 0.007));   // two stages give gain changes a soft S-curve
      this.doppler = 1; this.dopplerT = 1; this.directLevel = 1; this.earlyLevel = 1; this.lateLevel = 1;
      this.inGain = 0; this.inGainT = 1;
      this.occlusion = 0;
      this.notchF = 7000; this.notchFT = 7000; this.notchD = 0; this.notchDT = 0;
      this.rearG = 1; this.rearGT = 1;
      this.eq3 = 1; this.eq3T = 1; this.eq1 = 1; this.eq1T = 1; this.eq8 = 1; this.eq8T = 1;
      this.skull = 0; this.skullT = 0; this.roomDuck = 1; this.lateFocus = 1; this.lateTiltT = 0; this.notch2 = 0.6; this.notch2T = 0.6;
      this.found = [];
      this.cues = {};
      this.first = true;
      this.peak = 0;
    }

    setDirect(room, S, L, binaural) {
      const dx = S.x - L.x, dy = S.y - L.y, dz = S.z - L.z;
      const dist = Math.hypot(dx, dy, dz);
      const focus = clamp(L.focus ?? 0, 0, 1);   // 0 is pure physics; higher favours clear placement
      const clarity = (L.clarity ?? 1) * (binaural ? 1 : 0.45) * (1 + 0.25 * focus);
      const detour = room.detour(S, L);
      this.occlusion = detour;
      const shadow = f => clamp(1 / Math.sqrt(1 + 20 * ((2 * detour * f) / C)), 0.006, 1);
      const t = this.direct, fs = this.fs;
      t.dT = Math.min(this.maxDelay, (dist / C) * fs);
      t.glT = shadow(150);
      t.gmT = shadow(1000) * Math.pow(10, (-0.004 * dist) / 20);
      t.ghT = shadow(5000) * Math.pow(10, (-0.03 * dist - Math.min(8, 0.05 * focus * dist)) / 20);
      const c = headCues(dx, dy, dz, L, binaural, fs, this.cues);

      // 1 once the sound is inside the skull, easing in from just outside the skin
      const edge = clamp((0.26 - dist) / (0.26 - 0.09), 0, 1);
      const inside = edge * edge * (3 - 2 * edge);
      const w = inside * clamp(L.skull ?? 1, 0, 1);
      this.skullT = w;
      this.roomDuck = 1 - 0.88 * w;
      this.lateFocus = Math.pow(10, (-8 * focus) / 20);
      this.lateTiltT = 3 * focus * c.left * (1 - inside);   // the tail leans toward the sound's side
      const out = 1 - inside;    // directional hearing collapses at the centre of the head

      // Distance to each ear, so close sounds favour the near ear and cross smoothly
      const yaw = L.yaw || 0, cy = Math.cos(yaw), sy = Math.sin(yaw);
      const hF = dx * cy + dy * sy + 0.015, hL = -dx * sy + dy * cy, hU = dz;
      const dEarL = Math.hypot(hF, hL - HEAD_RADIUS, hU), dEarR = Math.hypot(hF, hL + HEAD_RADIUS, hU);
      const soft = d => Math.sqrt(d * d + 0.0144);
      const amp = (this.directLevel * (1 - 0.35 * w)) / Math.pow(dist * dist + 0.09, 0.5 * (1 - 0.25 * focus));
      let panL = c.panL, panR = c.panR;
      if (binaural) {
        panL = soft(dist) / soft(dEarL); panR = soft(dist) / soft(dEarR);
        // Turn down the delayed copy in the opposite ear, more for distant sounds
        const far = (6 + 6 * clamp((dist - 1) / 5, 0, 1)) * focus * out, side = Math.abs(c.left);
        const lift = Math.pow(10, (1.2 * focus * side * out) / 20);
        panL *= lift * Math.pow(10, (-far * Math.max(0, -c.left)) / 20);
        panR *= lift * Math.pow(10, (-far * Math.max(0, c.left)) / 20);
        const near = clamp((1 - dist) / 0.75, 0, 1);
        const itd = c.itd + (((dEarR - dEarL) / C) * fs * 0.5 - c.itd) * near;
        t.L.extraT = c.maxItd - itd; t.R.extraT = c.maxItd + itd;
      } else {
        const wide = Math.sign(c.left) * Math.pow(Math.abs(c.left), 1 - 0.3 * focus);
        const a = (Math.PI / 4) * (1 + clamp(wide * out, -1, 1));
        panL = Math.sin(a); panR = Math.cos(a);
        t.L.extraT = 0; t.R.extraT = 0;
      }
      t.L.ampT = amp * panL; t.R.ampT = amp * panR;
      const K = (fs * HEAD_RADIUS) / C, flat = (1 - K) / (1 + K);
      t.L.b0T = 1 + (c.b0L - 1) * out; t.L.b1T = flat + (c.b1L - flat) * out;
      t.R.b0T = 1 + (c.b0R - 1) * out; t.R.b1T = flat + (c.b1R - flat) * out;

      const el = (Math.asin(clamp(c.up, -1, 1)) * 180) / Math.PI;
      const flatPlane = Math.cos((el * Math.PI) / 180);
      const fb = c.front;         // +1 ahead, -1 behind
      const rear = Math.max(0, -fb), ahead = Math.max(0, fb);
      // Directional bands: 3 kHz reads as ahead, 1 kHz as behind, 8 kHz as above
      const dB = v => Math.pow(10, (v * clarity * out) / 20);
      this.eq3T = dB((5.5 * ahead - 8 * rear) * flatPlane);
      this.eq1T = dB((3.5 * rear - 1.5 * ahead) * flatPlane);
      this.eq8T = dB(c.up > 0 ? 7 * c.up : 3.5 * c.up);
      // the pinna notch sits higher and cuts deeper for sounds ahead
      this.notchFT = clamp(7600 + 3000 * (el / 60) - 1500 * rear, 4800, 12000);
      this.notchDT = binaural ? clamp(0.62 + 0.3 * fb, 0.15, 0.92) * out : 0;
      this.notch2T = 0.6 - 0.55 * ahead;   // keeps the top octave open for sounds ahead
      this.rearGT = Math.pow(10, (-9 * rear * clarity * out) / 20);
      this.lateDT = t.dT + (room.stats.mfp / C) * fs * 1.5;
      if (this.first) this.snap();
    }

    snap() {
      const t = this.direct;
      t.d = t.tS = t.tM = t.anchor = Math.max(MIN_DELAY, t.dT); t.xf = 0;
      t.L.extra = t.L.extraM = t.L.extraT; t.R.extra = t.R.extraM = t.R.extraT;
      t.gl = t.glM = t.glT; t.gm = t.gmM = t.gmT; t.gh = t.ghM = t.ghT;
      for (const e of [t.L, t.R]) { e.b0 = e.b0M = e.b0T; e.b1 = e.b1M = e.b1T; }
      this.notchF = this.notchFT; this.notchD = this.notchDT; this.rearG = this.rearGT;
      this.lateD = this.lateDT;
      this.eq3 = this.eq3T; this.eq1 = this.eq1T; this.eq8 = this.eq8T; this.skull = this.skullT;
      t.L.amp = t.L.ampM = t.L.ampT; t.R.amp = t.R.ampM = t.R.ampT;
      this.first = false;
    }

    setReflections(room, S, L, binaural, order, maxTaps) {
      this.last = [room, S, L, binaural, order, maxTaps];
      if (this.sleeping) return;
      const found = room.findReflections(S, L, order, this.found);
      const existing = new Map();
      for (const t of this.pool) if (t.active) existing.set(t.key, t);
      for (const f of found) if (existing.has(f.key)) f.rank *= 1.5;  // hysteresis stops slot flutter
      found.sort((a, b) => b.rank - a.rank);
      for (const t of this.pool) t.dying = true;
      const fs = this.fs, n = Math.min(found.length, maxTaps);
      for (let i = 0; i < n; i++) {
        const f = found[i];
        if (f.dist / C * fs > this.maxDelay) continue;
        let t = existing.get(f.key), fresh = false;
        if (!t) {
          t = this.pool.find(p => !p.active);
          if (!t) continue;
          fresh = true;
          t.active = true; t.key = f.key;
          t.L.lp1 = t.L.lp2 = t.L.shX = t.L.shY = t.R.lp1 = t.R.lp2 = t.R.shX = t.R.shY = 0;
          t.L.amp = t.R.amp = t.L.ampM = t.R.ampM = 0;
        }
        t.dying = false;
        t.order = f.order; t.pts = f.pts;
        // Real surfaces scatter treble far more than bass, and more with every bounce
        // Reflections landing right behind the direct sound are what comb against it, so they scatter most
        const lag = (f.dist - Math.hypot(S.x - L.x, S.y - L.y, S.z - L.z)) / C;
        const near = clamp(lag / 0.012, 0.3, 1), keep = near * near;
        const sL = 1 - Math.pow(0.8, f.order) * keep, sM = 1 - Math.pow(0.3, f.order) * keep, sH = 1 - Math.pow(0.1, f.order) * keep;
        t.spLT = Math.sqrt(1 - sL); t.spMT = Math.sqrt(1 - sM); t.spHT = Math.sqrt(1 - sH);
        t.scLT = Math.sqrt(sL); t.scMT = Math.sqrt(sM); t.scHT = Math.sqrt(sH);
        if (fresh) { t.spL = t.spLT; t.spM = t.spMT; t.spH = t.spHT; t.scL = t.scLT; t.scM = t.scMT; t.scH = t.scHT; }
        t.dT = (f.dist / C) * fs;
        const air = f.dist;
        const c = headCues(f.ax - L.x, f.ay - L.y, f.az - L.z, L, binaural, fs, this.cues);
        const shade = Math.pow(10, (-6 * Math.max(0, -c.front) * (L.clarity ?? 1) * (binaural ? 1 : 0.45)) / 20);
        t.glT = f.gl; t.gmT = f.gm * Math.pow(10, (-0.004 * air) / 20); t.ghT = f.gh * Math.pow(10, (-0.03 * air) / 20) * shade;
        const focus = clamp(L.focus ?? 0, 0, 1);
        const sx = S.x - L.x, sy = S.y - L.y, sz = S.z - L.z, sm = Math.hypot(sx, sy, sz) || 1;
        const rx = f.ax - L.x, ry = f.ay - L.y, rz = f.az - L.z, rm = Math.hypot(rx, ry, rz) || 1;
        const agree = (sx * rx + sy * ry + sz * rz) / (sm * rm);   // reflections from the wrong side blur the image
        const amp = ((this.earlyLevel * this.roomDuck) / Math.max(f.dist, 0.3)) * Math.pow(10, (-(3 + 3 * (1 - agree)) * focus) / 20);
        t.level = f.gm / Math.max(f.dist, 0.3);
        const farTap = binaural ? (6 + 6 * clamp((f.dist - 1) / 5, 0, 1)) * focus : 0;
        t.L.ampT = amp * c.panL * Math.pow(10, (-farTap * Math.max(0, -c.left)) / 20);
        t.R.ampT = amp * c.panR * Math.pow(10, (-farTap * Math.max(0, c.left)) / 20);
        t.L.b0T = c.b0L; t.L.b1T = c.b1L; t.R.b0T = c.b0R; t.R.b1T = c.b1R;
        t.L.extraT = c.itdL; t.R.extraT = c.itdR;
        if (fresh) {
          t.d = t.tS = t.tM = t.anchor = Math.max(MIN_DELAY, t.dT); t.xf = 0;
          t.gl = t.glM = t.glT; t.gm = t.gmM = t.gmT; t.gh = t.ghM = t.ghT;
          t.L.extra = t.L.extraM = t.L.extraT; t.R.extra = t.R.extraM = t.R.extraT;
          for (const e of [t.L, t.R]) { e.b0 = e.b0M = e.b0T; e.b1 = e.b1M = e.b1T; }
        }
      }
      for (const t of this.pool) if (t.active && t.dying) { t.L.ampT = 0; t.R.ampT = 0; }
    }

    /* Pitch bend. The read position moves at exactly `doppler` times the physical rate.
       Whatever timing error that leaves is removed by short crossfades between two read heads. */
    stepTap(t, n) {
      const a = this.doppler, free = t.xf <= 0;
      let jump = false;
      if (Math.abs(t.dT - t.tS) > this.jumpRange && free) { t.tS = t.tM = t.dT; t.anchor = t.dT; jump = true; }
      else { t.tM += (t.dT - t.tM) * this.kPath; t.tS += (t.tM - t.tS) * this.kPath; }
      if (Math.abs(a - 1) < 1e-4) t.anchor = t.tS;
      else if (Math.abs(t.tS - t.anchor) > (t === this.direct ? this.anchorRange : this.anchorRange * 3) && free) { t.anchor = t.tS; jump = true; }
      const v = clamp(t.anchor + a * (t.tS - t.anchor), MIN_DELAY, this.maxDelay);
      t.xf0 = t.xf;
      if (jump) { t.off = t.d - v; t.xf0 = 1; t.start = v; t.step = 0; }
      else { t.start = t.d; t.step = (v - t.d) / n; }
      t.d = v;
      t.xf = Math.max(0, t.xf0 - n / this.xfLen);
      const k = this.kSoft;
      t.gl0 = t.gl; t.gm0 = t.gm; t.gh0 = t.gh;
      t.spL += (t.spLT - t.spL) * k; t.spM += (t.spMT - t.spM) * k; t.spH += (t.spHT - t.spH) * k;
      t.scL += (t.scLT - t.scL) * k; t.scM += (t.scMT - t.scM) * k; t.scH += (t.scHT - t.scH) * k;
      t.glM += (t.glT - t.glM) * k; t.gmM += (t.gmT - t.gmM) * k; t.ghM += (t.ghT - t.ghM) * k;
      t.gl += (t.glM - t.gl) * k; t.gm += (t.gmM - t.gm) * k; t.gh += (t.ghM - t.gh) * k;
      for (const e of [t.L, t.R]) {
        e.amp0 = e.amp; e.b00 = e.b0; e.b10 = e.b1;
        e.ampM += (e.ampT - e.ampM) * k;
        e.amp += (e.ampM - e.amp) * k;
        e.b0M += (e.b0T - e.b0M) * k; e.b1M += (e.b1T - e.b1M) * k;
        e.b0 += (e.b0M - e.b0) * k; e.b1 += (e.b1M - e.b1) * k;
        e.x0 = e.extra;
        e.extraM += (e.extraT - e.extraM) * k;
        e.extra += clamp((e.extraM - e.extra) * k, -0.2 * n, 0.2 * n);
      }
    }

    readCubic(rp) {
      const b = this.buf, mask = this.mask, i = Math.floor(rp), f = rp - i;
      const xm = b[(i - 1) & mask], x0 = b[i & mask], x1 = b[(i + 1) & mask], x2 = b[(i + 2) & mask];
      return ((((0.5 * (x2 - xm) + 1.5 * (x0 - x1)) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + 0.5 * (x1 - xm)) * f) + x0;
    }

    readSinc(rp) {
      const b = this.buf, mask = this.mask, i = Math.floor(rp), p = (rp - i) * SINC_PHASES, j = Math.floor(p), m = p - j;
      const h0 = j * SINC_TAPS; let o = 0;
      for (let k = 0; k < SINC_TAPS; k++) o += b[(i - 5 + k) & mask] * (SINC[h0 + k] + m * (SINC[h0 + SINC_TAPS + k] - SINC[h0 + k]));
      return o;
    }

    renderEar(t, e, out, bus, n) {
      const { spL, spM, spH, scL, scM, scH } = t;
      const a1 = this.a1, c1 = this.c1, c2 = this.c2;
      const dStep = t.step + (e.extra - e.x0) / n, aStep = (e.amp - e.amp0) / n;
      let d = t.start + e.x0, amp = e.amp0, lp1 = e.lp1, lp2 = e.lp2, shX = e.shX, shY = e.shY;
      let gl = t.gl0, gm = t.gm0, gh = t.gh0, b0 = e.b00, b1 = e.b10; const off = t.off;
      const dl = (t.gl - gl) / n, dm = (t.gm - gm) / n, dh = (t.gh - gh) / n, db0 = (e.b0 - b0) / n, db1 = (e.b1 - b1) / n;
      let xf = t.xf0; const dx = (t.xf - t.xf0) / n, fading = t.xf0 > 0;
      let w = this.w;
      for (let s = 0; s < n; s++) {
        d += dStep; amp += aStep; gl += dl; gm += dm; gh += dh; b0 += db0; b1 += db1;
        let x = this.readCubic(w - d);
        if (fading) { xf += dx; const g = xf * xf * (3 - 2 * xf); x += g * (this.readCubic(w - d - off) - x); }
        lp1 += c1 * (x - lp1); lp2 += c2 * (x - lp2);
        const low = gl * lp1, mid = gm * (lp2 - lp1), high = gh * (x - lp2);
        const v = spL * low + spM * mid + spH * high;
        const y = b0 * v + b1 * shX - a1 * shY;
        shX = v; shY = y;
        out[s] += y * amp;
        bus[s] += (scL * low + scM * mid + scH * high) * amp;
        w++;
      }
      e.lp1 = lp1; e.lp2 = lp2; e.shX = shX; e.shY = shY;
    }

    renderDirectEar(t, e, out, n) {
      const b = this.buf, mask = this.mask, a1 = this.a1, c1 = this.c1, c2 = this.c2, fs = this.fs;
      const dStep = t.step + (e.extra - e.x0) / n, aStep = (e.amp - e.amp0) / n;
      let d = t.start + e.x0, amp = e.amp0, lp1 = e.lp1, lp2 = e.lp2, shX = e.shX, shY = e.shY;
      let s1 = e.s1, s2 = e.s2, s3 = e.s3, s4 = e.s4, rear = e.rear;
      let gl = t.gl0, gm = t.gm0, gh = t.gh0, b0 = e.b00, b1 = e.b10; const off = t.off;
      const dl = (t.gl - gl) / n, dm = (t.gm - gm) / n, dh = (t.gh - gh) / n, db0 = (e.b0 - b0) / n, db1 = (e.b1 - b1) / n;
      let xf = t.xf0; const dx = (t.xf - t.xf0) / n, fading = t.xf0 > 0;
      const g1 = Math.tan(Math.min(this.notchF, fs * 0.45) * Math.PI / fs), g2 = Math.tan(Math.min(this.notchF * 1.46, fs * 0.45) * Math.PI / fs);
      const R1 = 0.22, R2 = 0.3, h1 = 1 / (1 + 2 * R1 * g1 + g1 * g1), h2 = 1 / (1 + 2 * R2 * g2 + g2 * g2);
      const depth = this.notchD, notch2 = this.notch2, rearG = this.rearG, cRear = this.cRear;
      const eq = e.eq, A3 = this.eq3 - 1, A1 = this.eq1 - 1, A8 = this.eq8 - 1;
      const g3 = this.g3, g10 = this.g10, g8 = this.g8;
      const R3 = 0.42, R10 = 0.4, R8 = 0.35;
      const h3 = 1 / (1 + 2 * R3 * g3 + g3 * g3), h10 = 1 / (1 + 2 * R10 * g10 + g10 * g10), h8 = 1 / (1 + 2 * R8 * g8 + g8 * g8);
      const sk = e.sk, skull = this.skull, dry = 1 - skull, cS1 = this.cSk1, cS2 = this.cSk2;
      const right = e === t.R, gA = right ? this.gSkA2 : this.gSkA1, gB = right ? this.gSkB2 : this.gSkB1;
      const RA = 0.11, RB = 0.09, hA = 1 / (1 + 2 * RA * gA + gA * gA), hB = 1 / (1 + 2 * RB * gB + gB * gB);
      let w = this.w;
      for (let s = 0; s < n; s++) {
        d += dStep; amp += aStep; gl += dl; gm += dm; gh += dh; b0 += db0; b1 += db1;
        const rp = w - d;
        let x = this.readSinc(rp);
        if (fading) { xf += dx; const g = xf * xf * (3 - 2 * xf); x += g * (this.readSinc(rp - off) - x); }
        const raw = x;
        lp1 += c1 * (x - lp1); lp2 += c2 * (x - lp2);
        let v = gl * lp1 + gm * (lp2 - lp1) + gh * (x - lp2);
        const y0 = b0 * v + b1 * shX - a1 * shY;
        shX = v; shY = y0;
        v = y0;
        let hp = (v - (2 * R1 + g1) * s1 - s2) * h1, bp = g1 * hp + s1;
        s1 = g1 * hp + bp; let lp = g1 * bp + s2; s2 = g1 * bp + lp;
        v -= depth * 2 * R1 * bp;
        hp = (v - (2 * R2 + g2) * s3 - s4) * h2; bp = g2 * hp + s3;
        s3 = g2 * hp + bp; lp = g2 * bp + s4; s4 = g2 * bp + lp;
        v -= depth * notch2 * 2 * R2 * bp;
        rear += cRear * (v - rear);
        v = rear + rearG * (v - rear);
        let p = (v - (2 * R3 + g3) * eq[0] - eq[1]) * h3, q = g3 * p + eq[0];
        eq[0] = g3 * p + q; let l = g3 * q + eq[1]; eq[1] = g3 * q + l;
        v += A3 * 2 * R3 * q;
        p = (v - (2 * R10 + g10) * eq[2] - eq[3]) * h10; q = g10 * p + eq[2];
        eq[2] = g10 * p + q; l = g10 * q + eq[3]; eq[3] = g10 * q + l;
        v += A1 * 2 * R10 * q;
        p = (v - (2 * R8 + g8) * eq[4] - eq[5]) * h8; q = g8 * p + eq[4];
        eq[4] = g8 * p + q; l = g8 * q + eq[5]; eq[5] = g8 * q + l;
        v += A8 * 2 * R8 * q;
        if (skull > 0.0005) {
          sk[0] += cS1 * (raw - sk[0]); sk[1] += cS1 * (sk[0] - sk[1]);
          sk[2] += cS2 * (raw - sk[2]);
          p = (raw - (2 * RA + gA) * sk[3] - sk[4]) * hA; q = gA * p + sk[3];
          sk[3] = gA * p + q; l = gA * q + sk[4]; sk[4] = gA * q + l;
          const resA = 2 * RA * q;
          p = (raw - (2 * RB + gB) * sk[5] - sk[6]) * hB; q = gB * p + sk[5];
          sk[5] = gB * p + q; l = gB * q + sk[6]; sk[6] = gB * q + l;
          const resB = 2 * RB * q;
          v = dry * v + skull * (0.62 * sk[1] + 0.95 * sk[2] + 0.6 * resA + 0.34 * resB);
        }
        out[s] += v * amp;
        w++;
      }
      e.lp1 = lp1; e.lp2 = lp2; e.shX = shX; e.shY = shY;
      e.s1 = s1; e.s2 = s2; e.s3 = s3; e.s4 = s4; e.rear = rear;
    }

    /* Silent voices clear their state and stop computing until sound returns */
    sleep() {
      this.sleeping = true;
      this.buf.fill(0);
      this.late = new LateReverb(this.fs);
      if (this.last) this.late.setRoom(this.last[0].stats, this.last[3]);
      for (const t of this.pool) t.active = false;
      for (const a of [...this.scatterL, ...this.scatterR]) a.b.fill(0);
      for (const e of [this.direct.L, this.direct.R]) { e.lp1 = e.lp2 = e.shX = e.shY = e.s1 = e.s2 = e.s3 = e.s4 = e.rear = 0; e.eq.fill(0); e.sk.fill(0); }
      this.first = true;
    }
    wake() {
      this.sleeping = false; this.quietIn = 0; this.quietOut = 0;
      if (this.last) { const [r, S, L, b, o, m] = this.last; this.setDirect(r, S, L, b); this.setReflections(r, S, L, b, o, m); }
    }

    renderBlock() {
      const m = SUB, tmpL = this.outFL, tmpR = this.outFR, input = this.inF;
      let inPeak = 0;
      for (let s = 0; s < m; s++) { const a = Math.abs(input[s]); if (a > inPeak) inPeak = a; }
      if (this.sleeping) {
        if (inPeak * this.inGainT < 1e-9) { tmpL.fill(0); tmpR.fill(0); return; }
        this.wake();
      }
      const g0 = this.inGain;
      this.inGain += (this.inGainT - this.inGain) * this.kGain;
      const dg = (this.inGain - g0) / m;
      let g = g0;
      for (let s = 0; s < m; s++) { g += dg; this.buf[(this.w + s) & this.mask] = input[s] * g; }
      const k = this.kGain;
      this.doppler += (this.dopplerT - this.doppler) * k;
      this.notchF += (this.notchFT - this.notchF) * k; this.notchD += (this.notchDT - this.notchD) * k;
      this.rearG += (this.rearGT - this.rearG) * k;
      this.eq3 += (this.eq3T - this.eq3) * k; this.eq1 += (this.eq1T - this.eq1) * k; this.eq8 += (this.eq8T - this.eq8) * k;
      this.skull += (this.skullT - this.skull) * k;
      this.notch2 += (this.notch2T - this.notch2) * k;

      tmpL.fill(0); tmpR.fill(0); this.busL.fill(0); this.busR.fill(0);
      this.stepTap(this.direct, m);
      this.renderDirectEar(this.direct, this.direct.L, tmpL, m);
      this.renderDirectEar(this.direct, this.direct.R, tmpR, m);
      for (const t of this.pool) {
        if (!t.active) continue;
        this.stepTap(t, m);
        this.renderEar(t, t.L, tmpL, this.busL, m);
        this.renderEar(t, t.R, tmpR, this.busR, m);
        if (t.dying && t.L.amp < 2e-5 && t.R.amp < 2e-5) t.active = false;
      }
      for (const [bus, chain, out] of [[this.busL, this.scatterL, tmpL], [this.busR, this.scatterR, tmpR]]) {
        for (let s = 0; s < m; s++) {
          let x = bus[s];
          for (let c = 0; c < chain.length; c++) {
            const a = chain[c], d = a.b[a.i], v = x + 0.6 * d;
            a.b[a.i] = v; x = d - 0.6 * v;
            if (++a.i >= a.b.length) a.i = 0;
          }
          out[s] += x;
        }
      }
      this.lateD += clamp((this.lateDT - this.lateD) * this.kDelay, -0.3 * m, 0.3 * m);
      const lateIn = this.lateIn;
      for (let s = 0; s < m; s++) {
        const rp = this.w + s - this.lateD, i = Math.floor(rp), f = rp - i;
        lateIn[s] = this.buf[i & this.mask] * (1 - f) + this.buf[(i + 1) & this.mask] * f;
      }
      this.late.process(lateIn, tmpL, tmpR, m, this.lateLevel * this.roomDuck * this.lateFocus, this.lateTiltT);
      const o0 = this.outGain;
      this.outGain += clamp(this.outGainT - this.outGain, -m / (this.fs * 0.03), m / (this.fs * 0.03));
      const dO = (this.outGain - o0) / m;
      let og = o0, outPeak = 0;
      for (let s = 0; s < m; s++) {
        og += dO; tmpL[s] *= og; tmpR[s] *= og;
        const a = Math.max(Math.abs(tmpL[s]), Math.abs(tmpR[s]));
        if (a > outPeak) outPeak = a;
      }
      if (outPeak > this.peak) this.peak = outPeak;
      this.w = (this.w + m) & this.mask;
      this.quietIn = inPeak * this.inGain < 1e-9 ? this.quietIn + m : 0;
      this.quietOut = outPeak < 1e-7 ? this.quietOut + m : 0;
      if (this.quietIn > this.fs * 0.25 && this.quietOut > this.fs * 0.25) this.sleep();
    }

    /* input is mono; output is mixed into outL and outR. Any host block size gives identical
       audio because the engine always runs on fixed 32-sample blocks (32 samples of latency). */
    process(input, outL, outR, n) {
      const R = this.dcR;
      for (let i = 0; i < n; i++) {
        let x = input ? input[i] : 0;
        if (!(x === x) || x === Infinity || x === -Infinity) x = 0;       // never let bad samples in
        x = x > 4 ? 4 : x < -4 ? -4 : x;
        if (x > -1e-15 && x < 1e-15) x = 0;
        const y = x - this.dcX + R * this.dcY;                            // removes DC offset
        this.dcX = x; this.dcY = y > -1e-20 && y < 1e-20 ? 0 : y;
        const p = this.fifo;
        outL[i] += this.outFL[p]; outR[i] += this.outFR[p];
        this.inF[p] = y;
        if (++this.fifo === SUB) { this.fifo = 0; this.renderBlock(); }
      }
    }
  }

  /* Stereo-linked look-ahead limiter: a safety ceiling for anything thrown at the engine */
  class Limiter {
    constructor(fs, ceiling = 0.97) {
      this.ceiling = ceiling;
      this.len = Math.max(8, Math.round(fs * 0.0015));
      this.dL = new Float32Array(this.len); this.dR = new Float32Array(this.len);
      this.hold = new Float32Array(this.len).fill(1); this.box = new Float32Array(this.len).fill(1);
      this.i = 0; this.sum = this.len; this.env = 1;
      this.rel = 1 - Math.exp(-1 / (fs * 0.12));
    }
    process(L, R, n) {
      const len = this.len, c = this.ceiling;
      for (let s = 0; s < n; s++) {
        const a = Math.max(Math.abs(L[s]), Math.abs(R[s]));
        const want = a > c ? c / a : 1;
        const i = this.i;
        this.hold[i] = want;
        let low = 1; for (let k = 0; k < len; k++) if (this.hold[k] < low) low = this.hold[k];
        this.env = low < this.env ? low : this.env + (low - this.env) * this.rel;
        this.sum += this.env - this.box[i]; this.box[i] = this.env;
        const g = Math.min(1, this.sum / len);
        const xl = this.dL[i], xr = this.dR[i];
        this.dL[i] = L[s]; this.dR[i] = R[s];
        L[s] = clamp(xl * g, -c, c); R[s] = clamp(xr * g, -c, c);
        this.i = i + 1 === len ? 0 : i + 1;
      }
    }
  }

  /* ----------------------------------------------------------- built-in sounds */
  function renderLoop(type, bpm, fs) {
    const beat = (60 / bpm) * fs, bars = 2, len = Math.round(beat * 4 * bars);
    const out = new Float32Array(len);
    let seed = 22222;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 1073741823.5 - 1);
    const at = b => Math.round(b * beat);
    const put = (start, n, fn) => { for (let i = 0; i < n; i++) out[(start + i) % len] += fn(i / fs, i); };

    if (type === 'drums') {
      const kick = b => put(at(b), fs * 0.3, t => 0.9 * Math.exp(-t * 16) * Math.sin(TAU * (48 * t + 3.4 * (1 - Math.exp(-t * 34)))));
      const snare = b => { let lp = 0; put(at(b), fs * 0.24, t => { const n = rnd(); lp += 0.55 * (n - lp); return 0.42 * Math.exp(-t * 20) * (n - lp) + 0.3 * Math.exp(-t * 30) * Math.sin(TAU * 196 * t); }); };
      const hat = (b, v) => { let lp = 0; put(at(b), fs * 0.05, t => { const n = rnd(); lp += 0.8 * (n - lp); return v * Math.exp(-t * 110) * (n - lp); }); };
      for (let b = 0; b < 8; b += 2) { kick(b); snare(b + 1); }
      kick(2.5); kick(6.5); kick(7.5);
      for (let b = 0; b < 8; b += 0.5) hat(b, b % 1 ? 0.2 : 0.34);
    } else if (type === 'shaker') {
      for (let b = 0; b < 8; b += 0.25) {
        const v = b % 1 === 0 ? 0.55 : b % 0.5 === 0 ? 0.32 : 0.2;
        let lp = 0;
        put(at(b), fs * 0.09, t => { const n = rnd(); lp += 0.5 * (n - lp); return v * Math.min(t * 500, 1) * Math.exp(-t * 48) * (n - lp); });
      }
    } else if (type === 'pluck') {
      const notes = [57, 64, 69, 72, 76, 72, 69, 64, 53, 60, 65, 69, 72, 69, 65, 60];
      notes.forEach((m, i) => {
        const period = Math.round(fs / (440 * Math.pow(2, (m - 69) / 12)));
        const ring = new Float32Array(period);
        for (let j = 0; j < period; j++) ring[j] = rnd();
        let p = 0, prev = 0;
        put(at(i * 0.5), fs * 1.1, () => { const v = ring[p]; const nx = 0.996 * 0.5 * (v + prev); prev = v; ring[p] = nx; p = (p + 1) % period; return v * 0.42; });
      });
    } else if (type === 'voice') {
      const vowels = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480]];
      const notes = [52, 55, 59, 57];
      notes.forEach((m, n) => {
        const f0 = 440 * Math.pow(2, (m - 69) / 12), dur = Math.round(beat * 2), st = at(n * 2);
        const fil = vowels[n].map(f => ({ f, a: 0, b: 0 }));
        let ph = 0;
        for (let i = 0; i < dur; i++) {
          const t = i / fs, vib = 1 + 0.008 * Math.sin(TAU * 5.2 * t) * Math.min(t * 2, 1);
          ph += (f0 * vib) / fs; if (ph > 1) ph -= 1;
          const src = 2 * ph - 1 + 0.03 * rnd();
          let v = 0;
          fil.forEach((q, k) => {
            const g = 2 * Math.sin((Math.PI * q.f) / fs), Q = 0.09;
            const hp = src - q.b - Q * q.a; q.a += g * hp; q.b += g * q.a;
            v += q.a / (k + 1);
          });
          const env = Math.min(i / (fs * 0.05), 1) * Math.min((dur - i) / (fs * 0.09), 1);
          out[(st + i) % len] += v * env * 0.16;
        }
      });
    } else if (type === 'clicks') {
      for (let b = 0; b < 8; b += 1) put(at(b), Math.round(fs * 0.004), (t, i) => 0.85 * Math.exp(-i / (fs * 0.0007)) * (i % 2 ? -1 : 1));
    } else {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let b = 0; b < 8; b += 2) put(at(b), Math.round(beat * 1.4), (t, i) => {
        const w = rnd(); b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        const edge = Math.min(i / (fs * 0.01), (beat * 1.4 - i) / (fs * 0.01), 1);
        return 0.16 * (b0 + b1 + b2 + w * 0.1848) * edge;
      });
    }
    return out;
  }

  /* -------------------------------------------------------------------- engine */
  class Engine {
    constructor(fs) {
      this.fs = fs;
      this.voices = new Map();
      this.loops = new Map();
      this.scene = null;
      this.room = null;
      this.playing = false;
      this.beat = 0;
      this.sample = 0;
      this.counter = 0;
      this.robin = 0;
      this.inputBuf = new Float32Array(CONTROL);
      this.binaural = true;
      this.limiter = new Limiter(fs);
    }
    get spb() { return (60 / this.scene.bpm) * this.fs; }
    setLoop(id, data) { this.loops.set(id, data); }
    setTransport(playing, beat) {
      this.playing = playing;
      if (beat != null) { this.beat = beat; if (this.scene) this.sample = Math.round(beat * this.spb); }
    }
    setScene(scene) {
      const tempoChanged = this.scene && this.scene.bpm !== scene.bpm;
      this.scene = scene;
      if (tempoChanged) this.sample = Math.round(this.beat * this.spb);
      this.room = new SharedRoom(scene.room);
      this.binaural = scene.output !== 'speakers';
      const anySolo = scene.tracks.some(t => t.solo);
      const keep = new Set();
      for (const t of scene.tracks) {
        keep.add(t.id);
        let v = this.voices.get(t.id);
        if (!v) { v = new Voice(this.fs, t.id); this.voices.set(t.id, v); v.doppler = clamp(t.doppler, 0, 2); }
        v.track = t;
        v.outGainT = 1;
        v.dopplerT = clamp(t.doppler, 0, 2);
        v.directLevel = t.direct; v.earlyLevel = t.early; v.lateLevel = t.late;
        v.inGainT = t.mute || (anySolo && !t.solo) ? 0 : t.gain;
        v.late.setRoom(this.room.stats, this.binaural);
      }
      // removed tracks fade out instead of cutting off
      for (const [id, v] of this.voices) if (!keep.has(id)) { v.outGainT = 0; v.inGainT = 0; }
      this.control(true);
    }
    control(all) {
      if (!this.room) return;
      const L = this.scene.listener, list = [...this.voices.values()];
      const order = clamp(this.scene.quality?.order ?? 2, 1, 3), taps = clamp(this.scene.quality?.taps ?? 16, 4, 28);
      list.forEach((v, i) => {
        if (v.outGainT === 0) return;
        evalPath(v.track.motion, this.beat, v.pos);
        v.pos.z = clamp(v.pos.z, 0.05, this.room.height - 0.05);  // curves may overshoot between keys
        v.setDirect(this.room, v.pos, L, this.binaural);
        if (all || i === this.robin % list.length) v.setReflections(this.room, v.pos, L, this.binaural, order, taps);
      });
      this.robin++;
    }
    process(outL, outR, n) {
      outL.fill(0, 0, n); outR.fill(0, 0, n);
      if (!this.room) return;
      const spb = this.spb;
      let off = 0;
      while (off < n) {
        if (this.counter <= 0) { this.control(false); this.counter = CONTROL; }
        const m = Math.min(n - off, this.counter, CONTROL);
        const L = outL.subarray(off, off + m), R = outR.subarray(off, off + m);
        for (const [id, v] of this.voices) {
          const loop = this.loops.get(v.id);
          const inp = this.inputBuf;
          if (this.playing && loop && loop.length) {
            for (let i = 0; i < m; i++) inp[i] = loop[(this.sample + i) % loop.length];
          } else inp.fill(0, 0, m);
          v.process(inp, L, R, m);
          if (v.outGainT === 0 && v.outGain <= 0) this.voices.delete(id);
        }
        if (this.playing) { this.sample += m; this.beat = this.sample / spb; }
        off += m;
        this.counter -= m;
      }
      this.limiter.process(outL, outR, n);
    }
    telemetry() {
      const voices = [];
      for (const v of this.voices.values()) {
        const rays = [];
        for (const t of v.pool) if (t.active && !t.dying && t.pts) rays.push({ p: t.pts, o: t.order, l: t.level });
        voices.push({ id: v.id, x: v.pos.x, y: v.pos.y, z: v.pos.z, occ: v.occlusion, peak: v.peak, rays });
        v.peak = 0;
      }
      return { beat: this.beat, voices };
    }
  }

  return { Engine, Voice, Limiter, SharedRoom, LateReverb, analyzeRoom, evalPath, pathPhase, renderLoop, headCues, MATERIALS, pointInPoly, signedArea, obstacleCorners, BEATS_PER_BAR, C };
}
if (typeof module !== 'undefined') module.exports = RoomwalkerDSP;
