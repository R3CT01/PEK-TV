// NFS backend on libnfs (https://github.com/sahlberg/libnfs). Compiled only
// when PEK_NFS is defined; vfs.cpp supplies "no NFS support" stand-ins
// otherwise. Everything that touches libnfs lives in this file.
#ifdef PEK_NFS

#include "vfs.h"
#include "vfs_backends.h"

#include <fcntl.h>
#include <cstring>
#include <iostream>

extern "C" {
#include <nfsc/libnfs.h>
#include <nfsc/libnfs-raw.h>
#include <nfsc/libnfs-raw-mount.h>
}

namespace vfs {
namespace {

// NFSv3 file types (RFC 1813), matching libnfs's ftype3 enum.
constexpr uint32_t kNf3Dir = 2;
constexpr uint32_t kNf3Lnk = 5;

class NfsShare : public Share {
public:
    explicit NfsShare(nfs_context* c) : ctx_(c) {}
    ~NfsShare() override {
        closeFile();
        if (ctx_) nfs_destroy_context(ctx_);
    }

    bool list(const std::string& path, std::vector<Entry>& out, Error& err) override {
        nfsdir* dir = nullptr;
        std::string p = "/" + path;
        if (nfs_opendir(ctx_, p.c_str(), &dir) != 0 || !dir) {
            err.auth = false;
            err.msg = nfs_get_error(ctx_) ? nfs_get_error(ctx_) : "Could not open folder";
            return false;
        }
        nfsdirent* ent;
        while ((ent = nfs_readdir(ctx_, dir)) != nullptr) {
            if (!ent->name) continue;
            if (std::strcmp(ent->name, ".") == 0 || std::strcmp(ent->name, "..") == 0) continue;
            if (ent->type == kNf3Lnk) continue;                      // avoid loops
            Entry e;
            e.name = ent->name;
            e.is_dir = ent->type == kNf3Dir;
            e.size = ent->size;
            e.mtime = static_cast<int64_t>(ent->mtime.tv_sec);
            out.push_back(std::move(e));
        }
        nfs_closedir(ctx_, dir);
        return true;
    }

    bool open(const std::string& path, Error& err) override {
        closeFile();
        std::string p = "/" + path;
        if (nfs_open(ctx_, p.c_str(), O_RDONLY, &fh_) != 0) {
            err.auth = false;
            err.msg = nfs_get_error(ctx_) ? nfs_get_error(ctx_) : "Could not open file";
            fh_ = nullptr;
            return false;
        }
        nfs_stat_64 st;
        std::memset(&st, 0, sizeof st);
        if (nfs_stat64(ctx_, p.c_str(), &st) != 0) { closeFile(); err.msg = "Could not read the file size"; return false; }
        size_ = st.nfs_size;
        return true;
    }

    uint64_t fileSize() override { return size_; }

    int64_t read(uint64_t offset, void* buf, size_t len) override {
        if (!fh_) return -1;
        if (len > 1024 * 1024) len = 1024 * 1024;
        int n = nfs_pread(ctx_, fh_, static_cast<char*>(buf), len, offset);
        return n < 0 ? -1 : n;
    }

private:
    void closeFile() { if (fh_) { nfs_close(ctx_, fh_); fh_ = nullptr; } }
    nfs_context* ctx_;
    nfsfh* fh_ = nullptr;
    uint64_t size_ = 0;
};

} // namespace

std::unique_ptr<Share> nfsConnect(const Url& u, Error& err) {
    nfs_context* ctx = nfs_init_context();
    if (!ctx) { err.auth = false; err.msg = "Out of memory"; return nullptr; }
    std::string exp = urlDecode(u.share);
    if (exp.empty() || exp[0] != '/') exp = "/" + exp;
    if (nfs_mount(ctx, u.host.c_str(), exp.c_str()) != 0) {
        const char* m = nfs_get_error(ctx);
        std::string msg = m ? m : "";
        err.auth = msg.find("ermission") != std::string::npos || msg.find("ACCES") != std::string::npos;
        err.msg = err.auth ? "This export does not allow this device" : (msg.empty() ? "Could not mount the NFS export" : msg);
        nfs_destroy_context(ctx);
        return nullptr;
    }
    return std::unique_ptr<Share>(new NfsShare(ctx));
}

bool nfsListShares(const Url& u, std::vector<std::string>& shares, Error& err) {
    exportnode* list = mount_getexports(u.host.c_str());
    if (!list) {
        err.auth = false;
        err.msg = "Could not list the NFS exports on " + u.host;
        return false;
    }
    for (exportnode* e = list; e; e = e->ex_next) {
        if (e->ex_dir) shares.push_back(e->ex_dir);
    }
    mount_free_export_list(list);
    return true;
}

} // namespace vfs

#endif // PEK_NFS
