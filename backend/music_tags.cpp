#include "music_tags.h"

#include <algorithm>
#include <cstring>
#include <vector>

namespace musictags {
namespace {

const size_t kMaxText = 8192;            // longest text frame / comment we keep
const size_t kMaxPicture = 12u << 20;    // cover pictures above 12 MB are ignored

// ---------------------------------------------------------------- byte helpers
bool readAt(Reader& r, uint64_t off, size_t len, std::string& out) {
    out.assign(len, '\0');
    size_t got = 0;
    while (got < len) {
        int64_t n = r.read(off + got, &out[got], len - got);
        if (n <= 0) break;
        got += static_cast<size_t>(n);
    }
    out.resize(got);
    return got == len;
}
uint32_t be32(const unsigned char* p) { return (uint32_t(p[0]) << 24) | (uint32_t(p[1]) << 16) | (uint32_t(p[2]) << 8) | p[3]; }
uint32_t be24(const unsigned char* p) { return (uint32_t(p[0]) << 16) | (uint32_t(p[1]) << 8) | p[2]; }
uint32_t be16(const unsigned char* p) { return (uint32_t(p[0]) << 8) | p[1]; }
uint32_t le32(const unsigned char* p) { return (uint32_t(p[3]) << 24) | (uint32_t(p[2]) << 16) | (uint32_t(p[1]) << 8) | p[0]; }
uint64_t le64(const unsigned char* p) { return uint64_t(le32(p)) | (uint64_t(le32(p + 4)) << 32); }
const unsigned char* U(const std::string& s) { return reinterpret_cast<const unsigned char*>(s.data()); }

uint32_t synchsafe(const unsigned char* p) { return (uint32_t(p[0] & 0x7F) << 21) | (uint32_t(p[1] & 0x7F) << 14) | (uint32_t(p[2] & 0x7F) << 7) | (p[3] & 0x7F); }

// ---------------------------------------------------------------- text encodings -> UTF-8
void appendUtf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
}
std::string latin1ToUtf8(const std::string& s) {
    std::string out;
    for (unsigned char c : s) appendUtf8(out, c);
    return out;
}
std::string utf16ToUtf8(const std::string& s, bool bigEndian) {
    std::string out;
    size_t i = 0;
    if (s.size() >= 2) {                                  // byte order mark
        unsigned char a = s[0], b = s[1];
        if (a == 0xFF && b == 0xFE) { bigEndian = false; i = 2; }
        else if (a == 0xFE && b == 0xFF) { bigEndian = true; i = 2; }
    }
    for (; i + 1 < s.size(); i += 2) {
        unsigned char a = s[i], b = s[i + 1];
        uint32_t u = bigEndian ? (uint32_t(a) << 8 | b) : (uint32_t(b) << 8 | a);
        if (u >= 0xD800 && u < 0xDC00 && i + 3 < s.size()) {
            unsigned char c = s[i + 2], d = s[i + 3];
            uint32_t lo = bigEndian ? (uint32_t(c) << 8 | d) : (uint32_t(d) << 8 | c);
            if (lo >= 0xDC00 && lo < 0xE000) { u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00); i += 2; }
        }
        appendUtf8(out, u);
    }
    return out;
}
// ID3 text: first byte = encoding. Only the first value (before a NUL) is returned.
std::string decodeId3Text(const std::string& body) {
    if (body.empty()) return "";
    unsigned char enc = body[0];
    std::string t = body.substr(1);
    std::string out;
    if (enc == 1 || enc == 2) {
        size_t end = t.size();
        for (size_t i = 0; i + 1 < t.size(); i += 2) if (t[i] == 0 && t[i + 1] == 0) { end = i; break; }
        out = utf16ToUtf8(t.substr(0, end), enc == 2);
    } else {
        size_t z = t.find('\0');
        if (z != std::string::npos) t.resize(z);
        out = (enc == 3) ? t : latin1ToUtf8(t);
    }
    return out;
}
std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (unsigned char)s[a] <= ' ') ++a;
    while (b > a && (unsigned char)s[b - 1] <= ' ') --b;
    return s.substr(a, b - a);
}
int leadingInt(const std::string& s) {
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '(')) ++i;
    int v = 0, digits = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9' && digits < 6) { v = v * 10 + (s[i] - '0'); ++i; ++digits; }
    return digits ? v : 0;
}
int yearOf(const std::string& s) {
    for (size_t i = 0; i + 4 <= s.size(); ++i) {
        bool ok = true;
        for (size_t k = 0; k < 4; ++k) if (s[i + k] < '0' || s[i + k] > '9') { ok = false; break; }
        if (ok) { int y = std::atoi(s.substr(i, 4).c_str()); if (y >= 1000 && y <= 2999) return y; }
    }
    return 0;
}
// "(17)Rock", "(17)", "17" -> keep only real text
std::string cleanGenre(const std::string& g) {
    std::string s = trim(g);
    while (!s.empty() && s[0] == '(') { size_t e = s.find(')'); if (e == std::string::npos) break; s = trim(s.substr(e + 1)); }
    bool numeric = !s.empty();
    for (char c : s) if (c < '0' || c > '9') { numeric = false; break; }
    return numeric ? "" : s;
}
bool imageMime(const std::string& data, std::string& mime) {
    if (data.size() > 3 && (unsigned char)data[0] == 0xFF && (unsigned char)data[1] == 0xD8) { mime = "image/jpeg"; return true; }
    if (data.size() > 8 && data.compare(0, 4, "\x89PNG") == 0) { mime = "image/png"; return true; }
    if (data.size() > 12 && data.compare(0, 4, "RIFF") == 0 && data.compare(8, 4, "WEBP") == 0) { mime = "image/webp"; return true; }
    return false;
}

