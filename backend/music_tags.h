#ifndef MUSIC_TAGS_H
#define MUSIC_TAGS_H

#include <cstdint>
#include <string>

// Reads song tags (title, artist, album ...) and the embedded cover picture straight from the bytes of an audio
// file. No ffprobe needed, so it works on Android and on network shares (SMB, NFS, FTP, WebDAV): the only thing
// it asks for is "give me N bytes at this offset".
//
// Supported: MP3 (ID3v2.2 / 2.3 / 2.4, ID3v1), FLAC, Ogg Vorbis / Opus, M4A / M4B (AAC, ALAC).
// Other audio types (WAV, WMA, APE ...) simply get no tags; the scanner falls back to folder and file names.
namespace musictags {

class Reader {
public:
    virtual ~Reader() {}
    virtual uint64_t size() = 0;
    // Bytes read (0 = end of file), or -1 on error. Random access.
    virtual int64_t read(uint64_t offset, void* buf, size_t len) = 0;
};

struct Tags {
    std::string title, artist, albumArtist, album, genre;
    int track = 0, disc = 0, year = 0;
    double duration = 0;      // seconds, 0 = unknown
    bool hasArt = false;      // the file carries its own cover picture
};

struct Picture {
    std::string mime;         // "image/jpeg", "image/png" ...
    std::string data;
};

// ext: lowercase extension with the dot (".mp3"). Returns false when the format is not understood at all.
bool readTags(Reader& r, const std::string& ext, Tags& out);
// The embedded cover. False = none.
bool readCover(Reader& r, const std::string& ext, Picture& out);

// True for the file types the music scanner picks up.
bool isAudioExtension(const std::string& lowerExt);

} // namespace musictags

#endif
