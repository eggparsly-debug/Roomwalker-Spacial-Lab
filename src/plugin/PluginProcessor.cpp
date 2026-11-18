#include "PluginProcessor.h"
#include "PluginEditor.h"

static const char* kParamIds[RoomHub::NumParams] = { "pos", "gain", "direct", "early", "late", "bend" };

juce::AudioProcessorValueTreeState::ParameterLayout RoomwalkerProcessor::createLayout()
{
    std::vector<std::unique_ptr<juce::RangedAudioParameter>> p;
    auto add = [&p](const char* pid, const char* name, float lo, float hi, float def) {
        p.push_back(std::make_unique<juce::AudioParameterFloat>(juce::ParameterID { pid, 1 }, name, juce::NormalisableRange<float>(lo, hi, 0.001f), def));
    };
    add("pos", "Path Position", 0.f, 1.f, 0.f);
    add("gain", "Input Gain", 0.f, 1.6f, 1.f);
    add("direct", "Direct Sound", 0.f, 1.6f, 1.f);
    add("early", "Early Reflections", 0.f, 1.6f, 1.f);
    add("late", "Reverb Tail", 0.f, 1.6f, 1.f);
    add("bend", "Pitch Bend", 0.f, 2.f, 0.5f);
    return { p.begin(), p.end() };
}

RoomwalkerProcessor::RoomwalkerProcessor()
    : AudioProcessor(BusesProperties().withInput("Input", juce::AudioChannelSet::stereo(), true).withOutput("Output", juce::AudioChannelSet::stereo(), true)),
      params(*this, nullptr, "roomwalker", createLayout())
{
    RoomHub::Live start {};
    for (int i = 0; i < RoomHub::NumParams; i++) {
        raw[(size_t) i] = params.getRawParameterValue(kParamIds[i]);
        paramObj[(size_t) i] = params.getParameter(kParamIds[i]);
        start[(size_t) i] = raw[(size_t) i]->load();
    }
    id = hub->join(this, start);
    publishScene();
    startTimerHz(30);
}

RoomwalkerProcessor::~RoomwalkerProcessor()
{
    stopTimer();
    hub->leave(id);
    delete pending.exchange(nullptr);
    delete current;
    freeRetired();
}