// ---------------------------------------------------------------- Vorbis comments (FLAC and Ogg)
void applyVorbisField(const std::string& keyRaw, const std::string& val, Tags& t) {
    std::string key;
    for (char c : keyRaw) key += char(std::toupper((unsigned char)c));
    std::string v = trim(val);
    if (v.empty()) return;
    if (key == "TITLE") { if (t.title.empty()) t.title = v; }
    else if (key == "ARTIST") { if (t.artist.empty()) t.artist = v; }
    else if (key == "ALBUMARTIST" || key == "ALBUM ARTIST") { if (t.albumArtist.empty()) t.albumArtist = v; }
    else if (key == "ALBUM") { if (t.album.empty()) t.album = v; }
    else if (key == "GENRE") { if (t.genre.empty()) t.genre = v; }
    else if (key == "TRACKNUMBER" || key == "TRACK") { if (!t.track) t.track = leadingInt(v); }
    else if (key == "DISCNUMBER" || key == "DISC") { if (!t.disc) t.disc = leadingInt(v); }
    else if (key == "DATE" || key == "YEAR" || key == "ORIGINALDATE") { if (!t.year) t.year = yearOf(v); }
    else if (key == "METADATA_BLOCK_PICTURE") t.hasArt = true;
}
// body points at the vendor length. Stops quietly at anything that does not fit.
void parseVorbisComments(const std::string& d, size_t pos, Tags& t) {
    const unsigned char* p = U(d);
    if (pos + 4 > d.size()) return;
    uint32_t vendor = le32(p + pos); pos += 4;
    if (vendor > d.size() - pos) return;
    pos += vendor;
    if (pos + 4 > d.size()) return;
    uint32_t count = le32(p + pos); pos += 4;
    for (uint32_t i = 0; i < count && i < 512; ++i) {
        if (pos + 4 > d.size()) return;
        uint32_t len = le32(p + pos); pos += 4;
        if (len > d.size() - pos) return;
        std::string kv = d.substr(pos, len); pos += len;
        size_t eq = kv.find('=');
        if (eq == std::string::npos) continue;
        if (eq + 1 < kv.size() && kv.size() - eq > kMaxText) kv.resize(eq + 1 + kMaxText);
        applyVorbisField(kv.substr(0, eq), kv.substr(eq + 1), t);
    }
}

