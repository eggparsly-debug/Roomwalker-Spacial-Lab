#include "PluginEditor.h"
#include "PluginProcessor.h"
#include "BinaryData.h"

namespace {
// Defines window.__RW_PLUGIN before the page's own scripts run
juce::String bridgeScript(RoomwalkerProcessor& p)
{
    juce::String s;
    s << "window.__RW_PLUGIN = (function () {\n"
      << "  function emit(id, o) { try { window.__JUCE__.backend.emitEvent(id, o); } catch (e) {} }\n"
      << "  return {\n"
      << "    ownId: " << p.trackId() << ",\n"
      << "    scene: " << juce::String::fromUTF8(p.roomHub().sceneJson().c_str()) << ",\n"
      << "    send: function (m) { emit('rwmsg', { s: JSON.stringify(m) }); },\n"
      << "    on: function (id, fn) { try { window.__JUCE__.backend.addEventListener(id, fn); } catch (e) {} }\n"
      << "  };\n"
      << "})();\n";
    return s;
}
std::optional<juce::WebBrowserComponent::Resource> resource(const juce::String& url)
{
    auto path = url.upToFirstOccurrenceOf("?", false, false);
    if (path == "/" || path == "/index.html") {
        juce::WebBrowserComponent::Resource r;
        auto* d = reinterpret_cast<const std::byte*>(BinaryData::index_html);
        r.data.assign(d, d + BinaryData::index_htmlSize);
        r.mimeType = "text/html";
        return r;
    }
    return std::nullopt;
}
juce::var textEvent(const juce::String& text)
{
    juce::DynamicObject::Ptr o = new juce::DynamicObject();
    o->setProperty("s", text);
    return juce::var(o.get());
}
}

juce::WebBrowserComponent::Options RoomwalkerEditor::makeOptions(RoomwalkerProcessor& p)
{
    using O = juce::WebBrowserComponent::Options;
    return O {}
        .withBackend(O::Backend::webview2)
        .withWinWebView2Options(O::WinWebView2 {}
            .withUserDataFolder(juce::File::getSpecialLocation(juce::File::tempDirectory).getChildFile("Roomwalker-WebView2"))
            .withBackgroundColour(juce::Colour(0xff0b1e3a))
            .withStatusBarDisabled())
        .withNativeIntegrationEnabled()
        .withUserScript(bridgeScript(p))
        .withEventListener("rwmsg", [&p](juce::var o) { p.uiMessage(o["s"].toString()); })
        .withResourceProvider(resource);
}

RoomwalkerEditor::RoomwalkerEditor(RoomwalkerProcessor& p) : AudioProcessorEditor(p), proc(p), web(makeOptions(p))
{
    seenRev = proc.roomHub().revision();
    addAndMakeVisible(web);
    web.goToURL(juce::WebBrowserComponent::getResourceProviderRoot());
    setResizable(true, true);
    setResizeLimits(980, 620, 2800, 1900);
    setSize(1320, 820);
    startTimerHz(20);
}
RoomwalkerEditor::~RoomwalkerEditor() { stopTimer(); }

void RoomwalkerEditor::timerCallback()
{
    auto& hub = proc.roomHub();
    const auto rev = hub.revision();
    const bool asked = proc.wantScene.exchange(false);
    if (rev != seenRev || asked) {
        seenRev = rev;
        if (asked || hub.lastSender() != proc.trackId())   // this window already shows its own edits
            web.emitEventIfBrowserIsVisible("rwscene", textEvent(juce::String::fromUTF8(hub.sceneJson().c_str())));
    }
    web.emitEventIfBrowserIsVisible("rwtele", textEvent(proc.telemetry()));
}
void RoomwalkerEditor::paint(juce::Graphics& g) { g.fillAll(juce::Colour(0xff0b1e3a)); }
void RoomwalkerEditor::resized() { web.setBounds(getLocalBounds()); }
