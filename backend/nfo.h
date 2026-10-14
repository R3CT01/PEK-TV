#ifndef NFO_H
#define NFO_H

#include <cstdlib>
#include <string>

// Reads the small XML "NFO" files that Kodi, Radarr, Sonarr, tinyMediaManager and friends write next to
// a movie / episode / show:
//
//   <movie>           title, originaltitle, year (or premiered / releasedate), plot (or outline)
//   <episodedetails>  title, showtitle, season, episode, plot (or outline)
//   <tvshow>          title, originaltitle, year (or premiered), plot (or outline)
//
// Only the direct children of the root element are read (so an <actor><name> or a <set><name> can never
// be mistaken for the title). Unknown tags are ignored, CDATA and the usual XML entities are decoded, and
// a file that is not XML at all (for example a text file holding only a link) simply gives ok = false.
// No XML library: the files are tiny and the few fields needed do not justify a dependency.
namespace nfo {

struct Info {
    bool ok = false;
    std::string root;            // "movie", "episodedetails" or "tvshow"
    std::string title;
    std::string originaltitle;
    std::string showtitle;
    std::string plot;
    int year = 0;
    int season = 0;
    int episode = 0;
};

namespace detail {

inline std::string trim(const std::string& s) {
    size_t a = 0, b = s.size();
    while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) ++a;
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) --b;
    return s.substr(a, b - a);
}

inline std::string lower(std::string s) {
    for (char& c : s) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    return s;
}

inline void appendUtf8(std::string& out, unsigned long cp) {
    if (cp == 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return;
    if (cp < 0x80) out += static_cast<char>(cp);
    else if (cp < 0x800) { out += static_cast<char>(0xC0 | (cp >> 6)); out += static_cast<char>(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) {
        out += static_cast<char>(0xE0 | (cp >> 12)); out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
        out += static_cast<char>(0x80 | (cp & 0x3F));
    } else {
        out += static_cast<char>(0xF0 | (cp >> 18)); out += static_cast<char>(0x80 | ((cp >> 12) & 0x3F));
        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F)); out += static_cast<char>(0x80 | (cp & 0x3F));
    }
}

// Turns the raw text between <tag> and </tag> into plain text: CDATA unwrapped, entities decoded.
inline std::string decodeText(const std::string& raw) {
    std::string out;
    size_t i = 0;
    while (i < raw.size()) {
        if (raw.compare(i, 9, "<![CDATA[") == 0) {
            size_t end = raw.find("]]>", i + 9);
            if (end == std::string::npos) { out.append(raw, i + 9, std::string::npos); break; }
            out.append(raw, i + 9, end - (i + 9));
            i = end + 3;
            continue;
        }
        if (raw[i] == '<') {                       // a stray tag inside the text (e.g. <br/>): drop it
            size_t end = raw.find('>', i);
            if (end == std::string::npos) break;
            std::string tag = lower(raw.substr(i + 1, end - i - 1));
            if (tag.compare(0, 2, "br") == 0) out += '\n';
            i = end + 1;
            continue;
        }
        if (raw[i] == '&') {
            size_t semi = raw.find(';', i);
            if (semi != std::string::npos && semi - i <= 10) {
                std::string ent = raw.substr(i + 1, semi - i - 1);
                if (ent == "amp") { out += '&'; i = semi + 1; continue; }
                if (ent == "lt") { out += '<'; i = semi + 1; continue; }
                if (ent == "gt") { out += '>'; i = semi + 1; continue; }
                if (ent == "quot") { out += '"'; i = semi + 1; continue; }
                if (ent == "apos") { out += '\''; i = semi + 1; continue; }
                if (ent.size() > 1 && ent[0] == '#') {
                    char* endp = nullptr;
                    unsigned long cp = (ent[1] == 'x' || ent[1] == 'X')
                        ? std::strtoul(ent.c_str() + 2, &endp, 16)
                        : std::strtoul(ent.c_str() + 1, &endp, 10);
                    if (endp && *endp == '\0') { appendUtf8(out, cp); i = semi + 1; continue; }
                }
            }
        }
        out += raw[i++];
    }
    return trim(out);
}

inline int leadingInt(const std::string& s) {
    size_t i = 0;
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i;
    int v = 0;
    size_t digits = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9' && digits < 6) { v = v * 10 + (s[i] - '0'); ++i; ++digits; }
    return digits ? v : 0;
}