// FLAC PICTURE block (also the payload of METADATA_BLOCK_PICTURE in Ogg, after base64)
bool parseFlacPicture(const std::string& d, Picture& out) {
    const unsigned char* p = U(d);
    size_t pos = 4;
    if (d.size() < 32) return false;
    uint32_t mimeLen = be32(p + pos); pos += 4;
    if (mimeLen > d.size() - pos) return false;
    std::string mime = d.substr(pos, mimeLen); pos += mimeLen;
    if (pos + 4 > d.size()) return false;
    uint32_t descLen = be32(p + pos); pos += 4;
    if (descLen > d.size() - pos) return false;
    pos += descLen + 16;
    if (pos + 4 > d.size()) return false;
    uint32_t dataLen = be32(p + pos); pos += 4;
    if (dataLen == 0 || dataLen > d.size() - pos) return false;
    out.data = d.substr(pos, dataLen);
    if (!imageMime(out.data, out.mime)) out.mime = mime.empty() ? "image/jpeg" : mime;
    return true;
}

// ---------------------------------------------------------------- ID3
struct Id3Info { uint64_t tagEnd = 0; bool found = false; };

bool id3Header(Reader& r, uint64_t at, int& major, uint8_t& flags, uint32_t& size) {
    std::string h;
    if (!readAt(r, at, 10, h) || h.compare(0, 3, "ID3") != 0) return false;
    major = (unsigned char)h[3];
    if (major < 2 || major > 4) return false;
    flags = (unsigned char)h[5];
    for (int i = 6; i < 10; ++i) if ((unsigned char)h[i] & 0x80) return false;
    size = synchsafe(U(h) + 6);
    return true;
}

std::string unsync(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        out += s[i];
        if ((unsigned char)s[i] == 0xFF && i + 1 < s.size() && s[i + 1] == 0) ++i;
    }
    return out;
}

