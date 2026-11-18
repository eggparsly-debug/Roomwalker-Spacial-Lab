#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <array>
#include <atomic>
#include <memory>
#include "RoomHub.h"
#include "rw_engine.h"

// One Roomwalker instance: one track's sound moving through the room every instance shares.
class RoomwalkerProcessor : public juce::AudioProcessor, private juce::Timer {
public:
    RoomwalkerProcessor();
    ~RoomwalkerProcessor() override;

    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported(const BusesLayout&) const override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return "Roomwalker"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 12.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;
    void updateTrackProperties(const TrackProperties&) override;

    // ---- the page in the editor ----
    void uiMessage(const juce::String& json);
    void setParamFromUi(RoomHub::Param, double value);
    int trackId() const { return id; }
    std::atomic<bool> wantScene { false };   // the page just loaded and needs the current scene
    RoomHub& roomHub() { return *hub; }
    juce::String telemetry();

private:
    static juce::AudioProcessorValueTreeState::ParameterLayout createLayout();
    void timerCallback() override;
    void publishScene();
    void freeRetired();
    static void feed(void* ctx, int voice, int64_t sample, int offset, float* dst, int n);

    juce::SharedResourcePointer<RoomHub> hub;
    juce::AudioProcessorValueTreeState params;
    std::array<std::atomic<float>*, RoomHub::NumParams> raw {};
    std::array<juce::RangedAudioParameter*, RoomHub::NumParams> paramObj {};
    int id = 0;

    std::unique_ptr<rw::Engine> engine;
    double sr = 0;
    juce::AudioBuffer<float> mono;
    const float* feedPtr = nullptr;

    // scenes built on the message thread, handed to the audio thread without locks
    std::atomic<rw::Scene*> pending { nullptr };
    rw::Scene* current = nullptr;
    juce::AbstractFifo retiredFifo { 64 };
    std::array<rw::Scene*, 64> retired {};
    juce::int64 seenRev = -1;

    std::atomic<double> uiBeat { 0 }, uiBpm { 120 };
    std::atomic<bool> uiPlaying { false };
    std::atomic<float> uiPeak { 0 }, uiCpu { 0 };

    juce::CriticalSection nameLock; juce::String pendingName;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RoomwalkerProcessor)
};
