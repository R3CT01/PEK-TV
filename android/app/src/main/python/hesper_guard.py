"""PEK plugin guard: decides whether a plugin's Python backend may run, and how.

Used by the C++ core (backend/core.cpp) and by the Android runner
(hesper_runner.py). Both call run_plugin().

Two tiers
---------
1. TRUSTED plugins (bundled ones, or any named in the PEK_TRUSTED_PLUGINS
   environment variable, comma separated) run exactly as before, with full access.
2. EVERYTHING ELSE must pass these layers, or it does not run:
   a. plugin.json manifest declaring its permissions (network hosts, storage).
   b. A static allowlist scan of every .py file in the plugin: only a short list
      of imports, no eval/exec/open/getattr/..., no dunder tricks, no native code.
   c. All real work goes through the host module `pek_host` (also importable as `hesper_host`, the old name), which enforces the
      manifest: https only, allowlisted hosts only, no private/loopback addresses
      (this also stops a plugin reaching PEK's own API), size and time limits,
      files only inside <plugin>/data/. A plugin that declares "library": true may also call
      pek_host.library_titles() for the titles and years in the user's library.
   d. A runtime backstop (audit hook): blocks processes, raw sockets, ctypes and
      file access outside the plugin while its code runs, plus a time limit.

Honest limits: layer (d) is defence in depth, not a perfect sandbox. Python cannot
be fully sandboxed from inside itself, and a regex that backtracks forever cannot be
interrupted. Treat tier 2 as "reviewed-safe by construction", and keep untrusted
code to plugins whose manifest and source you or a registry have looked at.
"""
import ast
import hashlib
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import sysconfig
import threading
import time
import types
import urllib.parse
import importlib.util

# Plugins that ship with PEK and keep full access (as they always had).
BUNDLED_TRUSTED = {"weather", "sample_scraper"}

MANIFEST_NAME = "plugin.json"
MAX_SOURCE_BYTES = 200 * 1024
MAX_LINE_LENGTH = 500
RUN_TIME_LIMIT_SEC = 10.0

ALLOWED_IMPORTS = {
    "json", "re", "math", "datetime", "time", "collections", "itertools", "functools",
    "string", "textwrap", "html", "urllib.parse", "base64", "hashlib", "random",
    "statistics", "decimal", "fractions", "typing", "dataclasses", "enum", "copy",
    "operator", "unicodedata", "pek_host", "hesper_host", "pek_ui",
}

FORBIDDEN_CALLS = {
    "eval", "exec", "compile", "__import__", "open", "input", "breakpoint",
    "getattr", "setattr", "delattr", "vars", "globals", "locals", "memoryview",
}

# Attributes that reach into interpreter internals.
FORBIDDEN_ATTRS = {
    "mro", "gi_frame", "gi_code", "f_globals", "f_locals", "f_back", "f_builtins",
    "tb_frame", "tb_next", "cr_frame", "ag_frame", "func_globals", "co_code",
}

# Modules re-export their own imports (typing.sys, json.codecs, ...), which would be a
# way back to os/sys. Names that lead there are refused, along with every attribute
# starting with an underscore (collections._sys, random._os, ...).
ESCAPE_ATTRS = {
    "sys", "os", "posix", "nt", "modules", "environ", "environb", "getenv", "builtins",
    "importlib", "codecs", "io", "subprocess", "socket", "pathlib", "shutil", "open",
    "system", "popen", "path", "stdout", "stderr", "stdin",
}

# "{0.sys}" or "{x[0]}" inside a str.format() template walks attributes without any
# ast.Attribute node, so templates that do that are refused.
_FORMAT_TRAVERSAL = re.compile(r"\{\w*[.\[]")

NATIVE_OR_COMPILED = {".so", ".pyd", ".dll", ".dylib", ".pyc", ".pyo"}


class GuardError(Exception):
    pass


class PluginTimeout(BaseException):
    """BaseException so a plugin's `except Exception` cannot swallow it."""


# --------------------------------------------------------------------------
# Trust
# --------------------------------------------------------------------------

def trusted_names():
    names = set(BUNDLED_TRUSTED)
    extra = os.environ.get("PEK_TRUSTED_PLUGINS") or os.environ.get("HESPER_TRUSTED_PLUGINS", "")   # old name still honoured
    names.update(n.strip() for n in extra.split(",") if n.strip())
    return names


