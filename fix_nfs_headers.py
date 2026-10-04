# Run from the repo root:  python3 fix_nfs_headers.py
# Makes libnfs's generated mount/nfs headers visible as <nfsc/...> when libnfs
# is built from source (they are only copied to nfsc/ on "make install").
p = "android/app/src/main/cpp/CMakeLists.txt"
s = open(p).read()
anchor = "    target_include_directories(hesper PRIVATE ${LIBNFS_DIR}/include)\n"
add = anchor + '''    # libnfs keeps libnfs-raw-mount.h etc. in mount/, nfs/, ... and only copies
    # them under nfsc/ on install, so mirror them into a generated nfsc/ folder.
    file(GLOB_RECURSE LIBNFS_RAW_HDRS ${LIBNFS_DIR}/libnfs-raw-*.h ${LIBNFS_DIR}/*/libnfs-raw-*.h)
    file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/libnfs_inc/nfsc)
    foreach(h ${LIBNFS_RAW_HDRS})
        get_filename_component(hn ${h} NAME)
        if(NOT EXISTS ${LIBNFS_DIR}/include/nfsc/${hn})
            configure_file(${h} ${CMAKE_BINARY_DIR}/libnfs_inc/nfsc/${hn} COPYONLY)
        endif()
    endforeach()
    target_include_directories(hesper PRIVATE ${CMAKE_BINARY_DIR}/libnfs_inc)
'''
if "libnfs_inc" in s:
    print("already patched")
elif anchor not in s:
    print("anchor line not found - send me the CMakeLists.txt")
else:
    open(p, "w").write(s.replace(anchor, add))
    print("patched")
