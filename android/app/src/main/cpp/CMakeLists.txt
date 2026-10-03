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
)

target_include_directories(hesper PRIVATE ${BACKEND} ${OPENSSL_ROOT}/include)
target_compile_definitions(hesper PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
target_link_libraries(hesper
    ${OPENSSL_ROOT}/lib/libssl.a
    ${OPENSSL_ROOT}/lib/libcrypto.a
    log)
target_compile_definitions(hesper PRIVATE _FILE_OFFSET_BITS=64)
