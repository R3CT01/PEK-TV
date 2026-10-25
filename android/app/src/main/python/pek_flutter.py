"""pek_flutter: runs a plugin's Python screen (screen.py) for the Flutter UI.

Flutter cannot run JavaScript or load new code at run time, so a plugin screen is Python that returns
a small JSON tree of widgets (see pek_ui.py). Flutter draws the tree natively and sends every tap back here:

    Flutter  --call({"op": ...})-->  pek_flutter  -->  plugins/<id>/screen.py  (sandboxed, same rules as backend.py)
    Flutter  <--tree + effects----   pek_flutter

Everything the screen can do goes through the same guard as backend.py (hesper_guard.py): the manifest, the
static scan of every .py file, the allow-listed host API (pek_host) and the runtime backstop. This module only adds
the session: the tree, the tap handlers, background work and the "effects" (open a link, save a favorite) that
Flutter performs for the plugin.

Entry point for the Android host (Kotlin, through Chaquopy): call(json_text) -> json_text.
"""
import importlib.util
import json
import os
import re
import sys
import threading
import time
import traceback

import hesper_guard as g
import pek_ui

PLUGINS_DIR = ""                      # set by hesper_runner.run_all, or sent by the host with every call
SCREEN_FILE = "screen"                # plugins/<id>/screen.py
RENDER_LIMIT = 6.0                    # seconds a render() may take
EVENT_LIMIT = 15.0                    # seconds a tap handler may take
WORK_LIMIT = 25.0                     # seconds one ui.background(work) may take
RESERVED_HOST = "hesper-tmdb.aquariusibeats.workers.dev"
OFFICIAL_PROXY_PLUGINS = {"tmdb-discover"}   # the only plugin that may use PEK's built-in TMDb access
OFFICIAL_SKIN_PLUGINS = {"skin-maker"}       # the only plugin that may ask for the "skins" permission
OFFICIAL_WEATHER_PLUGINS = {"weather"}       # the only plugin that may ask for the "weather" permission (the app's city and unit)
RESERVED_HOSTS = {RESERVED_HOST: OFFICIAL_PROXY_PLUGINS}   # host -> the only plugins that may list it
HOOK_LIMIT = 25.0                     # seconds one on_event() may take (a scrobble can need two requests)
HOOK_EVENTS = {"app_start", "tick", "play", "pause", "resume", "stop", "watched", "rated", "favorited"}
HOOK_EFFECTS = {"watched.set", "watched.set_many", "ratings.set_many", "favorites.set_many"}   # all a hook may ask Flutter to do
ALLOWED_EFFECTS = {"open_url", "open_app", "open_plugin", "favorite.add", "favorite.remove", "watched.set", "watched.set_many", "ratings.set_many", "favorites.set_many", "torrent.play", "toast", "exit",
                   "skin.save", "skin.use", "skin.delete", "clipboard.copy", "weather.set"}

_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,39}$")
_SESSIONS = {}
_SESSIONS_LOCK = threading.Lock()
_HOOKS = {}                           # plugin id -> Session that runs hooks.py (separate from the screen's session)
_HOOKS_LOCK = threading.Lock()
_HOOK_FILE = re.compile(r"^[a-z0-9_]{1,40}\.py$")
_IMPORT_LOCK = threading.Lock()       # pek_host / pek_ui are swapped into sys.modules while a screen is imported


def log(*parts):
    print("[PEK Flutter Plugins]", *[str(p)[:500] for p in parts])


# ---------------------------------------------------------------------------------------------------------
# Running plugin code under the guard
# ---------------------------------------------------------------------------------------------------------

