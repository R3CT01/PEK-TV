#include "torrent.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <regex>
#include <system_error>

namespace fs = std::filesystem;

namespace torrent {
namespace {

std::string g_dir = ".";

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
    return s;
}

std::string baseName(const std::string& p) {
    size_t i = p.find_last_of("/\\");
    return i == std::string::npos ? p : p.substr(i + 1);
}

bool isVideoName(const std::string& name) {
    std::string ext = lower(fs::path(name).extension().string());
    return ext == ".mkv" || ext == ".mp4" || ext == ".m4v" || ext == ".avi" || ext == ".mov" ||
           ext == ".webm" || ext == ".ts" || ext == ".wmv" || ext == ".mpg" || ext == ".mpeg";
}

// MP4-style containers keep their index at the end, so the tail has to be there before play.
bool needsTail(const std::string& name) {
    std::string ext = lower(fs::path(name).extension().string());
    return ext == ".mp4" || ext == ".m4v" || ext == ".mov";
}

// Picks the file to play: the episode that matches S/E when given (season packs), else the
// biggest video file.
int pickFile(const std::vector<FileInfo>& files, int season, int episode) {
    int best = -1;
    auto better = [&](int i) { return best < 0 || files[i].size > files[best].size; };

    if (season > 0 && episode > 0) {
        std::string S = std::to_string(season), E = std::to_string(episode);
        std::regex a("(^|[^0-9])s0*" + S + "[ ._-]?e0*" + E + "([^0-9]|$)");
        std::regex b("(^|[^0-9])0*" + S + "x0*" + E + "([^0-9]|$)");
        for (const auto& f : files) {
            if (!f.video) continue;
            std::string n = lower(baseName(f.path));
            if ((std::regex_search(n, a) || std::regex_search(n, b)) && better(f.index)) best = f.index;
        }
        if (best >= 0) return best;
    }
    for (const auto& f : files) {
        if (!f.video) continue;
        std::string n = lower(baseName(f.path));
        if (n.find("sample") != std::string::npos && f.size < 300ull * 1024 * 1024) continue;
        if (better(f.index)) best = f.index;
    }
    if (best >= 0) return best;
    for (const auto& f : files) if (better(f.index)) best = f.index;   // no video at all: biggest file
    return best;
}

}  // namespace

void setDataDir(const std::string& dir) { g_dir = dir.empty() ? "." : dir; }

}  // namespace torrent

#ifndef PEK_TORRENT
// ------------------------------------------------------------------------------------------
// Built without libtorrent: everything reports "not available".
// ------------------------------------------------------------------------------------------
namespace torrent {
bool available() { return false; }
std::string add(const std::string&, int, int, std::string& err) { err = "Torrent support is not built into this PEK TV"; return ""; }
std::string addFile(const std::string&, int, int, std::string& err) { err = "Torrent support is not built into this PEK TV"; return ""; }
bool status(const std::string&, Status&, bool) { return false; }
int64_t read(const std::string&, uint64_t, void*, size_t, bool (*)(void*), void*) { return -1; }
void remove(const std::string&) {}
void removeAll() {}
void warmUp() {}
}  // namespace torrent

#else
// ------------------------------------------------------------------------------------------
// libtorrent-rasterbar (2.x) implementation
// ------------------------------------------------------------------------------------------
#include <condition_variable>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/magnet_uri.hpp>
#if __has_include(<libtorrent/pwrite_disk_io.hpp>)
#include <libtorrent/pwrite_disk_io.hpp>
#define PEK_PLAIN_DISK_IO lt::pwrite_disk_io_constructor
#elif __has_include(<libtorrent/posix_disk_io.hpp>)
#include <libtorrent/posix_disk_io.hpp>
#define PEK_PLAIN_DISK_IO lt::posix_disk_io_constructor
#endif
#include <libtorrent/session_params.hpp>
#include <libtorrent/session.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/torrent_status.hpp>

namespace lt = libtorrent;

