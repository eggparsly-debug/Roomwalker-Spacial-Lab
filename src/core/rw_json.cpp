#include "rw_json.h"
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace rw {

static const Json kUndef;

bool Json::truth() const
{
    switch (t) {
        case Undef: case Null: return false;
        case Bool: return b;
        case Num: return n != 0 && n == n;
        case Str: return !s.empty();
        default: return true;
    }
}

double Json::toNum() const
{
    switch (t) {
        case Undef: return NAN;
        case Null: return 0;
        case Bool: return b ? 1 : 0;
        case Num: return n;
        case Str: {
            if (s.empty()) return 0;
            char* e = nullptr; double v = std::strtod(s.c_str(), &e);
            return (e && *e == 0) ? v : NAN;
        }
        default: return NAN;
    }
}

const Json& Json::get(const std::string& k) const
{
    if (t != Obj) return kUndef;
    for (auto& kv : o) if (kv.first == k) return kv.second;
    return kUndef;
}

Json& Json::set(const std::string& k, const Json& v)
{
    if (t != Obj) { t = Obj; o.clear(); }
    for (auto& kv : o) if (kv.first == k) { kv.second = v; return kv.second; }
    o.emplace_back(k, v);
    return o.back().second;
}

const Json& Json::at(size_t i) const { return (t == Arr && i < a.size()) ? a[i] : kUndef; }

Json Json::merged(const Json& other) const
{
    Json r = (t == Obj) ? *this : Json::object();
    if (other.t == Obj) for (auto& kv : other.o) if (!kv.second.isUndef()) r.set(kv.first, kv.second);
    return r;
}

// ---------------- parser ----------------
namespace {
struct P {
    const char* p; const char* e; std::string err;
    void ws() { while (p < e && (*p == ' ' || *p == '\n' || *p == '\r' || *p == '\t')) ++p; }
    bool fail(const char* m) { if (err.empty()) err = m; return false; }
    bool str(std::string& out) {
        if (p >= e || *p != '"') return fail("expected string");
        ++p;
        while (p < e && *p != '"') {
            char c = *p++;
            if (c == '\\' && p < e) {
                char x = *p++;
                switch (x) {
                    case 'n': out += '\n'; break; case 't': out += '\t'; break; case 'r': out += '\r'; break;
                    case 'b': out += '\b'; break; case 'f': out += '\f'; break;
                    case 'u': {
                        if (e - p < 4) return fail("bad escape");
                        unsigned cp = (unsigned) std::strtoul(std::string(p, 4).c_str(), nullptr, 16); p += 4;
                        if (cp < 0x80) out += (char) cp;
                        else if (cp < 0x800) { out += (char) (0xC0 | (cp >> 6)); out += (char) (0x80 | (cp & 63)); }
                        else { out += (char) (0xE0 | (cp >> 12)); out += (char) (0x80 | ((cp >> 6) & 63)); out += (char) (0x80 | (cp & 63)); }
                        break;
                    }
                    default: out += x;
                }
            } else out += c;
        }
        if (p >= e) return fail("unterminated string");
        ++p; return true;
    }
    bool val(Json& j) {
        ws(); if (p >= e) return fail("unexpected end");
        char c = *p;
        if (c == '{') {
            ++p; j = Json::object(); ws();
            if (p < e && *p == '}') { ++p; return true; }
            for (;;) {
                ws(); std::string k; if (!str(k)) return false;
                ws(); if (p >= e || *p != ':') return fail("expected :"); ++p;
                Json v; if (!val(v)) return false; j.o.emplace_back(std::move(k), std::move(v));
                ws(); if (p < e && *p == ',') { ++p; continue; }
                if (p < e && *p == '}') { ++p; return true; }
                return fail("expected , or }");
            }
        }
        if (c == '[') {
            ++p; j = Json::array(); ws();
            if (p < e && *p == ']') { ++p; return true; }
            for (;;) {
                Json v; if (!val(v)) return false; j.a.push_back(std::move(v));
                ws(); if (p < e && *p == ',') { ++p; continue; }
                if (p < e && *p == ']') { ++p; return true; }
                return fail("expected , or ]");
            }
        }
        if (c == '"') { j.t = Json::Str; return str(j.s); }
        if (!std::strncmp(p, "true", 4)) { p += 4; j = Json::boolean(true); return true; }
        if (!std::strncmp(p, "false", 5)) { p += 5; j = Json::boolean(false); return true; }
        if (!std::strncmp(p, "null", 4)) { p += 4; j.t = Json::Null; return true; }
        char* end = nullptr; double v = std::strtod(p, &end);
        if (end == p) return fail("bad value");
        p = end; j = Json::number(v); return true;
    }
};
void dumpTo(const Json& j, std::string& out)
{
    switch (j.t) {
        case Json::Undef: case Json::Null: out += "null"; break;
        case Json::Bool: out += j.b ? "true" : "false"; break;
        case Json::Num: {
            if (!(j.n == j.n) || std::isinf(j.n)) { out += "null"; break; }
            char buf[40]; std::snprintf(buf, sizeof buf, "%.17g", j.n); out += buf; break;
        }
        case Json::Str: {
            out += '"';
            for (char c : j.s) {
                unsigned char u = (unsigned char) c;
                if (c == '"' || c == '\\') { out += '\\'; out += c; }
                else if (c == '\n') out += "\\n";
                else if (u < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", u); out += b; }
                else out += c;
            }
            out += '"'; break;
        }
        case Json::Arr: {
            out += '['; for (size_t i = 0; i < j.a.size(); ++i) { if (i) out += ','; dumpTo(j.a[i], out); } out += ']'; break;
        }
        case Json::Obj: {
            out += '{'; bool first = true;
            for (auto& kv : j.o) {
                if (kv.second.isUndef()) continue;
                if (!first) out += ',';
                first = false;
                dumpTo(Json::string(kv.first), out); out += ':'; dumpTo(kv.second, out);
            }
            out += '}'; break;
        }
    }
}
} // namespace

Json Json::parse(const std::string& text, std::string* err)
{
    P ps{ text.data(), text.data() + text.size(), {} };
    Json j;
    if (!ps.val(j)) { if (err) *err = ps.err; return Json(); }
    return j;
}

std::string Json::dump() const { std::string s; dumpTo(*this, s); return s; }

} // namespace rw
