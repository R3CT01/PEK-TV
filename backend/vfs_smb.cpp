// SMB backend, built on libsmb2 (https://github.com/sahlberg/libsmb2).
// Compiled only when PEK_SMB is defined; vfs.cpp supplies "no SMB support"
// stand-ins otherwise. Everything that touches libsmb2 lives in this one file.
#ifdef PEK_SMB

#include "vfs.h"
#include "vfs_backends.h"

#include <fcntl.h>
#include <poll.h>
#include <cerrno>
#include <cstring>
#include <iostream>

extern "C" {
#include <smb2/smb2.h>
#include <smb2/libsmb2.h>
#ifdef PEK_SMB_SHARE_ENUM
#include <smb2/libsmb2-dcerpc.h>
#include <smb2/libsmb2-dcerpc-srvsvc.h>
#endif
}

namespace vfs {

namespace {

constexpr int kTimeoutSeconds = 15;

bool looksLikeAuthFailure(int rc, const std::string& msg) {
    if (rc == -EACCES || rc == -EPERM) return true;
    return msg.find("LOGON") != std::string::npos ||
           msg.find("ACCESS_DENIED") != std::string::npos ||
           msg.find("PASSWORD") != std::string::npos;
}

// "DOMAIN\\user" or "user@domain" -> separate domain / user.
void splitUser(const std::string& full, std::string& user, std::string& domain) {
    size_t bs = full.find('\\');
    if (bs != std::string::npos) { domain = full.substr(0, bs); user = full.substr(bs + 1); return; }
    size_t at = full.find('@');
    if (at != std::string::npos) { user = full.substr(0, at); domain = full.substr(at + 1); return; }
    user = full;
    domain.clear();
}

smb2_context* openContext(const std::string& host, const std::string& share, Error& err) {
    smb2_context* ctx = smb2_init_context();
    if (!ctx) { err.auth = false; err.msg = "Out of memory"; return nullptr; }

    std::string rawUser, pass;
    if (!getCredentials("smb", host, rawUser, pass)) { rawUser.clear(); pass.clear(); }
    std::string user, domain;
    splitUser(rawUser, user, domain);
    if (user.empty()) user = "Guest";          // anonymous / guest access
    smb2_set_security_mode(ctx, SMB2_NEGOTIATE_SIGNING_ENABLED);
    smb2_set_timeout(ctx, kTimeoutSeconds);
    smb2_set_user(ctx, user.c_str());
    smb2_set_password(ctx, pass.c_str());
    if (!domain.empty()) smb2_set_domain(ctx, domain.c_str());

    int rc = smb2_connect_share(ctx, host.c_str(), share.c_str(), user.c_str());
    if (rc < 0) {
        std::string m = smb2_get_error(ctx);
        err.auth = looksLikeAuthFailure(rc, m);
        err.msg = err.auth ? "Wrong user name or password"
                           : (m.empty() ? std::string("Could not connect to ") + host : m);
        smb2_destroy_context(ctx);
        return nullptr;
    }
    return ctx;
}

class SmbShare : public Share {
public:
    explicit SmbShare(smb2_context* c) : ctx_(c) {}
    ~SmbShare() override {
        closeFile();
        if (ctx_) {
            smb2_disconnect_share(ctx_);
            smb2_destroy_context(ctx_);
        }
    }

    bool list(const std::string& path, std::vector<Entry>& out, Error& err) override {
        smb2dir* dir = smb2_opendir(ctx_, path.c_str());
        if (!dir) {
            std::string m = smb2_get_error(ctx_);
            err.auth = looksLikeAuthFailure(0, m);
            err.msg = m.empty() ? "Could not open folder" : m;
            return false;
        }
        smb2dirent* ent;
        while ((ent = smb2_readdir(ctx_, dir)) != nullptr) {
            if (!ent->name) continue;
            if (std::strcmp(ent->name, ".") == 0 || std::strcmp(ent->name, "..") == 0) continue;
            Entry e;
            e.name = ent->name;
            e.is_dir = ent->st.smb2_type == SMB2_TYPE_DIRECTORY;
            e.size = ent->st.smb2_size;
            e.mtime = static_cast<int64_t>(ent->st.smb2_mtime);
            if (ent->st.smb2_type == SMB2_TYPE_LINK) continue;   // avoid loops
            out.push_back(std::move(e));
        }
        smb2_closedir(ctx_, dir);
        return true;
    }

