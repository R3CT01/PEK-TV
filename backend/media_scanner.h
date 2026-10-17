#ifndef MEDIA_SCANNER_H
#define MEDIA_SCANNER_H

#include <string>
#include <vector>
#include <mutex>
#include <cstdint>
#include <functional>
#include <map>
#include <chrono>
#include <atomic>
#include <memory>
#include "vfs.h"

namespace pekdb { class Db; }

enum class MediaKind {
    Movie,
    Episode,
    Unclassified   // neither container tags nor the filename/folder
                    // fallback could identify it — shown under "Unknown".
};

struct MediaEntry {
    std::string id;          // stable hash of path
    std::string path;
    std::string filename;
    uint64_t size_bytes = 0;
    int64_t mtime = 0;

    MediaKind kind = MediaKind::Unclassified;

    // Movie fields
    std::string title;
    int year = 0;

    // Episode fields
    std::string show_title;
    int season = 0;
    int episode = 0;

    // Runtime only (not persisted): true when kind/title/show came from
    // the filename/folder fallback rather than embedded tags. Used to
    // decide which entries are worth confirming against TMDb.
    bool guessed = false;
};

// Classifies video files in layers, cheapest and most reliable first:
//   1. Metadata embedded in the container (via ffprobe) — show /
//      season_number / episode_sort tags, or a title tag for movies.
//   2. Folder structure and cleaned-up filename — "Show/Season 3/",
//      S03E04, 3x04, "Movie Name (1999)" — only for files the tags
//      couldn't identify.
//   3. Optional TMDb confirmation of a *guessed* show name (see
//      setShowResolver) so "friends" becomes the official "Friends".
// Anything still unidentified comes back Unclassified ("Unknown").
//
// Media source folders are user-chosen at runtime (via the folder
// picker UI backed by listSubdirectories()/addMediaDir()) rather
// than hardcoded — persisted to sources_file_path so they survive a
// restart.
class MediaScanner {
public:
    // cache_file_path is where the old tab-separated cache lived (media_cache.tsv). The library now lives in a SQLite
    // database named library.db in the same folder; an old cache file is imported once, then renamed *.migrated.
    MediaScanner(std::string sources_file_path, std::string cache_file_path);
    ~MediaScanner();

    // Loads both the source folder list and the classified-file
    // cache from disk. Call once at startup.
    void loadFromDisk();

    // Walks the current source folders, runs ffprobe on new/changed
    // video files (by size+mtime), classifies each via container
    // tags, and persists the result. Safe to call repeatedly —
    // unchanged files are skipped without re-invoking ffprobe.
    void scan();

    // Optional: maps a show name guessed from a filename/folder to the
    // official name (e.g. via TMDb). Return "" to keep the guess. Called
    // at most once per distinct guessed name per scan, on the scan thread,
    // so it may block on the network. The scanner itself stays network-free.
    using ShowResolver = std::function<std::string(const std::string&)>;
    void setShowResolver(ShowResolver resolver);

    // Called (on the scan thread, after the results are stored) at the end of every scan(). The music library uses it
    // to refresh itself; it must return quickly (start its own thread for anything slow).
    void setAfterScan(std::function<void()> callback);

    // --- Source folder management (the picker UI) ---
    // Validates the path is a real directory, adds it, and persists
    // the source list. Does NOT scan automatically — call scan()
    // afterward (typically in a background thread) if you want the
    // new folder picked up immediately.
    bool addMediaDir(const std::string& path);
    bool removeMediaDir(const std::string& path);
    std::vector<std::string> getMediaDirs();

    // Lists immediate subdirectories of dir_path, alphabetically,
    // skipping hidden (dotfile) folders — the data behind the
    // folder-picker screen. Returns false if dir_path doesn't exist
    // or isn't a directory.
    static bool listSubdirectories(const std::string& dir_path, std::vector<std::string>& out);

    // --- Results ---
    std::vector<MediaEntry> getMovies();
    std::vector<MediaEntry> getEpisodes();          // flat
    std::vector<MediaEntry> getUnclassified();      // the "Unknown" category
    bool findById(const std::string& id, MediaEntry& out);

