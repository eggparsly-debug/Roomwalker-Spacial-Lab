// Minimal JSON value with JavaScript-style accessors, so build configs read exactly like engine.js reads them.
//   num(k)      : like `obj.k` used in arithmetic (missing -> NaN, null -> 0)
//   nn(k, d)    : like `obj.k == null ? d : obj.k`
//   orv(k, d)   : like `obj.k || d`
//   truthy(k)   : like `!!obj.k`
#pragma once
#include <cmath>
#include <string>
#include <utility>
#include <vector>

namespace rw {

struct Json {
    enum Type { Undef, Null, Bool, Num, Str, Arr, Obj };
    Type t = Undef;
    double n = 0;
    bool b = false;
    std::string s;
    std::vector<Json> a;
    std::vector<std::pair<std::string, Json>> o;

    Json() = default;
    static Json number(double v) { Json j; j.t = Num; j.n = v; return j; }
    static Json boolean(bool v) { Json j; j.t = Bool; j.b = v; return j; }
    static Json string(const std::string& v) { Json j; j.t = Str; j.s = v; return j; }
    static Json object() { Json j; j.t = Obj; return j; }
    static Json array() { Json j; j.t = Arr; return j; }

    bool isUndef() const { return t == Undef; }
    bool isNullish() const { return t == Undef || t == Null; }
    bool isObj() const { return t == Obj; }
    bool isArr() const { return t == Arr; }
    bool isNum() const { return t == Num; }
    bool isStr() const { return t == Str; }

    // JS truthiness / numeric conversion of this value
    bool truth() const;
    double toNum() const;

    const Json& get(const std::string& k) const;
    Json& set(const std::string& k, const Json& v);
    const Json& at(size_t i) const;
    size_t size() const { return t == Arr ? a.size() : t == Obj ? o.size() : 0; }

    double num(const std::string& k) const { return get(k).toNum(); }
    double nn(const std::string& k, double d) const { const Json& v = get(k); return v.isNullish() ? d : v.toNum(); }
    double orv(const std::string& k, double d) const { const Json& v = get(k); return v.truth() ? v.toNum() : d; }
    bool truthy(const std::string& k) const { return get(k).truth(); }
    std::string str(const std::string& k, const std::string& d = "") const { const Json& v = get(k); return v.t == Str ? v.s : d; }

    // Object.assign({}, this, other)
    Json merged(const Json& other) const;

    static Json parse(const std::string& text, std::string* err = nullptr);
    std::string dump() const;
};

} // namespace rw
