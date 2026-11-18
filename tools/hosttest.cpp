// Runs real Roomwalker plugin instances without a DAW: linking, automation, transport, saved state and audio.
#include <juce_audio_utils/juce_audio_utils.h>
#include "PluginProcessor.h"

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter();

struct Head : juce::AudioPlayHead {
    double ppq = 0, bpm = 120; bool playing = true;
    juce::Optional<PositionInfo> getPosition() const override { PositionInfo p; p.setPpqPosition(ppq); p.setBpm(bpm); p.setIsPlaying(playing); return p; }
};
static int fails = 0;
static void check(const char* name, bool ok, juce::String detail = {}) { if (!ok) fails++; std::printf("%s  %s  %s\n", ok ? "PASS" : "FAIL", name, detail.toRawUTF8()); }
static void pump(int ms = 150) { juce::MessageManager::getInstance()->runDispatchLoopUntil(ms); }

// feeds a tone through and returns left/right RMS over the last half
static std::pair<double, double> run(RoomwalkerProcessor& p, Head& h, int blocks, int size = 256, double sr = 48000)
{
    juce::AudioBuffer<float> b(2, size); juce::MidiBuffer midi; double phase = 0, l = 0, r = 0; int counted = 0;
    for (int k = 0; k < blocks; k++) {
        for (int i = 0; i < size; i++) { const float v = 0.2f * (float) std::sin(phase += 2 * juce::MathConstants<double>::pi * 440 / sr); b.setSample(0, i, v); b.setSample(1, i, v); }
        p.processBlock(b, midi);
        if (h.playing) h.ppq += size / sr * h.bpm / 60;
        if (k >= blocks / 2) { for (int i = 0; i < size; i++) { l += b.getSample(0, i) * b.getSample(0, i); r += b.getSample(1, i) * b.getSample(1, i); } counted += size; }
    }
    return { std::sqrt(l / counted), std::sqrt(r / counted) };
}
static float paramValue(RoomwalkerProcessor& p, int i) { auto* r = static_cast<juce::RangedAudioParameter*>(p.getParameters()[i]); return r->convertFrom0to1(r->getValue()); }
static rw::Json scene(RoomwalkerProcessor& p) { return rw::Json::parse(p.roomHub().sceneJson()); }
static juce::String sceneWith(RoomwalkerProcessor& p, std::function<void(rw::Json&)> edit) { auto s = scene(p); edit(s); rw::Json m = rw::Json::object(); m.set("type", rw::Json::string("scene")); m.set("scene", s); return juce::String::fromUTF8(m.dump().c_str()); }
static rw::Json* find(rw::Json& o, const char* k) { for (auto& e : o.o) if (e.first == k) return &e.second; return nullptr; }
static rw::Json* track(rw::Json& s, int id) { for (auto& t : find(s, "tracks")->a) if ((int) t.num("id") == id) return &t; return nullptr; }
static void setKeys(rw::Json& t, const char* json) { auto* m = find(t, "motion"); m->set("keys", rw::Json::parse(json)); }