// Walks the frames of the tag at `at`. wantPicture: return the cover instead of the text fields.
Id3Info walkId3(Reader& r, uint64_t at, Tags* t, Picture* pic) {
    Id3Info info;
    int major = 0; uint8_t flags = 0; uint32_t size = 0;
    if (!id3Header(r, at, major, flags, size)) return info;
    info.found = true;
    info.tagEnd = at + 10 + size;
    const bool tagUnsync = (flags & 0x80) != 0;
    uint64_t pos = at + 10;
    const uint64_t end = at + 10 + size;
    if (flags & 0x40) {                                     // extended header: skip it
        std::string e;
        if (readAt(r, pos, 4, e)) pos += (major == 4) ? synchsafe(U(e)) : (be32(U(e)) + 4);
    }
    const size_t hdr = (major == 2) ? 6 : 10;
    int frames = 0;
    while (pos + hdr <= end && frames++ < 4000) {
        std::string h;
        if (!readAt(r, pos, hdr, h)) break;
        if (h[0] == '\0') break;                            // padding
        std::string id = h.substr(0, major == 2 ? 3 : 4);
        uint32_t fsize; uint8_t fflags2 = 0;
        if (major == 2) fsize = be24(U(h) + 3);
        else if (major == 3) { fsize = be32(U(h) + 4); fflags2 = (unsigned char)h[9]; }
        else { fsize = synchsafe(U(h) + 4); fflags2 = (unsigned char)h[9]; }
        uint64_t body = pos + hdr;
        if (fsize > end - body) break;
        pos = body + fsize;
        bool compressed = false, encrypted = false, hasDli = false;
        if (major == 3) { compressed = fflags2 & 0x80; encrypted = fflags2 & 0x40; }
        if (major == 4) { compressed = fflags2 & 0x08; encrypted = fflags2 & 0x04; hasDli = fflags2 & 0x01; }
        if (compressed || encrypted) continue;

        auto frameIs = [&](const char* v4, const char* v2) { return id == (major == 2 ? v2 : v4); };
        const bool isPic = frameIs("APIC", "PIC");
        if (isPic) {
            if (t) t->hasArt = true;
            if (!pic || fsize == 0 || fsize > kMaxPicture) continue;
            std::string d;
            if (!readAt(r, body, fsize, d)) continue;
            if (tagUnsync) d = unsync(d);
            size_t i = 0;
            if (hasDli && d.size() > 4) i = 4;
            if (i >= d.size()) continue;
            unsigned char enc = d[i++];
            std::string mime;
            if (major == 2) { if (i + 3 > d.size()) continue; mime = d.substr(i, 3); i += 3; }
            else { size_t z = d.find('\0', i); if (z == std::string::npos) continue; mime = d.substr(i, z - i); i = z + 1; }
            if (i >= d.size()) continue;
            unsigned char picType = d[i++];
            // description, terminated by NUL (two NULs, aligned, for UTF-16)
            if (enc == 1 || enc == 2) {
                while (i + 1 < d.size() && !(d[i] == 0 && d[i + 1] == 0)) i += 2;
                i += 2;
            } else {
                size_t z = d.find('\0', i);
                i = (z == std::string::npos) ? d.size() : z + 1;
            }
            if (i >= d.size()) continue;
            std::string img = d.substr(i);
            std::string m2;
            if (imageMime(img, m2)) mime = m2;
            else if (mime == "JPG") mime = "image/jpeg";
            else if (mime == "PNG") mime = "image/png";
            // prefer the front cover (type 3); otherwise keep the first picture
            if (pic->data.empty() || picType == 3) { pic->data = img; pic->mime = mime; }
            continue;
        }
        if (!t || fsize == 0 || fsize > kMaxText) continue;
        const bool wanted = frameIs("TIT2", "TT2") || frameIs("TPE1", "TP1") || frameIs("TPE2", "TP2") || frameIs("TALB", "TAL") ||
                            frameIs("TRCK", "TRK") || frameIs("TPOS", "TPA") || frameIs("TYER", "TYE") || frameIs("TDRC", "TOR") ||
                            frameIs("TCON", "TCO") || frameIs("TLEN", "TLE");
        if (!wanted) continue;
        std::string d;
        if (!readAt(r, body, fsize, d)) continue;
        if (tagUnsync) d = unsync(d);
        if (hasDli && d.size() > 4) d.erase(0, 4);
        std::string v = trim(decodeId3Text(d));
        if (v.empty()) continue;
        if (frameIs("TIT2", "TT2")) { if (t->title.empty()) t->title = v; }
        else if (frameIs("TPE1", "TP1")) { if (t->artist.empty()) t->artist = v; }
        else if (frameIs("TPE2", "TP2")) { if (t->albumArtist.empty()) t->albumArtist = v; }
        else if (frameIs("TALB", "TAL")) { if (t->album.empty()) t->album = v; }
        else if (frameIs("TRCK", "TRK")) { if (!t->track) t->track = leadingInt(v); }
        else if (frameIs("TPOS", "TPA")) { if (!t->disc) t->disc = leadingInt(v); }
        else if (frameIs("TYER", "TYE") || frameIs("TDRC", "TOR")) { if (!t->year) t->year = yearOf(v); }
        else if (frameIs("TCON", "TCO")) { if (t->genre.empty()) t->genre = cleanGenre(v); }
        else if (frameIs("TLEN", "TLE")) { if (t->duration <= 0) t->duration = leadingInt(v) / 1000.0; }
    }
    return info;
}

void readId3v1(Reader& r, Tags& t) {
    uint64_t sz = r.size();
    if (sz < 128) return;
    std::string d;
    if (!readAt(r, sz - 128, 128, d) || d.compare(0, 3, "TAG") != 0) return;
    auto field = [&](size_t off, size_t len) {
        std::string s = d.substr(off, len);
        size_t z = s.find('\0');
        if (z != std::string::npos) s.resize(z);
        return trim(latin1ToUtf8(s));
    };
    if (t.title.empty()) t.title = field(3, 30);
    if (t.artist.empty()) t.artist = field(33, 30);
    if (t.album.empty()) t.album = field(63, 30);
    if (!t.year) t.year = yearOf(d.substr(93, 4));
    if (!t.track && d[125] == '\0' && d[126] != '\0') t.track = (unsigned char)d[126];
}