def _guarded(sess, fn, limit):
    """Runs fn() on its own thread with the plugin guard on (unless the plugin is trusted).
    Returns (value, error text or None). Never raises."""
    box = {"value": None, "error": None}

    def worker():
        pek_ui._tl.session = sess
        if sess.sandboxed:
            g._state.active = True
            g._state.privileged = 0
            g._state.roots = g._READ_ROOTS + (os.path.realpath(sess.folder),)
            sys.settrace(g._make_tracer(time.monotonic() + limit))
        try:
            box["value"] = fn()
        except PermissionError as e:
            box["error"] = "permission denied: %s" % e
            log("'%s' blocked: %s" % (sess.id, e))
            traceback.print_exc()
        except g.PluginTimeout:
            box["error"] = "plugin exceeded its %.0f second time limit" % limit
        except BaseException as e:  # noqa: BLE001 - a plugin must never take the host down
            box["error"] = "%s: %s" % (type(e).__name__, e)
            if isinstance(e, (OSError, ValueError)):      # a failed request is normal: one line, no stack
                log("'%s': %s" % (sess.id, box["error"]))
            else:
                log("'%s' raised:" % sess.id)
                traceback.print_exc()
        finally:
            sys.settrace(None)
            g._state.active = False
            pek_ui._tl.session = None

    t = threading.Thread(target=worker, name="pek-screen-" + sess.id, daemon=True)
    t.start()
    t.join(limit + 5)
    if t.is_alive():
        box["error"] = "still running after the time limit (left in the background)"
    return box["value"], box["error"]


# ---------------------------------------------------------------------------------------------------------
# One open screen
# ---------------------------------------------------------------------------------------------------------

def _forget_siblings(folder):
    """Drops the plugin's own helper modules from sys.modules. The screen and the hooks of one plugin run in separate
    sessions, each with its own pek_host, so they must not share an imported copy (and an update must not keep the old one)."""
    prefix = folder.rstrip(os.sep) + os.sep
    for name in list(sys.modules):
        f = getattr(sys.modules.get(name), "__file__", None)
        if isinstance(f, str) and f.startswith(prefix):
            sys.modules.pop(name, None)


