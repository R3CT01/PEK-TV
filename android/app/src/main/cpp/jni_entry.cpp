// Android replacement for main() in core.cpp (core.cpp itself is NOT
// compiled into the app yet because it embeds Python).
#include <jni.h>
#include <atomic>
#include <string>
#include <thread>
#include <vector>
#include "server.h"
#include "media_scanner.h"

static MediaScanner* g_scanner = nullptr;
static std::atomic<bool> g_started{false};

extern "C" JNIEXPORT void JNICALL
Java_com_hesper_app_NativeBridge_startServer(JNIEnv* env, jclass, jstring jRoot) {
    if (g_started.exchange(true)) return;   // only start once per process

    const char* c = env->GetStringUTFChars(jRoot, nullptr);
    std::string root(c);
    env->ReleaseStringUTFChars(jRoot, c);

    std::string www     = root + "/www";
    std::string plugins = root + "/plugins";
    std::string skins   = root + "/skins";

    g_scanner = new MediaScanner(root + "/sources.tsv", root + "/media_cache.tsv");
    g_scanner->loadFromDisk();
    g_scanner->setShowResolver(HesperServer::resolveShowName);
    std::thread([]() { g_scanner->scan(); }).detach();

    std::thread([www, plugins, skins]() {
        HesperServer::start(8080, www, plugins, skins,
            []() { return std::vector<std::string>(); },   // Python plugin list: later step
            g_scanner);
    }).detach();
}
