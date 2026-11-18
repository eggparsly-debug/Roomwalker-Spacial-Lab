cmake_minimum_required(VERSION 3.22)
project(Roomwalker VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(RW_BUILD_PLUGIN "Build the JUCE plugin (needs JUCE)" ON)
option(RW_BUILD_TOOLS "Build command-line render and test tools" ON)

# Audio engine: plain C++17, no JUCE, tested headless against the browser prototype (reference/).
add_library(rwcore STATIC src/core/rw_engine.cpp src/core/rw_json.cpp)
set_target_properties(rwcore PROPERTIES POSITION_INDEPENDENT_CODE ON)
target_include_directories(rwcore PUBLIC src/core)
if(MSVC)
  target_compile_options(rwcore PRIVATE /O2 /fp:precise)
else()
  target_compile_options(rwcore PRIVATE -O2)
endif()

if(RW_BUILD_TOOLS)
  add_executable(rwrender tools/rwrender.cpp)
  target_link_libraries(rwrender PRIVATE rwcore)
  target_compile_definitions(rwrender PRIVATE RW_SELFTEST_JSON="${CMAKE_CURRENT_SOURCE_DIR}/tools/selftest.json")
endif()

if(RW_BUILD_PLUGIN)
  include(FetchContent)
  FetchContent_Declare(JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.4
    GIT_SHALLOW ON)
  FetchContent_MakeAvailable(JUCE)

  juce_add_plugin(Roomwalker
    COMPANY_NAME "Roomwalker"
    PLUGIN_MANUFACTURER_CODE Rmwk
    PLUGIN_CODE Rmw1
    PRODUCT_NAME "Roomwalker"
    FORMATS VST3
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    VST3_CATEGORIES Fx Spatial Reverb)

  juce_add_binary_data(RoomwalkerData SOURCES reference/default_scene.json src/ui/index.html)
  set_target_properties(RoomwalkerData PROPERTIES POSITION_INDEPENDENT_CODE ON)

  target_sources(Roomwalker PRIVATE
    src/plugin/PluginProcessor.cpp
    src/plugin/PluginEditor.cpp
    src/plugin/RoomHub.cpp)

  target_compile_definitions(Roomwalker PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=1)

  target_link_libraries(Roomwalker
    PRIVATE rwcore RoomwalkerData juce::juce_audio_utils juce::juce_gui_extra
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_lto_flags juce::juce_recommended_warning_flags)

  # Hosts real plugin instances without a DAW: linking, saved state, automation and transport
  if(RW_BUILD_TOOLS)
    juce_add_console_app(rwhosttest PRODUCT_NAME "rwhosttest" NEEDS_WEB_BROWSER TRUE)
    target_sources(rwhosttest PRIVATE tools/hosttest.cpp src/plugin/PluginProcessor.cpp src/plugin/PluginEditor.cpp src/plugin/RoomHub.cpp)
    target_include_directories(rwhosttest PRIVATE src/plugin)
    target_compile_definitions(rwhosttest PRIVATE
      JUCE_WEB_BROWSER=1 JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1 JUCE_USE_CURL=0 JUCE_STANDALONE_APPLICATION=1 JUCE_MODAL_LOOPS_PERMITTED=1
      JucePlugin_Name="Roomwalker" JucePlugin_VSTNumMidiInputs=0 JucePlugin_VSTNumMidiOutputs=0)
    target_link_libraries(rwhosttest PRIVATE rwcore RoomwalkerData juce::juce_audio_utils juce::juce_gui_extra juce::juce_recommended_config_flags)
  endif()
endif()