class Session:
    def __init__(self, plugin_id, folder, manifest, sandboxed):
        self.id = plugin_id
        self.folder = folder
        self.manifest = manifest
        self.perms = manifest.get("permissions", {}) or {}
        self.hosts = list(self.perms.get("network", []) or [])
        self.sandboxed = sandboxed
        self.lock = threading.RLock()        # one tap / draw at a time
        self.busy_lock = threading.Lock()    # only guards the busy counter (ui.background is called while self.lock is held)
        self.module = None
        self.ctx = {}
        self.version = 0              # bumped whenever background work changed what the screen should show
        self.busy = 0                 # background jobs still running
        self.handlers = {}            # id -> (fn, argc) of the tree Flutter is showing now
        self.next_handlers = None     # being filled while render() runs
        self.input_values = {}
        self.input_handlers = {}
        self.next_inputs = None
        self.back = None
        self.scroll = 0
        self.effects = []
        self.error = ""
        self.stamp = None             # hook sessions: when the plugin's files last changed (a newer one reloads)

    # -- what pek_ui calls ------------------------------------------------------------------------------

    def need(self, permission):
        if not self.perms.get(permission):
            raise PermissionError("plugin.json does not request the '%s' permission" % permission)

    def host_listed(self, host):
        return g._host_allowed(host, self.hosts)

    def register(self, fn, argc):
        if fn is None:
            return ""
        if self.next_handlers is None:
            raise RuntimeError("buttons can only be created inside render()")
        hid = "h%d" % (len(self.next_handlers) + 1)
        self.next_handlers[hid] = (fn, argc)
        return hid

    def register_input(self, key, value, on_change):
        if self.next_inputs is None:
            raise RuntimeError("text boxes can only be created inside render()")
        self.next_inputs[key] = (str(value if value is not None else ""), on_change)

    def effect(self, op, **fields):
        if op not in ALLOWED_EFFECTS:
            raise PermissionError("unknown effect %r" % op)
        if len(self.effects) < 50:
            d = {"op": op}
            d.update(fields)
            self.effects.append(d)

    def set_back(self, fn):
        self.back = fn

    def scroll_top(self):
        self.scroll += 1

    def background(self, work, done, fail=None):
        with self.busy_lock:
            self.busy += 1

        def job():
            value, err = _guarded(self, work, WORK_LIMIT)
            with self.lock:
                try:
                    if err is None:
                        _, e2 = _guarded(self, lambda: done(value), EVENT_LIMIT)
                        if e2:
                            log("'%s' done() failed: %s" % (self.id, e2))
                    elif fail is not None:
                        _, e2 = _guarded(self, lambda: fail(err), EVENT_LIMIT)
                        if e2:
                            log("'%s' fail() failed: %s" % (self.id, e2))
                    else:
                        log("'%s' background work failed: %s" % (self.id, err))
                finally:
                    with self.busy_lock:
                        self.busy -= 1
                    self.version += 1

        threading.Thread(target=job, name="pek-bg-" + self.id, daemon=True).start()

    # -- drawing -----------------------------------------------------------------------------------------

    def render(self):
        """Calls the plugin's render() and returns the tree (or an error card)."""
        fn = getattr(self.module, "render", None) if self.module else None
        if not callable(fn):
            return self.error_tree("This plugin's screen.py has no render() function.")
        self.next_handlers = {}
        self.next_inputs = {}
        tree, err = _guarded(self, fn, RENDER_LIMIT)
        handlers, inputs = self.next_handlers, self.next_inputs
        self.next_handlers = None
        self.next_inputs = None
        if err or not isinstance(tree, dict):
            if not err:
                err = "render() must return a tree (ui.column(...))"
            return self.error_tree(err)
        self.handlers = handlers
        self.input_handlers = {k: v[1] for k, v in inputs.items()}
        self.input_values = {k: v[0] for k, v in inputs.items()}
        return tree

    def error_tree(self, message):
        self.error = message
        self.handlers = {"retry": (lambda: None, 0)}
        self.back = None
        return {"t": "column", "c": [
            {"t": "heading", "s": "This plugin screen stopped"},
            {"t": "text", "s": str(message)[:600]},
            {"t": "button", "s": "Try again", "primary": True, "sel": False, "af": "retry", "on": "retry"},
        ]}

    def response(self, with_tree=True):
        out = {"ok": True, "sid": self.id, "v": self.version, "busy": self.busy > 0,
               "back": self.back is not None, "scroll": self.scroll, "hosts": self.hosts,
               "name": str(self.manifest.get("name") or self.id)}
        if with_tree:
            out["tree"] = self.render()
            out["v"] = self.version
            out["busy"] = self.busy > 0
            out["back"] = self.back is not None
            out["scroll"] = self.scroll
        out["effects"] = self.effects
        self.effects = []
        return out

    def load(self, stem=SCREEN_FILE, run_start=True):
        """Imports screen.py (or the hooks file) under the guard and runs start() for a screen."""
        path = os.path.join(self.folder, stem + ".py")
        host = g.build_host_module(self.id, self.folder, self.manifest)

        def import_and_start():
            spec = importlib.util.spec_from_file_location("pek_" + stem + "_" + re.sub(r"\W", "_", self.id), path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            self.module = mod
            start = getattr(mod, "start", None)
            if run_start and callable(start):
                start()

        with _IMPORT_LOCK:
            saved = {n: sys.modules.get(n) for n in ("pek_host", "hesper_host", "pek_ui")}
            sys.modules["pek_host"] = host
            sys.modules["hesper_host"] = host
            sys.modules["pek_ui"] = pek_ui
            sys.path.insert(0, self.folder)
            _forget_siblings(self.folder)      # a helper module the plugin ships is imported fresh for this session
            try:
                _, err = _guarded(self, import_and_start, EVENT_LIMIT)
            finally:
                _forget_siblings(self.folder)
                try:
                    sys.path.remove(self.folder)
                except ValueError:
                    pass
                for n, prev in saved.items():
                    if prev is None:
                        sys.modules.pop(n, None)
                    else:
                        sys.modules[n] = prev
        return err


# ---------------------------------------------------------------------------------------------------------
# Operations (what Flutter can ask for)
# ---------------------------------------------------------------------------------------------------------

def _fail(message):
    return {"ok": False, "error": str(message)}


def _plugins_dir(req):
    d = str(req.get("pluginsDir") or "")
    if d:
        return d
    if PLUGINS_DIR:
        return PLUGINS_DIR
    try:
        import hesper_runner
        return getattr(hesper_runner, "PLUGINS_DIR", "") or ""
    except Exception:  # noqa: BLE001
        return ""


def _open(req):
    pid = str(req.get("id") or "")
    if not _ID.match(pid):
        return _fail("bad plugin id")
    ctx = req.get("ctx") if isinstance(req.get("ctx"), dict) else {}
    with _SESSIONS_LOCK:
        sess = _SESSIONS.get(pid)
        if sess is not None and not req.get("fresh"):
            with sess.lock:
                sess.ctx = ctx
                return _after_launch(sess, req)
        base = _plugins_dir(req)
        folder = os.path.join(base, pid) if base else ""
        if not folder or not os.path.isdir(folder):
            return _fail("plugin %s is not installed" % pid)
        if not os.path.isfile(os.path.join(folder, SCREEN_FILE + ".py")):
            return _fail("this plugin has no Flutter screen (screen.py)")

        trusted = pid in g.trusted_names()
        manifest, err = g.load_manifest(folder)
        if err:
            return _fail("plugin.json: %s" % err)
        hosts = [str(h).lower() for h in (manifest.get("permissions", {}).get("network", []) or [])]
        for reserved, owners in RESERVED_HOSTS.items():
            if reserved in hosts and pid not in owners:
                return _fail("%s is reserved for PEK's official plugins" % reserved)
        if manifest.get("permissions", {}).get("skins") and pid not in OFFICIAL_SKIN_PLUGINS:
            return _fail("the 'skins' permission is reserved for PEK's official Skin maker")
        if manifest.get("permissions", {}).get("weather") and pid not in OFFICIAL_WEATHER_PLUGINS:
            return _fail("the 'weather' permission is reserved for PEK's official Weather plugin")
        if not trusted:
            problems = g.scan_plugin_folder(folder)
            if problems:
                log("REFUSED '%s':" % pid)
                for p in problems[:20]:
                    log("    - " + p)
                return _fail("the safety scan refused this plugin: " + problems[0])
            g._install_hook()
        if pid in _SESSIONS:
            _SESSIONS.pop(pid, None)
        sess = Session(pid, folder, manifest, sandboxed=not trusted)
        sess.ctx = ctx
        with sess.lock:
            err = sess.load()
            if err:
                return _fail("could not start: %s" % err)
            _SESSIONS[pid] = sess
            return _after_launch(sess, req)


def _after_launch(sess, req):
    intent = req.get("launch")
    if isinstance(intent, dict) and intent.get("id") and intent.get("type"):
        fn = getattr(sess.module, "on_launch", None)
        if callable(fn):
            _, err = _guarded(sess, lambda: fn(intent), EVENT_LIMIT)
            if err:
                log("'%s' on_launch failed: %s" % (sess.id, err))
    return sess.response()


def _session(req):
    sess = _SESSIONS.get(str(req.get("id") or ""))
    if sess is None:
        return None
    if isinstance(req.get("ctx"), dict):
        sess.ctx = req["ctx"]
    return sess


def _event(req):
    sess = _session(req)
    if sess is None:
        return _fail("the plugin screen is not open")
    hid = str(req.get("handler") or "")
    value = req.get("value")
    inputs = req.get("inputs") if isinstance(req.get("inputs"), dict) else {}
    if hid == "retry":     # outside the session lock: _open takes the sessions lock first
        return _open({"id": sess.id, "fresh": True, "ctx": sess.ctx, "pluginsDir": os.path.dirname(sess.folder)})
    with sess.lock:
        # Text typed since the last tap reaches the plugin first, like the web UI's per-keystroke callbacks.
        for key, txt in inputs.items():
            if key in sess.input_values and sess.input_values[key] != str(txt):
                sess.input_values[key] = str(txt)
                cb = sess.input_handlers.get(key)
                if cb is not None:
                    _, err = _guarded(sess, lambda cb=cb, txt=txt: cb(str(txt)), EVENT_LIMIT)
                    if err:
                        log("'%s' text callback failed: %s" % (sess.id, err))
        if hid == "back":
            fn = sess.back
            if fn is None:
                sess.effect("exit")
            else:
                _, err = _guarded(sess, fn, EVENT_LIMIT)
                if err:
                    log("'%s' back handler failed: %s" % (sess.id, err))
        elif hid:
            entry = sess.handlers.get(hid)
            if entry is not None:      # an unknown id is a tap on a tree that has already been replaced
                fn, argc = entry
                if argc == 1:
                    if isinstance(value, str) and value in ("true", "false"):
                        value = (value == "true")
                    _, err = _guarded(sess, lambda: fn(value), EVENT_LIMIT)
                else:
                    _, err = _guarded(sess, fn, EVENT_LIMIT)
                if err:
                    log("'%s' handler failed: %s" % (sess.id, err))
                    sess.effect("toast", text="That did not work: " + err[:120])
        return sess.response()


def _poll(req):
    sess = _session(req)
    if sess is None:
        return _fail("the plugin screen is not open")
    since = req.get("since")
    with sess.lock:
        if since == sess.version:
            effects, sess.effects = sess.effects, []
            return {"ok": True, "same": True, "v": sess.version, "busy": sess.busy > 0, "effects": effects}
        return sess.response()


def _close(req):
    with _SESSIONS_LOCK:
        _SESSIONS.pop(str(req.get("id") or ""), None)
    return {"ok": True}


# ---------------------------------------------------------------------------------------------------------
# Hooks: PEK TV tells a plugin what is being played (no screen needed)
# ---------------------------------------------------------------------------------------------------------

def _int(v, lo, hi):
    try:
        return max(lo, min(hi, int(float(v))))
    except (TypeError, ValueError):
        return lo


def _float(v, lo, hi):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return lo
    return lo if f != f else max(lo, min(hi, f))      # NaN -> lo


def _clean_item(it):
    """A movie or episode, with only the fields a plugin may know (never a file name, id or folder)."""
    if not isinstance(it, dict) or it.get("kind") not in ("movie", "episode"):
        return None
    title = str(it.get("title") or "").strip()[:200]
    if not title:
        return None
    return {"kind": it["kind"], "title": title, "year": _int(it.get("year"), 0, 3000),
            "season": _int(it.get("season"), 0, 999), "episode": _int(it.get("episode"), 0, 9999)}


def _clean_event(ev):
    if not isinstance(ev, dict) or ev.get("type") not in HOOK_EVENTS:
        return None
    out = {"type": ev["type"]}
    if ev["type"] in ("play", "pause", "resume", "stop"):
        item = _clean_item(ev)
        if item is None:
            return None
        out.update(item)
        pos, dur = _float(ev.get("position"), 0, 1e7), _float(ev.get("duration"), 0, 1e7)
        out["position"], out["duration"] = pos, dur
        out["percent"] = round(min(100.0, pos * 100.0 / dur), 2) if dur > 0 else 0.0
    elif ev["type"] == "watched":
        items = [i for i in (_clean_item(x) for x in list(ev.get("items") or [])[:300]) if i]
        if not items:
            return None
        out["items"], out["value"] = items, bool(ev.get("value"))
    elif ev["type"] == "rated":
        items = []
        for x in list(ev.get("items") or [])[:300]:
            if not isinstance(x, dict) or x.get("kind") not in ("movie", "episode", "show"):
                continue
            title = str(x.get("title") or "").strip()[:200]
            if not title:
                continue
            items.append({"kind": x["kind"], "title": title, "year": _int(x.get("year"), 0, 3000),
                          "season": _int(x.get("season"), 0, 10000), "episode": _int(x.get("episode"), 0, 100000),
                          "rating": _int(x.get("rating"), 0, 10)})          # 0 = the rating was removed
        if not items:
            return None
        out["items"] = items
    elif ev["type"] == "favorited":
        items = []
        for x in list(ev.get("items") or [])[:300]:
            if not isinstance(x, dict) or x.get("kind") not in ("movie", "show"):
                continue
            title = str(x.get("title") or "").strip()[:200]
            if not title:
                continue
            items.append({"kind": x["kind"], "title": title, "year": _int(x.get("year"), 0, 3000), "tmdb": _int(x.get("tmdb"), 0, 10 ** 9)})
        if not items:
            return None
        out["items"], out["value"] = items, bool(ev.get("value"))
    return out


def _files_stamp(folder):
    newest = 0.0
    try:
        for n in os.listdir(folder):
            if n.endswith(".py") or n == "plugin.json":
                newest = max(newest, os.path.getmtime(os.path.join(folder, n)))
    except OSError:
        pass
    return newest


def _hook_session(pid, req):
    """The running hook session of a plugin (loading it, or loading it again after an update). (session, error)."""
    base = _plugins_dir(req)
    folder = os.path.join(base, pid) if base else ""
    if not folder or not os.path.isdir(folder):
        return None, "plugin %s is not installed" % pid
    with _HOOKS_LOCK:
        stamp = _files_stamp(folder)
        sess = _HOOKS.get(pid)
        if sess is not None and sess.stamp == stamp:
            return sess, None
        _HOOKS.pop(pid, None)
        manifest, err = g.load_manifest(folder)
        if err:
            return None, "plugin.json: %s" % err
        perms = manifest.get("permissions", {}) or {}
        fl = manifest.get("flutter")
        fname = fl.get("hooks") if isinstance(fl, dict) else None
        if not perms.get("playback") or not isinstance(fname, str) or not _HOOK_FILE.match(fname):
            return None, "this plugin does not ask for playback hooks"
        if not os.path.isfile(os.path.join(folder, fname)):
            return None, "%s is missing" % fname
        hosts = [str(h).lower() for h in (perms.get("network", []) or [])]
        for reserved, owners in RESERVED_HOSTS.items():
            if reserved in hosts and pid not in owners:
                return None, "%s is reserved for PEK's official plugins" % reserved
        trusted = pid in g.trusted_names()
        if not trusted:
            problems = g.scan_plugin_folder(folder)
            if problems:
                log("REFUSED hooks of '%s': %s" % (pid, problems[0]))
                return None, "the safety scan refused this plugin: " + problems[0]
            g._install_hook()
        sess = Session(pid, folder, manifest, sandboxed=not trusted)
        sess.stamp = stamp
        with sess.lock:
            err = sess.load(fname[:-3], run_start=False)
        if err:
            return None, "could not start the hooks: %s" % err
        _HOOKS[pid] = sess
        return sess, None


def _hook(req):
    pid = str(req.get("id") or "")
    if not _ID.match(pid):
        return _fail("bad plugin id")
    ev = _clean_event(req.get("event"))
    if ev is None:
        return _fail("bad event")
    sess, err = _hook_session(pid, req)
    if sess is None:
        return _fail(err)
    fn = getattr(sess.module, "on_event", None)
    if not callable(fn):
        return _fail("hooks file has no on_event(event)")
    ctx = req.get("ctx") if isinstance(req.get("ctx"), dict) else {}
    with sess.lock:
        sess.ctx = ctx
        sess.effects = []
        _, err = _guarded(sess, lambda: fn(ev), HOOK_LIMIT)
        effects = [e for e in sess.effects if e.get("op") in HOOK_EFFECTS]
        sess.effects = []
    if err:
        log("'%s' on_event(%s) failed: %s" % (pid, ev["type"], err))
        return {"ok": False, "error": str(err)[:300], "effects": effects}
    return {"ok": True, "effects": effects}


_OPS = {"open": _open, "event": _event, "poll": _poll, "close": _close, "hook": _hook}


def call(text):
    """The one entry point: a JSON request in, a JSON answer out. Never raises."""
    try:
        req = json.loads(text)
        fn = _OPS.get(req.get("op"))
        if fn is None:
            return json.dumps(_fail("unknown op"))
        answer = fn(req)
        for e in answer.get("effects", []) or []:
            if e.get("op") not in ALLOWED_EFFECTS:
                answer["effects"] = []
                break
        return json.dumps(answer)
    except BaseException as e:  # noqa: BLE001
        log("call failed:", type(e).__name__, e)
        traceback.print_exc()
        return json.dumps(_fail("%s: %s" % (type(e).__name__, e)))