// MPEG audio duration: Xing / Info / VBRI frame count when present, otherwise constant bitrate.
void mpegDuration(Reader& r, uint64_t audioStart, Tags& t) {
    if (t.duration > 0) return;
    std::string d;
    readAt(r, audioStart, 4096 + 64, d);
    if (d.size() < 8) { readAt(r, audioStart, 8, d); }
    const unsigned char* p = U(d);
    size_t i = 0;
    for (; i + 4 <= d.size(); ++i) if (p[i] == 0xFF && (p[i + 1] & 0xE0) == 0xE0) break;
    if (i + 4 > d.size()) return;
    uint32_t h = be32(p + i);
    int ver = (h >> 19) & 3, layer = (h >> 17) & 3, br = (h >> 12) & 15, sr = (h >> 10) & 3;
    if (ver == 1 || layer == 0 || br == 0 || br == 15 || sr == 3) return;
    static const int rates[3] = {44100, 48000, 32000};
    int rate = rates[sr] >> (ver == 0 ? 2 : (ver == 2 ? 1 : 0));        // 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1
    static const int brV1L1[] = {0,32,64,96,128,160,192,224,256,288,320,352,384,416,448};
    static const int brV1L2[] = {0,32,48,56,64,80,96,112,128,160,192,224,256,320,384};
    static const int brV1L3[] = {0,32,40,48,56,64,80,96,112,128,160,192,224,256,320};
    static const int brV2L1[] = {0,32,48,56,64,80,96,112,128,144,160,176,192,224,256};
    static const int brV2L23[] = {0,8,16,24,32,40,48,56,64,80,96,112,128,144,160};
    int kbps;
    if (ver == 3) kbps = layer == 3 ? brV1L1[br] : (layer == 2 ? brV1L2[br] : brV1L3[br]);
    else kbps = layer == 3 ? brV2L1[br] : brV2L23[br];
    int samplesPerFrame = layer == 3 ? 384 : ((layer == 1 && ver != 3) ? 576 : 1152);
    if (rate <= 0 || kbps <= 0) return;
    const bool mono = ((h >> 6) & 3) == 3;
    size_t side = (ver == 3) ? (mono ? 17 : 32) : (mono ? 9 : 17);
    size_t x = i + 4 + side;
    if (x + 12 <= d.size() && (d.compare(x, 4, "Xing") == 0 || d.compare(x, 4, "Info") == 0)) {
        uint32_t flags = be32(p + x + 4);
        if (flags & 1) { t.duration = double(be32(p + x + 8)) * samplesPerFrame / rate; return; }
    }
    for (size_t v = i + 4 + 32; v + 18 <= d.size(); ) {
        if (d.compare(v, 4, "VBRI") == 0) { t.duration = double(be32(p + v + 14)) * samplesPerFrame / rate; return; }
        break;
    }
    uint64_t total = r.size();
    if (total > audioStart) t.duration = double(total - audioStart) * 8.0 / (kbps * 1000.0);
}

bool readMp3(Reader& r, Tags& t, Picture* pic) {
    uint64_t audioStart = 0;
    Id3Info info = walkId3(r, 0, &t, pic);
    if (info.found) audioStart = info.tagEnd;
    if (!pic) {
        readId3v1(r, t);
        mpegDuration(r, audioStart, t);
    }
    return true;
}

// ---------------------------------------------------------------- FLAC
bool readFlac(Reader& r, Tags* t, Picture* pic) {
    uint64_t pos = 0;
    Id3Info info = walkId3(r, 0, nullptr, nullptr);            // an ID3 tag glued to the front of a FLAC file
    if (info.found) pos = info.tagEnd;
    std::string m;
    if (!readAt(r, pos, 4, m) || m.compare(0, 4, "fLaC") != 0) return false;
    pos += 4;
    for (int blocks = 0; blocks < 64; ++blocks) {
        std::string h;
        if (!readAt(r, pos, 4, h)) break;
        bool last = (unsigned char)h[0] & 0x80;
        int type = (unsigned char)h[0] & 0x7F;
        uint32_t len = be24(U(h) + 1);
        uint64_t body = pos + 4;
        pos = body + len;
        if (type == 0 && len >= 18 && t) {                      // STREAMINFO
            std::string s;
            if (readAt(r, body, 18, s)) {
                const unsigned char* p = U(s);
                uint32_t sr = (uint32_t(p[10]) << 12) | (uint32_t(p[11]) << 4) | (p[12] >> 4);
                uint64_t total = (uint64_t(p[13] & 0x0F) << 32) | (uint64_t(p[14]) << 24) | (uint64_t(p[15]) << 16) | (uint64_t(p[16]) << 8) | p[17];
                if (sr && total) t->duration = double(total) / sr;
            }
        } else if (type == 4 && t && len <= (1u << 20)) {       // VORBIS_COMMENT
            std::string c;
            if (readAt(r, body, len, c)) parseVorbisComments(c, 0, *t);
        } else if (type == 6) {                                 // PICTURE
            if (t) t->hasArt = true;
            if (pic && len <= kMaxPicture) {
                std::string c;
                Picture one;
                if (readAt(r, body, len, c) && parseFlacPicture(c, one)) {
                    uint32_t picType = be32(U(c));
                    if (pic->data.empty() || picType == 3) *pic = one;
                }
            }
        }
        if (last) break;
    }
    return true;
}