    bool open(const std::string& path, Error& err) override {
        closeFile();
        fh_ = smb2_open(ctx_, path.c_str(), O_RDONLY);
        if (!fh_) {
            std::string m = smb2_get_error(ctx_);
            err.auth = looksLikeAuthFailure(0, m);
            err.msg = m.empty() ? "Could not open file" : m;
            return false;
        }
        smb2_stat_64 st;
        std::memset(&st, 0, sizeof st);
        if (smb2_fstat(ctx_, fh_, &st) < 0) {
            err.msg = smb2_get_error(ctx_);
            closeFile();
            return false;
        }
        size_ = st.smb2_size;
        return true;
    }

    uint64_t fileSize() override { return size_; }

    int64_t read(uint64_t offset, void* buf, size_t len) override {
        if (!fh_) return -1;
        // Stay under the usual 1 MiB negotiated read size.
        if (len > 1024 * 1024) len = 1024 * 1024;
        int n = smb2_pread(ctx_, fh_, static_cast<uint8_t*>(buf), static_cast<uint32_t>(len), offset);
        return n < 0 ? -1 : n;
    }

private:
    void closeFile() {
        if (fh_) { smb2_close(ctx_, fh_); fh_ = nullptr; }
    }
    smb2_context* ctx_;
    smb2fh* fh_ = nullptr;
    uint64_t size_ = 0;
};

#ifdef PEK_SMB_SHARE_ENUM
struct EnumState {
    bool done = false;
    int status = 0;
    std::vector<std::string> shares;
};

void shareEnumCb(smb2_context*, int status, void* command_data, void* cb_data) {
    auto* st = static_cast<EnumState*>(cb_data);
    st->status = status;
    st->done = true;
    if (status != 0 || !command_data) return;
    auto* rep = static_cast<srvsvc_NetrShareEnum_rep*>(command_data);
    for (uint32_t i = 0; i < rep->ses.ShareInfo.Level1.EntriesRead; ++i) {
        const auto& s = rep->ses.ShareInfo.Level1.Buffer[i];
        // Only ordinary disk shares: type 0 (disk tree), not the hidden bit, not "C$"-style admin shares.
        if ((s.type & 0x0FFFFFFFu) != 0) continue;
        if (s.type & 0x80000000u) continue;
        if (!s.netname.utf8) continue;
        std::string name = s.netname.utf8;
        if (name.empty() || name.back() == '$') continue;
        st->shares.push_back(name);
    }
}
#endif

} // namespace

std::unique_ptr<Share> smbConnect(const Url& u, Error& err) {
    smb2_context* ctx = openContext(u.host, urlDecode(u.share), err);
    if (!ctx) return nullptr;
    return std::unique_ptr<Share>(new SmbShare(ctx));
}

bool smbListShares(const Url& u, std::vector<std::string>& shares, Error& err) {
    const std::string& host = u.host;
#ifdef PEK_SMB_SHARE_ENUM
    smb2_context* ctx = openContext(host, "IPC$", err);
    if (!ctx) return false;
    EnumState st;
#ifdef PEK_SMB_ENUM_OLD_SIGNATURE
    int rc = smb2_share_enum_async(ctx, shareEnumCb, &st);
#else
    int rc = smb2_share_enum_async(ctx, SHARE_INFO_1, shareEnumCb, &st);
#endif
    if (rc != 0) {
        err.auth = false;
        err.msg = smb2_get_error(ctx);
        smb2_disconnect_share(ctx);
        smb2_destroy_context(ctx);
        return false;
    }
    int idle = 0;
    while (!st.done) {
        pollfd pfd;
        pfd.fd = smb2_get_fd(ctx);
        pfd.events = smb2_which_events(ctx);
        pfd.revents = 0;
        int n = ::poll(&pfd, 1, 1000);
        if (n < 0 && errno != EINTR) break;
        if (n == 0) { if (++idle >= kTimeoutSeconds) break; continue; }
        if (smb2_service(ctx, pfd.revents) < 0) break;
    }
    bool ok = st.done && st.status == 0;
    if (!ok) {
        err.auth = false;
        err.msg = "Could not list the shares on " + host;
    } else {
        shares = std::move(st.shares);
    }
    smb2_disconnect_share(ctx);
    smb2_destroy_context(ctx);
    return ok;
#else
    (void)host; (void)shares;
    err.auth = false;
    err.msg = "Share listing is not available in this build; type the share name instead.";
    return false;
#endif
}

} // namespace vfs

#endif // PEK_SMB
