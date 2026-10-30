#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pektool - look inside, check, build and convert .PEK plugin files for PEK TV.

Pure Python 3.8+, standard library only: runs the same in Termux, cmd.exe,
PowerShell, macOS and Linux.  See PEK_FORMAT.md for the file format.

    python pektool.py info weather.PEK        what is inside (works on .zip too)
    python pektool.py verify weather.PEK      is it a valid, untampered PEK?
    python pektool.py convert weather.zip     ZIP -> weather.PEK
    python pektool.py pack ./weather          folder -> weather.PEK
    python pektool.py ls | cat | extract | tozip | hexmap

Anything that is not a correct PEK plugin is rejected loudly in red, with every
reason listed.  Exit codes: 0 ok, 1 rejected, 2 usage / file error.

The plugin rules below mirror backend/plugin_install.h, so a file this tool
accepts is a file the app's installer accepts.
"""
import argparse
import hashlib
import json
import os
import re
import stat
import struct
import sys
import textwrap
import zipfile
import zlib

TOOL_VERSION = "1.0.0"

# ----------------------------------------------------------------------------
# Format constants (see PEK_FORMAT.md)
# ----------------------------------------------------------------------------
MAGIC = b"\x89PEK\r\n\x1a\n"
FORMAT_VERSION = 1
HEADER_SIZE = 64
FOOTER_SIZE = 32
HEADER_BODY = struct.Struct("<8sHHIQQQQ12x")   # 60 bytes, then a u32 CRC-32 of those 60
HEADER_CRC = struct.Struct("<I")
ENTRY = struct.Struct("<HBBQII32s")             # 52 bytes, then the UTF-8 path
METHODS = {0: "stored", 1: "deflate"}
EXT = ".PEK"

# Plugin rules (mirrors backend/plugin_install.h)
MAX_FILES = 200
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
MAX_MANIFEST = 16 * 1024
MAX_PATH = 120
MAX_DEPTH = 6
MAX_PY_BYTES = 200 * 1024
MAX_PEK_BYTES = MAX_TOTAL_BYTES + 1024 * 1024   # anything bigger cannot be a valid PEK
ALLOWED_EXT = {"json", "css", "md", "txt", "png", "jpg", "jpeg", "gif", "webp", "ico",
               "woff", "woff2", "ttf", "otf", "py"}
RESERVED_IDS = {"weather", "sample_scraper", "sample_counter", "tmdb-discover", "skin-maker"}
STOCK_IDS = {"weather", "tmdb-discover", "skin-maker"}
RESERVED_HOST = "hesper-tmdb.aquariusibeats.workers.dev"

# ----------------------------------------------------------------------------
# Terminal output
# ----------------------------------------------------------------------------
_COLOR = False


def _setup_terminal(no_color):
    global _COLOR
    if os.name == "nt":
        os.system("")   # switches on ANSI colours in Windows 10+ cmd / PowerShell
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except Exception:
            pass
    force = os.environ.get("FORCE_COLOR")
    _COLOR = (not no_color and not os.environ.get("NO_COLOR")
              and bool(force or sys.stdout.isatty() or sys.stderr.isatty()))


def _c(code, s):
    return "\033[%sm%s\033[0m" % (code, s) if _COLOR else str(s)


def red(s): return _c("1;31", s)
def green(s): return _c("32", s)
def yellow(s): return _c("33", s)
def cyan(s): return _c("36", s)
def dim(s): return _c("2", s)
def bold(s): return _c("1", s)


def eprint(*a):
    print(*a, file=sys.stderr)


class Reject(Exception):
    """The input is not a correct PEK plugin. Carries every reason found."""

    def __init__(self, what, problems, hint=None):
        Exception.__init__(self, what)
        self.what = what
        self.problems = list(problems)
        self.hint = hint


def show_reject(what, problems, hint=None):
    bar = "!" * 66
    eprint(red(bar))
    eprint(red("!!  REJECTED  -  " + str(what)))
    eprint(red("!!  This is NOT a valid PEK plugin."))
    eprint(red(bar))
    for p in problems:
        eprint(red("  [X] " + p))
    if hint:
        eprint(yellow("  Hint: " + hint))


def human(n):
    if n < 1024:
        return "%d B" % n
    for u in ("KB", "MB"):
        n /= 1024.0
        if n < 1024 or u == "MB":
            return "%.1f %s" % (n, u)


def sha(b):
    return hashlib.sha256(b).digest()


def ext_of(path):
    base = path.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def valid_id(s):
    return bool(re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", s or ""))


def slugify(s):
    return re.sub(r"[^a-z0-9_-]+", "-", s.lower()).strip("-_")[:40].strip("-_")


# ----------------------------------------------------------------------------
# Plugin rules (shared by pack, convert and every reader)
# ----------------------------------------------------------------------------
def check_path(p):
    """'' if the path is fine, otherwise the reason (same rules as plugin_install.h)."""
    if not p:
        return "a file has an empty name"
    if len(p.encode("utf-8", "replace")) > MAX_PATH:
        return "a file path is too long: %s..." % p[:40]
    if p[0] == "/":
        return "absolute paths are not allowed: " + p
    depth = 0
    for part in p.split("/"):
        if part == "":
            return "bad path (empty folder name): " + p
        if part in (".", ".."):
            return "bad path (. or ..): " + p
        if part[0] == ".":
            return "hidden files are not allowed: " + p
        if len(part.encode("utf-8", "replace")) > 64:
            return "a file or folder name is too long in: " + p
        if part[-1] in ". ":
            return "bad file name: " + p
        for ch in part:
            if ord(ch) < 0x20 or ord(ch) == 0x7F or ch in '\\:*?"<>|':
                return "bad character in file name: " + p
        depth += 1
        if depth > MAX_DEPTH:
            return "folders are nested too deeply: " + p
    return ""


def check_manifest(files, P, W, official):
    raw = files["plugin.json"]
    if len(raw) > MAX_MANIFEST:
        P.append("plugin.json is too large (limit 16 KB)")
    try:
        text = raw.decode("utf-8-sig")
        m = json.loads(text)
    except (UnicodeDecodeError, ValueError) as e:
        P.append("plugin.json is not valid JSON: %s" % e)
        return None
    if not isinstance(m, dict):
        P.append("plugin.json is not a JSON object")
        return None
    if not official and RESERVED_HOST in text.lower():
        P.append("%s is reserved for PEK's official plugins" % RESERVED_HOST)

    if not (isinstance(m.get("name"), str) and m["name"].strip()):
        P.append('plugin.json needs a "name" (non-empty text)')
    ver = m.get("version")
    if not (isinstance(ver, str) and ver.strip()):
        P.append('plugin.json needs a "version" (text such as "1.0.0")')
    elif not re.match(r"\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$", ver.strip()):
        W.append('"version" %r does not look like 1.2.3' % ver)

    fl = m.get("flutter")
    if not isinstance(fl, dict):
        P.append('plugin.json needs a "flutter" entry, for example "flutter": { "screen": "screen.py" }')
    else:
        scr = fl.get("screen")
        if not isinstance(scr, str) or not scr:
            P.append('"flutter" needs a "screen" file name, for example "screen": "screen.py"')
        elif scr not in files:
            P.append('"flutter.screen" points at %s, which is not in the plugin' % scr)

    icon = m.get("icon")
    if icon is not None and (not isinstance(icon, str) or icon not in files):
        P.append('"icon" points at %r, which is not in the plugin' % (icon,))

    perms = m.get("permissions")
    if perms is not None:
        if not isinstance(perms, dict):
            P.append('"permissions" must be an object')
        else:
            net = perms.get("network")
            if net is not None and not (isinstance(net, list) and all(isinstance(x, str) and x for x in net)):
                P.append('"permissions.network" must be a list of host names')
    if m.get("ui") is not None and not isinstance(m.get("ui"), dict):
        P.append('"ui" must be an object')

    if not m.get("description"):
        W.append('plugin.json has no "description"')
    if not m.get("author"):
        W.append('plugin.json has no "author"')
    if any(ext_of(p) == "py" for p in files) and perms is None:
        W.append("the plugin has Python files but plugin.json declares no \"permissions\"; "
                 "the app's guard will not run a backend without them")
    return m


def check_plugin(files, pid, official=False):
    """files: dict path -> bytes.  Returns (problems, warnings, manifest)."""
    P, W, manifest = [], [], None
    if not valid_id(pid):
        P.append("the plugin id %r is not valid: use 1-40 lowercase letters, digits, - or _, "
                 "starting with a letter or digit" % (pid,))
    elif pid in RESERVED_IDS and not (official and pid in STOCK_IDS):
        W.append('"%s" is the id of a built-in PEK TV plugin: the app will refuse to install it '
                 '(only the Official store can replace it). Use --id to pick another id.' % pid)
    if not files:
        P.append("the plugin has no files")
        return P, W, None
    if len(files) > MAX_FILES:
        P.append("too many files (%d, limit %d)" % (len(files), MAX_FILES))

    seen, total = {}, 0
    for path, data in files.items():
        why = check_path(path)
        if why:
            P.append(why)
            continue
        if path.lower() in seen:
            P.append("the same file appears twice: " + path)
            continue
        seen[path.lower()] = path
        total += len(data)
        ext = ext_of(path)
        if len(data) > MAX_FILE_BYTES:
            P.append("%s is too large (limit 2 MB per file, this one is %s)" % (path, human(len(data))))
        if ext in ("js", "mjs"):
            P.append("plugins can't include JavaScript (%s). PEK TV only installs plugins written in Python (screen.py)" % path)
        elif ext not in ALLOWED_EXT:
            P.append("file type not allowed in plugins: " + path)
        elif ext == "py" and len(data) > MAX_PY_BYTES:
            P.append("%s is too large for a plugin backend (limit 200 KB)" % path)
    if total > MAX_TOTAL_BYTES:
        P.append("the plugin is too large (limit 8 MB in total, this is %s)" % human(total))

    has_skin = "skin.json" in files
    if "plugin.json" not in files:
        if has_skin:
            P.append("this is a skin, not a plugin. Install it from Settings -> Skins.")
        else:
            P.append("plugin.json is missing (it must sit at the top level of the plugin)")
    else:
        if has_skin:
            P.append("this has both plugin.json and skin.json, so it is not clearly a plugin or a skin")
        manifest = check_manifest(files, P, W, official and pid in STOCK_IDS)
        if "screen.py" not in files:
            P.append("screen.py is missing. PEK TV only installs plugins with a Python screen for the Flutter UI")
    if any(p.startswith("data/") for p in files):
        W.append("the plugin ships a data/ folder. That is the plugin's private, per-device runtime data; "
                 "you almost certainly don't want it inside a release (use --clean to drop it)")
    return P, W, manifest


# ----------------------------------------------------------------------------
# Package: what a loaded .PEK or .zip looks like to the commands
# ----------------------------------------------------------------------------
class Package(object):
    def __init__(self, kind, path):
        self.kind = kind            # "pek" or "zip"
        self.path = path
        self.pid = ""
        self.files = {}             # path -> raw bytes
        self.entries = {}           # path -> entry dict (pek only)
        self.header = {}
        self.manifest = None
        self.problems = []
        self.warnings = []
        self.notes = []
        self.saw_junk = False
        self.whole_sha = b""


def is_junk(path):
    parts = path.split("/")
    if any(p in ("__pycache__", "__MACOSX") for p in parts):
        return True
    if any(p.startswith(".") for p in parts):
        return True
    if parts[-1].lower() in ("thumbs.db", "desktop.ini"):
        return True
    if ext_of(path) in ("pyc", "pyo"):
        return True
    return parts[0] == "data" and len(parts) > 1


def describe_unknown(head):
    if not head:
        return "the file is empty"
    hx = " ".join("%02x" % b for b in head)
    guess = ""
    if head[:2] == b"\x1f\x8b":
        guess = " (looks like a gzip file)"
    elif head[:6] == b"7z\xbc\xaf\x27\x1c":
        guess = " (looks like a 7-Zip archive)"
    elif head[:4] == b"Rar!":
        guess = " (looks like a RAR archive)"
    elif head[:4] == b"\x89PNG":
        guess = " (looks like a PNG image)"
    elif head[:4] == b"\x7fELF":
        guess = " (looks like a native binary)"
    elif head[:3] == b"dex":
        guess = " (looks like Android DEX code)"
    elif head[:1] in (b"{", b"[", b"<"):
        guess = " (looks like plain text / JSON / HTML)"
    return ("this is neither a PEK nor a ZIP. A PEK starts with 89 50 45 4b 0d 0a 1a 0a, "
            "this file starts with %s%s" % (hx, guess))


def load_package(path, want=None, clean=False, pid=None):
    with open(path, "rb") as f:
        head = f.read(8)
    if head[:4] in (b"PK\x03\x04", b"PK\x05\x06"):
        pkg = load_zip(path, clean, pid)
    elif head[:4] == b"\x89PEK":
        if os.path.getsize(path) > MAX_PEK_BYTES:
            raise Reject(path, ["the file is %s, bigger than any valid PEK can be (limit about 9 MB)"
                                % human(os.path.getsize(path))])
        with open(path, "rb") as f:
            data = f.read()
        pkg = parse_pek(data, path)
    else:
        raise Reject(path, [describe_unknown(head)])
    if want == "pek" and pkg.kind != "pek":
        raise Reject(path, ["this is a ZIP file, not a PEK."],
                     hint="turn it into one with:  pektool.py convert " + path)
    return pkg


# ----------------------------------------------------------------------------
# Reading a ZIP
# ----------------------------------------------------------------------------
def load_zip(path, clean, pid_override):
    pkg = Package("zip", path)
    P = pkg.problems
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as e:
        raise Reject(path, ["the file starts like a ZIP but is damaged: %s" % e])
    with zf:
        entries, seen = [], set()
        for i in zf.infolist():
            if i.is_dir():
                continue
            if i.filename in seen:
                P.append("the same file appears twice: " + i.filename)
                continue
            seen.add(i.filename)
            entries.append(i)
        pkg.saw_junk = any(is_junk(i.filename) for i in entries)
        if clean:
            keep = []
            for i in entries:
                if is_junk(i.filename):
                    pkg.notes.append("dropped " + i.filename)
                else:
                    keep.append(i)
            entries = keep

        # plugin sitting inside one top-level folder (weather/plugin.json): step inside it
        prefix = ""
        names = [i.filename for i in entries]
        if names and "plugin.json" not in names:
            tops = set(n.split("/", 1)[0] for n in names if "/" in n)
            if len(tops) == 1 and all("/" in n for n in names):
                top = next(iter(tops))
                if top + "/plugin.json" in names:
                    prefix = top + "/"
                    pkg.notes.append("plugin was inside the folder %s: stepped into it" % prefix)

        total = 0
        for i in entries:
            n = i.filename[len(prefix):]
            if i.flag_bits & 0x1:
                P.append("%s is password-protected" % n)
                continue
            if stat.S_ISLNK(i.external_attr >> 16):
                P.append("%s is a symbolic link, which plugins can't contain" % n)
                continue
            if i.file_size > MAX_FILE_BYTES:
                P.append("%s is too large (limit 2 MB per file, this one is %s)" % (n, human(i.file_size)))
                continue
            total += i.file_size
            if total > MAX_TOTAL_BYTES:
                P.append("the plugin is too large (limit 8 MB in total)")
                break
            try:
                with zf.open(i) as fh:
                    data = fh.read(MAX_FILE_BYTES + 1)
            except (zipfile.BadZipFile, RuntimeError, NotImplementedError, zlib.error) as e:
                P.append("%s is damaged or uses an unsupported compression: %s" % (n, e))
                continue
            if len(data) > MAX_FILE_BYTES:
                P.append("%s is too large (limit 2 MB per file)" % n)
                continue
            pkg.files[n] = data

    stem = os.path.splitext(os.path.basename(path))[0]
    if pid_override:
        pkg.pid = pid_override
    elif prefix:
        pkg.pid = slugify(prefix.rstrip("/"))
    else:
        pkg.pid = slugify(stem)
    if not pid_override and pkg.pid != stem:
        pkg.notes.append("plugin id taken from the name: %r -> %r" % (stem, pkg.pid))
    cp, cw, pkg.manifest = check_plugin(pkg.files, pkg.pid)
    pkg.problems += cp
    pkg.warnings += cw
    return pkg


# ----------------------------------------------------------------------------
# Reading a PEK
# ----------------------------------------------------------------------------
def parse_pek(data, path):
    pkg = Package("pek", path)
    P = pkg.problems
    n = len(data)
    if n < HEADER_SIZE + FOOTER_SIZE:
        raise Reject(path, ["only %d bytes: too short to be a PEK (the smallest possible is %d)"
                            % (n, HEADER_SIZE + FOOTER_SIZE)])
    if data[:8] != MAGIC:
        raise Reject(path, ["the PEK signature is damaged (the first 4 bytes are right, the next 4 are wrong). "
                            "This usually means the file went through a text-mode transfer or CRLF conversion. "
                            "Copy it again in binary mode."])
    magic, ver, flags, count, toc_off, toc_len, data_off, fsize = HEADER_BODY.unpack_from(data, 0)
    (crc,) = HEADER_CRC.unpack_from(data, 60)
    if zlib.crc32(data[:60]) & 0xFFFFFFFF != crc:
        raise Reject(path, ["the header checksum is wrong: the header is damaged, so nothing else can be trusted"])
    pkg.header = dict(version=ver, flags=flags, files=count, toc_offset=toc_off, toc_length=toc_len,
                      data_offset=data_off, size=fsize, actual_size=n)
    if ver != FORMAT_VERSION:
        raise Reject(path, ["unsupported PEK format version %d (this tool understands version %d). "
                            "Update pektool.py." % (ver, FORMAT_VERSION)])
    if flags != 0:
        P.append("unknown header flags 0x%04x are set (format version 1 requires 0)" % flags)
    if any(data[48:60]):
        P.append("the reserved header bytes are not zero")
    if fsize != n:
        P.append("size mismatch: the header says %d bytes but the file is %d bytes%s"
                 % (fsize, n, " (truncated: incomplete download or copy?)" if n < fsize
                    else " (extra bytes after the end)"))
    if data_off != HEADER_SIZE:
        P.append("the data area must start at byte %d, the header says %d" % (HEADER_SIZE, data_off))
    if not (HEADER_SIZE <= toc_off and toc_off + toc_len == n - FOOTER_SIZE):
        P.append("the table of contents does not fit the file (offset %d, length %d, file %d bytes)"
                 % (toc_off, toc_len, n))
        raise Reject(path, P)
    if count > MAX_FILES:
        P.append("too many files (%d, limit %d)" % (count, MAX_FILES))
        raise Reject(path, P)

    pkg.whole_sha = data[-FOOTER_SIZE:]
    if sha(data[:-FOOTER_SIZE]) != pkg.whole_sha:
        P.append("the whole-file SHA-256 does not match: the file was modified or damaged after it was packed")

    toc = data[toc_off:toc_off + toc_len]
    if len(toc) < 1 or 1 + toc[0] > len(toc):
        P.append("the table of contents is cut short (plugin id)")
        raise Reject(path, P)
    pid_raw = toc[1:1 + toc[0]]
    try:
        pkg.pid = pid_raw.decode("ascii")
    except UnicodeDecodeError:
        pkg.pid = pid_raw.decode("ascii", "replace")
        P.append("the plugin id is not plain ASCII")
    cur, complete, entries = 1 + toc[0], True, []
    for k in range(count):
        if cur + ENTRY.size > len(toc):
            P.append("the table of contents is cut short at entry %d of %d" % (k + 1, count))
            complete = False
            break
        plen, method, eflags, off, stored, rawsz, digest = ENTRY.unpack_from(toc, cur)
        cur += ENTRY.size
        if cur + plen > len(toc):
            P.append("the table of contents is cut short inside the path of entry %d" % (k + 1))
            complete = False
            break
        pb = toc[cur:cur + plen]
        cur += plen
        try:
            p = pb.decode("utf-8")
        except UnicodeDecodeError:
            P.append("entry %d: the path is not valid UTF-8" % (k + 1))
            p = pb.decode("utf-8", "replace")
        entries.append(dict(path=p, method=method, eflags=eflags, offset=off, stored=stored,
                            raw=rawsz, sha=digest))
    if complete and cur != len(toc):
        P.append("%d unexpected bytes after the last table-of-contents entry" % (len(toc) - cur))

    # the data area must be tiled exactly by the entries: no gaps (hidden payloads), no overlaps
    exp = HEADER_SIZE
    for e in sorted(entries, key=lambda x: x["offset"]):
        if e["offset"] < exp:
            P.append("%s: its data overlaps another file" % e["path"])
        elif e["offset"] > exp:
            P.append("%d bytes of unaccounted data before %s" % (e["offset"] - exp, e["path"]))
        exp = e["offset"] + e["stored"]
    if complete and exp != toc_off:
        P.append("%d bytes of unaccounted data between the last file and the table of contents"
                 % abs(toc_off - exp))

    seen = set()
    for e in entries:
        p = e["path"]
        if p in seen:
            P.append("the same file appears twice: " + p)
            continue
        seen.add(p)
        if e["method"] not in METHODS:
            P.append("%s: unknown compression method %d" % (p, e["method"]))
            continue
        if e["eflags"]:
            P.append("%s: unknown entry flags 0x%02x" % (p, e["eflags"]))
        if e["offset"] < HEADER_SIZE or e["offset"] + e["stored"] > toc_off:
            P.append("%s: its data lies outside the data area" % p)
            continue
        if e["raw"] > MAX_FILE_BYTES:
            P.append("%s claims to be %s once unpacked (limit 2 MB per file)" % (p, human(e["raw"])))
            continue
        blob = data[e["offset"]:e["offset"] + e["stored"]]
        if e["method"] == 0:
            if e["stored"] != e["raw"]:
                P.append("%s: stored size and real size disagree" % p)
                continue
            raw = blob
        else:
            d = zlib.decompressobj(-15)
            try:
                raw = d.decompress(blob, e["raw"] + 1)
            except zlib.error:
                P.append("%s: the compressed data is corrupt" % p)
                continue
            if not d.eof or d.unconsumed_tail or d.unused_data or len(raw) != e["raw"]:
                P.append("%s: unpacks to the wrong size (corrupt data or a zip bomb)" % p)
                continue
        if sha(raw) != e["sha"]:
            P.append("%s: SHA-256 mismatch, the file's contents were changed or damaged" % p)
            continue
        pkg.files[p] = raw
        pkg.entries[p] = e

    if not P:
        cp, cw, pkg.manifest = check_plugin(pkg.files, pkg.pid)
        P += cp
        pkg.warnings += cw
    if not path.lower().endswith(".pek"):
        pkg.warnings.append("the file name does not end in %s" % EXT)
    return pkg


# ----------------------------------------------------------------------------
# Writing a PEK
# ----------------------------------------------------------------------------
def build_pek(pid, files):
    """Deterministic: files sorted by path, no timestamps. plugin.json is always stored plain."""
    body = bytearray()
    toc = bytearray([len(pid)]) + pid.encode("ascii")
    off = HEADER_SIZE
    for path in sorted(files, key=lambda s: s.encode("utf-8")):
        raw = files[path]
        method, blob = 0, raw
        if path != "plugin.json" and len(raw) > 64:
            c = zlib.compressobj(9, zlib.DEFLATED, -15)
            comp = c.compress(raw) + c.flush()
            if len(comp) < len(raw):
                method, blob = 1, comp
        pb = path.encode("utf-8")
        toc += ENTRY.pack(len(pb), method, 0, off, len(blob), len(raw), sha(raw)) + pb
        body += blob
        off += len(blob)
    toc_off = HEADER_SIZE + len(body)
    size = toc_off + len(toc) + FOOTER_SIZE
    h60 = HEADER_BODY.pack(MAGIC, FORMAT_VERSION, 0, len(files), toc_off, len(toc), HEADER_SIZE, size)
    header = h60 + HEADER_CRC.pack(zlib.crc32(h60) & 0xFFFFFFFF)
    blob = bytes(header) + bytes(body) + bytes(toc)
    return blob + sha(blob)


def write_pek(pid, files, out, force, notes=()):
    """Check the plugin rules, write the PEK, read it back and verify it. Raises Reject if not valid."""
    P, W, _ = check_plugin(files, pid)
    if P:
        raise Reject(out, P)
    if os.path.exists(out) and not force:
        raise Reject(out, ["%s already exists" % out], hint="use --force to overwrite it")
    blob = build_pek(pid, files)
    tmp = out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(blob)
    try:
        back = parse_pek(blob, out)
        if back.problems or back.files != files:
            raise Reject(out, ["internal self-check failed after writing: %s" % "; ".join(back.problems or ["files differ"])])
    except Reject:
        os.remove(tmp)
        raise
    os.replace(tmp, out)
    for note in notes:
        print(dim("  note: " + note))
    for w in W:
        print(yellow("  [!] " + w))
    raw_total = sum(len(v) for v in files.values())
    print(green("OK  ") + bold(out) + "  id=%s  %d files  %s unpacked -> %s PEK  (round-trip verified)"
          % (pid, len(files), human(raw_total), human(len(blob))))
    print(dim("    sha256 " + hashlib.sha256(blob).hexdigest()))


def default_out(pid, near):
    d = os.path.dirname(os.path.abspath(near)) if near else os.getcwd()
    return os.path.join(d, pid + EXT)


# ----------------------------------------------------------------------------
# Commands
# ----------------------------------------------------------------------------
def table(rows, header):
    widths = [max(len(str(r[i])) for r in rows + [header]) for i in range(len(header))]
    line = "  ".join(str(h).ljust(w) for h, w in zip(header, widths))
    print("  " + bold(line))
    for r in rows:
        print("  " + "  ".join(str(c).ljust(w) if i != 1 and i != 2 else str(c).rjust(w)
                               for i, (c, w) in enumerate(zip(r, widths))))


def file_rows(pkg):
    rows = []
    for p in sorted(pkg.files, key=lambda s: s.encode("utf-8")):
        e = pkg.entries.get(p)
        rows.append((p, human(len(pkg.files[p])), human(e["stored"]) if e else "-",
                     METHODS[e["method"]] if e else "-", sha(pkg.files[p]).hex()[:12]))
    return rows


def cmd_info(a):
    pkg = load_package(a.file, clean=a.clean, pid=a.id)
    if a.json:
        print(json.dumps(dict(
            kind=pkg.kind, id=pkg.pid, manifest=pkg.manifest, header=pkg.header,
            files=[dict(path=r[0], size=len(pkg.files[r[0]]), sha256=sha(pkg.files[r[0]]).hex())
                   for r in file_rows(pkg)],
            valid=not pkg.problems, problems=pkg.problems, warnings=pkg.warnings), indent=2))
        return 1 if pkg.problems else 0

    m = pkg.manifest or {}
    title = "%s  v%s" % (m.get("name", "(unnamed)"), m.get("version", "?"))
    print(bold("PEK plugin: ") + cyan(title))

    def row(label, value):
        print("  " + label.ljust(13) + str(value))

    row("id", pkg.pid or "?")
    if m.get("author"):
        row("author", m["author"])
    if m.get("description"):
        lines = textwrap.wrap(str(m["description"]), 64) or [""]
        row("about", lines[0])
        for ln in lines[1:]:
            print("  " + " " * 13 + ln)
    ui = m.get("ui") if isinstance(m.get("ui"), dict) else {}
    if ui.get("navTab"):
        row("nav tab", ui["navTab"])
    fl = m.get("flutter") if isinstance(m.get("flutter"), dict) else {}
    if fl.get("screen"):
        row("screen", fl["screen"])
    perms = m.get("permissions") if isinstance(m.get("permissions"), dict) else {}
    net = perms.get("network") if isinstance(perms.get("network"), list) else []
    caps = [k for k, v in perms.items() if k != "network" and v]
    row("network", ", ".join(net) if net else "none")
    row("capabilities", ", ".join(caps) if caps else "none")
    py = [p for p in sorted(pkg.files) if ext_of(p) == "py"]
    if py:
        row("python", ", ".join("%s (%s)" % (p, human(len(pkg.files[p]))) for p in py))
    if pkg.kind == "pek":
        h = pkg.header
        packed = sum(e["stored"] for e in pkg.entries.values())
        row("container", "PEK format v%d, %d files, %s unpacked, %s packed, %s on disk"
            % (h["version"], h["files"], human(sum(len(v) for v in pkg.files.values())),
               human(packed), human(h["actual_size"])))
        ok = not any("SHA-256" in p or "checksum" in p for p in pkg.problems)
        row("sha256", (green("verified  ") if ok else red("MISMATCH  ")) + pkg.whole_sha.hex())
    else:
        row("container", yellow("ZIP: not a PEK yet. ") + "run: pektool.py convert " + a.file)
    for note in pkg.notes:
        print(dim("  note: " + note))
    print()
    if pkg.files:
        table(file_rows(pkg), ("FILE", "SIZE", "PACKED", "METHOD", "SHA-256"))
        print()
    for w in pkg.warnings:
        print(yellow("  [!] " + w))
    if pkg.problems:
        hint = "re-run with --clean to drop __pycache__, hidden files and data/ automatically." \
            if (pkg.kind == "zip" and pkg.saw_junk and not a.clean) else None
        show_reject(a.file, pkg.problems, hint)
        return 1
    print(green("VALID") + (" PEK plugin." if pkg.kind == "pek" else " plugin layout (still a ZIP)."))
    return 0


def cmd_verify(a):
    pkg = load_package(a.file, want="pek")
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    for w in pkg.warnings:
        print(yellow("  [!] " + w))
    print(green("OK  ") + bold(a.file) + " is a valid PEK plugin: %s v%s, %d files, untampered."
          % (pkg.manifest.get("name"), pkg.manifest.get("version"), len(pkg.files)))
    print(dim("    sha256 " + pkg.whole_sha.hex()))
    return 0


def cmd_ls(a):
    pkg = load_package(a.file, want="pek")
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    table(file_rows(pkg), ("FILE", "SIZE", "PACKED", "METHOD", "SHA-256"))
    return 0


def cmd_cat(a):
    pkg = load_package(a.file, want="pek")
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    if a.path not in pkg.files:
        raise Reject(a.file, ["no file named %r in this plugin" % a.path],
                     hint="files: " + ", ".join(sorted(pkg.files)))
    data = pkg.files[a.path]
    binary = b"\x00" in data[:4096]
    if binary and sys.stdout.isatty() and not a.force:
        eprint(yellow("%s is binary (%s). Use --force to print it anyway, or redirect: cat ... > file"
                      % (a.path, human(len(data)))))
        return 2
    sys.stdout.flush()
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    return 0


def cmd_extract(a):
    pkg = load_package(a.file, want="pek")
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    out = a.output or pkg.pid
    if os.path.isdir(out) and os.listdir(out) and not a.force:
        raise Reject(a.file, ["the folder %s already exists and is not empty" % out],
                     hint="use --force to write into it, or -o to pick another folder")
    root = os.path.abspath(out)
    for p, data in pkg.files.items():
        dest = os.path.abspath(os.path.join(root, *p.split("/")))
        if not dest.startswith(root + os.sep):      # belt and braces: check_path already rules this out
            raise Reject(a.file, ["%s would be written outside the output folder" % p])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(data)
    print(green("OK  ") + "extracted %d files to %s" % (len(pkg.files), out))
    return 0


def cmd_tozip(a):
    pkg = load_package(a.file, want="pek")
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    out = a.output or os.path.join(os.path.dirname(os.path.abspath(a.file)), pkg.pid + ".zip")
    if os.path.exists(out) and not a.force:
        raise Reject(a.file, ["%s already exists" % out], hint="use --force to overwrite it")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(pkg.files):
            zi = zipfile.ZipInfo(p, (1980, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.external_attr = 0o644 << 16
            z.writestr(zi, pkg.files[p])
    print(green("OK  ") + "wrote %s (%d files, plugin files at the top level)" % (out, len(pkg.files)))
    return 0


def cmd_hexmap(a):
    pkg = load_package(a.file, want="pek")
    h = pkg.header
    regions = [(0, HEADER_SIZE, "header", "")]
    for p, e in pkg.entries.items():
        regions.append((e["offset"], e["offset"] + e["stored"], p, METHODS[e["method"]]))
    regions.append((h["toc_offset"], h["toc_offset"] + h["toc_length"], "table of contents", "id + %d entries" % h["files"]))
    regions.append((h["actual_size"] - FOOTER_SIZE, h["actual_size"], "footer", "sha-256 of everything above"))
    print(bold("%-10s %-10s %8s  %s" % ("START", "END", "BYTES", "WHAT")))
    for s, e, what, extra in sorted(regions):
        print("0x%06x   0x%06x   %8d  %s %s" % (s, e, e - s, what, dim(extra)))
    if pkg.problems:
        raise Reject(a.file, pkg.problems)
    return 0


def read_folder(folder, clean):
    P, notes, files, junk = [], [], {}, False
    total = 0
    for root, dirs, names in os.walk(folder):
        dirs.sort()
        for nm in sorted(names):
            full = os.path.join(root, nm)
            rel = os.path.relpath(full, folder).replace(os.sep, "/")
            if is_junk(rel):
                junk = True
                if clean:
                    notes.append("dropped " + rel)
                    continue
            if os.path.islink(full):
                P.append("%s is a symbolic link, which plugins can't contain" % rel)
                continue
            size = os.path.getsize(full)
            if size > MAX_FILE_BYTES:
                P.append("%s is too large (limit 2 MB per file, this one is %s)" % (rel, human(size)))
                continue
            total += size
            if total > MAX_TOTAL_BYTES:
                P.append("the plugin is too large (limit 8 MB in total)")
                return files, P, notes, junk
            with open(full, "rb") as f:
                files[rel] = f.read()
    return files, P, notes, junk


def cmd_pack(a):
    folder = a.folder
    if not os.path.isdir(folder):
        raise Reject(folder, ["not a folder"])
    pid = a.id or slugify(os.path.basename(os.path.abspath(folder)))
    files, P, notes, junk = read_folder(folder, a.clean)
    if P:
        raise Reject(folder, P)
    out = a.output or default_out(pid, os.path.abspath(folder) + "/x")
    try:
        write_pek(pid, files, out, a.force, notes)
    except Reject as r:
        if junk and not a.clean:
            r.hint = r.hint or "re-run with --clean to drop __pycache__, hidden files and data/ automatically."
        r.what = folder
        raise
    return 0


def cmd_convert(a):
    if a.output and len(a.zips) > 1:
        eprint(red("ERROR: -o can only be used with one ZIP at a time"))
        return 2
    failed = 0
    for z in a.zips:
        try:
            with open(z, "rb") as f:
                head = f.read(8)
            if head[:4] == b"\x89PEK":
                raise Reject(z, ["this is already a PEK, not a ZIP"])
            if head[:4] not in (b"PK\x03\x04", b"PK\x05\x06"):
                raise Reject(z, ["this is not a ZIP file (it starts with %s)"
                                 % (" ".join("%02x" % b for b in head) or "nothing: the file is empty")])
            pkg = load_zip(z, a.clean, a.id)
            if pkg.problems:
                raise Reject(z, pkg.problems,
                             hint="re-run with --clean to drop __pycache__, hidden files and data/ automatically."
                             if pkg.saw_junk and not a.clean else None)
            write_pek(pkg.pid, pkg.files, a.output or default_out(pkg.pid, z), a.force, pkg.notes)
        except Reject as r:
            show_reject(r.what if r.what else z, r.problems, r.hint)
            failed += 1
    return 1 if failed else 0


# ----------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="pektool", formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Inspect, verify, build and convert .PEK plugin files for PEK TV.",
        epilog=textwrap.dedent("""\
            examples:
              pektool.py convert weather.zip            -> weather.PEK
              pektool.py convert --clean myplugin.zip   drop __pycache__, hidden files, data/
              pektool.py info weather.PEK
              pektool.py cat weather.PEK plugin.json
              pektool.py verify weather.PEK && echo safe
            Anything that is not a correct PEK plugin is rejected in red (exit code 1)."""))
    ap.add_argument("--no-color", action="store_true", help="plain output (also: NO_COLOR=1)")
    ap.add_argument("-V", "--version", action="version", version="pektool %s (PEK format v%d)" % (TOOL_VERSION, FORMAT_VERSION))
    sub = ap.add_subparsers(dest="cmd", metavar="COMMAND")

    def add(name, fn, help_):
        sp = sub.add_parser(name, help=help_, description=help_)
        sp.set_defaults(fn=fn)
        return sp

    sp = add("info", cmd_info, "show what a .PEK (or a .zip) contains")
    sp.add_argument("file")
    sp.add_argument("--json", action="store_true", help="machine-readable output")
    sp.add_argument("--clean", action="store_true", help="(zip) preview with junk files dropped")
    sp.add_argument("--id", help="(zip) plugin id to use")

    sp = add("verify", cmd_verify, "check a .PEK: structure, hashes, plugin rules (exit 1 if invalid)")
    sp.add_argument("file")

    sp = add("ls", cmd_ls, "list the files in a .PEK")
    sp.add_argument("file")

    sp = add("cat", cmd_cat, "print one file from a .PEK")
    sp.add_argument("file")
    sp.add_argument("path")
    sp.add_argument("--force", action="store_true", help="print binary files to the terminal")

    sp = add("extract", cmd_extract, "unpack a .PEK into a folder (safe paths only)")
    sp.add_argument("file")
    sp.add_argument("-o", "--output", help="folder (default: the plugin id)")
    sp.add_argument("--force", action="store_true")

    sp = add("pack", cmd_pack, "build a .PEK from a plugin folder")
    sp.add_argument("folder")
    sp.add_argument("-o", "--output", help="output file (default: <id>.PEK next to the folder)")
    sp.add_argument("--id", help="plugin id (default: the folder name)")
    sp.add_argument("--clean", action="store_true", help="drop __pycache__, *.pyc, hidden files and data/")
    sp.add_argument("--force", action="store_true", help="overwrite an existing file")

    sp = add("convert", cmd_convert, "convert one or more plugin .zip files into .PEK files")
    sp.add_argument("zips", nargs="+", metavar="zip")
    sp.add_argument("-o", "--output", help="output file (single zip only; default: <id>.PEK next to the zip)")
    sp.add_argument("--id", help="plugin id (default: from the zip name)")
    sp.add_argument("--clean", action="store_true", help="drop __pycache__, *.pyc, hidden files and data/")
    sp.add_argument("--force", action="store_true", help="overwrite an existing file")

    sp = add("tozip", cmd_tozip, "turn a .PEK back into a plain .zip")
    sp.add_argument("file")
    sp.add_argument("-o", "--output")
    sp.add_argument("--force", action="store_true")

    sp = add("hexmap", cmd_hexmap, "show which byte range of a .PEK holds what")
    sp.add_argument("file")

    a = ap.parse_args(argv)
    _setup_terminal(a.no_color)
    if not a.cmd:
        ap.print_help()
        return 2
    try:
        return a.fn(a) or 0
    except Reject as r:
        show_reject(r.what, r.problems, r.hint)
        return 1
    except (OSError, IOError) as e:
        eprint(red("ERROR: %s" % e))
        return 2
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