// ---------------------------------------------------------------- Ogg (Vorbis / Opus)
std::string base64Decode(const std::string& in) {
    static int8_t map[256]; static bool init = false;
    if (!init) {
        std::memset(map, -1, sizeof map);
        const char* a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        for (int i = 0; i < 64; ++i) map[(unsigned char)a[i]] = int8_t(i);
        init = true;
    }
    std::string out; uint32_t acc = 0; int bits = 0;
    for (unsigned char c : in) {
        if (c == '=') break;
        int v = map[c];
        if (v < 0) continue;
        acc = (acc << 6) | uint32_t(v); bits += 6;
        if (bits >= 8) { bits -= 8; out += char((acc >> bits) & 0xFF); }
    }
    return out;
}

bool readOgg(Reader& r, Tags* t, Picture* pic) {
    std::string head;
    size_t want = pic ? (size_t)std::min<uint64_t>(r.size(), 6u << 20) : (size_t)std::min<uint64_t>(r.size(), 128u << 10);
    if (!readAt(r, 0, want, head) && head.size() < 64) return false;
    if (head.compare(0, 4, "OggS") != 0) return false;
    // Take the packet bytes out of the pages that follow the identification header (page headers removed).
    std::string packets;
    size_t pos = 0;
    int pages = 0;
    bool opus = head.find("OpusHead") != std::string::npos && head.find("OpusHead") < 100;
    uint32_t vorbisRate = 0;
    while (pos + 27 <= head.size() && pages++ < 400) {
        if (head.compare(pos, 4, "OggS") != 0) break;
        unsigned segs = (unsigned char)head[pos + 26];
        if (pos + 27 + segs > head.size()) break;
        size_t dataLen = 0;
        for (unsigned i = 0; i < segs; ++i) dataLen += (unsigned char)head[pos + 27 + i];
        size_t dataPos = pos + 27 + segs;
        if (dataPos + dataLen > head.size()) dataLen = head.size() - dataPos;
        std::string body = head.substr(dataPos, dataLen);
        if (pages == 1 && !opus && body.size() >= 16 && body.compare(0, 7, "\x01vorbis") == 0) vorbisRate = le32(U(body) + 12);
        else if (pages > 1) packets += body;
        pos = dataPos + dataLen;
        if (packets.size() > (pic ? (8u << 20) : (96u << 10))) break;
        if (pages >= 2 && packets.size() > 8 && !pic && packets.size() > 60000) break;
    }
    size_t tagPos = std::string::npos;
    if (opus) { size_t f = packets.find("OpusTags"); if (f != std::string::npos) tagPos = f + 8; }
    else { size_t f = packets.find("\x03vorbis"); if (f != std::string::npos) tagPos = f + 7; }
    if (tagPos != std::string::npos) {
        if (t) parseVorbisComments(packets, tagPos, *t);
        if (pic) {
            // METADATA_BLOCK_PICTURE=<base64 of a FLAC picture block>
            size_t k = packets.find("METADATA_BLOCK_PICTURE=", tagPos);
            if (k != std::string::npos) {
                size_t s = k + 23, e = s;
                while (e < packets.size() && packets[e] != '\0' && (std::isalnum((unsigned char)packets[e]) || packets[e] == '+' || packets[e] == '/' || packets[e] == '=')) ++e;
                parseFlacPicture(base64Decode(packets.substr(s, e - s)), *pic);
            }
        }
    }
    if (t && t->duration <= 0) {                                 // last page's granule position
        uint64_t sz = r.size();
        std::string tail;
        size_t n = (size_t)std::min<uint64_t>(sz, 64u << 10);
        if (readAt(r, sz - n, n, tail)) {
            size_t f = tail.rfind("OggS");
            if (f != std::string::npos && f + 14 <= tail.size()) {
                uint64_t gran = le64(U(tail) + f + 6);
                if (opus) {
                    size_t oh = head.find("OpusHead");
                    uint32_t pre = (oh != std::string::npos && oh + 12 <= head.size()) ? (unsigned char)head[oh + 10] | ((unsigned char)head[oh + 11] << 8) : 0;
                    if (gran > pre) t->duration = double(gran - pre) / 48000.0;
                } else if (vorbisRate) t->duration = double(gran) / vorbisRate;
            }
        }
    }
    return true;
}

