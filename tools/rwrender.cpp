// Renders tools/scenarios.json through the C++ engine.
//   rwrender --dump <scenarios.json> <outDir>     raw stereo float32 for a null test against tools/jsrender.js
//   rwrender --selftest                           level check against reference envelopes (runs in CI)
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include "rw_engine.h"
#ifndef RW_SELFTEST_JSON
#define RW_SELFTEST_JSON "tools/selftest.json"
#endif

using namespace rw;

struct Input { std::vector<std::vector<float>> loops; };
static std::vector<float> makeInput(int id, const Json& sc)
{
    const double sr = sc.num("fs"); const size_t n = (size_t) std::floor(sc.num("seconds") * sr + 0.5) + (size_t) sr;
    std::vector<float> x(n); double s = std::fmod(id * 1000.0 + 7, 2147483647.0);
    const Json& gap = sc.get("gap");
    for (size_t i = 0; i < n; i++) {
        s = std::fmod(s * 16807.0, 2147483647.0);
        const double t = (double) i / sr, ph = std::fmod(t * 2, 1.0), env = std::exp(-ph * 7);
        double v = 0.35 * env * (s / 1073741823.5 - 1) + 0.3 * env * std::sin(2 * 3.14159265358979323846 * (220.0 * id) * t);
        if (gap.isArr() && t >= gap.at(0).toNum() && t < gap.at(1).toNum()) v = 0;
        x[i] = (float) v;
    }
    return x;
}
static void feed(void* c, int v, int64_t sample, int, float* dst, int n)
{
    auto& loop = ((Input*) c)->loops[(size_t) v];
    for (int i = 0; i < n; i++) dst[i] = loop[(size_t) ((sample + i) % (int64_t) loop.size())];
}
static void applySet(Json& scene, const Json& set)
{
    for (auto& kv : set.o) {
        Json* o = &scene; std::stringstream ss(kv.first); std::string part; std::vector<std::string> p;
        while (std::getline(ss, part, '.')) p.push_back(part);
        for (size_t i = 0; i + 1 < p.size(); i++) {
            if (o->isArr()) o = &o->a[(size_t) std::stoi(p[i])];
            else for (auto& e : o->o) if (e.first == p[i]) { o = &e.second; break; }
        }
        o->set(p.back(), kv.second);
    }
}
static void render(const Json& sc, std::vector<float>& L, std::vector<float>& R)
{
    const double fs = sc.num("fs"); const int N = (int) std::floor(sc.num("seconds") * fs + 0.5);
    Json scene = sc.get("scene");
    auto cur = parseScene(scene); std::vector<std::unique_ptr<Scene>> keep;
    Engine e(fs); Input in;
    for (auto& t : cur->tracks) { e.addVoice(t.id); in.loops.push_back(makeInput(t.id, sc)); }
    e.spb = (60 / cur->bpm) * fs;
    e.setScene(cur.get()); e.playing = true;
    L.assign((size_t) N, 0.f); R.assign((size_t) N, 0.f);
    const Json& blocks = sc.get("blocks"); const Json& ev = sc.get("events");
    int off = 0; size_t bi = 0, ei = 0;
    while (off < N) {
        int n = std::min((int) blocks.at(bi++ % blocks.size()).toNum(), N - off);
        if (ev.isArr() && ei < ev.size() && off >= (int) std::floor(ev.at(ei).num("at") * fs + 0.5)) {
            applySet(scene, ev.at(ei).get("set")); keep.push_back(std::move(cur)); cur = parseScene(scene); e.setScene(cur.get()); ei++;
        }
        e.process(L.data() + off, R.data() + off, n, feed, &in);
        off += n;
    }
}
int main(int argc, char** argv)
{
    std::string mode = argc > 1 ? argv[1] : "--selftest";
    std::string text = argc > 2 ? [&] { std::ifstream f(argv[2]); std::stringstream b; b << f.rdbuf(); return b.str(); }() : [] { std::ifstream f(RW_SELFTEST_JSON); std::stringstream b; b << f.rdbuf(); return b.str(); }();
    Json all = Json::parse(text);
    int failed = 0;
    for (size_t s = 0; s < all.size(); s++) {
        const Json& sc = all.at(s); std::vector<float> L, R; render(sc, L, R);
        if (mode == "--dump") {
            std::vector<float> b(L.size() * 2); for (size_t i = 0; i < L.size(); i++) { b[i * 2] = L[i]; b[i * 2 + 1] = R[i]; }
            std::ofstream f(std::string(argv[3]) + "/" + sc.str("name") + ".cpp.f32", std::ios::binary); f.write((const char*) b.data(), (std::streamsize) (b.size() * sizeof(float)));
            continue;
        }
        const Json& env = sc.get("envelope"); const int W = (int) sc.num("window"); double worst = 0; bool finite = true;
        for (size_t c = 0; c < 2; c++) {
            auto& x = c ? R : L; const Json& ref = env.at(c);
            for (size_t k = 0; k < ref.size(); k++) { double e = 0; for (int i = 0; i < W; i++) { const double v = x[k * (size_t) W + (size_t) i]; if (!std::isfinite(v)) finite = false; e += v * v; }
                const double db = 10 * std::log10(e / W + 1e-12); if (db > -90 || ref.at(k).toNum() > -90) worst = std::max(worst, std::abs(db - ref.at(k).toNum())); }
        }
        const bool ok = finite && worst < 0.05;
        std::printf("%-20s worst level difference from browser engine %.4f dB  %s\n", sc.str("name").c_str(), worst, ok ? "OK" : "FAIL");
        if (!ok) failed++;
    }
    return failed ? 1 : 0;
}