int main()
{
    juce::ScopedJuceInitialiser_GUI gui;
    {
        Head ha, hb;
        std::unique_ptr<RoomwalkerProcessor> a(static_cast<RoomwalkerProcessor*>(createPluginFilter())), b(static_cast<RoomwalkerProcessor*>(createPluginFilter()));
        a->setPlayHead(&ha); b->setPlayHead(&hb);
        a->setPlayConfigDetails(2, 2, 48000, 256); b->setPlayConfigDetails(2, 2, 48000, 256);
        a->prepareToPlay(48000, 256); b->prepareToPlay(48000, 256);
        check("Instances get different tracks", a->trackId() != b->trackId(), juce::String(a->trackId()) + " and " + juce::String(b->trackId()));
        check("Both tracks appear in the shared room", scene(*a).get("tracks").size() == 2);
        check("Latency is reported to the host", a->getLatencySamples() == 32 + 72, juce::String(a->getLatencySamples()) + " samples");

        pump();
        auto first = run(*a, ha, 400);
        check("A tone comes out of the plugin", first.first > 0.003 && first.first < 1.0, juce::String(first.first, 4));

        // an edit in one window reaches the other instance and its audio
        a->uiMessage(sceneWith(*a, [](rw::Json& s) { find(s, "room")->set("height", rw::Json::number(9)); find(s, "listener")->set("yaw", rw::Json::number(1.57)); }));
        pump();
        check("Room edits reach every linked instance", std::abs(scene(*b).get("room").num("height") - 9) < 1e-9);

        // left/right placement follows the edited path
        const int idA = a->trackId();
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { setKeys(*track(s, idA), "[{\"t\":0,\"x\":3.4,\"y\":1,\"z\":1.6,\"ease\":\"linear\"}]"); find(s, "listener")->set("yaw", rw::Json::number(0)); }));
        pump(); auto right = run(*a, ha, 300);
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { setKeys(*track(s, idA), "[{\"t\":0,\"x\":3.4,\"y\":5,\"z\":1.6,\"ease\":\"linear\"}]"); }));
        pump(); auto left = run(*a, ha, 300);
        check("Sound to the right is louder on the right", right.second > right.first * 1.5, juce::String(right.first, 4) + " / " + juce::String(right.second, 4));
        check("Sound to the left is louder on the left", left.first > left.second * 1.5, juce::String(left.first, 4) + " / " + juce::String(left.second, 4));

        // DAW automation drives the path position
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { auto* t = track(s, idA); auto* m = find(*t, "motion"); m->set("mode", rw::Json::string("automation")); m->set("curve", rw::Json::boolean(false));
            setKeys(*t, "[{\"t\":0,\"x\":3.4,\"y\":1,\"z\":1.6,\"ease\":\"linear\"},{\"t\":8,\"x\":3.4,\"y\":5,\"z\":1.6,\"ease\":\"linear\"}]"); m->set("loop", rw::Json::string("once")); }));
        pump();
        auto* pos = a->getParameters()[0];
        pos->setValueNotifyingHost(0.0f); auto at0 = run(*a, ha, 300);
        pos->setValueNotifyingHost(0.5f); auto at1 = run(*a, ha, 300);
        check("Path Position automation moves the sound", at0.second > at0.first * 1.5 && at1.first > at1.second * 1.5, juce::String(at0.second / at0.first, 2) + " then " + juce::String(at1.first / at1.second, 2));

        // tempo sync follows the DAW's song position
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { auto* m = find(*track(s, idA), "motion"); m->set("mode", rw::Json::string("tempo")); m->set("bars", rw::Json::number(4)); }));
        pump(); ha.playing = false; ha.ppq = 0; auto s0 = run(*a, ha, 300); ha.ppq = 8; auto s1 = run(*a, ha, 300);
        check("Tempo-synced path follows the song position", s0.second > s0.first * 1.5 && s1.first > s1.second * 1.5);
        ha.playing = true;

        // parameter changes from the page reach the host parameter
        a->uiMessage("{\"type\":\"param\",\"track\":" + juce::String(b->trackId()) + ",\"name\":\"direct\",\"value\":0.4}");
        pump();
        check("Sliders can drive another linked track", std::abs(paramValue(*b, 2) - 0.4f) < 0.002f);

        // mute and solo work across instances
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { track(s, b->trackId())->set("solo", rw::Json::boolean(true)); }));
        pump(); auto muted = run(*a, ha, 900);
        check("Soloing one track silences the others", muted.first < 0.0005, juce::String(muted.first, 6));
        a->uiMessage(sceneWith(*a, [&](rw::Json& s) { track(s, b->trackId())->set("solo", rw::Json::boolean(false)); }));
        pump();

        // saved projects reload their room, path and parameters
        juce::MemoryBlock stA, stB; a->getStateInformation(stA); b->getStateInformation(stB);
        a.reset(); b.reset();
        Head hc; std::unique_ptr<RoomwalkerProcessor> c(static_cast<RoomwalkerProcessor*>(createPluginFilter())), d(static_cast<RoomwalkerProcessor*>(createPluginFilter()));
        check("A new project starts with the default room", std::abs(scene(*c).get("room").num("height") - 3.6) < 1e-9);
        c->setStateInformation(stA.getData(), (int) stA.getSize()); d->setStateInformation(stB.getData(), (int) stB.getSize());
        pump();
        auto sc = scene(*c);
        check("Saved room comes back", std::abs(sc.get("room").num("height") - 9) < 1e-9);
        check("Saved path comes back", track(sc, c->trackId())->get("motion").get("keys").size() == 2);
        check("Saved parameters come back", std::abs(paramValue(*d, 2) - 0.4f) < 0.002f);

        // nasty hosts: sample-rate changes, odd buffer sizes, blocks larger than promised
        c->setPlayHead(&hc); c->setPlayConfigDetails(2, 2, 96000, 64); c->prepareToPlay(96000, 64); pump();
        bool finite = true; double peak = 0;
        { juce::AudioBuffer<float> big(2, 1000); juce::MidiBuffer mid; juce::Random rng(3); for (int k = 0; k < 300; k++) { for (int ch = 0; ch < 2; ch++) for (int i = 0; i < 1000; i++) big.setSample(ch, i, rng.nextFloat() * 2 - 1); big.setSample(0, 5, std::numeric_limits<float>::quiet_NaN()); c->processBlock(big, mid);
            for (int ch = 0; ch < 2; ch++) for (int i = 0; i < 1000; i++) { const float v = big.getSample(ch, i); if (!std::isfinite(v)) finite = false; peak = juce::jmax(peak, (double) std::abs(v)); } } }
        check("Bad input and oversized blocks stay safe", finite && peak <= 1.0, "peak " + juce::String(peak, 3));
    }
    std::printf("\n%s\n", fails ? "HOST TEST FAILED" : "All host tests passed");
    return fails ? 1 : 0;
}
