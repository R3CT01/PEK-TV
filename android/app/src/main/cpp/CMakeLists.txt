cmake_minimum_required(VERSION 3.18)
project(pek C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Repo root is five levels up from this folder; backend/ lives there.
set(BACKEND ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../backend)

# Static OpenSSL built by android/scripts/build-openssl.sh (one folder per ABI)
set(OPENSSL_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../openssl/${ANDROID_ABI})

# SQLite (the library and music databases). The amalgamation (sqlite3.c + sqlite3.h) lives in android/sqlite; the CI
# workflow fetches it with android/scripts/fetch-sqlite.sh (run that once for a local Android Studio build). It is
# compiled into the app, so nothing depends on the SQLite version of the phone or TV box.
set(SQLITE_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../sqlite)
if(NOT EXISTS ${SQLITE_DIR}/sqlite3.c)
    message(FATAL_ERROR "SQLite is missing: run android/scripts/fetch-sqlite.sh (it unpacks sqlite3.c and sqlite3.h into android/sqlite).")
endif()
add_library(pek_sqlite STATIC ${SQLITE_DIR}/sqlite3.c)
target_include_directories(pek_sqlite PUBLIC ${SQLITE_DIR})
target_compile_definitions(pek_sqlite PRIVATE SQLITE_THREADSAFE=1 SQLITE_OMIT_LOAD_EXTENSION=1 SQLITE_DEFAULT_MEMSTATUS=0)
set_target_properties(pek_sqlite PROPERTIES POSITION_INDEPENDENT_CODE ON)

add_library(pek SHARED
    jni_entry.cpp
    ${BACKEND}/server.cpp
    ${BACKEND}/media_scanner.cpp
    ${BACKEND}/playback.cpp
    ${BACKEND}/music.cpp       # /api/music/* (library, albums, artists, streaming)
    ${BACKEND}/music_tags.cpp  # reads song tags + covers (MP3, FLAC, Ogg, M4A) without ffprobe
    ${BACKEND}/discovery.cpp
    ${BACKEND}/vfs.cpp
    ${BACKEND}/vfs_ftp.cpp     # FTP
    ${BACKEND}/vfs_http.cpp    # WebDAV + UPnP/DLNA
    ${BACKEND}/torrent.cpp         # torrent engine (a stub unless PEK_TORRENT below)
    ${BACKEND}/torrent_routes.cpp  # /api/torrent/* (provider search + streaming)
)

# SMB (network shares) via libsmb2. The CI workflow clones it to android/libsmb2;
# when that folder is missing the app still builds and runs - discovery works,
# and connecting to a share reports "no SMB support".
set(LIBSMB2_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../libsmb2)
# OFF by default: share enumeration needs libsmb2's DCE/RPC headers
# (smb2/libsmb2-dcerpc.h), which were missing from the CI clone and broke the
# build. Turn ON with -DPEK_SHARE_ENUM=ON once the headers are confirmed.
option(PEK_SHARE_ENUM "List a host's shares with libsmb2's share-enum call" OFF)
if(EXISTS ${LIBSMB2_DIR}/CMakeLists.txt)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(ENABLE_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(ENABLE_LIBKRB5 OFF CACHE BOOL "" FORCE)
    add_subdirectory(${LIBSMB2_DIR} libsmb2 EXCLUDE_FROM_ALL)
    target_sources(pek PRIVATE ${BACKEND}/vfs_smb.cpp)
    target_include_directories(pek PRIVATE ${LIBSMB2_DIR}/include)
    target_compile_definitions(pek PRIVATE PEK_SMB)
    if(PEK_SHARE_ENUM)
        target_compile_definitions(pek PRIVATE PEK_SMB_SHARE_ENUM)
    endif()
    target_link_libraries(pek smb2)
    message(STATUS "PEK: SMB support ON (libsmb2)")
else()
    message(STATUS "PEK: SMB support OFF (android/libsmb2 not found)")
endif()

target_include_directories(pek PRIVATE ${BACKEND} ${OPENSSL_ROOT}/include ${SQLITE_DIR})
target_compile_definitions(pek PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
target_link_libraries(pek
    pek_sqlite
    ${OPENSSL_ROOT}/lib/libssl.a
    ${OPENSSL_ROOT}/lib/libcrypto.a
    log)
target_compile_definitions(pek PRIVATE _FILE_OFFSET_BITS=64)
# Google Play (apps targeting Android 15+) needs native libraries aligned for 16 KB memory pages.
target_link_options(pek PRIVATE -Wl,-z,max-page-size=16384)

# NFS via libnfs: off by default so a libnfs build problem can never break the
# app. To turn it on, clone https://github.com/sahlberg/libnfs into android/libnfs
# (the workflow's "Clone libnfs" step does this).
set(LIBNFS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../libnfs)
if(EXISTS ${LIBNFS_DIR}/CMakeLists.txt)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(ENABLE_TESTS OFF CACHE BOOL "" FORCE)
    set(ENABLE_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(ENABLE_UTILS OFF CACHE BOOL "" FORCE)
    set(ENABLE_DOCUMENTATION OFF CACHE BOOL "" FORCE)
    set(ENABLE_SHARED OFF CACHE BOOL "" FORCE)
    add_subdirectory(${LIBNFS_DIR} libnfs EXCLUDE_FROM_ALL)
    target_sources(pek PRIVATE ${BACKEND}/vfs_nfs.cpp)
    target_include_directories(pek PRIVATE ${LIBNFS_DIR}/include)
    # libnfs keeps libnfs-raw-mount.h etc. in mount/, nfs/, ... and only copies
    # them under nfsc/ on install, so mirror them into a generated nfsc/ folder.
    file(GLOB_RECURSE LIBNFS_RAW_HDRS ${LIBNFS_DIR}/libnfs-raw-*.h ${LIBNFS_DIR}/*/libnfs-raw-*.h)
    file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/libnfs_inc/nfsc)
    foreach(h ${LIBNFS_RAW_HDRS})
        get_filename_component(hn ${h} NAME)
        if(NOT EXISTS ${LIBNFS_DIR}/include/nfsc/${hn})
            configure_file(${h} ${CMAKE_BINARY_DIR}/libnfs_inc/nfsc/${hn} COPYONLY)
        endif()
    endforeach()
    target_include_directories(pek PRIVATE ${CMAKE_BINARY_DIR}/libnfs_inc)
    target_compile_definitions(pek PRIVATE PEK_NFS)
    target_link_libraries(pek nfs)
    message(STATUS "PEK: NFS support ON (libnfs)")
else()
    message(STATUS "PEK: NFS support OFF (android/libnfs not found)")
endif()

# Torrent streaming via libtorrent-rasterbar. OFF by default so a libtorrent build problem can
# never break the app: the workflow turns it on (-PhesperTorrent=true -> PEK_TORRENT=ON) after
# cloning android/libtorrent and unpacking the Boost headers into android/boost, and retries the
# build without it if that fails. Without it the torrent routes still exist and report
# "not available"; the release search (Torznab) works either way.
option(PEK_TORRENT "Build in torrent streaming (libtorrent)" OFF)
set(LIBTORRENT_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../libtorrent)
set(BOOST_DIR      ${CMAKE_CURRENT_SOURCE_DIR}/../../../../boost)
if(PEK_TORRENT AND EXISTS ${LIBTORRENT_DIR}/CMakeLists.txt AND EXISTS ${BOOST_DIR}/boost/version.hpp)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(deprecated-functions OFF CACHE BOOL "" FORCE)
    set(build_tests OFF CACHE BOOL "" FORCE)
    set(build_examples OFF CACHE BOOL "" FORCE)
    set(build_tools OFF CACHE BOOL "" FORCE)
    set(python-bindings OFF CACHE BOOL "" FORCE)
    set(static_runtime OFF CACHE BOOL "" FORCE)
    # Boost is used header-only; OpenSSL is the static build from build-openssl.sh.
    set(BOOST_ROOT ${BOOST_DIR} CACHE PATH "" FORCE)
    set(Boost_INCLUDE_DIR ${BOOST_DIR} CACHE PATH "" FORCE)
    set(Boost_NO_BOOST_CMAKE ON CACHE BOOL "" FORCE)
    set(Boost_NO_SYSTEM_PATHS ON CACHE BOOL "" FORCE)
    set(OPENSSL_ROOT_DIR ${OPENSSL_ROOT} CACHE PATH "" FORCE)
    set(OPENSSL_INCLUDE_DIR ${OPENSSL_ROOT}/include CACHE PATH "" FORCE)
    set(OPENSSL_SSL_LIBRARY ${OPENSSL_ROOT}/lib/libssl.a CACHE FILEPATH "" FORCE)
    set(OPENSSL_CRYPTO_LIBRARY ${OPENSSL_ROOT}/lib/libcrypto.a CACHE FILEPATH "" FORCE)
    add_subdirectory(${LIBTORRENT_DIR} libtorrent EXCLUDE_FROM_ALL)
    target_include_directories(pek PRIVATE ${LIBTORRENT_DIR}/include ${BOOST_DIR})
    target_compile_definitions(pek PRIVATE PEK_TORRENT)
    target_link_libraries(pek torrent-rasterbar)
    message(STATUS "PEK: torrent streaming ON (libtorrent)")
else()
    message(STATUS "PEK: torrent streaming OFF (PEK_TORRENT not set, or android/libtorrent / android/boost missing)")
endif()
