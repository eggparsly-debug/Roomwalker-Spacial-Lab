#pragma once
#include <juce_core/juce_core.h>
#include <array>
#include <map>
#include <mutex>
#include <string>
#include "rw_json.h"

class RoomwalkerProcessor;

// One room shared by every Roomwalker in the project. Instances live in the same process, so a single object
// holds the scene document. It is never touched on the audio thread: each instance turns it into its own
// immutable rw::Scene on the message thread.
class RoomHub {
public:
    enum Param { Pos, Gain, Direct, Early, Late, Bend, NumParams };
    using Live = std::array<double, NumParams>;

    int join(RoomwalkerProcessor*, const Live& start);
    void leave(int id);
    void edit(const rw::Json& scene, int sender);                              // a page changed the scene
    void restore(int id, const rw::Json& shared, double savedAt, const rw::Json& track);
    void setLive(int id, const Live&);
    void setHostName(int id, const juce::String&);
    RoomwalkerProcessor* member(int id);

    juce::int64 revision();
    int lastSender();
    std::string sceneJson();
    std::string telemetryLive();                                               // {"id":{pos,gain,...}}
    rw::Json savedShared(double& savedAt);
    rw::Json savedTrack(int id);

private:
    rw::Json* trackDoc(int id);
    void stamp(int sender);
    std::mutex lock;
    rw::Json doc = rw::Json::parse(defaultDoc());
    static std::string defaultDoc();
    std::map<int, RoomwalkerProcessor*> members;
    std::map<int, Live> live;
    juce::int64 rev = 1; int sender_ = 0; double savedAt_ = 0; bool pristine = true;
};
