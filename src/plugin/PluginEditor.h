#pragma once
#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_extra/juce_gui_extra.h>

class RoomwalkerProcessor;

// The plugin window is the Roomwalker page itself, shown in an embedded WebView2.
class RoomwalkerEditor : public juce::AudioProcessorEditor, private juce::Timer {
public:
    explicit RoomwalkerEditor(RoomwalkerProcessor&);
    ~RoomwalkerEditor() override;
    void paint(juce::Graphics&) override;
    void resized() override;

private:
    static juce::WebBrowserComponent::Options makeOptions(RoomwalkerProcessor&);
    void timerCallback() override;
    RoomwalkerProcessor& proc;
    juce::WebBrowserComponent web;
    juce::int64 seenRev = 0;
};