    // --- What the user's own files say about a title (NFO plot + artwork next to the video) ---
    // Works for local folders and network sources (SMB, NFS, FTP, WebDAV, UPnP) alike. The detail screens and the
    // poster grid prefer these over a TMDb lookup; TMDb is only asked for whatever is still missing.
    //   NFO:      "<video>.nfo", "movie.nfo" (movie alone in its folder), "tvshow.nfo" (show folder)
    //   Movie art:   <video>-poster.jpg, <video>.jpg, then poster / folder / cover .jpg (movie alone in its folder)
    //   Show art:    poster / folder / cover / show .jpg in the show folder
    //   Episode art: <video>-thumb.jpg, <video>.jpg           (.jpg, .jpeg, .png and .webp are all accepted)
    // Results are remembered for a couple of minutes, and forgotten at every scan.
    struct Local {
        std::string title;   // the NFO <title>: the episode name for an episode, the show name for a show
        std::string plot;    // <plot>, or <outline> when there is no plot; "" = none
        std::string art;     // path or network URL of an image file; "" = none. Only ever read by readArtwork().
    };
    Local localMovie(const MediaEntry& entry);
    Local localEpisode(const std::string& show, int season, int episode);
    Local localShow(const std::string& show);
    // Reads the image named by Local::art (local or network). False = too big / unreadable.
    static bool readArtwork(const std::string& art, std::string& bytes, std::string& mime);

    // --- Searching and browsing the library (SQLite) ---
    // What the NFO files say (genre, actors, directors, studio, collection, rating) is read after every scan and kept in
    // the database, so a search by actor, genre, year ... is one indexed query instead of a pass over every title.
    // Only titles with an NFO have those fields; the year and the title always work.
    struct SearchQuery {
        std::string type = "movies";       // "movies" or "shows"
        std::string q;                     // free text: every word must match a title, year, genre, actor, director, studio or collection
        std::string genre, actor, director, studio, collection;   // exact (case and accent insensitive) filters
        int year = 0;                      // exactly this year
        int decade = 0;                    // 1990 = 1990..1999
        std::string sort = "title";        // title | year | added | rating
        int limit = 500;
        int offset = 0;
    };
    // {"total":N,"movies":["<id>",...]}  or  {"total":N,"shows":["<show title>",...]}
    std::string searchJson(const SearchQuery& query);
    // {"indexing":{"done":a,"total":b},"genres":[{"name","count"}],"decades":[{"decade","count"}],
    //  "actors":[...],"directors":[...],"studios":[...]}   actorPrefix narrows the actor list (the picker's own search box).
    std::string facetsJson(const std::string& type, const std::string& actorPrefix, int limit);

private:
    std::string sources_file_path_;
    std::string cache_file_path_;
    std::vector<std::string> media_dirs_;
    std::vector<MediaEntry> entries_;
    std::mutex mutex_;
    ShowResolver show_resolver_;
    std::function<void()> after_scan_;
    std::map<std::string, std::string> resolved_names_;   // lowercase guess -> official name ("" = no match); only touched under scan_mutex_
    std::mutex local_mutex_;
    std::map<std::string, std::pair<std::chrono::steady_clock::time_point, Local>> local_cache_;   // "m:<id>" / "e:<show>|s|e" / "s:<show>"
    Local cachedLocal(const std::string& key, const std::function<Local()>& make);
    std::mutex scan_mutex_;   // serializes scan() so overlapping scans (startup + POST /api/sources + /api/rescan) can't race on the cache file

    bool dirHasNomedia(const std::string& dir_path);
    bool isVideoFile(const std::string& extension);
    void scanDirectory(const std::string& dir_path, std::vector<MediaEntry>& found);

    // Network (smb://) sources. Returns false only when the share could not be
    // reached at all, so scan() can keep the old entries instead of wiping them
    // while a NAS is switched off. Files are classified from their names/folders
    // only (ffprobe can't open smb:// URLs).
    bool scanRemote(const std::string& root_url, std::vector<MediaEntry>& found);
    bool scanRemoteDir(vfs::Share& share, const vfs::Url& base, const std::string& rel,
                       std::vector<MediaEntry>& found, int depth);

    // Runs `ffprobe -show_format -print_format json` on the file and
    // fills in kind/title/year/show_title/season/episode from
    // whatever tags are present. Leaves kind == Unclassified if the
    // needed tags aren't there.
    static void probeAndClassify(MediaEntry& entry);

    // Fallback for files the tags couldn't identify (or tagged only with a
    // bare title but named like an episode): parses the filename and the
    // parent folders. media_roots are the user's source folders, never
    // treated as a show name. Sets entry.guessed on success.
    static void classifyFromFilename(MediaEntry& entry, const std::vector<std::string>& media_roots);

    static std::string makeId(const std::string& path);
    void persistSourcesToDisk();

    // ---- the library database (library.db) ----
    std::unique_ptr<pekdb::Db> db_;            // null = could not be opened: the app still works, it just rescans at every start
    std::string db_path_;
    std::atomic<int> index_done_{0}, index_total_{0};
    void openDb();                             // opens, creates the tables, imports an old media_cache.tsv once
    void persistToDb();                        // brings the media table in line with entries_ (one transaction)
    void indexMetadata();                      // reads NFO genres / people for titles that are new or whose NFO changed
};

#endif