// ---------------------------------------------------------------- MP4 / M4A
struct Atom { uint64_t start = 0, hdr = 8, size = 0; char type[5] = {0, 0, 0, 0, 0}; };

bool nextAtom(Reader& r, uint64_t pos, uint64_t end, Atom& a) {
    if (pos + 8 > end) return false;
    std::string h;
    if (!readAt(r, pos, 16, h)) { if (!readAt(r, pos, 8, h)) return false; }
    a.start = pos;
    uint64_t sz = be32(U(h));
    std::memcpy(a.type, h.data() + 4, 4);
    a.hdr = 8;
    if (sz == 1) { if (h.size() < 16) return false; sz = (uint64_t(be32(U(h) + 8)) << 32) | be32(U(h) + 12); a.hdr = 16; }
    else if (sz == 0) sz = end - pos;
    if (sz < a.hdr || pos + sz > end) { if (pos + sz > end && sz >= a.hdr) sz = end - pos; else return false; }
    a.size = sz;
    return true;
}

void mp4Item(Reader& r, const Atom& item, Tags* t, Picture* pic) {
    // item holds a "data" box: size, 'data', flags(4), locale(4), payload
    Atom d;
    if (!nextAtom(r, item.start + item.hdr, item.start + item.size, d) || std::strcmp(d.type, "data") != 0) return;
    if (d.size < d.hdr + 8) return;
    uint64_t payloadLen = d.size - d.hdr - 8;
    std::string flagsRaw;
    if (!readAt(r, d.start + d.hdr, 4, flagsRaw)) return;
    uint32_t dtype = be24(U(flagsRaw) + 1);
    std::string key(item.type, 4);
    if (key == "covr") {
        if (t) t->hasArt = true;
        if (pic && payloadLen > 0 && payloadLen <= kMaxPicture && pic->data.empty()) {
            std::string img;
            if (readAt(r, d.start + d.hdr + 8, (size_t)payloadLen, img)) {
                pic->data = img;
                if (!imageMime(img, pic->mime)) pic->mime = dtype == 14 ? "image/png" : "image/jpeg";
            }
        }
        return;
    }
    if (!t || payloadLen == 0 || payloadLen > kMaxText) return;
    std::string payload;
    if (!readAt(r, d.start + d.hdr + 8, (size_t)payloadLen, payload)) return;
    const unsigned char* p = U(payload);
    if (key == "trkn" || key == "disk") {
        if (payload.size() >= 4) { int n = int(be16(p + 2)); if (key == "trkn") { if (!t->track) t->track = n; } else if (!t->disc) t->disc = n; }
        return;
    }
    std::string v = trim(payload);
    if (v.empty()) return;
    if (key == "\xA9nam") { if (t->title.empty()) t->title = v; }
    else if (key == "\xA9" "ART") { if (t->artist.empty()) t->artist = v; }
    else if (key == "aART") { if (t->albumArtist.empty()) t->albumArtist = v; }
    else if (key == "\xA9" "alb") { if (t->album.empty()) t->album = v; }
    else if (key == "\xA9" "gen") { if (t->genre.empty()) t->genre = v; }
    else if (key == "\xA9" "day") { if (!t->year) t->year = yearOf(v); }
}

