# Run from the repo root:  python3 fix_nfs_types.py
# libnfs built from source doesn't expose NF3DIR / NF3LNK to vfs_nfs.cpp.
# They are fixed NFSv3 protocol values (RFC 1813), so define them locally.
p = "backend/vfs_nfs.cpp"
s = open(p).read()
if "kNf3Dir" in s:
    print("already patched")
    raise SystemExit
anchor = "namespace vfs {\nnamespace {\n"
if anchor not in s or "NF3LNK" not in s:
    print("expected text not found - send me backend/vfs_nfs.cpp")
    raise SystemExit
s = s.replace(anchor, anchor + "\n// NFSv3 file types (RFC 1813), matching libnfs's ftype3 enum.\nconstexpr uint32_t kNf3Dir = 2;\nconstexpr uint32_t kNf3Lnk = 5;\n", 1)
s = s.replace("NF3LNK", "kNf3Lnk").replace("NF3DIR", "kNf3Dir")
open(p, "w").write(s)
print("patched")
