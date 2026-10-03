"""Runs Hesper's Python plugins on Android (via Chaquopy).

Mirrors HesperCore::executePluginModule / runFolderPlugins in backend/core.cpp:
every plugins/<name>/backend.py that defines run() is imported and run() is
called once. Plugins keep working unchanged, including writing files next to
themselves (e.g. weather.json), because they run from the real extracted
plugins folder, not from inside the APK.
"""
import importlib
import os
import sys
import traceback

sys.dont_write_bytecode = True  # no __pycache__ clutter inside plugins/


def _run_module(module_name, folder):
    # Every folder plugin is called "backend", so the module cache has to be
    # cleared each time or the second plugin would get the first one's module.
    sys.path.insert(0, folder)
    sys.modules.pop(module_name, None)
    importlib.invalidate_caches()
    try:
        mod = importlib.import_module(module_name)
        fn = getattr(mod, "run", None)
        if callable(fn):
            fn()
        else:
            print("[Hesper Python Bridge] '%s' has no callable run()." % module_name)
    except Exception:
        print("[Hesper Python Bridge] '%s' in %s failed:" % (module_name, folder))
        traceback.print_exc()
    finally:
        try:
            sys.path.remove(folder)
        except ValueError:
            pass
        sys.modules.pop(module_name, None)


def run_all(plugins_dir):
    if not os.path.isdir(plugins_dir):
        print("[Hesper Python Bridge] No plugins folder at", plugins_dir)
        return
    print("[Hesper Python Bridge] Python %s online." % sys.version.split()[0])

    for name in sorted(os.listdir(plugins_dir)):
        path = os.path.join(plugins_dir, name)
        if name.startswith(".") or name == "__pycache__":
            continue
        if os.path.isdir(path):
            if os.path.isfile(os.path.join(path, "backend.py")):
                print("[Hesper Backend] Running plugin backend:", name)
                _run_module("backend", path)
        elif name.endswith(".py") and not name.startswith("_"):
            # legacy loose-file plugin, e.g. plugins/sample_scraper.py
            print("[Hesper Backend] Running loose plugin:", name)
            _run_module(name[:-3], plugins_dir)
