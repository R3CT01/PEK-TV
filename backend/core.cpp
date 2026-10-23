#include <iostream>
#include <cstdlib>
#include <string>
#include <vector>
#include <filesystem>
#include <thread>
#include <mutex>
#include <Python.h>
#include "server.h"
#include "media_scanner.h"
#include "vfs.h"
#include "torrent_routes.h"

namespace fs = std::filesystem;

class PekCore {
private:
    std::string version;
    std::vector<std::string> loaded_plugins;
    std::mutex plugin_mutex;
    std::thread worker_thread;
    bool is_running;

    void backgroundPluginScanner(const std::string& path_str) {
        std::cout << "[PEK Background Worker] Scanning path: " << path_str << std::endl;
        
        if (!fs::exists(path_str) || !fs::is_directory(path_str)) {
            std::cout << "[PEK Background Worker] Directory missing. Creating path..." << std::endl;
            fs::create_directories(path_str);
            return;
        }

        try {
            for (const auto& entry : fs::directory_iterator(path_str)) {
                if (entry.path().extension() == ".py") {
                    std::string filename = entry.path().stem().string();
                    std::lock_guard<std::mutex> lock(plugin_mutex);
                    loaded_plugins.push_back(filename);
                    std::cout << "[PEK Background Worker] Discovered Python Plugin Module: " << filename << std::endl;
                }
            }
        } catch (const std::exception& e) {
            std::cout << "[PEK Background Worker] Plugin scan aborted: " << e.what() << std::endl;
        }
    }

public:
    PekCore(std::string v) : version(v), is_running(true) {
        std::cout << "[PEK Backend] Initialized v" << version << std::endl;
        Py_Initialize();
        if (Py_IsInitialized()) {
            std::cout << "[PEK Python Bridge] Embedded Python Interpreter online." << std::endl;
        }
    }

    ~PekCore() {
        is_running = false;
        if (worker_thread.joinable()) {
            worker_thread.join();
        }
        Py_Finalize();
        std::cout << "[PEK Backend] Shut down cleanly." << std::endl;
    }

    void startPluginScanAsync(const std::string& path_str) {
        worker_thread = std::thread(&PekCore::backgroundPluginScanner, this, path_str);
    }

    // Thread-safe method for the server to fetch active plugins for the JS frontend
    std::vector<std::string> getPlugins() {
        std::lock_guard<std::mutex> lock(plugin_mutex);
        return loaded_plugins;
    }

    // Where hesper_guard.py lives (set from main()).
    void setGuardDir(const std::string& dir) { guard_dir = dir; }

    // Every plugin backend goes through hesper_guard.py, which decides whether it may
    // run and applies the manifest permissions, static scan and runtime backstop (see
    // that file). If the guard itself cannot be loaded this FAILS CLOSED: only the
    // plugins that ship with PEK still run, everything else is refused.
    void executePluginModule(const std::string& module_name, const std::string& plugins_path) {
        std::string safe_guard;
        for (char c : guard_dir) {
            if (c == '\\' || c == '\'') safe_guard += '\\';
            safe_guard += c;
        }
        PyRun_SimpleString(("import sys\nif '" + safe_guard + "' not in sys.path: sys.path.insert(0, '" + safe_guard + "')\n").c_str());

        PyObject* guard = PyImport_ImportModule("hesper_guard");
        if (guard != nullptr) {
            PyObject* r = PyObject_CallMethod(guard, "run_plugin", "ss", module_name.c_str(), plugins_path.c_str());
            if (r == nullptr) PyErr_Print(); else Py_DECREF(r);
            Py_DECREF(guard);
            return;
        }
        PyErr_Print();
        std::string id = (module_name == "backend") ? fs::path(plugins_path).filename().string() : module_name;
        if (id != "weather" && id != "sample_scraper") {
            std::cout << "[PEK Plugin Guard] hesper_guard.py not found in '" << guard_dir
                      << "' - REFUSING to run plugin '" << id << "'." << std::endl;
            return;
        }
        std::cout << "[PEK Plugin Guard] hesper_guard.py not found; running bundled plugin '" << id << "' only." << std::endl;
        executePluginModuleUnguarded(module_name, plugins_path);
    }

