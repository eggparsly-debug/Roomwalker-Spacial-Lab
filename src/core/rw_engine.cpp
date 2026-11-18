#include "rw_engine.h"
#include <algorithm>
#include <cmath>

namespace rw {

static const double PI = 3.14159265358979323846;
static const double C = 343, TAU = PI * 2, HEAD_RADIUS = 0.0875, MIN_DELAY = 9;
static inline double clamp(double v, double a, double b) { return v < a ? a : v > b ? b : v; }
static inline double jsRound(double x) { return std::floor(x + 0.5); }
static inline double hyp3(double a, double b, double c) { return std::sqrt(a * a + b * b + c * c); }
static inline double hyp2(double a, double b) { return std::sqrt(a * a + b * b); }
static inline double sgn(double x) { return x > 0 ? 1 : x < 0 ? -1 : 0; }

// ---- 12-point Kaiser-windowed sinc for the direct path
static const int SINC_TAPS = 12, SINC_PHASES = 256;
static const std::vector<double>& sincTable()
{
    static const std::vector<double> table = [] {
        auto bessel = [](double x) { double s = 1, t = 1; for (int k = 1; k < 30; k++) { t *= std::pow(x / (2 * k), 2); s += t; } return s; };
        const double beta = 6.5;
        std::vector<double> h((size_t) ((SINC_PHASES + 1) * SINC_TAPS));
        for (int p = 0; p <= SINC_PHASES; p++) {
            const double f = (double) p / SINC_PHASES; double sum = 0;
            for (int k = 0; k < SINC_TAPS; k++) {
                const double x = k - 5 - f, r = x / 6;
                const double win = std::abs(r) >= 1 ? 0 : bessel(beta * std::sqrt(1 - r * r)) / bessel(beta);
                const double v = (std::abs(x) < 1e-9 ? 1 : std::sin(PI * x) / (PI * x)) * win;
                h[(size_t) (p * SINC_TAPS + k)] = v; sum += v;
            }
            for (int k = 0; k < SINC_TAPS; k++) h[(size_t) (p * SINC_TAPS + k)] /= sum;
        }
        return h;
    }();
    return table;
}

// ---- materials: absorption at low / mid / high
struct Material { const char* id; double a[3]; };
static const Material MATERIALS[] = {
    { "plaster", { 0.12, 0.06, 0.04 } }, { "concrete", { 0.02, 0.03, 0.05 } }, { "brick", { 0.03, 0.04, 0.07 } },
    { "stone", { 0.02, 0.03, 0.04 } }, { "rock", { 0.05, 0.08, 0.14 } }, { "tile", { 0.01, 0.015, 0.02 } },
    { "glass", { 0.2, 0.05, 0.03 } }, { "drywall", { 0.2, 0.06, 0.05 } }, { "wood", { 0.2, 0.1, 0.08 } },
    { "hardwood", { 0.12, 0.08, 0.08 } }, { "carpet", { 0.08, 0.35, 0.6 } }, { "curtain", { 0.1, 0.5, 0.65 } },
    { "foam", { 0.2, 0.75, 0.95 } }
};
static const double AIR[3] = { 0.0001, 0.0006, 0.0045 };
int materialIndex(const std::string& id)
{
    for (size_t i = 0; i < sizeof(MATERIALS) / sizeof(MATERIALS[0]); i++) if (id == MATERIALS[i].id) return (int) i;
    return 0;   // unknown materials read as plaster
}

// ---- geometry
static double signedArea(const std::vector<Vert>& v)
{
    double s = 0;
    for (size_t i = 0; i < v.size(); i++) { const Vert& a = v[i]; const Vert& b = v[(i + 1) % v.size()]; s += a.x * b.y - b.x * a.y; }
    return s / 2;
}
static bool pointInPoly(double x, double y, const std::vector<Vert>& v)
{
    bool inside = false;
    for (size_t i = 0, j = v.size() - 1; i < v.size(); j = i++) {
        const Vert& a = v[i]; const Vert& b = v[j];
        if ((a.y > y) != (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

RoomStats analyzeRoom(const RoomDesc& desc)
{
    const double H = std::max(1.5, desc.height);
    const auto& v = desc.verts;
    const double planArea = std::abs(signedArea(v));
    double perim = 0, absorb[3] = { 0, 0, 0 };
    auto add = [&](int mat, double area) { for (int b = 0; b < 3; b++) absorb[b] += area * MATERIALS[mat].a[b]; };
    for (size_t i = 0; i < v.size(); i++) {
        const Vert& p = v[i]; const Vert& q = v[(i + 1) % v.size()];
        const double len = hyp2(q.x - p.x, q.y - p.y);
        perim += len; add(p.mat, len * H);
    }
    add(desc.floor, planArea); add(desc.ceiling, planArea);
    double volume = planArea * H, surface = 2 * planArea + perim * H;
    for (const Obstacle& o : desc.obstacles) {
        const double h = std::min(o.h, H);
        volume -= o.w * o.d * h;
        const double area = 2 * (o.w + o.d) * h;
        surface += area; add(o.mat, area);
    }
    volume = std::max(1.0, volume);
    RoomStats st {};
    for (int b = 0; b < 3; b++) {
        const double mean = clamp(absorb[b] / surface, 0.001, 0.98);
        st.rt[b] = clamp((desc.decay * 0.161 * volume) / (-surface * std::log(1 - mean) + 4 * AIR[b] * volume), 0.05, 20);
    }
    st.volume = volume; st.surface = surface; st.planArea = planArea; st.mfp = (4 * volume) / surface;
    st.absorption = (0.161 * volume) / st.rt[1];
    st.critical = std::sqrt(st.absorption / (16 * PI));
    return st;
}

SharedRoom::SharedRoom(const RoomDesc& desc)
{
    const double H = height = std::max(1.5, desc.height);
    verts = desc.verts;
    if (signedArea(verts) < 0) {   // keep each wall's material attached to the wall when the winding flips
        const size_t n = verts.size(); std::vector<Vert> r;
        for (size_t i = 0; i < n; i++) r.push_back({ desc.verts[(n - i) % n].x, desc.verts[(n - i) % n].y, desc.verts[(2 * n - i - 1) % n].mat });
        verts = r;
    }
    auto setR = [](Surface& s, int m) { for (int b = 0; b < 3; b++) s.R[b] = std::sqrt(1 - MATERIALS[m].a[b]); };
    for (size_t i = 0; i < verts.size(); i++) {
        const Vert& p = verts[i]; const Vert& q = verts[(i + 1) % verts.size()];
        Surface s; s.kind = Surface::Wall; s.px = p.x; s.py = p.y; s.qx = q.x; s.qy = q.y; s.ex = q.x - p.x; s.ey = q.y - p.y;
        s.len = hyp2(s.ex, s.ey); if (s.len == 0) s.len = 1;
        s.nx = -s.ey / s.len; s.ny = s.ex / s.len; s.d = s.nx * p.x + s.ny * p.y; s.zmax = H; setR(s, p.mat);
        blockers.push_back((int) surfaces.size()); surfaces.push_back(s);
    }
    Surface fl; fl.kind = Surface::Floor; fl.nz = 1; fl.d = 0; setR(fl, desc.floor); surfaces.push_back(fl);
    Surface ce; ce.kind = Surface::Ceil; ce.nz = -1; ce.d = -H; setR(ce, desc.ceiling); surfaces.push_back(ce);
    int oi = 0;
    for (const Obstacle& o : desc.obstacles) {
        const double c = std::cos(o.rot), sn = std::sin(o.rot), w = o.w / 2, d = o.d / 2, h = std::min(o.h, H);
        const double pts[4][2] = { { -w, -d }, { w, -d }, { w, d }, { -w, d } };
        Obs ob; ob.h = h;
        for (int i = 0; i < 4; i++) ob.corners[(size_t) i] = { o.x + pts[i][0] * c - pts[i][1] * sn, o.y + pts[i][0] * sn + pts[i][1] * c, 0 };
        obstacles.push_back(ob);
        for (int i = 0; i < 4; i++) {   // corners run counter-clockwise, so the right-hand normal faces outward
            const Vec3& p = ob.corners[(size_t) i]; const Vec3& q = ob.corners[(size_t) ((i + 1) % 4)];
            Surface s; s.kind = Surface::Obs; s.px = p.x; s.py = p.y; s.qx = q.x; s.qy = q.y; s.ex = q.x - p.x; s.ey = q.y - p.y;
            s.len = hyp2(s.ex, s.ey); if (s.len == 0) s.len = 1;
            s.nx = s.ey / s.len; s.ny = -s.ex / s.len; s.d = s.nx * p.x + s.ny * p.y; s.zmax = h; s.obs = oi; setR(s, o.mat);
            blockers.push_back((int) surfaces.size()); surfaces.push_back(s);
        }
        oi++;
    }
    for (size_t i = 0; i < surfaces.size(); i++) surfaces[i].id = (int) i;
    stats = analyzeRoom(desc);
}

double SharedRoom::hit(double ax, double ay, double az, double bx, double by, double bz, const Surface& s) const
{
    const double dx = bx - ax, dy = by - ay;
    const double den = dx * s.ey - dy * s.ex;
    if (den > -1e-10 && den < 1e-10) return -1;
    const double rx = s.px - ax, ry = s.py - ay;
    const double t = (rx * s.ey - ry * s.ex) / den;
    if (t <= 1e-4 || t >= 0.9999) return -1;
    const double u = (rx * dy - ry * dx) / den;
    if (u < 0 || u > 1) return -1;
    if (az + t * (bz - az) > s.zmax) return -1;
    return t;
}
bool SharedRoom::blocked(double ax, double ay, double az, double bx, double by, double bz, int skipA, int skipB) const
{
    for (int b : blockers) {
        const Surface& s = surfaces[(size_t) b];
        if (s.id == skipA || s.id == skipB) continue;
        if (hit(ax, ay, az, bx, by, bz, s) >= 0) return true;
    }
    return false;
}
double SharedRoom::detour(const Vec3& a, const Vec3& b) const
{
    const double direct = hyp3(b.x - a.x, b.y - a.y, b.z - a.z);
    double wall = 0, obstacle = 0; uint64_t seen = 0;
    auto via = [&](double x, double y, double z) { return hyp3(x - a.x, y - a.y, z - a.z) + hyp3(x - b.x, y - b.y, z - b.z) - direct; };
    for (int bi : blockers) {
        const Surface& s = surfaces[(size_t) bi];
        const double t = hit(a.x, a.y, a.z, b.x, b.y, b.z, s);
        if (t < 0) continue;
        const double z = a.z + t * (b.z - a.z);
        if (s.kind == Surface::Wall) {
            wall = std::max(wall, std::min(via(s.px, s.py, z), via(s.qx, s.qy, z)));
        } else if (!(seen & (1ull << s.obs))) {
            seen |= 1ull << s.obs;
            const Obs& o = obstacles[(size_t) s.obs];
            double best = via(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), o.h);
            for (const Vec3& c : o.corners) best = std::min(best, via(c.x, c.y, z));
            obstacle += std::max(0.0, best);
        }
    }
    return wall + obstacle;
}
bool SharedRoom::onSurface(const Surface& s, double x, double y, double z) const
{
    if (s.kind == Surface::Floor || s.kind == Surface::Ceil) return pointInPoly(x, y, verts);
    const double u = ((x - s.px) * s.ex + (y - s.py) * s.ey) / (s.len * s.len);
    return u >= 0 && u <= 1 && z >= 0 && z <= s.zmax;
}

struct ReflectionSearch {
    const SharedRoom& room; const Vec3& S; const Vec3& L; int order; Reflection* out; int capacity;
    int count = 0, budget = 5000, chain[4] = {}; Vec3 images[4];

    void trace(int depth)
    {
        double tx = L.x, ty = L.y, tz = L.z, gl = 1, gm = 1, gh = 1, ax = 0, ay = 0, az = 0; int prev = -1; bool firstPt = true;
        for (int j = depth - 1; j >= 0; j--) {
            const Surface& s = room.surfaces[(size_t) chain[j]]; const Vec3& I = images[j];
            const double dx = I.x - tx, dy = I.y - ty, dz = I.z - tz;
            const double den = s.nx * dx + s.ny * dy + s.nz * dz;
            if (den > -1e-9 && den < 1e-9) return;
            const double t = (s.d - (s.nx * tx + s.ny * ty + s.nz * tz)) / den;
            if (t <= 1e-4 || t >= 0.9999) return;
            const double px = tx + t * dx, py = ty + t * dy, pz = tz + t * dz;
            if (!room.onSurface(s, px, py, pz)) return;
            if (room.blocked(tx, ty, tz, px, py, pz, prev, s.id)) return;
            if (firstPt) { ax = px; ay = py; az = pz; firstPt = false; }
            gl *= s.R[0]; gm *= s.R[1]; gh *= s.R[2];
            tx = px; ty = py; tz = pz; prev = s.id;
        }
        if (room.blocked(tx, ty, tz, S.x, S.y, S.z, prev, -1)) return;
        if (count >= capacity) return;
        const Vec3& I = images[depth - 1];
        const double dist = hyp3(I.x - L.x, I.y - L.y, I.z - L.z);
        int64_t key = 0;
        for (int j = 0; j < depth; j++) key = key * 64 + chain[j] + 1;
        Reflection& r = out[count++];
        r.key = key; r.dist = dist; r.gl = gl; r.gm = gm; r.gh = gh; r.order = depth; r.ax = ax; r.ay = ay; r.az = az;
        r.rank = gm / std::max(dist, 0.3);
    }
    void descend(int depth, const Vec3& from)
    {
        const int n = (int) room.surfaces.size();
        for (int i = 0; i < n; i++) {
            if (depth > 0 && chain[depth - 1] == i) continue;
            if (--budget < 0) return;
            const Surface& s = room.surfaces[(size_t) i];
            const double side = s.nx * from.x + s.ny * from.y + s.nz * from.z - s.d;
            if (side <= 0) continue;
            if (s.nx * L.x + s.ny * L.y + s.nz * L.z - s.d <= 0 && depth + 1 == order) continue;
            const Vec3 img { from.x - 2 * side * s.nx, from.y - 2 * side * s.ny, from.z - 2 * side * s.nz };
            chain[depth] = i; images[depth] = img;
            trace(depth + 1);
            if (depth + 1 < order) descend(depth + 1, img);
        }
    }
};
int SharedRoom::findReflections(const Vec3& S, const Vec3& L, int order, Reflection* out, int capacity) const
{
    ReflectionSearch r { *this, S, L, order, out, capacity, 0, 5000, {}, {} };
    r.descend(0, S);
    return r.count;
}

// ---- motion
double pathPhase(const Motion& m, double beat, double autoPos)
{
    const double len = std::max(1.0, m.bars * BEATS_PER_BAR);
    if (m.automation) return clamp(autoPos, 0, 1) * len;
    if (m.loop == Loop::Once) return clamp(beat, 0, len);
    if (m.loop == Loop::PingPong) {
        const double p = std::fmod(std::fmod(beat, 2 * len) + 2 * len, 2 * len);
        return p > len ? 2 * len - p : p;
    }
    return std::fmod(std::fmod(beat, len) + len, len);
}
void evalPath(const Motion& m, double beat, double autoPos, Vec3& out)
{
    const auto& k = m.keys; const int n = (int) k.size();
    if (!n) return;
    auto at = [&](const Key& a) { out.x = a.x; out.y = a.y; out.z = a.z; };
    if (n == 1) { at(k[0]); return; }
    const double len = std::max(1.0, m.bars * BEATS_PER_BAR);
    const bool closed = m.loop == Loop::Loop;
    const double p = pathPhase(m, beat, autoPos);
    int i0;
    if (p < k[0].t) {
        if (!closed) { at(k[0]); return; }
        i0 = n - 1;
    } else {
        i0 = n - 1;
        for (int i = 0; i < n - 1; i++) if (p < k[(size_t) i + 1].t) { i0 = i; break; }
        if (i0 == n - 1 && !closed) { at(k[(size_t) n - 1]); return; }
    }
    const int i1 = (i0 + 1) % n;
    double t0 = k[(size_t) i0].t, t1 = k[(size_t) i1].t, q = p;
    if (i1 <= i0) { t1 += len; if (q < t0) q += len; }
    const double raw = t1 > t0 ? clamp((q - t0) / (t1 - t0), 0, 1) : 0;
    double u = raw;
    switch (k[(size_t) i0].ease) {
        case Ease::Smooth: u = raw * raw * (3 - 2 * raw); break;
        case Ease::In: u = raw * raw; break;
        case Ease::Out: u = 1 - (1 - raw) * (1 - raw); break;
        default: break;
    }
    const Key& a = k[(size_t) i0]; const Key& b = k[(size_t) i1];
    if (!m.curve) { out.x = a.x + (b.x - a.x) * u; out.y = a.y + (b.y - a.y) * u; out.z = a.z + (b.z - a.z) * u; return; }
    const Key& before = closed ? k[(size_t) ((i0 - 1 + n) % n)] : k[(size_t) std::max(0, i0 - 1)];
    const Key& after = closed ? k[(size_t) ((i1 + 1) % n)] : k[(size_t) std::min(n - 1, i1 + 1)];
    auto cr = [u](double p0, double p1, double p2, double p3) { return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u); };
    out.x = cr(before.x, a.x, b.x, after.x); out.y = cr(before.y, a.y, b.y, after.y); out.z = cr(before.z, a.z, b.z, after.z);
}

// ---- late reverb
static double lineRatio(int i) { return 0.55 * std::pow(1.75 / 0.55, (double) i / (LINES - 1)); }
static int walsh(int row, int i) { int n = row & i, c = 0; while (n) { c ^= n & 1; n >>= 1; } return c ? -1 : 1; }
static bool isPrime(int n) { for (int d = 3; d * d <= n; d += 2) if (n % d == 0) return false; return n % 2 == 1; }
static int nextPrime(int n) { n |= 1; while (!isPrime(n)) n += 2; return n; }
static const std::array<int, LINES> SIGN_L = [] { std::array<int, LINES> a {}; for (int i = 0; i < LINES; i++) a[(size_t) i] = walsh(5, i); return a; }();
static const std::array<int, LINES> SIGN_R = [] { std::array<int, LINES> a {}; for (int i = 0; i < LINES; i++) a[(size_t) i] = walsh(10, i); return a; }();
static const std::array<int, LINES> SIGN_IN = [] { std::array<int, LINES> a {}; for (int i = 0; i < LINES; i++) a[(size_t) i] = walsh(15, i); return a; }();

LateReverb::LateReverb(double sampleRate) : fs(sampleRate)
{
    int size = 1 << 12;
    while (size < fs * 0.36) size <<= 1;
    mask = size - 1;
    for (auto& l : lines) l.assign((size_t) size, 0.f);
    kLow = std::tan((PI * 400) / fs); kHigh = std::tan((PI * 3000) / fs);
    modDepth = fs * 0.0001;
    sideC = 1 - std::exp((-TAU * 220) / fs);
    for (int i = 0; i < LINES; i++) loopAP[(size_t) i].b.assign((size_t) nextPrime((int) jsRound(fs * (0.0031 + 0.00083 * i))), 0.f);
    const double ms[8] = { 1.3, 2.1, 3.1, 4.7, 7.3, 11.9, 17.3, 26.9 };
    for (int i = 0; i < 8; i++) { diff[(size_t) i].ms = ms[i]; diff[(size_t) i].b.assign((size_t) std::ceil((ms[i] * fs) / 1000), 0.f); }
    reset();
}
void LateReverb::reset()
{
    for (auto& l : lines) std::fill(l.begin(), l.end(), 0.f);
    for (int i = 0; i < LINES; i++) {
        const size_t u = (size_t) i;
        cur[u] = target[u] = lineRatio(i) * 0.03 * fs; gm[u] = 0.8; y[u] = 0;
        ls[u] = Filter {}; hs[u] = Filter {};
        phase[u] = i * 0.83; rate[u] = (TAU * (0.07 + i * 0.019)) / fs;
        std::fill(loopAP[u].b.begin(), loopAP[u].b.end(), 0.f); loopAP[u].i = 0;
    }
    for (auto& d : diff) { std::fill(d.b.begin(), d.b.end(), 0.f); d.i = 0; d.g = 0.6; }
    w = 0; tuned = false; apG = 0.5; gain = 0; gainTarget = 0; tiltL = tiltR = 1; sideLP = sideLP2 = 0; bassMono = false;
}
void LateReverb::design(Filter& fl, Filter& fh, double lowDb, double highDb) const
{
    const double low = std::pow(10, lowDb / 40), high = std::pow(10, highDb / 40);
    double K = kLow, a0 = 1 + K / low;
    fl.b0 = (1 + K * low) / a0; fl.b1 = (K * low - 1) / a0; fl.a1 = (K / low - 1) / a0;
    K = kHigh; a0 = 1 / high + K;
    fh.b0 = (high + K) / a0; fh.b1 = (K - high) / a0; fh.a1 = (K - 1 / high) / a0;
}
void LateReverb::setRoom(const RoomStats& st, bool binaural)
{
    const double PROBE[3] = { (TAU * 150) / fs, (TAU * 1000) / fs, (TAU * 6000) / fs };
    auto response = [](const Filter& f, double om) {
        const double c = std::cos(om), s = std::sin(om);
        const double num = std::pow(f.b0 + f.b1 * c, 2) + std::pow(f.b1 * s, 2), den = std::pow(1 + f.a1 * c, 2) + std::pow(f.a1 * s, 2);
        return 10 * std::log10(num / den);
    };
    // Long decays need more total delay, or the tail rings at individual pitches
    const double base = clamp(std::max(st.mfp / C, (0.15 * st.rt[1]) / LINES), 0.0105, 0.05) * fs;
    double total = 0;
    for (int i = 0; i < LINES; i++) {
        const size_t u = (size_t) i;
        target[u] = nextPrime((int) jsRound(base * lineRatio(i)));
        const double loopLen = target[u] + (double) loopAP[u].b.size();   // the in-loop allpass adds to the path
        total += loopLen;
        // Solve the three gains so the loop hits each band's target at 150 Hz, 1 kHz and 6 kHz
        double want[3]; for (int b = 0; b < 3; b++) want[b] = (-60 * loopLen) / (fs * st.rt[b]);
        double mid = want[1], low = want[0] - want[1], high = want[2] - want[1];
        Filter& fl = ls[u]; Filter& fh = hs[u];
        for (int it = 0; it < 6; it++) {
            design(fl, fh, low, high);
            double err[3]; for (int b = 0; b < 3; b++) err[b] = want[b] - (mid + response(fl, PROBE[b]) + response(fh, PROBE[b]));
            mid += err[1];
            low = clamp(low + (err[0] - err[1]) * 1.3, -60, 60);
            high = clamp(high + (err[2] - err[1]) * 1.3, -60, 60);
        }
        design(fl, fh, low, high);
        // Guarantee the loop loses energy at every frequency, in every room
        double top = -999;
        for (int k = 0; k <= 48; k++) {
            const double om = (TAU * 4 * std::pow(fs / 8.2, k / 48.0)) / fs;
            top = std::max(top, mid + response(fl, om) + response(fh, om));
        }
        const double ceiling = (-60 * loopLen) / (fs * 30);
        if (top > ceiling) mid -= top - ceiling;
        gm[u] = std::pow(10, mid / 20);
    }
    if (!tuned) { cur = target; tuned = true; }
    // The input diffusers must never ring longer than the room itself
    const double spread = clamp(st.rt[1] / 0.9, 0.62, 1);   // short rooms get less smear so they stay tight
    for (auto& a : diff) a.g = (a.ms < 8 ? 1 : spread) * std::min(0.6, std::pow(10, (-3 * a.ms) / (1000 * st.rt[1])));
    apG = 0.5 * spread;
    // Scale so the steady reverberant field matches the room's critical distance
    const double ratio = std::min(16.0, (16 * PI) / st.absorption);
    const double impulseEnergy = (fs * st.rt[1]) / (13.8 * total);
    gainTarget = std::sqrt(ratio / impulseEnergy);
    bassMono = binaural;
}
void LateReverb::process(const float* input, float* outL, float* outR, int n, double level, double tiltDb)
{
    const double tl0 = tiltL, tr0 = tiltR;
    tiltL += (std::pow(10, tiltDb / 20) - tiltL) * 0.02; tiltR += (std::pow(10, -tiltDb / 20) - tiltR) * 0.02;
    const double dtl = (tiltL - tl0) / n, dtr = (tiltR - tr0) / n; double tl = tl0, tr = tr0;
    const double depth = modDepth, margin = depth + 4;
    for (int i = 0; i < LINES; i++) cur[(size_t) i] += clamp(target[(size_t) i] - cur[(size_t) i], -2, 2);
    const double g0 = gain;
    gain += (gainTarget * level - gain) * 0.02;
    const double dg = (gain - g0) / n;
    double g = g0;
    for (int s = 0; s < n; s++) {
        double x = input[s];
        for (auto& a : diff) {
            const double d = a.b[(size_t) a.i], v = x + a.g * d;
            a.b[(size_t) a.i] = (float) v;
            x = d - a.g * v;
            if (++a.i >= (int) a.b.size()) a.i = 0;
        }
        double sum = 0, L = 0, R = 0;
        for (int i = 0; i < LINES; i++) {
            const size_t u = (size_t) i;
            phase[u] += rate[u];
            if (phase[u] > TAU) phase[u] -= TAU;
            const double rd = w - cur[u] - depth * std::sin(phase[u]) - margin;
            const double fl0 = std::floor(rd), f = rd - fl0; const int64_t idx = (int64_t) fl0;
            const float* b = lines[u].data();
            const double xm = b[(idx - 1) & mask], x0 = b[idx & mask], x1 = b[(idx + 1) & mask], x2 = b[(idx + 2) & mask];
            const double c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
            const double v = ((c3 * f + c2) * f + c1) * f + x0;
            Filter& fl = ls[u]; Filter& fh = hs[u];
            const double o1 = fl.b0 * v + fl.b1 * fl.x - fl.a1 * fl.y; fl.x = v; fl.y = o1;
            const double o2 = fh.b0 * o1 + fh.b1 * fh.x - fh.a1 * fh.y; fh.x = o1; fh.y = o2;
            Stage& ap = loopAP[u];
            const double z = ap.b[(size_t) ap.i], uu = o2 + apG * z;
            ap.b[(size_t) ap.i] = (float) uu; if (++ap.i >= (int) ap.b.size()) ap.i = 0;
            const double o = gm[u] * (z - apG * uu);
            y[u] = o; sum += o;
            L += SIGN_L[u] * v; R += SIGN_R[u] * v;
        }
        sum *= 2.0 / LINES;
        const double inj = x * 0.25;
        for (int i = 0; i < LINES; i++) lines[(size_t) i][(size_t) (w & mask)] = (float) (y[(size_t) i] - sum + SIGN_IN[(size_t) i] * inj);
        w = (w + 1) & mask;
        L *= 0.25; R *= 0.25;
        if (bassMono) {   // real rooms are coherent at the two ears below roughly 200 Hz
            const double side = 0.5 * (L - R), mid = 0.5 * (L + R);
            sideLP += sideC * (side - sideLP);
            const double hp1 = side - sideLP;
            sideLP2 += sideC * (hp1 - sideLP2);
            const double sh = hp1 - sideLP2;
            L = mid + sh; R = mid - sh;
        }
        g += dg;
        tl += dtl; tr += dtr;
        outL[s] = (float) (outL[s] + L * g * tl); outR[s] = (float) (outR[s] + R * g * tr);
    }
}

// ---- head-relative cues: spherical-head delay and shadow after Woodworth and Brown-Duda
static void headCues(double fx, double fy, double fz, const Listener& listener, bool binaural, double fs, Cues& r)
{
    const double yaw = listener.yaw, cy = std::cos(yaw), sy = std::sin(yaw);
    double m = hyp3(fx, fy, fz); if (m == 0) m = 1;
    const double x = fx / m, y = fy / m, z = fz / m;
    const double front = x * cy + y * sy, left = -x * sy + y * cy, up = z;
    r.front = front; r.left = left; r.up = up;
    const double K = (fs * HEAD_RADIUS) / C, a1 = (1 - K) / (1 + K);
    if (!binaural) {
        const double a = (PI / 4) * (1 + clamp(left, -1, 1));
        r.itdL = 0; r.itdR = 0; r.panL = std::sin(a); r.panR = std::cos(a);
        r.b0L = 1; r.b1L = a1; r.b0R = 1; r.b1R = a1;   // zero cancels the pole: flat
        r.maxItd = 0; r.itd = 0;
        return;
    }
    const double axis = clamp(left, -1, 1);
    const double lat = std::asin(axis), abs = std::abs(lat);
    const double itd = ((HEAD_RADIUS / C) * (abs + std::sin(abs)) * fs) / 2;
    const double maxItd = ((HEAD_RADIUS / C) * (PI / 2 + 1) * fs) / 2;
    r.maxItd = maxItd; r.itd = axis >= 0 ? itd : -itd;
    r.itdL = maxItd - r.itd; r.itdR = maxItd + r.itd;
    r.panL = 1; r.panR = 1;
    auto zero = [K](double cosine, double& b0, double& b1) {
        const double deg = (std::acos(clamp(cosine, -1, 1)) * 180) / PI;
        const double alpha = 1.05 + 0.95 * std::cos((std::min(deg, 150.0) / 150) * PI);
        b0 = (1 + alpha * K) / (1 + K); b1 = (1 - alpha * K) / (1 + K);
    };
    zero(left, r.b0L, r.b1L); zero(-left, r.b0R, r.b1R);
}

// ---- voice
Voice::Voice(double sampleRate, int voiceId) : id(voiceId), late(sampleRate), fs(sampleRate)
{
    sinc = sincTable().data();
    int size = 1 << 16;
    while (size < fs * 2.8) size <<= 1;
    mask = size - 1; maxDelay = size - 2048;
    buf.assign((size_t) size, 0.f);
    direct.active = true; direct.key = 0;
    lateD = lateDT = fs * 0.03;
    c1 = 1 - std::exp((-TAU * 300) / fs); c2 = 1 - std::exp((-TAU * 2500) / fs); cRear = 1 - std::exp((-TAU * 3500) / fs);
    auto tanF = [this](double f) { return std::tan((PI * std::min(f, fs * 0.45)) / fs); };
    g3 = tanF(3200); g10 = tanF(1050); g8 = tanF(8000);
    cSk1 = 1 - std::exp((-TAU * 1500) / fs); cSk2 = 1 - std::exp((-TAU * 320) / fs);
    gSkA1 = tanF(610); gSkA2 = tanF(640); gSkB1 = tanF(1420); gSkB2 = tanF(1510);
    a1 = (1 - (2 * fs * HEAD_RADIUS) / (2 * C)) / (1 + (2 * fs * HEAD_RADIUS) / (2 * C));
    anchorRange = fs * 0.008; jumpRange = fs * 0.006; xfLen = (int) jsRound(fs * 0.02);
    dcR = std::exp((-TAU * 8) / fs);
    const double msL[5] = { 1.7, 3.1, 5.3, 8.9, 13.7 }, msR[5] = { 2.3, 3.7, 6.1, 10.1, 15.1 };
    for (size_t i = 0; i < 5; i++) { scatterL[i].b.assign((size_t) jsRound((msL[i] * fs) / 1000), 0.f); scatterR[i].b.assign((size_t) jsRound((msR[i] * fs) / 1000), 0.f); }
    kDelay = 1 - std::exp(-SUB / (fs * 0.03)); kPath = 1 - std::exp(-SUB / (fs * 0.015));
    kGain = 1 - std::exp(-SUB / (fs * 0.012)); kSoft = 1 - std::exp(-SUB / (fs * 0.007));
    found.resize(5002); order_.resize(5002); orderTmp.resize(5002);
}

void Voice::setDirect(const SharedRoom& room, const Vec3& S, const Listener& L, bool binaural)
{
    const double dx = S.x - L.x, dy = S.y - L.y, dz = S.z - L.z;
    const double dist = hyp3(dx, dy, dz);
    const double focus = clamp(L.focus, 0, 1);   // 0 is pure physics; higher favours clear placement
    const double clarity = L.clarity * (binaural ? 1 : 0.45) * (1 + 0.25 * focus);
    const Vec3 lp { L.x, L.y, L.z };
    const double det = room.detour(S, lp);
    occlusion = det;
    auto shadow = [det](double f) { return clamp(1 / std::sqrt(1 + 20 * ((2 * det * f) / C)), 0.006, 1); };
    Tap& t = direct;
    t.dT = std::min((double) maxDelay, (dist / C) * fs);
    t.glT = shadow(150);
    t.gmT = shadow(1000) * std::pow(10, (-0.004 * dist) / 20);
    t.ghT = shadow(5000) * std::pow(10, (-0.03 * dist - std::min(8.0, 0.05 * focus * dist)) / 20);
    Cues c; headCues(dx, dy, dz, L, binaural, fs, c);

    // 1 once the sound is inside the skull, easing in from just outside the skin
    const double edge = clamp((0.26 - dist) / (0.26 - 0.09), 0, 1);
    const double inside = edge * edge * (3 - 2 * edge);
    const double wk = inside * clamp(L.skull, 0, 1);
    skullT = wk;
    roomDuck = 1 - 0.88 * wk;
    lateFocus = std::pow(10, (-8 * focus) / 20);
    lateTiltT = 3 * focus * c.left * (1 - inside);   // the tail leans toward the sound's side
    const double out = 1 - inside;    // directional hearing collapses at the centre of the head

    // Distance to each ear, so close sounds favour the near ear and cross smoothly
    const double cy = std::cos(L.yaw), sy = std::sin(L.yaw);
    const double hF = dx * cy + dy * sy + 0.015, hL = -dx * sy + dy * cy, hU = dz;
    const double dEarL = hyp3(hF, hL - HEAD_RADIUS, hU), dEarR = hyp3(hF, hL + HEAD_RADIUS, hU);
    auto soft = [](double d) { return std::sqrt(d * d + 0.0144); };
    const double amp = (directLevel * (1 - 0.35 * wk)) / std::pow(dist * dist + 0.09, 0.5 * (1 - 0.25 * focus));
    double panL = c.panL, panR = c.panR;
    if (binaural) {
        panL = soft(dist) / soft(dEarL); panR = soft(dist) / soft(dEarR);
        // Turn down the delayed copy in the opposite ear, more for distant sounds
        const double far = (6 + 6 * clamp((dist - 1) / 5, 0, 1)) * focus * out, side = std::abs(c.left);
        const double lift = std::pow(10, (1.2 * focus * side * out) / 20);
        panL *= lift * std::pow(10, (-far * std::max(0.0, -c.left)) / 20);
        panR *= lift * std::pow(10, (-far * std::max(0.0, c.left)) / 20);
        const double near = clamp((1 - dist) / 0.75, 0, 1);
        const double itd = c.itd + (((dEarR - dEarL) / C) * fs * 0.5 - c.itd) * near;
        t.L.extraT = c.maxItd - itd; t.R.extraT = c.maxItd + itd;
    } else {
        const double wide = sgn(c.left) * std::pow(std::abs(c.left), 1 - 0.3 * focus);
        const double a = (PI / 4) * (1 + clamp(wide * out, -1, 1));
        panL = std::sin(a); panR = std::cos(a);
        t.L.extraT = 0; t.R.extraT = 0;
    }
    t.L.ampT = amp * panL; t.R.ampT = amp * panR;
    const double K = (fs * HEAD_RADIUS) / C, flat = (1 - K) / (1 + K);
    t.L.b0T = 1 + (c.b0L - 1) * out; t.L.b1T = flat + (c.b1L - flat) * out;
    t.R.b0T = 1 + (c.b0R - 1) * out; t.R.b1T = flat + (c.b1R - flat) * out;

    const double el = (std::asin(clamp(c.up, -1, 1)) * 180) / PI;
    const double flatPlane = std::cos((el * PI) / 180);
    const double fb = c.front;         // +1 ahead, -1 behind
    const double rear = std::max(0.0, -fb), ahead = std::max(0.0, fb);
    // Directional bands: 3 kHz reads as ahead, 1 kHz as behind, 8 kHz as above
    auto dB = [&](double v) { return std::pow(10, (v * clarity * out) / 20); };
    eq3T = dB((5.5 * ahead - 8 * rear) * flatPlane);
    eq1T = dB((3.5 * rear - 1.5 * ahead) * flatPlane);
    eq8T = dB(c.up > 0 ? 7 * c.up : 3.5 * c.up);
    // the pinna notch sits higher and cuts deeper for sounds ahead
    notchFT = clamp(7600 + 3000 * (el / 60) - 1500 * rear, 4800, 12000);
    notchDT = binaural ? clamp(0.62 + 0.3 * fb, 0.15, 0.92) * out : 0;
    notch2T = 0.6 - 0.55 * ahead;   // keeps the top octave open for sounds ahead
    rearGT = std::pow(10, (-9 * rear * clarity * out) / 20);
    lateDT = t.dT + (room.stats.mfp / C) * fs * 1.5;
    if (first) snap();
}

void Voice::snap()
{
    Tap& t = direct;
    t.d = t.tS = t.tM = t.anchor = std::max(MIN_DELAY, t.dT); t.xf = 0;
    t.L.extra = t.L.extraM = t.L.extraT; t.R.extra = t.R.extraM = t.R.extraT;
    t.gl = t.glM = t.glT; t.gm = t.gmM = t.gmT; t.gh = t.ghM = t.ghT;
    for (Ear* e : { &t.L, &t.R }) { e->b0 = e->b0M = e->b0T; e->b1 = e->b1M = e->b1T; }
    notchF = notchFT; notchD = notchDT; rearG = rearGT;
    lateD = lateDT;
    eq3 = eq3T; eq1 = eq1T; eq8 = eq8T; skull = skullT;
    t.L.amp = t.L.ampM = t.L.ampT; t.R.amp = t.R.ampM = t.R.ampT;
    first = false;
}

void Voice::setReflections(const SharedRoom& room, const Vec3& S, const Listener& L, bool binaural, int order, int maxTaps)
{
    lastRoom = &room; lastS = &S; lastL = &L; lastBin = binaural; lastOrder = order; lastTaps = maxTaps;
    if (sleeping) return;
    const Vec3 lp { L.x, L.y, L.z };
    const int count = room.findReflections(S, lp, order, found.data(), (int) found.size());
    auto existing = [this](int64_t key) -> Tap* { for (Tap& t : pool) if (t.active && t.key == key) return &t; return nullptr; };
    for (int i = 0; i < count; i++) if (existing(found[(size_t) i].key)) found[(size_t) i].rank *= 1.5;   // hysteresis stops slot flutter
    // stable merge sort, strongest first, without allocating
    for (int i = 0; i < count; i++) order_[(size_t) i] = i;
    for (int width = 1; width < count; width *= 2) {
        for (int lo = 0; lo < count; lo += 2 * width) {
            const int mid = std::min(lo + width, count), hi = std::min(lo + 2 * width, count);
            int a = lo, b = mid, o = lo;
            while (a < mid && b < hi) {
                if (found[(size_t) order_[(size_t) b]].rank > found[(size_t) order_[(size_t) a]].rank) orderTmp[(size_t) o++] = order_[(size_t) b++];
                else orderTmp[(size_t) o++] = order_[(size_t) a++];
            }
            while (a < mid) orderTmp[(size_t) o++] = order_[(size_t) a++];
            while (b < hi) orderTmp[(size_t) o++] = order_[(size_t) b++];
        }
        std::swap(order_, orderTmp);
    }
    bool wasActive[POOL]; for (int i = 0; i < POOL; i++) { wasActive[i] = pool[(size_t) i].active; pool[(size_t) i].dying = true; }
    const int n = std::min(count, maxTaps);
    for (int i = 0; i < n; i++) {
        const Reflection& f = found[(size_t) order_[(size_t) i]];
        if (f.dist / C * fs > maxDelay) continue;
        Tap* tp = nullptr; bool fresh = false;
        for (int p = 0; p < POOL; p++) if (wasActive[p] && pool[(size_t) p].key == f.key) { tp = &pool[(size_t) p]; break; }
        if (!tp) {
            for (Tap& p : pool) if (!p.active) { tp = &p; break; }
            if (!tp) continue;
            fresh = true;
            tp->active = true; tp->key = f.key;
            tp->L.lp1 = tp->L.lp2 = tp->L.shX = tp->L.shY = tp->R.lp1 = tp->R.lp2 = tp->R.shX = tp->R.shY = 0;
            tp->L.amp = tp->R.amp = tp->L.ampM = tp->R.ampM = 0;
        }
        Tap& t = *tp;
        t.dying = false;
        t.order = f.order;
        // Real surfaces scatter treble far more than bass, and more with every bounce.
        // Reflections landing right behind the direct sound are what comb against it, so they scatter most.
        const double lag = (f.dist - hyp3(S.x - L.x, S.y - L.y, S.z - L.z)) / C;
        const double near = clamp(lag / 0.012, 0.3, 1), keep = near * near;
        const double sL = 1 - std::pow(0.8, f.order) * keep, sM = 1 - std::pow(0.3, f.order) * keep, sH = 1 - std::pow(0.1, f.order) * keep;
        t.spLT = std::sqrt(1 - sL); t.spMT = std::sqrt(1 - sM); t.spHT = std::sqrt(1 - sH);
        t.scLT = std::sqrt(sL); t.scMT = std::sqrt(sM); t.scHT = std::sqrt(sH);
        if (fresh) { t.spL = t.spLT; t.spM = t.spMT; t.spH = t.spHT; t.scL = t.scLT; t.scM = t.scMT; t.scH = t.scHT; }
        t.dT = (f.dist / C) * fs;
        const double air = f.dist;
        Cues c; headCues(f.ax - L.x, f.ay - L.y, f.az - L.z, L, binaural, fs, c);
        const double shade = std::pow(10, (-6 * std::max(0.0, -c.front) * L.clarity * (binaural ? 1 : 0.45)) / 20);
        t.glT = f.gl; t.gmT = f.gm * std::pow(10, (-0.004 * air) / 20); t.ghT = f.gh * std::pow(10, (-0.03 * air) / 20) * shade;
        const double focus = clamp(L.focus, 0, 1);
        const double sx = S.x - L.x, sy = S.y - L.y, sz = S.z - L.z; double sm = hyp3(sx, sy, sz); if (sm == 0) sm = 1;
        const double rx = f.ax - L.x, ry = f.ay - L.y, rz = f.az - L.z; double rm = hyp3(rx, ry, rz); if (rm == 0) rm = 1;
        const double agree = (sx * rx + sy * ry + sz * rz) / (sm * rm);   // reflections from the wrong side blur the image
        const double amp = ((earlyLevel * roomDuck) / std::max(f.dist, 0.3)) * std::pow(10, (-(3 + 3 * (1 - agree)) * focus) / 20);
        const double farTap = binaural ? (6 + 6 * clamp((f.dist - 1) / 5, 0, 1)) * focus : 0;
        t.L.ampT = amp * c.panL * std::pow(10, (-farTap * std::max(0.0, -c.left)) / 20);
        t.R.ampT = amp * c.panR * std::pow(10, (-farTap * std::max(0.0, c.left)) / 20);
        t.L.b0T = c.b0L; t.L.b1T = c.b1L; t.R.b0T = c.b0R; t.R.b1T = c.b1R;
        t.L.extraT = c.itdL; t.R.extraT = c.itdR;
        if (fresh) {
            t.d = t.tS = t.tM = t.anchor = std::max(MIN_DELAY, t.dT); t.xf = 0;
            t.gl = t.glM = t.glT; t.gm = t.gmM = t.gmT; t.gh = t.ghM = t.ghT;
            t.L.extra = t.L.extraM = t.L.extraT; t.R.extra = t.R.extraM = t.R.extraT;
            for (Ear* e : { &t.L, &t.R }) { e->b0 = e->b0M = e->b0T; e->b1 = e->b1M = e->b1T; }
        }
    }
    for (Tap& t : pool) if (t.active && t.dying) { t.L.ampT = 0; t.R.ampT = 0; }
}

// Pitch bend. The read position moves at exactly `doppler` times the physical rate.
// Whatever timing error that leaves is removed by short crossfades between two read heads.
void Voice::stepTap(Tap& t, int n)
{
    const double a = doppler; const bool freeHead = t.xf <= 0;
    bool jump = false;
    if (std::abs(t.dT - t.tS) > jumpRange && freeHead) { t.tS = t.tM = t.dT; t.anchor = t.dT; jump = true; }
    else { t.tM += (t.dT - t.tM) * kPath; t.tS += (t.tM - t.tS) * kPath; }
    if (std::abs(a - 1) < 1e-4) t.anchor = t.tS;
    else if (std::abs(t.tS - t.anchor) > (&t == &direct ? anchorRange : anchorRange * 3) && freeHead) { t.anchor = t.tS; jump = true; }
    const double v = clamp(t.anchor + a * (t.tS - t.anchor), MIN_DELAY, maxDelay);
    t.xf0 = t.xf;
    if (jump) { t.off = t.d - v; t.xf0 = 1; t.start = v; t.step = 0; }
    else { t.start = t.d; t.step = (v - t.d) / n; }
    t.d = v;
    t.xf = std::max(0.0, t.xf0 - (double) n / xfLen);
    const double k = kSoft;
    t.gl0 = t.gl; t.gm0 = t.gm; t.gh0 = t.gh;
    t.spL += (t.spLT - t.spL) * k; t.spM += (t.spMT - t.spM) * k; t.spH += (t.spHT - t.spH) * k;
    t.scL += (t.scLT - t.scL) * k; t.scM += (t.scMT - t.scM) * k; t.scH += (t.scHT - t.scH) * k;
    t.glM += (t.glT - t.glM) * k; t.gmM += (t.gmT - t.gmM) * k; t.ghM += (t.ghT - t.ghM) * k;
    t.gl += (t.glM - t.gl) * k; t.gm += (t.gmM - t.gm) * k; t.gh += (t.ghM - t.gh) * k;
    for (Ear* ep : { &t.L, &t.R }) {
        Ear& e = *ep;
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

inline double Voice::readCubic(double rp) const
{
    const float* b = buf.data(); const double fl = std::floor(rp), f = rp - fl; const int64_t i = (int64_t) fl;
    const double xm = b[(i - 1) & mask], x0 = b[i & mask], x1 = b[(i + 1) & mask], x2 = b[(i + 2) & mask];
    return ((((0.5 * (x2 - xm) + 1.5 * (x0 - x1)) * f + (xm - 2.5 * x0 + 2 * x1 - 0.5 * x2)) * f + 0.5 * (x1 - xm)) * f) + x0;
}
inline double Voice::readSinc(double rp) const
{
    const double* const S = sinc;
    const float* b = buf.data(); const double fl = std::floor(rp); const int64_t i = (int64_t) fl;
    const double p = (rp - fl) * SINC_PHASES, pf = std::floor(p), m = p - pf; const int h0 = (int) pf * SINC_TAPS;
    double o = 0;
    for (int k = 0; k < SINC_TAPS; k++) o += b[(i - 5 + k) & mask] * (S[h0 + k] + m * (S[h0 + SINC_TAPS + k] - S[h0 + k]));
    return o;
}

void Voice::renderEar(Tap& t, Ear& e, float* out, float* bus, int n)
{
    const double spL = t.spL, spM = t.spM, spH = t.spH, scL = t.scL, scM = t.scM, scH = t.scH;
    const double dStep = t.step + (e.extra - e.x0) / n, aStep = (e.amp - e.amp0) / n;
    double d = t.start + e.x0, amp = e.amp0, lp1 = e.lp1, lp2 = e.lp2, shX = e.shX, shY = e.shY;
    double gl = t.gl0, gm = t.gm0, gh = t.gh0, b0 = e.b00, b1 = e.b10; const double off = t.off;
    const double dl = (t.gl - gl) / n, dm = (t.gm - gm) / n, dh = (t.gh - gh) / n, db0 = (e.b0 - b0) / n, db1 = (e.b1 - b1) / n;
    double xf = t.xf0; const double dx = (t.xf - t.xf0) / n; const bool fading = t.xf0 > 0;
    int wp = w;
    for (int s = 0; s < n; s++) {
        d += dStep; amp += aStep; gl += dl; gm += dm; gh += dh; b0 += db0; b1 += db1;
        double x = readCubic(wp - d);
        if (fading) { xf += dx; const double g = xf * xf * (3 - 2 * xf); x += g * (readCubic(wp - d - off) - x); }
        lp1 += c1 * (x - lp1); lp2 += c2 * (x - lp2);
        const double low = gl * lp1, mid = gm * (lp2 - lp1), high = gh * (x - lp2);
        const double v = spL * low + spM * mid + spH * high;
        const double y = b0 * v + b1 * shX - a1 * shY;
        shX = v; shY = y;
        out[s] = (float) (out[s] + y * amp);
        bus[s] = (float) (bus[s] + (scL * low + scM * mid + scH * high) * amp);
        wp++;
    }
    e.lp1 = lp1; e.lp2 = lp2; e.shX = shX; e.shY = shY;
}

void Voice::renderDirectEar(Tap& t, Ear& e, float* out, int n)
{
    const double dStep = t.step + (e.extra - e.x0) / n, aStep = (e.amp - e.amp0) / n;
    double d = t.start + e.x0, amp = e.amp0, lp1 = e.lp1, lp2 = e.lp2, shX = e.shX, shY = e.shY;
    double s1 = e.s1, s2 = e.s2, s3 = e.s3, s4 = e.s4, rear = e.rear;
    double gl = t.gl0, gm = t.gm0, gh = t.gh0, b0 = e.b00, b1 = e.b10; const double off = t.off;
    const double dl = (t.gl - gl) / n, dm = (t.gm - gm) / n, dh = (t.gh - gh) / n, db0 = (e.b0 - b0) / n, db1 = (e.b1 - b1) / n;
    double xf = t.xf0; const double dx = (t.xf - t.xf0) / n; const bool fading = t.xf0 > 0;
    const double g1 = std::tan(std::min(notchF, fs * 0.45) * PI / fs), g2 = std::tan(std::min(notchF * 1.46, fs * 0.45) * PI / fs);
    const double R1 = 0.22, R2 = 0.3, h1 = 1 / (1 + 2 * R1 * g1 + g1 * g1), h2 = 1 / (1 + 2 * R2 * g2 + g2 * g2);
    const double depth = notchD, n2 = notch2, rG = rearG, cR = cRear;
    double* eq = e.eq; const double A3 = eq3 - 1, A1 = eq1 - 1, A8 = eq8 - 1;
    const double R3 = 0.42, R10 = 0.4, R8 = 0.35;
    const double h3 = 1 / (1 + 2 * R3 * g3 + g3 * g3), h10 = 1 / (1 + 2 * R10 * g10 + g10 * g10), h8 = 1 / (1 + 2 * R8 * g8 + g8 * g8);
    double* sk = e.sk; const double sku = skull, dry = 1 - skull;
    const bool right = &e == &t.R; const double gA = right ? gSkA2 : gSkA1, gB = right ? gSkB2 : gSkB1;
    const double RA = 0.11, RB = 0.09, hA = 1 / (1 + 2 * RA * gA + gA * gA), hB = 1 / (1 + 2 * RB * gB + gB * gB);
    int wp = w;
    for (int s = 0; s < n; s++) {
        d += dStep; amp += aStep; gl += dl; gm += dm; gh += dh; b0 += db0; b1 += db1;
        const double rp = wp - d;
        double x = readSinc(rp);
        if (fading) { xf += dx; const double g = xf * xf * (3 - 2 * xf); x += g * (readSinc(rp - off) - x); }
        const double raw = x;
        lp1 += c1 * (x - lp1); lp2 += c2 * (x - lp2);
        double v = gl * lp1 + gm * (lp2 - lp1) + gh * (x - lp2);
        const double y0 = b0 * v + b1 * shX - a1 * shY;
        shX = v; shY = y0;
        v = y0;
        double hp = (v - (2 * R1 + g1) * s1 - s2) * h1, bp = g1 * hp + s1;
        s1 = g1 * hp + bp; double lp = g1 * bp + s2; s2 = g1 * bp + lp;
        v -= depth * 2 * R1 * bp;
        hp = (v - (2 * R2 + g2) * s3 - s4) * h2; bp = g2 * hp + s3;
        s3 = g2 * hp + bp; lp = g2 * bp + s4; s4 = g2 * bp + lp;
        v -= depth * n2 * 2 * R2 * bp;
        rear += cR * (v - rear);
        v = rear + rG * (v - rear);
        double p = (v - (2 * R3 + g3) * eq[0] - eq[1]) * h3, q = g3 * p + eq[0];
        eq[0] = g3 * p + q; double l = g3 * q + eq[1]; eq[1] = g3 * q + l;
        v += A3 * 2 * R3 * q;
        p = (v - (2 * R10 + g10) * eq[2] - eq[3]) * h10; q = g10 * p + eq[2];
        eq[2] = g10 * p + q; l = g10 * q + eq[3]; eq[3] = g10 * q + l;
        v += A1 * 2 * R10 * q;
        p = (v - (2 * R8 + g8) * eq[4] - eq[5]) * h8; q = g8 * p + eq[4];
        eq[4] = g8 * p + q; l = g8 * q + eq[5]; eq[5] = g8 * q + l;
        v += A8 * 2 * R8 * q;
        if (sku > 0.0005) {
            sk[0] += cSk1 * (raw - sk[0]); sk[1] += cSk1 * (sk[0] - sk[1]);
            sk[2] += cSk2 * (raw - sk[2]);
            p = (raw - (2 * RA + gA) * sk[3] - sk[4]) * hA; q = gA * p + sk[3];
            sk[3] = gA * p + q; l = gA * q + sk[4]; sk[4] = gA * q + l;
            const double resA = 2 * RA * q;
            p = (raw - (2 * RB + gB) * sk[5] - sk[6]) * hB; q = gB * p + sk[5];
            sk[5] = gB * p + q; l = gB * q + sk[6]; sk[6] = gB * q + l;
            const double resB = 2 * RB * q;
            v = dry * v + sku * (0.62 * sk[1] + 0.95 * sk[2] + 0.6 * resA + 0.34 * resB);
        }
        out[s] = (float) (out[s] + v * amp);
        wp++;
    }
    e.lp1 = lp1; e.lp2 = lp2; e.shX = shX; e.shY = shY;
    e.s1 = s1; e.s2 = s2; e.s3 = s3; e.s4 = s4; e.rear = rear;
}

// Silent voices clear their state and stop computing until sound returns
void Voice::sleep()
{
    sleeping = true;
    std::fill(buf.begin(), buf.end(), 0.f);
    late.reset();
    if (lastRoom) late.setRoom(lastRoom->stats, lastBin);
    for (Tap& t : pool) t.active = false;
    for (auto* chain : { &scatterL, &scatterR }) for (Stage& a : *chain) std::fill(a.b.begin(), a.b.end(), 0.f);
    for (Ear* e : { &direct.L, &direct.R }) {
        e->lp1 = e->lp2 = e->shX = e->shY = e->s1 = e->s2 = e->s3 = e->s4 = e->rear = 0;
        std::fill(std::begin(e->eq), std::end(e->eq), 0.0); std::fill(std::begin(e->sk), std::end(e->sk), 0.0);
    }
    first = true;
}
void Voice::wake()
{
    sleeping = false; quietIn = 0; quietOut = 0;
    if (lastRoom) { setDirect(*lastRoom, *lastS, *lastL, lastBin); setReflections(*lastRoom, *lastS, *lastL, lastBin, lastOrder, lastTaps); }
}

void Voice::renderBlock()
{
    const int m = SUB; float* tmpL = outFL; float* tmpR = outFR;
    double inPeak = 0;
    for (int s = 0; s < m; s++) { const double a = std::abs((double) inF[s]); if (a > inPeak) inPeak = a; }
    if (sleeping) {
        if (inPeak * inGainT < 1e-9) { std::fill_n(tmpL, m, 0.f); std::fill_n(tmpR, m, 0.f); return; }
        wake();
    }
    const double g0 = inGain;
    inGain += (inGainT - inGain) * kGain;
    const double dg = (inGain - g0) / m;
    double g = g0;
    for (int s = 0; s < m; s++) { g += dg; buf[(size_t) ((w + s) & mask)] = (float) (inF[s] * g); }
    const double k = kGain;
    doppler += (dopplerT - doppler) * k;
    notchF += (notchFT - notchF) * k; notchD += (notchDT - notchD) * k;
    rearG += (rearGT - rearG) * k;
    eq3 += (eq3T - eq3) * k; eq1 += (eq1T - eq1) * k; eq8 += (eq8T - eq8) * k;
    skull += (skullT - skull) * k;
    notch2 += (notch2T - notch2) * k;

    std::fill_n(tmpL, m, 0.f); std::fill_n(tmpR, m, 0.f); std::fill_n(busL, m, 0.f); std::fill_n(busR, m, 0.f);
    stepTap(direct, m);
    renderDirectEar(direct, direct.L, tmpL, m);
    renderDirectEar(direct, direct.R, tmpR, m);
    for (Tap& t : pool) {
        if (!t.active) continue;
        stepTap(t, m);
        renderEar(t, t.L, tmpL, busL, m);
        renderEar(t, t.R, tmpR, busR, m);
        if (t.dying && t.L.amp < 2e-5 && t.R.amp < 2e-5) t.active = false;
    }
    auto scatter = [m](const float* bus, std::array<Stage, 5>& chain, float* out) {
        for (int s = 0; s < m; s++) {
            double x = bus[s];
            for (Stage& a : chain) {
                const double d = a.b[(size_t) a.i], v = x + 0.6 * d;
                a.b[(size_t) a.i] = (float) v; x = d - 0.6 * v;
                if (++a.i >= (int) a.b.size()) a.i = 0;
            }
            out[s] = (float) (out[s] + x);
        }
    };
    scatter(busL, scatterL, tmpL); scatter(busR, scatterR, tmpR);
    lateD += clamp((lateDT - lateD) * kDelay, -0.3 * m, 0.3 * m);
    for (int s = 0; s < m; s++) {
        const double rp = w + s - lateD, fl = std::floor(rp), f = rp - fl; const int64_t i = (int64_t) fl;
        lateIn[s] = (float) (buf[(size_t) (i & mask)] * (1 - f) + buf[(size_t) ((i + 1) & mask)] * f);
    }
    late.process(lateIn, tmpL, tmpR, m, lateLevel * roomDuck * lateFocus, lateTiltT);
    const double o0 = outGain, oStep = m / (fs * 0.03);
    outGain += clamp(outGainT - outGain, -oStep, oStep);
    const double dO = (outGain - o0) / m;
    double og = o0, outPeak = 0;
    for (int s = 0; s < m; s++) {
        og += dO; tmpL[s] = (float) (tmpL[s] * og); tmpR[s] = (float) (tmpR[s] * og);
        const double a = std::max(std::abs((double) tmpL[s]), std::abs((double) tmpR[s]));
        if (a > outPeak) outPeak = a;
    }
    if (outPeak > peak) peak = (float) outPeak;
    w = (w + m) & mask;
    quietIn = inPeak * inGain < 1e-9 ? quietIn + m : 0;
    quietOut = outPeak < 1e-7 ? quietOut + m : 0;
    if (quietIn > fs * 0.25 && quietOut > fs * 0.25) sleep();
}

// Any host block size gives identical audio because the engine always runs on fixed 32-sample blocks
void Voice::process(const float* input, float* outL, float* outR, int n)
{
    for (int i = 0; i < n; i++) {
        double x = input ? input[i] : 0;
        if (!std::isfinite(x)) x = 0;                 // never let bad samples in
        x = x > 4 ? 4 : x < -4 ? -4 : x;
        if (x > -1e-15 && x < 1e-15) x = 0;
        const double y = x - dcX + dcR * dcY;         // removes DC offset
        dcX = x; dcY = y > -1e-20 && y < 1e-20 ? 0 : y;
        const int p = fifo;
        outL[i] = (float) ((double) outL[i] + outFL[p]); outR[i] = (float) ((double) outR[i] + outFR[p]);
        inF[p] = (float) y;
        if (++fifo == SUB) { fifo = 0; renderBlock(); }
    }
}

// ---- limiter
Limiter::Limiter(double fs, double c) : ceiling(c)
{
    len = std::max(8, (int) jsRound(fs * 0.0015));
    dL.assign((size_t) len, 0.f); dR.assign((size_t) len, 0.f); hold.assign((size_t) len, 1.f); box.assign((size_t) len, 1.f);
    sum = len; rel = 1 - std::exp(-1 / (fs * 0.12));
}
void Limiter::process(float* L, float* R, int n)
{
    const double c = ceiling;
    for (int s = 0; s < n; s++) {
        const double a = std::max(std::abs((double) L[s]), std::abs((double) R[s]));
        const double want = a > c ? c / a : 1;
        const size_t u = (size_t) i;
        hold[u] = (float) want;
        double low = 1; for (int k = 0; k < len; k++) if (hold[(size_t) k] < low) low = hold[(size_t) k];
        env = low < env ? low : env + (low - env) * rel;
        sum += env - box[u]; box[u] = (float) env;
        const double g = std::min(1.0, sum / len);
        const double xl = dL[u], xr = dR[u];
        dL[u] = L[s]; dR[u] = R[s];
        L[s] = (float) clamp(xl * g, -c, c); R[s] = (float) clamp(xr * g, -c, c);
        i = i + 1 == len ? 0 : i + 1;
    }
}

// ---- engine
Engine::Engine(double sampleRate) : fs(sampleRate), limiter(sampleRate) {}
Voice& Engine::addVoice(int id) { voices.push_back(std::make_unique<Voice>(fs, id)); return *voices.back(); }

void Engine::setScene(const Scene* s)
{
    scene = s;
    if (!s) return;
    for (auto& vp : voices) {
        Voice& v = *vp;
        const TrackCfg* t = nullptr;
        for (const TrackCfg& c : s->tracks) if (c.id == v.id) { t = &c; break; }
        if (!t) { v.track = nullptr; v.forgetRoom(); continue; }
        if (!v.track) v.doppler = clamp(t->doppler, 0, 2);
        v.track = t;
        v.outGainT = 1;
        v.dopplerT = clamp(t->doppler, 0, 2);
        v.directLevel = t->direct; v.earlyLevel = t->early; v.lateLevel = t->late;
        v.inGainT = t->mute || (s->anySolo && !t->solo) ? 0 : t->gain;
        v.late.setRoom(s->room->stats, s->binaural);
    }
    control(true);
}
void Engine::control(bool all)
{
    if (!scene) return;
    const Listener& L = scene->listener;
    const int count = (int) voices.size();
    for (int i = 0; i < count; i++) {
        Voice& v = *voices[(size_t) i];
        if (!v.track || v.outGainT == 0) continue;
        evalPath(v.track->motion, beat, autoOverride >= 0 ? autoOverride : v.track->motion.autoPos, v.pos);
        v.pos.z = clamp(v.pos.z, 0.05, scene->room->height - 0.05);  // curves may overshoot between keys
        v.setDirect(*scene->room, v.pos, L, scene->binaural);
        const bool turn = count > 0 && i == robin % count && (reflectDivider <= 1 || robin % reflectDivider == 0);
        if (all || turn) v.setReflections(*scene->room, v.pos, L, scene->binaural, scene->order, scene->taps);
    }
    robin++;
}
void Engine::process(float* outL, float* outR, int n, InputFn fn, void* ctx)
{
    std::fill_n(outL, n, 0.f); std::fill_n(outR, n, 0.f);
    if (!scene) return;
    int off = 0;
    while (off < n) {
        if (counter <= 0) { control(false); counter = CONTROL; }
        const int m = std::min({ n - off, counter, CONTROL });
        for (size_t i = 0; i < voices.size(); i++) {
            fn(ctx, (int) i, sample, off, inputBuf, m);
            voices[i]->process(inputBuf, outL + off, outR + off, m);
        }
        if (playing) { sample += m; beat = beatOrigin + (double) sample / spb; }
        off += m;
        counter -= m;
    }
    limiter.process(outL, outR, n);
}

// ---- scene parsing
static Ease easeOf(const std::string& s) { return s == "smooth" ? Ease::Smooth : s == "in" ? Ease::In : s == "out" ? Ease::Out : Ease::Linear; }
std::unique_ptr<Scene> parseScene(const Json& j)
{
    auto sc = std::make_unique<Scene>();
    sc->bpm = j.nn("bpm", 120);
    sc->binaural = j.str("output", "binaural") != "speakers";
    const Json& q = j.get("quality");
    sc->order = (int) clamp(q.nn("order", 2), 1, 3); sc->taps = (int) clamp(q.nn("taps", 16), 4, 28);
    const Json& l = j.get("listener");
    sc->listener.x = l.nn("x", 0); sc->listener.y = l.nn("y", 0); sc->listener.z = l.nn("z", 1.6); sc->listener.yaw = l.nn("yaw", 0);
    sc->listener.clarity = l.nn("clarity", 1); sc->listener.skull = l.nn("skull", 1); sc->listener.focus = l.nn("focus", 0);
    const Json& r = j.get("room");
    RoomDesc d; d.height = r.nn("height", 3); d.decay = r.nn("decay", 1);
    d.floor = materialIndex(r.str("floor")); d.ceiling = materialIndex(r.str("ceiling"));
    const Json& vs = r.get("verts");
    for (size_t i = 0; i < vs.size(); i++) d.verts.push_back({ vs.at(i).num("x"), vs.at(i).num("y"), materialIndex(vs.at(i).str("mat")) });
    const Json& os = r.get("obstacles");
    for (size_t i = 0; i < os.size() && i < 60; i++) { const Json& o = os.at(i); d.obstacles.push_back({ o.num("x"), o.num("y"), o.num("w"), o.num("d"), o.num("h"), o.nn("rot", 0), materialIndex(o.str("mat")) }); }
    if (d.verts.size() < 3) return nullptr;
    sc->room = std::make_unique<SharedRoom>(d);
    const Json& ts = j.get("tracks");
    for (size_t i = 0; i < ts.size(); i++) {
        const Json& t = ts.at(i); TrackCfg c;
        c.id = (int) t.nn("id", (double) i + 1); c.gain = t.nn("gain", 1); c.direct = t.nn("direct", 1); c.early = t.nn("early", 1); c.late = t.nn("late", 1); c.doppler = t.nn("doppler", 1);
        c.mute = t.truthy("mute"); c.solo = t.truthy("solo");
        if (c.solo) sc->anySolo = true;
        const Json& m = t.get("motion");
        c.motion.automation = m.str("mode") == "automation"; c.motion.bars = m.nn("bars", 4); c.motion.autoPos = m.nn("auto", 0);
        const std::string lp = m.str("loop", "loop");
        c.motion.loop = lp == "once" ? Loop::Once : lp == "pingpong" ? Loop::PingPong : Loop::Loop;
        const Json& cv = m.get("curve"); c.motion.curve = !(cv.t == Json::Bool && !cv.b);
        const Json& ks = m.get("keys");
        for (size_t k = 0; k < ks.size(); k++) { const Json& e = ks.at(k); c.motion.keys.push_back({ e.num("t"), e.num("x"), e.num("y"), e.num("z"), easeOf(e.str("ease")) }); }
        sc->tracks.push_back(std::move(c));
    }
    return sc;
}

} // namespace rw
