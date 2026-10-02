cmake_minimum_required(VERSION 3.18)
project(hesper CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Repo root is five levels up from this folder; backend/ lives there.
# We compile your existing files in place - nothing is copied.
set(BACKEND ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../backend)

add_library(hesper SHARED
    jni_entry.cpp
    ${BACKEND}/server.cpp
    ${BACKEND}/media_scanner.cpp
)

target_include_directories(hesper PRIVATE ${BACKEND})
target_link_libraries(hesper log)
