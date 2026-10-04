cmake_minimum_required(VERSION 3.18)
project(hesper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Repo root is five levels up from this folder; backend/ lives there.
set(BACKEND ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../backend)

# Static OpenSSL built by android/scripts/build-openssl.sh (one folder per ABI)
set(OPENSSL_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/../../../../openssl/${ANDROID_ABI})

add_library(hesper SHARED
    jni_entry.cpp
    ${BACKEND}/server.cpp
    ${BACKEND}/media_scanner.cpp
    ${BACKEND}/playback.cpp
    ${BACKEND}/discovery.cpp
    ${BACKEND}/vfs.cpp
)

# SMB (network shares) via libsmb2. The CI workflow clones it to android/libsmb2;
# when that folder is missing the app still builds and runs - discovery works,
# and connecting to a share reports "no SMB support".
set(LIBSMB2_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../../../../libsmb2)
option(HESPER_SHARE_ENUM "List a host's shares with libsmb2's share-enum call" ON)
if(EXISTS ${LIBSMB2_DIR}/CMakeLists.txt)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
    set(ENABLE_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(ENABLE_LIBKRB5 OFF CACHE BOOL "" FORCE)
    add_subdirectory(${LIBSMB2_DIR} libsmb2 EXCLUDE_FROM_ALL)
    target_sources(hesper PRIVATE ${BACKEND}/vfs_smb.cpp)
    target_include_directories(hesper PRIVATE ${LIBSMB2_DIR}/include)
    target_compile_definitions(hesper PRIVATE HESPER_SMB)
    if(HESPER_SHARE_ENUM)
        target_compile_definitions(hesper PRIVATE HESPER_SMB_SHARE_ENUM)
    endif()
    target_link_libraries(hesper smb2)
    message(STATUS "Hesper: SMB support ON (libsmb2)")
else()
    message(STATUS "Hesper: SMB support OFF (android/libsmb2 not found)")
endif()

target_include_directories(hesper PRIVATE ${BACKEND} ${OPENSSL_ROOT}/include)
target_compile_definitions(hesper PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
target_link_libraries(hesper
    ${OPENSSL_ROOT}/lib/libssl.a
    ${OPENSSL_ROOT}/lib/libcrypto.a
    log)
target_compile_definitions(hesper PRIVATE _FILE_OFFSET_BITS=64)
