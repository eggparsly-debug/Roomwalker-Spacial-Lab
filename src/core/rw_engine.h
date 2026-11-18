// Roomwalker audio engine: a line-for-line C++ port of reference/dsp.js.
// No JUCE and no allocation on the audio path, so it can be null-tested headless against the browser engine.
//   Scene / SharedRoom : the room every linked instance shares (built off the audio thread)
//   Voice              : one track's moving sound
//   Engine             : voices + control-rate motion + safety limiter
#pragma once
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include "rw_json.h"

namespace rw {

constexpr int SUB = 32;            // audio-rate parameter ramps, and the engine's fixed internal block
constexpr int CONTROL = 256;       // motion and direct-path update interval, samples
constexpr int POOL = 34;           // tap slots per voice, including ones fading out
constexpr int LINES = 16;
constexpr int BEATS_PER_BAR = 4;

struct Vec3 { double x = 0, y = 0, z = 0; };

// ---------------------------------------------------------------- scene description
struct Vert { double x, y; int mat; };
struct Obstacle { double x, y, w, d, h, rot; int mat; };
struct RoomDesc {
    double height = 3, decay = 1;
    std::vector<Vert> verts;
    std::vector<Obstacle> obstacles;
    int floor = 0, ceiling = 0;
};
struct RoomStats { double volume, surface, planArea, rt[3], mfp, absorption, critical; };
RoomStats analyzeRoom(const RoomDesc&);
int materialIndex(const std::string& id);

enum class Ease { Linear, Smooth, In, Out };
enum class Loop { Loop, PingPong, Once };
struct Key { double t, x, y, z; Ease ease; };
struct Motion {
    bool automation = false, curve = true;
    double bars = 4, autoPos = 0;
    Loop loop = Loop::Loop;
    std::vector<Key> keys;
};
double pathPhase(const Motion&, double beat, double autoPos);
void evalPath(const Motion&, double beat, double autoPos, Vec3& out);

struct Listener { double x = 0, y = 0, z = 1.6, yaw = 0, clarity = 1, skull = 1, focus = 0; };

struct TrackCfg {
    int id = 1;
    double gain = 1, direct = 1, early = 1, late = 1, doppler = 1;
    bool mute = false, solo = false;
    Motion motion;
};

// ---------------------------------------------------------------- room geometry
struct Surface {
    enum Kind { Wall, Floor, Ceil, Obs } kind = Wall;
    double px = 0, py = 0, qx = 0, qy = 0, ex = 0, ey = 0, len = 1, nx = 0, ny = 0, nz = 0, d = 0, zmax = 0;
    double R[3] = { 1, 1, 1 };
    int obs = -1, id = 0;
};
struct Reflection {
    int64_t key = 0; double dist = 0, gl = 1, gm = 1, gh = 1, ax = 0, ay = 0, az = 0, rank = 0; int order = 1;
};

class SharedRoom {
public:
    explicit SharedRoom(const RoomDesc&);
    double height = 3;
    RoomStats stats {};
    double detour(const Vec3& a, const Vec3& b) const;
    int findReflections(const Vec3& S, const Vec3& L, int order, Reflection* out, int capacity) const;
private:
    struct Obs { std::array<Vec3, 4> corners; double h; };
    double hit(double, double, double, double, double, double, const Surface&) const;
    bool blocked(double, double, double, double, double, double, int, int) const;
    bool onSurface(const Surface&, double, double, double) const;
    std::vector<Vert> verts;
    std::vector<Surface> surfaces;
    std::vector<int> blockers;
    std::vector<Obs> obstacles;
    friend struct ReflectionSearch;
};

// Everything the audio thread needs, immutable once built
struct Scene {
    double bpm = 120;
    bool binaural = true, anySolo = false;
    int order = 2, taps = 16;
    Listener listener;
    std::vector<TrackCfg> tracks;
    std::unique_ptr<SharedRoom> room;
};
std::unique_ptr<Scene> parseScene(const Json&);

// ---------------------------------------------------------------- late reverb
class LateReverb {
public:
    explicit LateReverb(double fs);
    void reset();
    void setRoom(const RoomStats&, bool binaural);
    void process(const float* input, float* outL, float* outR, int n, double level, double tiltDb);
private:
    struct Filter { double b0 = 1, b1 = 0, a1 = 0, x = 0, y = 0; };
    struct Stage { std::vector<float> b; int i = 0; double ms = 0, g = 0.6; };
    void design(Filter&, Filter&, double lowDb, double highDb) const;
    double fs; int mask = 0, w = 0;
    std::array<std::vector<float>, LINES> lines;
    std::array<double, LINES> cur {}, target {}, gm {}, phase {}, rate {}, y {};
    std::array<Filter, LINES> ls, hs;
    std::array<Stage, LINES> loopAP;
    std::array<Stage, 8> diff;
    double kLow, kHigh, apG = 0.5, modDepth, gain = 0, gainTarget = 0, tiltL = 1, tiltR = 1, sideLP = 0, sideLP2 = 0, sideC;
    bool tuned = false, bassMono = false;
};

// ---------------------------------------------------------------- one track
struct Ear {
    double lp1 = 0, lp2 = 0, shX = 0, shY = 0;
    double amp = 0, ampT = 0, ampM = 0, amp0 = 0, b0 = 1, b1 = 0, b0T = 1, b1T = 0, b0M = 1, b1M = 0, b00 = 1, b10 = 0;
    double extra = 0, extraT = 0, extraM = 0, x0 = 0;
    double s1 = 0, s2 = 0, s3 = 0, s4 = 0, rear = 0;
    double eq[6] = {}, sk[8] = {};
};
struct Tap {
    bool active = false, dying = false; int64_t key = -1;
    double d = 0, dT = 0, tM = 0, tS = 0, anchor = 0, xf = 0, xf0 = 0, off = 0, start = 0, step = 0;
    double gl = 1, gm = 1, gh = 1, glT = 1, gmT = 1, ghT = 1, glM = 1, gmM = 1, ghM = 1, gl0 = 1, gm0 = 1, gh0 = 1;
    Ear L, R;
    int order = 1;
    double spL = 1, spM = 1, spH = 1, scL = 0, scM = 0, scH = 0, spLT = 1, spMT = 1, spHT = 1, scLT = 0, scMT = 0, scHT = 0;
};
struct Cues { double front, left, up, itdL, itdR, panL, panR, b0L, b1L, b0R, b1R, maxItd, itd; };

class Voice {
public:
    Voice(double fs, int id);
    void setDirect(const SharedRoom&, const Vec3& S, const Listener&, bool binaural);
    void setReflections(const SharedRoom&, const Vec3& S, const Listener&, bool binaural, int order, int maxTaps);
    void process(const float* input, float* outL, float* outR, int n);   // mixes into the outputs
    void forgetRoom() { lastRoom = nullptr; }

