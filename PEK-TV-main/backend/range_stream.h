// Serves a seekable stream of ANY size (> 4 GB included) over HTTP, also on 32-bit builds.
//
// Why: httplib keeps a response's length in size_t and byte ranges in ssize_t, both 32 bits on
// armeabi-v7a, so it cannot describe a body of 4 GB or more. For those, this does the Range handling
// itself in 64-bit and sends the body as chunks (Content-Range still carries the real size, which is
// what ffmpeg / mpv use to know the file length and to seek).
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>
#include "httplib.h"

namespace rangestream {

// Reads up to len bytes at `offset`; returns bytes read, 0 at end, -1 on failure.
using ReadFn = std::function<int64_t(uint64_t offset, char* buf, size_t len, httplib::DataSink& sink)>;

// Files this big (or bigger) cannot go through httplib's own size_t-based range code on a 32-bit build.
inline bool needsOwnRanges(uint64_t size) {
    return sizeof(size_t) < 8 && size >= 0x7FFFFFFFull;   // keep a margin below 2^31 as well
}

// Parses "bytes=a-b" / "bytes=a-" / "bytes=-n" (first range only). false = no usable Range header.
inline bool parseRange(const std::string& h, uint64_t size, uint64_t& first, uint64_t& last, bool& unsatisfiable) {
    unsatisfiable = false;
    if (h.compare(0, 6, "bytes=") != 0) return false;
    std::string spec = h.substr(6);
    size_t comma = spec.find(',');
    if (comma != std::string::npos) spec.resize(comma);
    size_t dash = spec.find('-');
    if (dash == std::string::npos) return false;
    std::string a = spec.substr(0, dash), b = spec.substr(dash + 1);
    auto digits = [](const std::string& s) {
        return !s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) { return c >= '0' && c <= '9'; });
    };
    if (a.empty() && !digits(b)) return false;
    if (!a.empty() && !digits(a)) return false;
    if (!b.empty() && !digits(b)) return false;
    if (a.empty()) {                                   // suffix: the last n bytes
        uint64_t n = std::strtoull(b.c_str(), nullptr, 10);
        if (n == 0) { unsatisfiable = true; return true; }
        first = n >= size ? 0 : size - n;
        last = size - 1;
    } else {
        first = std::strtoull(a.c_str(), nullptr, 10);
        last = b.empty() ? size - 1 : std::min<uint64_t>(std::strtoull(b.c_str(), nullptr, 10), size - 1);
        if (first >= size || first > last) { unsatisfiable = true; return true; }
    }
    return true;
}

// Answers a GET for a stream of `size` bytes, honouring Range, with 64-bit math throughout.
inline void serve(const httplib::Request& req, httplib::Response& res, uint64_t size,
                  const std::string& mime, ReadFn read, size_t chunk = 256 * 1024) {
    // httplib has already parsed Range into 32-bit-sized slots; this response is not described by them.
    const_cast<httplib::Request&>(req).ranges.clear();

    uint64_t first = 0, last = size ? size - 1 : 0;
    bool partial = false, bad = false;
    if (req.has_header("Range")) partial = parseRange(req.get_header_value("Range"), size, first, last, bad);
    res.set_header("Accept-Ranges", "bytes");
    if (bad || size == 0) {
        res.status = 416;
        res.set_header("Content-Range", "bytes */" + std::to_string(size));
        return;
    }
    if (partial) {
        res.status = 206;
        res.set_header("Content-Range", "bytes " + std::to_string(first) + "-" + std::to_string(last) + "/" + std::to_string(size));
    } else {
        res.status = 200;
    }
    auto pos = std::make_shared<uint64_t>(first);
    const uint64_t end = last;
    res.set_chunked_content_provider(mime, [pos, end, read, chunk](size_t, httplib::DataSink& sink) {
        if (*pos > end) { sink.done(); return true; }
        std::vector<char> buf(static_cast<size_t>(std::min<uint64_t>(chunk, end - *pos + 1)));
        int64_t n = read(*pos, buf.data(), buf.size(), sink);
        if (n <= 0) return false;                       // data not available: drop the connection, the player retries
        if (!sink.write(buf.data(), static_cast<size_t>(n))) return false;
        *pos += static_cast<uint64_t>(n);
        return true;
    });
}

}  // namespace rangestream
