"""Runs Hesper's Python plugins on Android (via Chaquopy).

Mirrors HesperCore::executePluginModule / runFolderPlugins in backend/core.cpp:
every plugins/<name>/backend.py that defines run() is imported and run() is
called once. Plugins keep working unchanged, including writing files next to
themselves (e.g. weather.json), because they run from the real extracted
plugins folder, not from inside the APK.
"""
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ clutter inside plugins/


def _run_module(module_name, folder):
    # hesper_guard decides whether this plugin may run (bundled/trusted, or manifest +
    # static scan + runtime backstop) and runs it. See hesper_guard.py.
    import hesper_guard
    hesper_guard.run_plugin(module_name, folder)


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
            # legacy loose-file plugin, plugins/<name>.py
            print("[Hesper Backend] Running loose plugin:", name)
            _run_module(name[:-3], plugins_dir)