inline int yearFrom(const std::string& s) {      // "1999", "1999-03-31"
    std::string t = trim(s);
    if (t.size() >= 4 && t[0] >= '0' && t[0] <= '9') {
        int y = leadingInt(t.substr(0, 4));
        if (y >= 1880 && y <= 2200) return y;
    }
    return 0;
}

}  // namespace detail

// Parses the text of one NFO file. Never throws.
inline Info parse(const std::string& text) {
    using namespace detail;
    Info info;
    size_t i = 0;
    if (text.compare(0, 3, "\xEF\xBB\xBF") == 0) i = 3;       // UTF-8 byte-order mark

    int depth = 0;                                           // 0 = outside the root element
    std::string premiered, outline;
    const size_t n = text.size();

    while (i < n) {
        size_t lt = text.find('<', i);
        if (lt == std::string::npos) break;
        if (text.compare(lt, 4, "<!--") == 0) {
            size_t e = text.find("-->", lt + 4);
            if (e == std::string::npos) break;
            i = e + 3; continue;
        }
        if (text.compare(lt, 2, "<?") == 0) {
            size_t e = text.find("?>", lt + 2);
            if (e == std::string::npos) break;
            i = e + 2; continue;
        }
        if (text.compare(lt, 9, "<![CDATA[") == 0) {
            size_t e = text.find("]]>", lt + 9);
            if (e == std::string::npos) break;
            i = e + 3; continue;
        }
        if (text.compare(lt, 2, "<!") == 0) {                // <!DOCTYPE ...>
            size_t e = text.find('>', lt + 2);
            if (e == std::string::npos) break;
            i = e + 1; continue;
        }
        size_t gt = text.find('>', lt + 1);
        if (gt == std::string::npos) break;
        std::string tag = text.substr(lt + 1, gt - lt - 1);

        if (!tag.empty() && tag[0] == '/') {                 // closing tag
            if (depth > 0) --depth;
            i = gt + 1;
            if (depth == 0 && info.ok) break;                // the root element is complete
            continue;
        }
        const bool selfClosing = !tag.empty() && tag.back() == '/';
        size_t sp = tag.find_first_of(" \t\r\n/");
        std::string name = lower(sp == std::string::npos ? tag : tag.substr(0, sp));

        if (depth == 0) {                                    // the root element
            if (name == "movie" || name == "tvshow" || name == "episodedetails") {
                info.ok = true;
                info.root = name;
            } else {
                return Info();                               // some other XML: not an NFO we understand
            }
            if (!selfClosing) depth = 1;
            i = gt + 1;
            if (selfClosing) break;
            continue;
        }

        if (depth == 1) {                                    // a direct child of the root
            const bool wanted = name == "title" || name == "originaltitle" || name == "showtitle" ||
                                name == "plot" || name == "outline" || name == "year" || name == "premiered" ||
                                name == "releasedate" || name == "season" || name == "episode";
            if (wanted && !selfClosing) {
                std::string closer = "</" + name;
                size_t from = gt + 1;
                size_t e = std::string::npos;
                for (;;) {                                   // find the real closing tag (case-insensitive)
                    size_t c = text.find("</", from);
                    if (c == std::string::npos) break;
                    if (lower(text.substr(c, closer.size())) == closer) { e = c; break; }
                    from = c + 2;
                }
                if (e == std::string::npos) { i = gt + 1; ++depth; continue; }
                std::string value = decodeText(text.substr(gt + 1, e - (gt + 1)));
                size_t after = text.find('>', e);
                i = after == std::string::npos ? n : after + 1;
                if (name == "title" && info.title.empty()) info.title = value;
                else if (name == "originaltitle" && info.originaltitle.empty()) info.originaltitle = value;
                else if (name == "showtitle" && info.showtitle.empty()) info.showtitle = value;
                else if (name == "plot" && info.plot.empty()) info.plot = value;
                else if (name == "outline" && outline.empty()) outline = value;
                else if (name == "year" && info.year == 0) info.year = yearFrom(value);
                else if ((name == "premiered" || name == "releasedate") && premiered.empty()) premiered = value;
                else if (name == "season" && info.season == 0) info.season = leadingInt(value);
                else if (name == "episode" && info.episode == 0) info.episode = leadingInt(value);
                continue;                                    // the whole element was consumed
            }
        }
        if (!selfClosing) ++depth;
        i = gt + 1;
    }

    if (!info.ok) return Info();
    if (info.plot.empty()) info.plot = outline;
    if (info.year == 0) info.year = yearFrom(premiered);
    if (info.title.empty()) info.title = info.originaltitle;
    return info;
}

}  // namespace nfo

#endif