namespace torrent {
namespace {

using Clock = std::chrono::steady_clock;

const uint64_t kStartBuffer   = 6ull * 1024 * 1024;   // bytes that must be in place before "ready"
const uint64_t kLookaheadBytes = 48ull * 1024 * 1024; // how far ahead of the player pieces are scheduled (about a minute of 1080p)
const int      kMaxTorrents   = 2;                    // older ones are removed (and their data deleted)
const auto     kIdleLimit     = std::chrono::minutes(60);
const auto     kMetaTimeout   = std::chrono::seconds(90);
const auto     kStallTimeout  = std::chrono::seconds(60);

struct Entry {
    lt::torrent_handle h;
    std::string hash;
    int season = 0, episode = 0;
    bool have_meta = false;
    std::string name, err;
    std::vector<FileInfo> files;
    int file_index = -1;
    uint64_t file_size = 0, file_offset = 0;
    int piece_len = 0;
    int first_piece = 0, last_piece = 0, num_pieces = 0;
    bool tail_needed = false;
    int lookahead = 24;                 // pieces scheduled ahead of the player (kLookaheadBytes / piece size)
    uint64_t last_end = 0;
    int aimed_piece = -1;               // where the non-urgent download currently continues from (-1 = from the start)
    Clock::time_point last_access = Clock::now();
    std::map<int, std::shared_ptr<std::vector<char>>> cache;   // downloaded pieces we have read back
    std::deque<int> cache_order;
    std::map<int, Clock::time_point> reading;                   // read_piece() issued (when), answer pending
    std::deque<uint64_t> recent_ends;                           // where the last few reads ended (mpv reads from 2+ places)
    int dl_p0 = -1;                                             // piece the lookahead deadlines were last set from
    Clock::time_point last_peer = Clock::now();                 // last time at least one peer was connected
    Clock::time_point last_kick{};                              // last forced re-announce (watchdog)
    int kicks = 0;
};

std::mutex g_mx;
std::condition_variable g_cv;
std::map<std::string, std::shared_ptr<Entry>> g_entries;
std::unique_ptr<lt::session> g_ses;
std::thread g_alerts;
bool g_stop = false;

std::string toHex(const lt::sha1_hash& h) {
    std::ostringstream ss;
    ss << h;
    return lower(ss.str());
}

// Called with g_mx held, once metadata is known.
void selectFile(Entry& e) {
    std::shared_ptr<const lt::torrent_info> ti = e.h.torrent_file();
    if (!ti) return;
    const lt::file_storage& fst = ti->files();
    e.files.clear();
    for (int i = 0; i < fst.num_files(); i++) {
        FileInfo f;
        f.index = i;
        f.path = fst.file_path(lt::file_index_t(i));
        f.size = static_cast<uint64_t>(fst.file_size(lt::file_index_t(i)));
        f.video = isVideoName(f.path);
        e.files.push_back(f);
    }
    e.name = ti->name();
    int idx = pickFile(e.files, e.season, e.episode);
    if (idx < 0) { e.err = "This torrent has no files"; return; }

    std::vector<lt::download_priority_t> prios(static_cast<size_t>(fst.num_files()), lt::dont_download);
    prios[static_cast<size_t>(idx)] = lt::default_priority;
    e.h.prioritize_files(prios);

    e.file_index  = idx;
    e.file_size   = e.files[static_cast<size_t>(idx)].size;
    e.file_offset = static_cast<uint64_t>(fst.file_offset(lt::file_index_t(idx)));
    e.piece_len   = ti->piece_length();
    e.num_pieces  = ti->num_pieces();
    e.first_piece = static_cast<int>(e.file_offset / static_cast<uint64_t>(e.piece_len));
    e.last_piece  = static_cast<int>((e.file_offset + (e.file_size ? e.file_size - 1 : 0)) / static_cast<uint64_t>(e.piece_len));
    e.tail_needed = needsTail(e.files[static_cast<size_t>(idx)].path);
    e.last_end = 0;
    e.recent_ends.clear();
    e.dl_p0 = -1;
    e.aimed_piece = -1;
    // By bytes, not by pieces: with 16 MB pieces 40 of them would spread the bandwidth over 640 MB at once
    // and the piece the player needs next would arrive late.
    e.lookahead = static_cast<int>(std::max<uint64_t>(4, std::min<uint64_t>(48, kLookaheadBytes / static_cast<uint64_t>(e.piece_len))));

    // Start-up: the beginning first, then the end (container index), both ahead of the rest.
    e.h.clear_piece_deadlines();
    int headPcs = static_cast<int>(std::min<uint64_t>(kStartBuffer / static_cast<uint64_t>(e.piece_len) + 2, 24));
    for (int k = 0; k < headPcs && e.first_piece + k <= e.last_piece; k++)
        e.h.set_piece_deadline(lt::piece_index_t(e.first_piece + k), 100 + k * 150);
    for (int k = 0; k < 2 && e.last_piece - k > e.first_piece + headPcs; k++)
        e.h.set_piece_deadline(lt::piece_index_t(e.last_piece - k), 1500 + k * 300);
    e.have_meta = true;
}

// Bounded by bytes, not by count: with 8-16 MB pieces a count of 8 meant up to 128 MB of native heap
// (plus a transient second copy in read_piece), which on a TV with 1-2 GB of RAM gets the app killed.
const uint64_t kCacheBytes = 24ull * 1024 * 1024;
const size_t   kCacheMax   = 6;
void trimCache(Entry& e) {
    uint64_t total = 0;
    for (auto& kv : e.cache) total += kv.second ? kv.second->size() : 0;
    while (e.cache_order.size() > 1 && (e.cache_order.size() > kCacheMax || total > kCacheBytes)) {
        auto it = e.cache.find(e.cache_order.front());
        if (it != e.cache.end()) { total -= it->second ? it->second->size() : 0; e.cache.erase(it); }
        e.cache_order.pop_front();
    }
}

void dropLocked(const std::string& hash) {
    auto it = g_entries.find(hash);
    if (it == g_entries.end()) return;
    if (g_ses && it->second->h.is_valid()) g_ses->remove_torrent(it->second->h, lt::session::delete_files);
    g_entries.erase(it);
}

// Public trackers added to every torrent on top of the ones in the link (search results usually carry 3).
// More trackers = more chances to get peers back once the first ones have gone quiet.
const char* const kFallbackTrackers[] = {
    "udp://tracker.opentrackr.org:1337/announce", "udp://open.tracker.cl:1337/announce",
    "udp://tracker.torrent.eu.org:451/announce",  "udp://open.stealth.si:80/announce",
    "udp://exodus.desync.com:6969/announce",      "udp://tracker.tiny-vps.com:6969/announce",
    "udp://explodie.org:6969/announce",           "udp://tracker.dler.org:6969/announce",
    "udp://opentracker.io:6969/announce",         "udp://tracker.moeking.me:6969/announce",
};

// Peer watchdog (g_mx held). libtorrent only re-announces on its own every 30+ minutes and its peer list
// shrinks as peers drop; once it reaches 0 nothing brings peers back. So: when a running torrent has had no
// peers for a while, ask the trackers and the DHT again (after 6 s, then every 12 s, and re-add the fallback trackers).
void peerWatchdog(Entry& e, Clock::time_point now) {
    if (!e.h.is_valid()) return;
    lt::torrent_status st = e.h.status();
    if (st.is_finished) return;
    if (st.num_peers > 0) { e.last_peer = now; e.kicks = 0; return; }
    if (now - e.last_peer < std::chrono::seconds(6)) return;
    if (e.last_kick != Clock::time_point{} && now - e.last_kick < std::chrono::seconds(12)) return;
    e.last_kick = now;
    e.kicks++;
    try {
        if (e.kicks % 3 == 1) {
            for (const char* t : kFallbackTrackers) e.h.add_tracker(lt::announce_entry(t));
        }
        e.h.force_reannounce();
        e.h.force_dht_announce();
        e.h.resume();   // no-op unless something paused it
    } catch (const std::exception&) {}
}

void alertLoop() {
    std::vector<lt::alert*> alerts;
    auto lastSweep = Clock::now();
    auto lastWatch = Clock::now();
    for (;;) {
        {
            std::lock_guard<std::mutex> lk(g_mx);
            if (g_stop) return;
        }
        if (!g_ses) return;
        g_ses->wait_for_alert(std::chrono::milliseconds(500));
        alerts.clear();
        g_ses->pop_alerts(&alerts);

        std::lock_guard<std::mutex> lk(g_mx);
        for (lt::alert* a : alerts) {
            if (auto* m = lt::alert_cast<lt::metadata_received_alert>(a)) {
                for (auto& kv : g_entries) if (kv.second->h == m->handle) selectFile(*kv.second);
            } else if (auto* r = lt::alert_cast<lt::read_piece_alert>(a)) {
                for (auto& kv : g_entries) {
                    Entry& e = *kv.second;
                    if (!(e.h == r->handle)) continue;
                    int p = static_cast<int>(r->piece);
                    e.reading.erase(p);
                    if (!r->error && r->size > 0) {
                        if (e.cache.find(p) == e.cache.end()) e.cache_order.push_back(p);
                        e.cache[p] = std::make_shared<std::vector<char>>(r->buffer.get(), r->buffer.get() + r->size);
                        trimCache(e);
                    }
                }
            } else if (auto* t = lt::alert_cast<lt::torrent_error_alert>(a)) {
                for (auto& kv : g_entries) if (kv.second->h == t->handle) kv.second->err = t->error.message();
            }
        }
        // Drop torrents nobody has touched for a long time.
        auto now = Clock::now();
        if (now - lastWatch > std::chrono::seconds(5)) {
            lastWatch = now;
            for (auto& kv : g_entries) peerWatchdog(*kv.second, now);
        }
        if (now - lastSweep > std::chrono::seconds(30)) {
            lastSweep = now;
            std::vector<std::string> old;
            for (auto& kv : g_entries) if (now - kv.second->last_access > kIdleLimit) old.push_back(kv.first);
            for (auto& h : old) dropLocked(h);
        }
        g_cv.notify_all();
    }
}

void ensureSession() {   // g_mx held
    if (g_ses) return;
    std::error_code ec;
    fs::remove_all(fs::path(g_dir) / "torrent_cache", ec);   // leftovers from a previous run
    fs::create_directories(fs::path(g_dir) / "torrent_cache", ec);

    lt::settings_pack sp;
    sp.set_str(lt::settings_pack::user_agent, "PEK/1.0");
    sp.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:6881,[::]:6881");
    // piece_progress: a finished piece wakes the reader at once instead of at its next poll.
    sp.set_int(lt::settings_pack::alert_mask, lt::alert_category::status | lt::alert_category::error | lt::alert_category::storage |
                                              lt::alert_category::piece_progress);
    // Memory: this runs next to a WebView and mpv on devices with 1-2 GB of RAM.
    sp.set_int(lt::settings_pack::connections_limit, 60);
    sp.set_int(lt::settings_pack::max_queued_disk_bytes, 4 * 1024 * 1024);
    sp.set_int(lt::settings_pack::send_buffer_watermark, 256 * 1024);
    // Find peers sooner and give up on dead / silent ones sooner: all of it is time spent staring at "Buffering".
    sp.set_bool(lt::settings_pack::announce_to_all_trackers, true);
    sp.set_bool(lt::settings_pack::announce_to_all_tiers, true);
    // Not too aggressive: a TV on Wi-Fi often answers slowly for a moment, and every timeout counts as a failure
    // against that peer. Peers that fail max_failcount times are forgotten for good, so the list slowly empties.
    sp.set_int(lt::settings_pack::peer_connect_timeout, 15);
    sp.set_int(lt::settings_pack::request_timeout, 30);
    sp.set_int(lt::settings_pack::piece_timeout, 20);
    sp.set_int(lt::settings_pack::max_failcount, 8);
    sp.set_int(lt::settings_pack::min_reconnect_time, 20);
    sp.set_bool(lt::settings_pack::enable_upnp, true);
    sp.set_bool(lt::settings_pack::enable_natpmp, true);
    lt::session_params params(sp);
#ifdef PEK_PLAIN_DISK_IO
    // libtorrent 2.x memory-maps the files by default. On a 32-bit process (armeabi-v7a TVs / sticks) mapping
    // multi-GB video files runs out of address space; plain pread/pwrite does not have that problem.
    if (sizeof(void*) == 4) params.disk_io_constructor = PEK_PLAIN_DISK_IO;
#endif
    g_ses.reset(new lt::session(std::move(params)));
    g_stop = false;
    g_alerts = std::thread(alertLoop);
    std::atexit([]() { removeAll(); });
}

// Adds (or finds) the torrent for p. g_mx must NOT be held.
std::string addParams(lt::add_torrent_params p, int season, int episode, std::string& err) {
    std::lock_guard<std::mutex> lk(g_mx);
    ensureSession();

    std::string hash = toHex(p.info_hashes.get_best());
    auto it = g_entries.find(hash);
    if (it != g_entries.end()) {                       // already running: just re-aim it
        Entry& e = *it->second;
        e.last_access = Clock::now();
        if (e.season != season || e.episode != episode) {
            e.season = season; e.episode = episode;
            e.cache.clear(); e.cache_order.clear();
            if (e.have_meta) selectFile(e);
        }
        return hash;
    }

    // Keep the cache small: only the newest few torrents stay.
    while (static_cast<int>(g_entries.size()) >= kMaxTorrents) {
        auto oldest = g_entries.begin();
        for (auto i = g_entries.begin(); i != g_entries.end(); ++i)
            if (i->second->last_access < oldest->second->last_access) oldest = i;
        dropLocked(oldest->first);
    }

    for (const char* t : kFallbackTrackers)
        if (std::find(p.trackers.begin(), p.trackers.end(), std::string(t)) == p.trackers.end()) p.trackers.push_back(t);
    p.save_path = (fs::path(g_dir) / "torrent_cache" / hash).string();
    p.flags |= lt::torrent_flags::sequential_download;
    p.flags &= ~(lt::torrent_flags::auto_managed | lt::torrent_flags::paused);

    lt::error_code ec;
    lt::torrent_handle h = g_ses->add_torrent(std::move(p), ec);
    if (ec || !h.is_valid()) { err = ec ? ec.message() : "Could not start the torrent"; return ""; }

    auto e = std::make_shared<Entry>();
    e->h = h; e->hash = hash; e->season = season; e->episode = episode;
    g_entries[hash] = e;
    if (h.torrent_file()) selectFile(*e);               // .torrent files already carry the file list
    return hash;
}

std::shared_ptr<Entry> find(const std::string& hash) {
    std::lock_guard<std::mutex> lk(g_mx);
    auto it = g_entries.find(hash);
    return it == g_entries.end() ? nullptr : it->second;
}

// Waits for one piece and returns its bytes (nullptr on timeout / error / abort).
std::shared_ptr<std::vector<char>> getPiece(Entry& e, int piece, bool (*aborted)(void*), void* ctx) {
    auto lastProgress = Clock::now();
    int lastHave = -1;
    Clock::time_point readSince{};
    std::unique_lock<std::mutex> lk(g_mx);
    for (;;) {
        // The torrent was removed (stop / evicted for a newer one / idle sweep) while the player was still reading.
        if (!e.h.is_valid()) return nullptr;
        try {
        auto c = e.cache.find(piece);
        if (c != e.cache.end()) return c->second;
        if (!e.err.empty()) return nullptr;
        if (e.h.have_piece(lt::piece_index_t(piece))) {
            const auto nowT = Clock::now();
            if (readSince == Clock::time_point{}) readSince = nowT;
            else if (nowT - readSince > std::chrono::seconds(20)) return nullptr;   // never read back: fail, do not hang
            auto rit = e.reading.find(piece);
            // Issue the read, and issue it again if the answer was lost or failed (not on every 100 ms turn).
            if (rit == e.reading.end() || nowT - rit->second > std::chrono::seconds(3)) {
                e.reading[piece] = nowT;
                e.h.read_piece(lt::piece_index_t(piece));
            }
            lastProgress = nowT;
        } else {
            lt::torrent_status st = e.h.status();            // no piece bitfield needed: just the count
            int have = st.num_pieces;
            if (have != lastHave) { lastHave = have; lastProgress = Clock::now(); }
        }
        if (Clock::now() - lastProgress > kStallTimeout) return nullptr;
        if (aborted && aborted(ctx)) return nullptr;
        } catch (const std::exception&) { return nullptr; }
        g_cv.wait_for(lk, std::chrono::milliseconds(100));
    }
}

}  // namespace

bool available() { return true; }

// Starts the session (DHT, listening sockets) ahead of the first stream, so peers are already being
// found while the viewer is still picking / searching.
void warmUp() {
    std::lock_guard<std::mutex> lk(g_mx);
    ensureSession();
}

std::string add(const std::string& source, int season, int episode, std::string& err) {
    lt::error_code ec;
    lt::add_torrent_params p = lt::parse_magnet_uri(source, ec);
    if (ec) { err = "Not a valid magnet link"; return ""; }
    return addParams(std::move(p), season, episode, err);
}

std::string addFile(const std::string& bytes, int season, int episode, std::string& err) {
    lt::error_code ec;
    lt::add_torrent_params p;
    // libtorrent 2.x: the buffer constructor is tagged with from_span_t.
    p.ti = std::make_shared<lt::torrent_info>(
        lt::span<char const>(bytes.data(), static_cast<std::ptrdiff_t>(bytes.size())), ec, lt::from_span_t());
    if (ec) { err = "Not a valid .torrent file"; return ""; }
    return addParams(std::move(p), season, episode, err);
}

bool status(const std::string& hash, Status& out, bool withMap) {
    std::shared_ptr<Entry> e = find(hash);
    if (!e || !e->h.is_valid()) return false;
    lt::torrent_status st = withMap ? e->h.status(lt::torrent_handle::query_pieces) : e->h.status();

    std::lock_guard<std::mutex> lk(g_mx);
    e->last_access = Clock::now();
    out = Status();
    out.name = e->name;
    out.peers = st.num_peers;
    out.seeds = st.num_seeds;
    out.down_kbps = st.download_payload_rate / 1024;
    out.up_kbps = st.upload_payload_rate / 1024;
    out.files = e->files;
    if (!e->err.empty()) { out.state = "error"; out.error = e->err; return true; }
    if (!e->have_meta) { out.state = "metadata"; return true; }

    out.file_index = e->file_index;
    out.file_size = e->file_size;
    out.file_name = baseName(e->files[static_cast<size_t>(e->file_index)].path);

    std::vector<int64_t> fp = e->h.file_progress(lt::torrent_handle::piece_granularity);
    if (e->file_size && static_cast<size_t>(e->file_index) < fp.size())
        out.file_progress = std::min(1.0, static_cast<double>(fp[static_cast<size_t>(e->file_index)]) / static_cast<double>(e->file_size));

    // Start-up buffer: contiguous pieces from the beginning (and the end for MP4-style files).
    uint64_t need = std::min<uint64_t>(kStartBuffer, e->file_size);
    int needPcs = static_cast<int>((need + static_cast<uint64_t>(e->piece_len) - 1) / static_cast<uint64_t>(e->piece_len));
    needPcs = std::max(1, std::min(needPcs, e->last_piece - e->first_piece + 1));
    int have = 0;
    while (have < needPcs && e->h.have_piece(lt::piece_index_t(e->first_piece + have))) have++;
    bool tailOk = !e->tail_needed || e->h.have_piece(lt::piece_index_t(e->last_piece));
    out.buffer_progress = static_cast<double>(have) / needPcs;
    out.ready = (have >= needPcs) && tailOk;
    out.state = out.ready ? "ready" : "buffering";

    if (withMap && st.pieces.size() > 0) {
        const int cnt = e->last_piece - e->first_piece + 1;
        if (cnt > 0) {
            const int slices = std::min(100, cnt);
            out.have_map.assign(static_cast<size_t>(slices), 0);
            for (int b = 0; b < slices; b++) {
                const int p0 = e->first_piece + static_cast<int>(static_cast<int64_t>(b) * cnt / slices);
                const int p1 = e->first_piece + static_cast<int>(static_cast<int64_t>(b + 1) * cnt / slices);
                int got = 0;
                for (int p = p0; p < p1; p++)
                    if (p < static_cast<int>(st.pieces.size()) && st.pieces.get_bit(lt::piece_index_t(p))) got++;
                out.have_map[static_cast<size_t>(b)] = static_cast<unsigned char>(p1 > p0 ? 100 * got / (p1 - p0) : 0);
            }
        }
    }
    return true;
}

int64_t read(const std::string& hash, uint64_t offset, void* buf, size_t len,
             bool (*aborted)(void*), void* ctx) {
    std::shared_ptr<Entry> e = find(hash);
    if (!e) return -1;

    // Wait for the file list (magnet links need to fetch it from peers first).
    auto t0 = Clock::now();
    for (;;) {
        std::unique_lock<std::mutex> lk(g_mx);
        if (!e->err.empty()) return -1;
        if (e->have_meta) break;
        if (Clock::now() - t0 > kMetaTimeout || (aborted && aborted(ctx))) return -1;
        g_cv.wait_for(lk, std::chrono::milliseconds(200));
    }

    if (offset >= e->file_size) return 0;
    len = static_cast<size_t>(std::min<uint64_t>(len, e->file_size - offset));

    {   // Aim the downloader at where the player is reading.
        std::lock_guard<std::mutex> lk(g_mx);
        if (!e->h.is_valid()) return -1;
        try {
        e->last_access = Clock::now();
        // A jump is a read far from ALL recent read positions. mpv reads from more than one place at once
        // (index at the end, audio and video far apart); comparing with the last read only made every such
        // read look like a seek: deadlines cleared and the whole torrent re-prioritised again and again.
        bool nearRecent = false;
        for (uint64_t end : e->recent_ends)
            if (offset + 8ull * 1024 * 1024 >= end && offset <= end + 4ull * 1024 * 1024) { nearRecent = true; break; }
        bool jumped = e->recent_ends.empty() ? offset > 4ull * 1024 * 1024 : !nearRecent;
        int p0 = static_cast<int>((e->file_offset + offset) / static_cast<uint64_t>(e->piece_len));
        if (jumped) {
            e->h.clear_piece_deadlines();
            // Seek: from here on the rest of the download continues from the new spot. Without this the
            // sequential downloader would first fill the gap that was skipped over, then carry on.
            if (e->num_pieces > 0 && p0 != e->aimed_piece) {
                std::vector<lt::download_priority_t> pr(static_cast<size_t>(e->num_pieces), lt::dont_download);
                for (int i = e->first_piece; i <= e->last_piece && i < e->num_pieces; i++)
                    pr[static_cast<size_t>(i)] = i < p0 ? lt::low_priority : lt::default_priority;
                e->h.prioritize_pieces(pr);
                e->aimed_piece = p0;
            }
        }
        // Each of these is a synchronous call into libtorrent's network thread: once per piece, not once per 256 KB read.
        if (jumped || p0 != e->dl_p0) {
            e->dl_p0 = p0;
            for (int k = 0; k < e->lookahead && p0 + k <= e->last_piece; k++) {
                lt::piece_index_t pi(p0 + k);
                if (!e->h.have_piece(pi)) e->h.set_piece_deadline(pi, 50 + k * 120);
            }
        }
        } catch (const std::exception&) { return -1; }
    }

    size_t done = 0;
    char* out = static_cast<char*>(buf);
    while (done < len) {
        uint64_t abs = e->file_offset + offset + done;
        int piece = static_cast<int>(abs / static_cast<uint64_t>(e->piece_len));
        size_t within = static_cast<size_t>(abs % static_cast<uint64_t>(e->piece_len));
        std::shared_ptr<std::vector<char>> data = getPiece(*e, piece, aborted, ctx);
        if (!data || within >= data->size()) break;
        size_t n = std::min(len - done, data->size() - within);
        std::memcpy(out + done, data->data() + within, n);
        done += n;
    }
    if (done == 0) return -1;
    {
        std::lock_guard<std::mutex> lk(g_mx);
        e->last_end = offset + done;
        const uint64_t endp = offset + done;
        bool merged = false;
        for (auto& end : e->recent_ends)
            if (offset + 8ull * 1024 * 1024 >= end && offset <= end + 4ull * 1024 * 1024) { end = endp; merged = true; break; }
        if (!merged) { e->recent_ends.push_back(endp); if (e->recent_ends.size() > 4) e->recent_ends.pop_front(); }
    }
    return static_cast<int64_t>(done);
}

void remove(const std::string& hash) {
    std::lock_guard<std::mutex> lk(g_mx);
    dropLocked(hash);
    g_cv.notify_all();
}

void removeAll() {
    std::thread t;
    {
        std::lock_guard<std::mutex> lk(g_mx);
        g_stop = true;
        std::vector<std::string> all;
        for (auto& kv : g_entries) all.push_back(kv.first);
        for (auto& h : all) dropLocked(h);
        t = std::move(g_alerts);
    }
    if (t.joinable()) t.join();
    std::lock_guard<std::mutex> lk(g_mx);
    g_ses.reset();
    std::error_code ec;
    fs::remove_all(fs::path(g_dir) / "torrent_cache", ec);
}

}  // namespace torrent
#endif
