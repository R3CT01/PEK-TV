// Dev test: g++ -std=c++17 music_test.cpp music_tags.cpp -o music_test && ./music_test song.mp3 song.flac ...
#include "music_tags.h"
#include <cstdio>
#include <fstream>
#include <iostream>

struct FileReader : musictags::Reader {
    std::ifstream f; uint64_t sz = 0;
    explicit FileReader(const std::string& p) : f(p, std::ios::binary) { f.seekg(0, std::ios::end); sz = (uint64_t)f.tellg(); }
    uint64_t size() override { return sz; }
    int64_t read(uint64_t off, void* buf, size_t len) override {
        if (off >= sz) return 0;
        f.clear(); f.seekg((std::streamoff)off);
        f.read((char*)buf, (std::streamsize)len);
        return f.gcount();
    }
};

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        std::string p = argv[i];
        std::string ext = p.substr(p.rfind('.'));
        FileReader r(p);
        musictags::Tags t;
        bool ok = musictags::readTags(r, ext, t);
        musictags::Picture pic;
        bool cov = musictags::readCover(r, ext, pic);
        std::cout << p << "  ok=" << ok << "\n  title=[" << t.title << "] artist=[" << t.artist << "] albumArtist=[" << t.albumArtist
                  << "] album=[" << t.album << "] genre=[" << t.genre << "]\n  track=" << t.track << " disc=" << t.disc << " year=" << t.year
                  << " dur=" << t.duration << " hasArt=" << t.hasArt << " cover=" << cov << " (" << pic.mime << ", " << pic.data.size() << " bytes)\n";
    }
}
