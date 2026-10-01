#ifndef MEDIA_SCANNER_H
#define MEDIA_SCANNER_H

#include <string>
#include <vector>
#include <mutex>
#include <cstdint>
#include <functional>
#include <map>

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
    MediaScanner(std::string sources_file_path, std::string cache_file_path);

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

private:
    std::string sources_file_path_;
    std::string cache_file_path_;
    std::vector<std::string> media_dirs_;
    std::vector<MediaEntry> entries_;
    std::mutex mutex_;
    ShowResolver show_resolver_;
    std::map<std::string, std::string> resolved_names_;   // lowercase guess -> official name ("" = no match); only touched under scan_mutex_
    std::mutex scan_mutex_;   // serializes scan() so overlapping scans (startup + POST /api/sources + /api/rescan) can't race on the cache file

    bool dirHasNomedia(const std::string& dir_path);
    bool isVideoFile(const std::string& extension);
    void scanDirectory(const std::string& dir_path, std::vector<MediaEntry>& found);

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
    void persistCacheToDisk();
    void persistSourcesToDisk();
};

#endif