# --------------------------------------------------------------------------
# Manifest
# --------------------------------------------------------------------------

def load_manifest(folder):
    """Returns (manifest dict, error string or None). Missing manifest = no permissions."""
    path = os.path.join(folder, MANIFEST_NAME)
    if not os.path.isfile(path):
        return {"permissions": {}}, None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:  # noqa: BLE001
        return None, "%s is not valid JSON (%s)" % (MANIFEST_NAME, e)
    if not isinstance(data, dict):
        return None, "%s must contain a JSON object" % MANIFEST_NAME
    perms = data.get("permissions", {})
    if not isinstance(perms, dict):
        return None, "'permissions' must be an object"
    net = perms.get("network", [])
    if not (isinstance(net, list) and all(isinstance(h, str) for h in net)):
        return None, "'permissions.network' must be a list of host names"
    for h in net:
        if not re.fullmatch(r"(\*\.)?[A-Za-z0-9.-]+", h) or h.replace("*.", "").count(".") < 1:
            return None, "invalid network host %r" % h
        try:
            ipaddress.ip_address(h)
            return None, "network permissions must be host names, not IP addresses (%r)" % h
        except ValueError:
            pass
    if not isinstance(perms.get("library", False), bool):
        return None, "'permissions.library' must be true or false"
    for flag in ("send", "playback"):
        if not isinstance(perms.get(flag, False), bool):
            return None, "'permissions.%s' must be true or false" % flag
    fl = data.get("flutter")
    if isinstance(fl, dict) and "hooks" in fl and not (isinstance(fl["hooks"], str) and re.fullmatch(r"[a-z0-9_]{1,40}\.py", fl["hooks"])):
        return None, "'flutter.hooks' must be a file name such as \"hooks.py\""
    if perms.get("playback") and not (isinstance(fl, dict) and "hooks" in fl):
        return None, "the 'playback' permission needs \"flutter\": {\"hooks\": \"hooks.py\"}"
    return data, None


def _host_allowed(host, allowed):
    host = host.lower().rstrip(".")
    for pattern in allowed:
        p = pattern.lower()
        if p.startswith("*."):
            if host.endswith(p[1:]) and host != p[2:]:
                return True
        elif host == p:
            return True
    return False


# --------------------------------------------------------------------------
# Static scan (layer b)
# --------------------------------------------------------------------------