bool RoomwalkerProcessor::isBusesLayoutSupported(const BusesLayout& l) const
{
    if (l.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
    const auto in = l.getMainInputChannelSet();
    return in == juce::AudioChannelSet::stereo() || in == juce::AudioChannelSet::mono();
}

void RoomwalkerProcessor::publishScene()
{
    seenRev = hub->revision();
    auto parsed = rw::parseScene(rw::Json::parse(hub->sceneJson()));
    if (!parsed) return;
    delete pending.exchange(parsed.release());
}
void RoomwalkerProcessor::freeRetired()
{
    const int n = retiredFifo.getNumReady();
    if (n <= 0) return;
    auto rd = retiredFifo.read(n);
    for (int i = 0; i < rd.blockSize1; i++) delete retired[(size_t) (rd.startIndex1 + i)];
    for (int i = 0; i < rd.blockSize2; i++) delete retired[(size_t) (rd.startIndex2 + i)];
}
void RoomwalkerProcessor::timerCallback()
{
    freeRetired();
    RoomHub::Live v {};
    for (int i = 0; i < RoomHub::NumParams; i++) v[(size_t) i] = raw[(size_t) i]->load();
    hub->setLive(id, v);
    juce::String name;
    { const juce::ScopedLock sl(nameLock); name = pendingName; pendingName.clear(); }
    if (name.isNotEmpty()) hub->setHostName(id, name);
    if (hub->revision() != seenRev) publishScene();
}
void RoomwalkerProcessor::updateTrackProperties(const TrackProperties& p)
{
    const juce::ScopedLock sl(nameLock);
    pendingName = p.name;
}

void RoomwalkerProcessor::uiMessage(const juce::String& text)
{
    const rw::Json m = rw::Json::parse(text.toStdString());
    const std::string type = m.str("type");
    if (type == "hello") {
        wantScene = true;
    } else if (type == "scene") {
        hub->edit(m.get("scene"), id);
    } else if (type == "param") {
        const std::string name = m.str("name");
        for (int i = 0; i < RoomHub::NumParams; i++)
            if (name == kParamIds[i]) if (auto* target = hub->member((int) m.num("track"))) target->setParamFromUi((RoomHub::Param) i, m.num("value"));
    }
}
void RoomwalkerProcessor::setParamFromUi(RoomHub::Param p, double value)
{
    auto* obj = paramObj[(size_t) p];
    obj->beginChangeGesture();
    obj->setValueNotifyingHost(obj->convertTo0to1((float) value));
    obj->endChangeGesture();
}
juce::String RoomwalkerProcessor::telemetry()
{
    rw::Json o = rw::Json::object();
    o.set("beat", rw::Json::number(uiBeat.load())); o.set("bpm", rw::Json::number(uiBpm.load()));
    o.set("playing", rw::Json::boolean(uiPlaying.load())); o.set("cpu", rw::Json::number(uiCpu.load()));
    o.set("live", rw::Json::parse(hub->telemetryLive()));
    rw::Json peaks = rw::Json::object();
    const auto list = rw::Json::parse(hub->telemetryLive());
    for (auto& kv : list.o) if (auto* m = hub->member(std::stoi(kv.first))) peaks.set(kv.first, rw::Json::number(m->uiPeak.exchange(m->uiPeak.load() * 0.8f)));
    o.set("peaks", peaks);
    return juce::String::fromUTF8(o.dump().c_str());
}

void RoomwalkerProcessor::prepareToPlay(double sampleRate, int samplesPerBlock)
{
    if (!engine || sampleRate != sr) {
        sr = sampleRate;
        engine = std::make_unique<rw::Engine>(sampleRate);
        engine->addVoice(id);
        engine->reflectDivider = 3;
        engine->playing = false;
        if (current) engine->setScene(current);
    }
    mono.setSize(1, juce::jmax(1, samplesPerBlock));
    setLatencySamples(engine->latencySamples());
}

void RoomwalkerProcessor::feed(void* ctx, int, int64_t, int offset, float* dst, int n)
{
    auto* self = static_cast<RoomwalkerProcessor*>(ctx);
    juce::FloatVectorOperations::copy(dst, self->feedPtr + offset, n);
}

void RoomwalkerProcessor::processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    const auto startTicks = juce::Time::getHighResolutionTicks();
    const int n = buffer.getNumSamples();
    if (n == 0) return;
    if (!engine) { buffer.clear(); return; }

    // take the newest scene if there is room to hand the old one back
    if (pending.load(std::memory_order_acquire) != nullptr && retiredFifo.getFreeSpace() > 0) {
        if (auto* next = pending.exchange(nullptr)) {
            auto* old = current;
            current = next;
            engine->setScene(current);
            if (old) { auto wr = retiredFifo.write(1); retired[(size_t) (wr.blockSize1 ? wr.startIndex1 : wr.startIndex2)] = old; }
        }
    }
    if (!current) { buffer.clear(); return; }

    // follow the DAW's transport
    double ppq = uiBeat.load(), bpm = uiBpm.load(); bool playing = false;
    if (auto* head = getPlayHead()) if (auto pos = head->getPosition()) {
        playing = pos->getIsPlaying();
        if (auto v = pos->getPpqPosition()) ppq = *v;
        if (auto v = pos->getBpm()) if (*v > 1) bpm = *v;
    }
    engine->spb = (60.0 / bpm) * sr;
    engine->beat = engine->beatOrigin = ppq;
    engine->sample = 0;
    engine->playing = playing;

    // DAW automation and the page's sliders both arrive as parameters
    rw::Voice& v = *engine->voices[0];
    const bool audible = !v.track || (!v.track->mute && (!current->anySolo || v.track->solo));
    v.inGainT = audible ? (double) raw[RoomHub::Gain]->load() : 0.0;
    v.directLevel = raw[RoomHub::Direct]->load(); v.earlyLevel = raw[RoomHub::Early]->load(); v.lateLevel = raw[RoomHub::Late]->load();
    v.dopplerT = raw[RoomHub::Bend]->load();
    engine->autoOverride = raw[RoomHub::Pos]->load();

    // the sound enters the room as a single point (hosts may exceed their promised block size, so work in chunks)
    const int inputs = getTotalNumInputChannels(), chunk = mono.getNumSamples();
    auto* m = mono.getWritePointer(0); auto* outL = buffer.getWritePointer(0); auto* outR = buffer.getWritePointer(1);
    for (int at = 0; at < n; at += chunk) {
        const int len = juce::jmin(chunk, n - at);
        if (inputs >= 2) { for (int i = 0; i < len; i++) m[i] = 0.5f * (outL[at + i] + outR[at + i]); }
        else if (inputs == 1) juce::FloatVectorOperations::copy(m, outL + at, len);
        else juce::FloatVectorOperations::clear(m, len);
        feedPtr = m;
        engine->process(outL + at, outR + at, len, feed, this);
    }

    uiBeat.store(ppq); uiBpm.store(bpm); uiPlaying.store(playing);
    float peak = uiPeak.load(); if (v.peak > peak) uiPeak.store(v.peak);
    v.peak = 0;
    const double used = juce::Time::highResolutionTicksToSeconds(juce::Time::getHighResolutionTicks() - startTicks);
    uiCpu.store(uiCpu.load() * 0.95f + 0.05f * (float) (used / (n / sr)));
}

void RoomwalkerProcessor::getStateInformation(juce::MemoryBlock& dest)
{
    auto state = params.copyState();
    double savedAt = 0;
    rw::Json o = rw::Json::object();
    o.set("shared", hub->savedShared(savedAt));
    o.set("savedAt", rw::Json::number(savedAt));
    o.set("track", hub->savedTrack(id));
    state.setProperty("scene", juce::String::fromUTF8(o.dump().c_str()), nullptr);
    if (auto xml = state.createXml()) copyXmlToBinary(*xml, dest);
}
void RoomwalkerProcessor::setStateInformation(const void* data, int size)
{
    auto xml = getXmlFromBinary(data, size);
    if (!xml || !xml->hasTagName(params.state.getType())) return;
    auto state = juce::ValueTree::fromXml(*xml);
    const rw::Json o = rw::Json::parse(state.getProperty("scene").toString().toStdString());
    state.removeProperty("scene", nullptr);
    params.replaceState(state);
    RoomHub::Live v {};
    for (int i = 0; i < RoomHub::NumParams; i++) v[(size_t) i] = raw[(size_t) i]->load();
    hub->setLive(id, v);
    hub->restore(id, o.get("shared"), o.num("savedAt"), o.get("track"));
}

juce::AudioProcessorEditor* RoomwalkerProcessor::createEditor() { return new RoomwalkerEditor(*this); }
juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() { return new RoomwalkerProcessor(); }
