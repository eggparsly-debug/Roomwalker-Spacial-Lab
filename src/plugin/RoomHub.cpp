#include "RoomHub.h"
#include "BinaryData.h"
#include <cmath>

using rw::Json;

std::string RoomHub::defaultDoc() { return std::string(BinaryData::default_scene_json, (size_t) BinaryData::default_scene_jsonSize); }

static Json* field(Json& o, const std::string& k) { for (auto& e : o.o) if (e.first == k) return &e.second; return nullptr; }

Json* RoomHub::trackDoc(int id)
{
    if (auto* ts = field(doc, "tracks")) for (auto& t : ts->a) if ((int) t.num("id") == id) return &t;
    return nullptr;
}
void RoomHub::stamp(int sender)
{
    rev++; sender_ = sender; pristine = false;
    savedAt_ = (double) juce::Time::currentTimeMillis();
}
static void writeLive(Json& t, const RoomHub::Live& v)
{
    t.set("gain", Json::number(v[RoomHub::Gain])); t.set("direct", Json::number(v[RoomHub::Direct]));
    t.set("early", Json::number(v[RoomHub::Early])); t.set("late", Json::number(v[RoomHub::Late]));
    t.set("doppler", Json::number(v[RoomHub::Bend]));
    if (auto* m = field(t, "motion")) m->set("auto", Json::number(v[RoomHub::Pos]));
}
// New sounds start in a ring around the listener, inside the room
static void placeNew(const Json& doc, int count, double& x, double& y, double& z)
{
    const Json& l = doc.get("listener"); const Json& vs = doc.get("room").get("verts");
    auto inside = [&](double px, double py) {
        bool in = false; const size_t n = vs.size();
        for (size_t i = 0, j = n - 1; i < n; j = i++) {
            const double ax = vs.at(i).num("x"), ay = vs.at(i).num("y"), bx = vs.at(j).num("x"), by = vs.at(j).num("y");
            if ((ay > py) != (by > py) && px < (bx - ax) * (py - ay) / (by - ay) + ax) in = !in;
        }
        return in;
    };
    const double a = l.nn("yaw", 0) + count * 2.399963;   // golden angle keeps new sounds apart
    z = l.nn("z", 1.6);
    for (double r = 2.0; r > 0.4; r -= 0.2) {
        x = l.nn("x", 0) + r * std::cos(a); y = l.nn("y", 0) + r * std::sin(a);
        if (inside(x, y)) return;
    }
    x = l.nn("x", 0) + 0.5; y = l.nn("y", 0);
}

int RoomHub::join(RoomwalkerProcessor* p, const Live& start)
{
    std::lock_guard<std::mutex> g(lock);
    int id = 1; while (members.count(id)) id++;
    members[id] = p; live[id] = start;
    double x, y, z; placeNew(doc, (int) members.size() - 1, x, y, z);
    juce::String txt;
    txt << "{\"id\":" << id << ",\"name\":\"Track " << id << "\",\"hostName\":true,\"sound\":\"host\",\"mute\":false,\"solo\":false,"
        << "\"motion\":{\"mode\":\"tempo\",\"bars\":4,\"loop\":\"loop\",\"auto\":0,\"curve\":true,\"keys\":[{\"t\":0,\"x\":"
        << juce::String(x, 2) << ",\"y\":" << juce::String(y, 2) << ",\"z\":" << juce::String(z, 2) << ",\"ease\":\"linear\"}]}}";
    Json t = Json::parse(txt.toStdString()); writeLive(t, start);
    if (auto* ts = field(doc, "tracks")) ts->a.push_back(t);
    rev++; sender_ = 0;
    return id;
}
void RoomHub::leave(int id)
{
    std::lock_guard<std::mutex> g(lock);
    members.erase(id); live.erase(id);
    if (auto* ts = field(doc, "tracks")) for (size_t i = 0; i < ts->a.size(); i++) if ((int) ts->a[i].num("id") == id) { ts->a.erase(ts->a.begin() + (long) i); break; }
    rev++; sender_ = 0;
    if (members.empty()) { doc = Json::parse(defaultDoc()); pristine = true; savedAt_ = 0; }   // the next project starts fresh
}
void RoomHub::edit(const Json& in, int sender)
{
    if (!in.isObj() || !in.get("room").isObj()) return;
    std::lock_guard<std::mutex> g(lock);
    for (const char* k : { "output", "preset", "quality", "room", "listener" }) if (!in.get(k).isUndef()) doc.set(k, in.get(k));
    if (auto* ts = field(doc, "tracks")) for (auto& t : ts->a) {
        const int id = (int) t.num("id"); const Json& list = in.get("tracks");
        for (size_t i = 0; i < list.size(); i++) if ((int) list.at(i).num("id") == id) { t = list.at(i); if (live.count(id)) writeLive(t, live[id]); break; }
    }
    stamp(sender);
}
void RoomHub::restore(int id, const Json& shared, double savedAt, const Json& track)
{
    std::lock_guard<std::mutex> g(lock);
    if (shared.isObj() && shared.get("room").isObj() && (pristine || savedAt >= savedAt_)) {
        for (const char* k : { "output", "preset", "quality", "room", "listener" }) if (!shared.get(k).isUndef()) doc.set(k, shared.get(k));
        savedAt_ = savedAt; pristine = false;
    }
    if (auto* t = trackDoc(id)) if (track.isObj()) { *t = track; t->set("id", Json::number(id)); if (live.count(id)) writeLive(*t, live[id]); }
    rev++; sender_ = 0;
}
void RoomHub::setLive(int id, const Live& v)
{
    std::lock_guard<std::mutex> g(lock);
    live[id] = v;
    if (auto* t = trackDoc(id)) writeLive(*t, v);
}
void RoomHub::setHostName(int id, const juce::String& name)
{
    std::lock_guard<std::mutex> g(lock);
    if (auto* t = trackDoc(id)) if (t->truthy("hostName") && t->str("name") != name.toStdString()) { t->set("name", Json::string(name.substring(0, 18).toStdString())); rev++; sender_ = 0; }
}
RoomwalkerProcessor* RoomHub::member(int id) { std::lock_guard<std::mutex> g(lock); auto it = members.find(id); return it == members.end() ? nullptr : it->second; }
juce::int64 RoomHub::revision() { std::lock_guard<std::mutex> g(lock); return rev; }
int RoomHub::lastSender() { std::lock_guard<std::mutex> g(lock); return sender_; }
std::string RoomHub::sceneJson() { std::lock_guard<std::mutex> g(lock); return doc.dump(); }
std::string RoomHub::telemetryLive()
{
    std::lock_guard<std::mutex> g(lock);
    Json o = Json::object();
    for (auto& kv : live) {
        Json v = Json::object();
        v.set("pos", Json::number(kv.second[Pos])); v.set("gain", Json::number(kv.second[Gain])); v.set("direct", Json::number(kv.second[Direct]));
        v.set("early", Json::number(kv.second[Early])); v.set("late", Json::number(kv.second[Late])); v.set("bend", Json::number(kv.second[Bend]));
        o.set(std::to_string(kv.first), v);
    }
    return o.dump();
}
Json RoomHub::savedShared(double& savedAt)
{
    std::lock_guard<std::mutex> g(lock);
    savedAt = savedAt_;
    Json o = Json::object();
    for (const char* k : { "output", "preset", "quality", "room", "listener" }) o.set(k, doc.get(k));
    return o;
}
Json RoomHub::savedTrack(int id) { std::lock_guard<std::mutex> g(lock); auto* t = trackDoc(id); return t ? *t : Json(); }