def scan_source(source, filename, sibling_modules=()):
    """Returns a list of human-readable violations (empty list = passes)."""
    problems = []
    if len(source.encode("utf-8", "replace")) > MAX_SOURCE_BYTES:
        return ["%s: file is larger than %d KB" % (filename, MAX_SOURCE_BYTES // 1024)]
    for n, line in enumerate(source.splitlines(), 1):
        if len(line) > MAX_LINE_LENGTH:
            problems.append("%s:%d: line over %d characters (minified or obfuscated code)" % (filename, n, MAX_LINE_LENGTH))
            break
    try:
        tree = ast.parse(source, filename)
    except SyntaxError as e:
        return ["%s:%s: syntax error (%s)" % (filename, e.lineno, e.msg)]

    allowed = set(ALLOWED_IMPORTS) | set(sibling_modules)

    def bad(node, msg):
        problems.append("%s:%d: %s" % (filename, getattr(node, "lineno", 0), msg))

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name not in allowed:
                    bad(node, "import of %r is not allowed" % a.name)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                bad(node, "relative imports are not allowed")
            elif (node.module or "") not in allowed:
                bad(node, "import from %r is not allowed" % node.module)
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_CALLS:
                bad(node, "use of %r is not allowed" % node.id)
            elif node.id.startswith("__") and node.id not in ("__name__",):
                bad(node, "name %r is not allowed" % node.id)
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr in FORBIDDEN_ATTRS or node.attr in ESCAPE_ATTRS:
                bad(node, "attribute %r is not allowed" % node.attr)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            # Blocks "{0.__globals__}".format(f) style leaks and string-built dunder lookups.
            if "__" in node.value:
                bad(node, "string containing '__' is not allowed")
            elif _FORMAT_TRAVERSAL.search(node.value):
                bad(node, "format template that reads attributes or items is not allowed")
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            pass
    return problems


def scan_plugin_folder(folder):
    """Scans every .py file in the plugin folder (top level only). Returns violations."""
    problems = []
    try:
        entries = sorted(os.listdir(folder))
    except OSError as e:
        return ["cannot read plugin folder (%s)" % e]
    siblings = {e[:-3] for e in entries if e.endswith(".py") and e != "__init__.py"}
    for entry in entries:
        full = os.path.join(folder, entry)
        if entry == "__pycache__" or entry.startswith("."):
            continue
        if os.path.isdir(full):
            if entry == "data":
                continue
            for root, _dirs, files in os.walk(full):
                for f in files:
                    if f.endswith(".py"):
                        problems.append("%s: Python files in subfolders are not allowed" % os.path.join(entry, f))
            continue
        ext = os.path.splitext(entry)[1].lower()
        if ext in NATIVE_OR_COMPILED:
            problems.append("%s: native or compiled code is not allowed" % entry)
        elif ext == ".py":
            try:
                with open(full, "r", encoding="utf-8") as f:
                    problems.extend(scan_source(f.read(), entry, siblings - {entry[:-3]}))
            except (OSError, UnicodeDecodeError) as e:
                problems.append("%s: cannot read as UTF-8 text (%s)" % (entry, e))
    return problems


# --------------------------------------------------------------------------
# Host API for plugins (layer c): the module a guarded plugin imports as pek_host (or hesper_host)
# --------------------------------------------------------------------------

_state = threading.local()


class _Privileged:
    """Host code runs with the runtime backstop lifted (it is trusted)."""
    def __enter__(self):
        _state.privileged = getattr(_state, "privileged", 0) + 1

    def __exit__(self, *exc):
        _state.privileged -= 1


_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class _PinnedHTTPS(http.client.HTTPSConnection):
    """Connects to an IP we already validated, but verifies the certificate for the host name."""
    def __init__(self, host, ip, **kw):
        super().__init__(host, **kw)
        self._pinned_ip = ip

    def connect(self):
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _resolve_public(host, port):
    """Resolves host and returns one public IP, or raises PermissionError."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as e:
        raise ConnectionError("could not resolve %s (%s)" % (host, e))
    for family, _t, _p, _c, addr in infos:
        ip = ipaddress.ip_address(addr[0])
        if not ip.is_global:
            raise PermissionError("%s resolves to a non-public address; blocked" % host)
    return infos[0][4][0]


def build_host_module(plugin_id, folder, manifest):
    perms = manifest.get("permissions", {})
    allowed_hosts = list(perms.get("network", []))
    storage_ok = bool(perms.get("storage", False))
    library_ok = bool(perms.get("library", False))
    send_ok = bool(perms.get("send", False))
    data_dir = os.path.join(folder, "data")
    mod = types.ModuleType("pek_host")

    def _need_storage():
        if not storage_ok:
            raise PermissionError("plugin.json does not request the 'storage' permission")

    def _data_path(name):
        if not isinstance(name, str) or not _NAME_RE.match(name):
            raise ValueError("file name must be letters, digits, '.', '_' or '-' (no folders)")
        return os.path.join(data_dir, name)

    def fetch_text(url, headers=None, timeout=5, max_bytes=1000000):
        """HTTPS GET of an allowlisted host. Returns the body as text."""
        with _Privileged():
            hops = 0
            while True:
                u = urllib.parse.urlsplit(url)
                if u.scheme != "https":
                    raise PermissionError("only https:// URLs are allowed")
                if not u.hostname or u.username or u.password:
                    raise PermissionError("invalid URL")
                if not _host_allowed(u.hostname, allowed_hosts):
                    raise PermissionError("host %r is not in this plugin's network permissions" % u.hostname)
                port = u.port or 443
                ip = _resolve_public(u.hostname, port)
                conn = _PinnedHTTPS(u.hostname, ip, port=port, timeout=min(float(timeout), 10.0),
                                    context=ssl.create_default_context())
                try:
                    path = (u.path or "/") + ("?" + u.query if u.query else "")
                    hdrs = {"User-Agent": "PEK-Plugin/" + plugin_id, "Accept-Encoding": "identity"}
                    for k, v in (headers or {}).items():
                        if str(k).lower() not in ("host", "cookie", "authorization", "proxy-authorization"):
                            hdrs[str(k)] = str(v)
                    conn.request("GET", path, headers=hdrs)
                    resp = conn.getresponse()
                    if resp.status in (301, 302, 303, 307, 308) and resp.getheader("Location"):
                        hops += 1
                        if hops > 3:
                            raise ConnectionError("too many redirects")
                        url = urllib.parse.urljoin(url, resp.getheader("Location"))
                        continue
                    if resp.status != 200:
                        raise ConnectionError("HTTP %d" % resp.status)
                    body = resp.read(max_bytes + 1)
                    if len(body) > max_bytes:
                        raise ValueError("response larger than %d bytes" % max_bytes)
                    return body.decode("utf-8", "replace")
                finally:
                    conn.close()

    def fetch_json(url, **kw):
        return json.loads(fetch_text(url, **kw))

    def write_text(name, text):
        _need_storage()
        if not isinstance(text, str) or len(text.encode("utf-8")) > 1000000:
            raise ValueError("text must be a string under 1 MB")
        with _Privileged():
            os.makedirs(data_dir, exist_ok=True)
            tmp = "%s.%d.tmp" % (_data_path(name), threading.get_ident())     # one per thread: two writers must not share it
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, _data_path(name))

    def read_text(name):
        _need_storage()
        with _Privileged():
            with open(_data_path(name), "r", encoding="utf-8") as f:
                return f.read(1000001)

    def write_json(name, obj):
        write_text(name, json.dumps(obj))

    def read_json(name):
        return json.loads(read_text(name))

    def _library_file(name, env_names):
        """A file of the library scanner (library.db, or the old media_cache.tsv). Its place depends on the build:
        Android keeps it next to the plugins folder, Termux one level further up."""
        plugins_dir = os.path.dirname(os.path.normpath(folder))
        candidates = []
        for env_name in env_names:
            env = os.environ.get(env_name)
            if env:
                candidates.append(env)
        candidates.append(os.path.join(plugins_dir, "..", name))
        candidates.append(os.path.join(plugins_dir, "..", "..", name))
        for c in candidates:
            c = os.path.normpath(c)
            if os.path.isfile(c):
                return c
        return None

    def _as_int(text):
        try:
            return int(text)
        except ValueError:
            return 0

    def _titles_from_db(path):
        """Movies and shows from library.db (opened read-only), or None when it cannot be read."""
        import sqlite3
        import urllib.parse
        try:
            con = sqlite3.connect("file:" + urllib.parse.quote(path) + "?mode=ro", uri=True, timeout=5)
        except sqlite3.Error:
            return None
        try:
            rows = con.execute("SELECT kind, title, year, show_title FROM media WHERE kind IN (0, 1)").fetchall()
        except sqlite3.Error:
            return None
        finally:
            con.close()
        return rows

    def library_titles():
        """Titles and years from the user's library: [{"title", "year", "kind": "movie"|"tv"}].
        Needs "library": true in plugin.json. Never returns file names or folders. The list is
        the one the scanner last saved, so it can be a little behind the files on disk."""
        if not library_ok:
            raise PermissionError("plugin.json does not request the 'library' permission")
        with _Privileged():
            rows = []                       # (kind 0 = movie / 1 = episode, movie title, year, show title)
            db_path = _library_file("library.db", ("PEK_LIBRARY_DB",))
            found = _titles_from_db(db_path) if db_path else None
            if found is not None:
                rows = found
            else:                           # an older install that has not moved to the database yet
                tsv = _library_file("media_cache.tsv", ("PEK_LIBRARY_CACHE", "HESPER_LIBRARY_CACHE"))   # old name still honoured
                if tsv:
                    with open(tsv, "r", encoding="utf-8", errors="replace") as f:
                        if f.readline().startswith("#hesper-cache-"):
                            for line in f:
                                cols = line.rstrip("\n").split("\t")
                                if len(cols) >= 11 and cols[5] in ("0", "1"):
                                    rows.append((int(cols[5]), cols[6], _as_int(cols[7]), cols[8]))
            out = []
            seen = set()
            for kind_code, movie_title, movie_year, show_title in rows:
                if kind_code == 0:
                    title, year, kind = (movie_title or "").strip(), int(movie_year or 0), "movie"
                else:
                    title, year, kind = (show_title or "").strip(), 0, "tv"
                key = (kind, title.lower(), year)
                if title and key not in seen:
                    seen.add(key)
                    out.append({"title": title, "year": year, "kind": kind})
                if len(out) >= 20000:
                    break
            return out

    _SEND_BLOCKED = ("host", "cookie", "proxy-authorization", "content-length", "transfer-encoding", "connection", "upgrade")

    def request_json(method, url, body=None, headers=None, timeout=10, max_bytes=2000000):
        """HTTPS GET or POST of JSON to an allowlisted host. Needs "send": true in plugin.json.

        Unlike fetch_text, a plugin may send an Authorization header here (that is what signing in to a service
        needs) and gets the status back instead of an exception, so it can tell "pending" from "denied". Redirects
        are never followed, so a header can only ever go to the host the plugin named. Returns
        {"status": int, "data": parsed JSON or None, "page_count": int, "retry_after": int}."""
        if not send_ok:
            raise PermissionError("plugin.json does not request the 'send' permission")
        method = str(method).upper()
        if method not in ("GET", "POST"):
            raise ValueError("method must be 'GET' or 'POST'")
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            if len(payload) > 262144:
                raise ValueError("request body larger than 256 KB")
        with _Privileged():
            u = urllib.parse.urlsplit(url)
            if u.scheme != "https":
                raise PermissionError("only https:// URLs are allowed")
            if not u.hostname or u.username or u.password:
                raise PermissionError("invalid URL")
            if not _host_allowed(u.hostname, allowed_hosts):
                raise PermissionError("host %r is not in this plugin's network permissions" % u.hostname)
            port = u.port or 443
            ip = _resolve_public(u.hostname, port)
            conn = _PinnedHTTPS(u.hostname, ip, port=port, timeout=min(float(timeout), 10.0),
                                context=ssl.create_default_context())
            try:
                path = (u.path or "/") + ("?" + u.query if u.query else "")
                hdrs = {"User-Agent": "PEK-Plugin/" + plugin_id, "Accept-Encoding": "identity", "Accept": "application/json"}
                if payload is not None:
                    hdrs["Content-Type"] = "application/json"
                for k, v in (headers or {}).items():
                    if str(k).lower() not in _SEND_BLOCKED:
                        hdrs[str(k)] = str(v)
                conn.request(method, path, body=payload, headers=hdrs)
                resp = conn.getresponse()
                raw = resp.read(max_bytes + 1)
                if len(raw) > max_bytes:
                    raise ValueError("response larger than %d bytes" % max_bytes)
                text = raw.decode("utf-8", "replace")
                data = None
                if text.strip():
                    try:
                        data = json.loads(text)
                    except ValueError:
                        data = None

                def _num(name):
                    try:
                        return max(0, int(resp.getheader(name) or 0))
                    except ValueError:
                        return 0
                return {"status": resp.status, "data": data,
                        "page_count": _num("X-Pagination-Page-Count"), "retry_after": _num("Retry-After")}
            finally:
                conn.close()

    def log(*parts):
        print("[plugin %s]" % plugin_id, *[str(p)[:500] for p in parts])

    for fn in (fetch_text, fetch_json, request_json, write_text, read_text, write_json, read_json, library_titles, log):
        setattr(mod, fn.__name__, fn)
    return mod


# --------------------------------------------------------------------------
# Runtime backstop (layer d)
# --------------------------------------------------------------------------

_DENY_PREFIXES = (
    "os.system", "os.exec", "os.spawn", "os.posix_spawn", "os.fork", "os.forkpty", "os.kill",
    "os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.symlink",
    "os.link", "os.truncate", "os.putenv", "os.unsetenv", "os.setuid", "os.setgid",
    "subprocess.", "ctypes.", "socket.", "shutil.", "pty.", "signal.", "http.client.",
    "urllib.Request", "smtplib.", "ftplib.", "telnetlib.", "imaplib.", "poplib.",
    "webbrowser.", "pickle.", "ssl.",
)
_DENY_IMPORTS = {"ctypes", "_ctypes", "subprocess", "multiprocessing", "pty", "shutil",
                 "tkinter", "webbrowser", "pickle", "marshal"}

_READ_ROOTS = ()
_hook_installed = False


def _compute_read_roots():
    roots = set()
    for key in ("stdlib", "platstdlib", "purelib", "platlib"):
        p = sysconfig.get_paths().get(key)
        if p:
            roots.add(os.path.realpath(p))
    for p in (sys.prefix, sys.base_prefix, sys.exec_prefix):
        if p:
            roots.add(os.path.realpath(p))
    for p in sys.path:
        if p and os.path.exists(p):          # directories, and zip files on Android
            roots.add(os.path.realpath(p))
    return tuple(sorted(roots))


def _under(path, roots):
    for r in roots:
        if path == r or path.startswith(r + os.sep):
            return True
    return False


def _where():
    """The last few places in the code that led to a blocked action ("file.py:123 func"), so the message says WHAT tried it."""
    out = []
    try:
        f = sys._getframe(2)
        while f is not None and len(out) < 4:
            name = os.path.basename(f.f_code.co_filename)
            if name != "hesper_guard.py":
                out.append("%s:%d %s" % (name, f.f_lineno, f.f_code.co_name))
            f = f.f_back
    except Exception:  # noqa: BLE001
        pass
    return " < ".join(out) or "unknown"


def _from_chaquopy_importer():
    """True when Chaquopy's own importer is on the call stack. The first time something imports a native module it
    extracts it from the APK (stdlib-armeabi-v7a and friends): creating folders, writing temp files, renaming and
    chmod-ing them. None of that is the plugin's doing, so the guard lets it through.

    A frame counts only if the code's file is called importer.py AND that file is NOT inside the plugin's own folder.
    (The module name is not checked: it differs between Chaquopy versions. A plugin cannot change its code's file name
    without compile/exec, which the static scan refuses, and it can only write inside its own data/ folder.)"""
    try:
        folder = _state.roots[-1] if getattr(_state, "roots", None) else None
        f = sys._getframe(1)
        n = 0
        while f is not None and n < 80:
            code_file = f.f_code.co_filename or ""
            if os.path.basename(code_file) == "importer.py":
                real = os.path.realpath(code_file)
                if not folder or not (real == folder or real.startswith(folder + os.sep)):
                    return True
            f = f.f_back
            n += 1
    except Exception:  # noqa: BLE001
        pass
    return False


def _check(event, args):
    if not getattr(_state, "active", False) or getattr(_state, "privileged", 0):
        return
    if event.startswith(_DENY_PREFIXES):
        raise PermissionError("blocked by PEK plugin guard: %s" % event)
    if event == "import":
        top = str(args[0]).split(".")[0]
        if top in _DENY_IMPORTS:
            raise PermissionError("blocked by PEK plugin guard: import %s" % top)
    elif event == "open":
        target, mode, flags = args[0], args[1], args[2]
        if isinstance(target, int):
            return
        try:
            path = os.path.realpath(os.fsdecode(target))
        except Exception:  # noqa: BLE001
            raise PermissionError("blocked by PEK plugin guard: unreadable path")
        writes = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC)) \
            or (isinstance(mode, str) and any(c in mode for c in "wax+"))
        if writes:
            raise PermissionError("blocked by PEK plugin guard: file writes to '%s' from %s (use pek_host.write_json) [guard 2]"
                                  % (os.path.basename(path), _where()))
        if not _under(path, _state.roots):
            raise PermissionError("blocked by PEK plugin guard: reading outside the plugin folder")
    elif event in ("os.listdir", "os.scandir", "glob.glob"):
        target = args[0]
        if target is not None and not isinstance(target, int):
            try:
                path = os.path.realpath(os.fsdecode(target))
            except Exception:  # noqa: BLE001
                return
            if not _under(path, _state.roots):
                raise PermissionError("blocked by PEK plugin guard: listing outside the plugin folder")


def _hook(event, args):
    """Runs _check on every audit event. Only when _check would block something do we look at the call stack (that
    walk is too slow for every event), and Chaquopy's own module extraction is let through."""
    try:
        _check(event, args)
    except PermissionError:
        if _from_chaquopy_importer():
            return
        raise


def _install_hook():
    global _hook_installed, _READ_ROOTS
    if _hook_installed:
        return
    # Make sure the modules host code needs are loaded before the hook is active.
    import http.client, ssl, socket, ipaddress, urllib.parse  # noqa: F401,E401
    _READ_ROOTS = _compute_read_roots()
    sys.addaudithook(_hook)
    _hook_installed = True


def _make_tracer(deadline):
    def tracer(frame, event, arg):
        if time.monotonic() > deadline:
            raise PluginTimeout("plugin exceeded its %.0f second time limit" % RUN_TIME_LIMIT_SEC)
        return tracer
    return tracer


def _run_guarded(plugin_id, folder, module_name, manifest):
    host = build_host_module(plugin_id, folder, manifest)
    result = {"error": None}

    def worker():
        _state.active = True
        _state.privileged = 0
        _state.roots = _READ_ROOTS + (os.path.realpath(folder),)
        sys.settrace(_make_tracer(time.monotonic() + RUN_TIME_LIMIT_SEC))
        try:
            spec = importlib.util.spec_from_file_location(
                "pek_plugin_" + re.sub(r"\W", "_", plugin_id), os.path.join(folder, module_name + ".py"))
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            fn = getattr(mod, "run", None)
            if callable(fn):
                fn()
            else:
                print("[PEK Plugin Guard] '%s' has no callable run()." % plugin_id)
        except PermissionError as e:
            result["error"] = "permission denied: %s" % e
        except PluginTimeout as e:
            result["error"] = str(e)
        except BaseException as e:  # noqa: BLE001
            result["error"] = "%s: %s" % (type(e).__name__, e)
        finally:
            sys.settrace(None)
            _state.active = False

    # Siblings in the plugin folder are importable by the plugin; pek_host (and hesper_host) is injected.
    sys.path.insert(0, folder)
    saved = sys.modules.get("pek_host")
    saved_old = sys.modules.get("hesper_host")
    sys.modules["pek_host"] = host
    sys.modules["hesper_host"] = host   # old name, kept so existing plugins keep working
    try:
        t = threading.Thread(target=worker, name="pek-plugin-" + plugin_id, daemon=True)
        t.start()
        t.join(RUN_TIME_LIMIT_SEC + 5)
        if t.is_alive():
            result["error"] = "still running after the time limit (left in the background)"
    finally:
        try:
            sys.path.remove(folder)
        except ValueError:
            pass
        for name, prev in (("pek_host", saved), ("hesper_host", saved_old)):
            if prev is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prev
    return result["error"]


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def _run_legacy(module_name, path):
    """The original behaviour: import the module and call run(), full access."""
    sys.path.insert(0, path)
    sys.modules.pop(module_name, None)
    importlib.invalidate_caches()
    try:
        mod = importlib.import_module(module_name)
        fn = getattr(mod, "run", None)
        if callable(fn):
            fn()
        else:
            print("[PEK Plugin Guard] '%s' has no callable run()." % module_name)
    except Exception:  # noqa: BLE001
        import traceback
        print("[PEK Plugin Guard] '%s' in %s failed:" % (module_name, path))
        traceback.print_exc()
    finally:
        try:
            sys.path.remove(path)
        except ValueError:
            pass
        sys.modules.pop(module_name, None)


def run_plugin(module_name, path):
    """Runs one plugin backend, or refuses and says why. Never raises.

    Folder plugins: module_name == "backend", path == the plugin's folder.
    Loose plugins:  module_name == "<file stem>", path == the plugins folder.
    """
    try:
        loose = module_name != "backend"
        plugin_id = module_name if loose else os.path.basename(os.path.normpath(path))

        if plugin_id in trusted_names():
            print("[PEK Plugin Guard] '%s' is trusted: running with full access." % plugin_id)
            _run_legacy(module_name, path)
            return True

        if loose:
            print("[PEK Plugin Guard] REFUSED loose plugin '%s.py': move it into its own folder "
                  "with a plugin.json, or add it to PEK_TRUSTED_PLUGINS." % module_name)
            return False

        manifest, err = load_manifest(path)
        if err:
            print("[PEK Plugin Guard] REFUSED '%s': %s" % (plugin_id, err))
            return False
        problems = scan_plugin_folder(path)
        if problems:
            print("[PEK Plugin Guard] REFUSED '%s':" % plugin_id)
            for p in problems[:20]:
                print("    - " + p)
            if len(problems) > 20:
                print("    ... and %d more" % (len(problems) - 20))
            return False

        _install_hook()
        print("[PEK Plugin Guard] running '%s' sandboxed (network: %s, storage: %s)" % (
            plugin_id, ", ".join(manifest["permissions"].get("network", [])) or "none",
            "yes" if manifest["permissions"].get("storage") else "no"))
        err = _run_guarded(plugin_id, path, module_name, manifest)
        if err:
            print("[PEK Plugin Guard] '%s' stopped: %s" % (plugin_id, err))
            return False
        return True
    except Exception as e:  # noqa: BLE001
        print("[PEK Plugin Guard] error while handling '%s': %s: %s" % (module_name, type(e).__name__, e))
        return False