    int id;
    Vec3 pos { 0, 0, 1.5 };
    const TrackCfg* track = nullptr;
    LateReverb late;
    double doppler = 1, dopplerT = 1, directLevel = 1, earlyLevel = 1, lateLevel = 1, inGain = 0, inGainT = 1, outGain = 1, outGainT = 1, occlusion = 0;
    float peak = 0;
    bool sleeping = false;

private:
    struct Stage { std::vector<float> b; int i = 0; };
    void snap();
    void sleep();
    void wake();
    void stepTap(Tap&, int n);
    void renderEar(Tap&, Ear&, float* out, float* bus, int n);
    void renderDirectEar(Tap&, Ear&, float* out, int n);
    void renderBlock();
    double readCubic(double rp) const;
    double readSinc(double rp) const;

    double fs; int mask, w = 0, maxDelay;
    const double* sinc = nullptr;
    std::vector<float> buf;
    std::array<Tap, POOL> pool;
    Tap direct;
    float lateIn[SUB] = {}, inF[SUB] = {}, outFL[SUB] = {}, outFR[SUB] = {}, busL[SUB] = {}, busR[SUB] = {};
    double lateD, lateDT, c1, c2, cRear, g3, g10, g8, cSk1, cSk2, gSkA1, gSkA2, gSkB1, gSkB2, a1;
    double anchorRange, jumpRange; int xfLen;
    int fifo = 0; double dcX = 0, dcY = 0, dcR;
    std::array<Stage, 5> scatterL, scatterR;
    double quietIn = 0, quietOut = 0;
    double kDelay, kPath, kGain, kSoft;
    double notchF = 7000, notchFT = 7000, notchD = 0, notchDT = 0, rearG = 1, rearGT = 1;
    double eq3 = 1, eq3T = 1, eq1 = 1, eq1T = 1, eq8 = 1, eq8T = 1;
    double skull = 0, skullT = 0, roomDuck = 1, lateFocus = 1, lateTiltT = 0, notch2 = 0.6, notch2T = 0.6;
    std::vector<Reflection> found;
    std::vector<int> order_, orderTmp;
    bool first = true;
    // what the last reflection update used, so a sleeping voice can wake up correctly
    const SharedRoom* lastRoom = nullptr; const Vec3* lastS = nullptr; const Listener* lastL = nullptr;
    bool lastBin = true; int lastOrder = 2, lastTaps = 16;
};

// ---------------------------------------------------------------- safety limiter
class Limiter {
public:
    explicit Limiter(double fs, double ceiling = 0.97);
    void process(float* L, float* R, int n);
    int latency() const { return len; }
private:
    double ceiling; int len, i = 0; double sum, env = 1, rel;
    std::vector<float> dL, dR, hold, box;
};

// ---------------------------------------------------------------- engine
class Engine {
public:
    using InputFn = void (*)(void* ctx, int voiceIndex, int64_t sample, int offset, float* dst, int n);
    explicit Engine(double fs);
    Voice& addVoice(int id);                 // not on the audio thread
    void setScene(const Scene*);             // the scene must outlive its use; allocation free
    void process(float* outL, float* outR, int n, InputFn fn, void* ctx);
    void control(bool all);

    double beat = 0, beatOrigin = 0, spb = 24000;
    int64_t sample = 0;
    bool playing = false;
    int reflectDivider = 1;                  // update reflections every Nth control tick
    double autoOverride = -1;                // >= 0: DAW automation position for every voice
    int latencySamples() const { return SUB + limiter.latency(); }
    std::vector<std::unique_ptr<Voice>> voices;

private:
    double fs; const Scene* scene = nullptr;
    int counter = 0; int64_t robin = 0;
    float inputBuf[CONTROL] = {};
    Limiter limiter;
};

} // namespace rw