bool readMp4(Reader& r, Tags* t, Picture* pic) {
    uint64_t total = r.size();
    Atom a;
    uint64_t pos = 0;
    bool sawMoov = false;
    for (int guard = 0; guard < 64 && nextAtom(r, pos, total, a); ++guard) {
        pos = a.start + a.size;
        if (std::strcmp(a.type, "moov") != 0) continue;
        sawMoov = true;
        uint64_t cpos = a.start + a.hdr, cend = a.start + a.size;
        Atom c;
        for (int g2 = 0; g2 < 64 && nextAtom(r, cpos, cend, c); ++g2) {
            cpos = c.start + c.size;
            if (std::strcmp(c.type, "mvhd") == 0 && t && c.size >= c.hdr + 20) {
                std::string m;
                if (readAt(r, c.start + c.hdr, 20, m)) {
                    const unsigned char* p = U(m);
                    if (p[0] == 1) {
                        std::string m2;
                        if (readAt(r, c.start + c.hdr, 32, m2)) {
                            uint32_t ts = be32(U(m2) + 20); uint64_t dur = (uint64_t(be32(U(m2) + 24)) << 32) | be32(U(m2) + 28);
                            if (ts) t->duration = double(dur) / ts;
                        }
                    } else {
                        uint32_t ts = be32(p + 12), dur = be32(p + 16);
                        if (ts) t->duration = double(dur) / ts;
                    }
                }
            } else if (std::strcmp(c.type, "udta") == 0) {
                Atom meta;
                uint64_t upos = c.start + c.hdr, uend = c.start + c.size;
                Atom u;
                for (int g3 = 0; g3 < 32 && nextAtom(r, upos, uend, u); ++g3) {
                    upos = u.start + u.size;
                    if (std::strcmp(u.type, "meta") != 0) continue;
                    uint64_t mpos = u.start + u.hdr + 4, mend = u.start + u.size;     // meta is a full box: 4 version/flag bytes
                    Atom ilst;
                    for (int g4 = 0; g4 < 32 && nextAtom(r, mpos, mend, ilst); ++g4) {
                        mpos = ilst.start + ilst.size;
                        if (std::strcmp(ilst.type, "ilst") != 0) continue;
                        uint64_t ipos = ilst.start + ilst.hdr, iend = ilst.start + ilst.size;
                        Atom item;
                        for (int g5 = 0; g5 < 128 && nextAtom(r, ipos, iend, item); ++g5) {
                            ipos = item.start + item.size;
                            mp4Item(r, item, t, pic);
                        }
                    }
                }
            }
        }
        break;
    }
    return sawMoov;
}

} // namespace

// ---------------------------------------------------------------- public
bool isAudioExtension(const std::string& e) {
    static const char* exts[] = {".mp3", ".flac", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".wav", ".wma", ".ape", ".wv", ".aiff", ".aif"};
    for (const char* x : exts) if (e == x) return true;
    return false;
}

bool readTags(Reader& r, const std::string& ext, Tags& t) {
    if (ext == ".mp3") return readMp3(r, t, nullptr);
    if (ext == ".flac") return readFlac(r, &t, nullptr);
    if (ext == ".ogg" || ext == ".oga" || ext == ".opus") return readOgg(r, &t, nullptr);
    if (ext == ".m4a" || ext == ".m4b") return readMp4(r, &t, nullptr);
    return false;
}

bool readCover(Reader& r, const std::string& ext, Picture& pic) {
    pic = Picture();
    if (ext == ".mp3") { Tags t; readMp3(r, t, &pic); }
    else if (ext == ".flac") readFlac(r, nullptr, &pic);
    else if (ext == ".ogg" || ext == ".oga" || ext == ".opus") readOgg(r, nullptr, &pic);
    else if (ext == ".m4a" || ext == ".m4b") readMp4(r, nullptr, &pic);
    return !pic.data.empty();
}

} // namespace musictags