    void executePluginModuleUnguarded(const std::string& module_name, const std::string& plugins_path) {
        // Folder-based plugins all use the same filename (backend.py), so
        // Python's module cache must be cleared each time — otherwise the
        // second plugin's "import backend" would silently return the
        // first plugin's already-cached module instead of its own.
        // Escape so a folder name containing ' or \ can't break the snippet.
        std::string safe_path;
        for (char c : plugins_path) {
            if (c == '\\' || c == '\'') safe_path += '\\';
            safe_path += c;
        }
        std::string py_code =
            "import sys\n"
            "sys.path.insert(0, '" + safe_path + "')\n"
            "sys.modules.pop('" + module_name + "', None)\n";
        PyRun_SimpleString(py_code.c_str());

        PyObject* pName = PyUnicode_FromString(module_name.c_str());
        PyObject* pModule = PyImport_Import(pName);
        Py_DECREF(pName);

        if (pModule != nullptr) {
            PyObject* pFunc = PyObject_GetAttrString(pModule, "run");
            if (pFunc && PyCallable_Check(pFunc)) {
                PyObject* pValue = PyObject_CallObject(pFunc, nullptr);
                if (pValue != nullptr) {
                    Py_DECREF(pValue);
                } else {
                    PyErr_Print();
                }
                Py_DECREF(pFunc);
            } else {
                std::cout << "[PEK Python Bridge] '" << module_name << "' has no callable run()." << std::endl;
                PyErr_Clear();
            }
            Py_DECREF(pModule);
        } else {
            std::cout << "[PEK Python Bridge] Failed to import '" << module_name << "':" << std::endl;
            PyErr_Print();
        }
    }

    // Runs plugins/<folder>/backend.py for every plugin folder that has
    // one. screen.py is run on demand by the UI and isn't touched here —
    // this only handles the backend side.
    void runFolderPlugins(const std::string& path_str) {
        if (!fs::exists(path_str) || !fs::is_directory(path_str)) return;

        for (const auto& entry : fs::directory_iterator(path_str)) {
            if (!entry.is_directory()) continue;

            std::string folder_name = entry.path().filename().string();
            fs::path backend_file = entry.path() / "backend.py";

            if (fs::exists(backend_file)) {
                std::cout << "[PEK Backend] Running plugin backend: " << folder_name << std::endl;
                executePluginModule("backend", entry.path().string());

                std::lock_guard<std::mutex> lock(plugin_mutex);
                loaded_plugins.push_back(folder_name);
            }
        }
    }

    std::string guard_dir;

    void status() {
        std::lock_guard<std::mutex> lock(plugin_mutex);
        std::cout << "[PEK Backend] Active registered plugins count: " << loaded_plugins.size() << std::endl;
    }
};

std::string getExecutionDirectory(char* argv0) {
    fs::path exe_path = fs::absolute(argv0);
    return exe_path.parent_path().string();
}

int main(int argc, char* argv[]) {
    std::string plugin_dir = "/storage/emulated/0/Documents/media_core/hesper/plugins";
    std::string skins_dir = "/storage/emulated/0/Documents/media_core/hesper/skins";

    PekCore pek("0.1.0");
    pek.setGuardDir((fs::path(plugin_dir).parent_path() / "backend").string());

    // Legacy loose-file Python plugins (e.g. plugins/sample_scraper.py)
    pek.startPluginScanAsync(plugin_dir);
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
    pek.executePluginModule("sample_scraper", plugin_dir);

    // Folder-based plugins: runs plugins/<name>/backend.py for each one found
    pek.runFolderPlugins(plugin_dir);

    // Movie/TV library scanner — classifies from embedded container
    // metadata (ffprobe tags) first, then folder/filename. Source
    // folders are chosen at runtime via the "Add Source" picker UI
    // (POST /api/sources) rather than hardcoded here.
    // Network-share logins live in Termux's private home folder (not on shared
    // storage, where any app could read them).
    {
        const char* home = std::getenv("HOME");
        std::string dir = "/storage/emulated/0/Documents/media_core";
        if (home) {
            dir = std::string(home) + "/.pek";
            std::error_code probe;
            // keep an existing ~/.hesper (saved logins, torrent settings) until the user moves it
            if (!fs::exists(dir, probe) && fs::exists(std::string(home) + "/.hesper", probe)) dir = std::string(home) + "/.hesper";
        }
        std::error_code ec;
        fs::create_directories(dir, ec);
        vfs::init(dir + "/net_credentials.tsv");
        setTorrentDataDir(dir);   // torrent.json + temporary torrent cache
    }

    MediaScanner scanner(
        "/storage/emulated/0/Documents/media_core/sources.tsv",
        "/storage/emulated/0/Documents/media_core/media_cache.tsv"
    );
    scanner.loadFromDisk();
    // Confirms show names guessed from filenames against TMDb (needs the
    // TMDB_API_KEY env var; without it the parsed name is used as-is).
    scanner.setShowResolver(PekServer::resolveShowName);
    std::thread scan_thread([&scanner]() { scanner.scan(); });
    scan_thread.detach();

    // Launch HTTP server with a lambda callback to dynamically serve scanned plugins to JS
    std::thread server_thread([&pek, plugin_dir, skins_dir, &scanner]() {
        PekServer::start(8080, plugin_dir, skins_dir, [&pek]() {
            return pek.getPlugins();
        }, &scanner);
    });
    server_thread.detach();

    pek.status();

    std::cout << "[PEK Core] System active. Listening for UI connections. Press Ctrl+C to exit." << std::endl;
    while (true) {
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    return 0;
}
