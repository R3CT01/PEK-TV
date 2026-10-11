#ifndef VFS_BACKENDS_H
#define VFS_BACKENDS_H
// Internal: one connect function per protocol, implemented in its own file.
#include "vfs.h"

namespace vfs {
std::unique_ptr<Share> smbConnect(const Url& u, Error& err);                 // vfs_smb.cpp   (PEK_SMB)
bool smbListShares(const Url& u, std::vector<std::string>& out, Error& err);
std::unique_ptr<Share> nfsConnect(const Url& u, Error& err);                 // vfs_nfs.cpp   (PEK_NFS)
bool nfsListShares(const Url& u, std::vector<std::string>& out, Error& err);
std::unique_ptr<Share> ftpConnect(const Url& u, Error& err);                 // vfs_ftp.cpp
std::unique_ptr<Share> davConnect(const Url& u, Error& err);                 // vfs_http.cpp
std::unique_ptr<Share> upnpConnect(const Url& u, Error& err);                // vfs_http.cpp

// Reads a UPnP device description (the LOCATION an SSDP reply points to).
// On success fills the friendly name, "host:port" and the ContentDirectory
// control path. Used by discovery.
bool upnpDescribe(const std::string& locationUrl, std::string& friendlyName,
                  std::string& hostPort, std::string& controlPath);

// Text helpers shared by the backends.
std::string xmlUnescape(const std::string& s);
}

#endif
