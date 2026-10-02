// Android replacement for main() in core.cpp (core.cpp itself is NOT
// compiled into the app yet because it embeds Python).
#include <jni.h>
#include <stdlib.h>
#include <atomic>
#include <string>
#include <thread>
#include <vector>
#include "httplib.h"
#include "server.h"
#include "media_scanner.h"

static MediaScanner* g_scanner = nullptr;
static std::atomic<bool> g_started{false};

extern "C" JNIEXPORT void JNICALL
Java_com_hesper_app_NativeBridge_startServer(JNIEnv* env, jclass, jstring jRoot) {
    if (g_started.exchange(true)) return;   // only start once per process

    // Tell OpenSSL where Android keeps its trusted HTTPS certificates,
    // otherwise every https:// request (TMDb) fails verification.
    setenv("SSL_CERT_DIR", "/system/etc/security/cacerts", 1);

    const char* c = env->GetStringUTFChars(jRoot, nullptr);
    std::string root(c);
    env->ReleaseStringUTFChars(jRoot, c);

    // Bundled Mozilla CA list (downloaded by the workflow). Works on any
    // Android version, even if the device's own certificate store is old.
    setenv("SSL_CERT_FILE", (root + "/cacert.pem").c_str(), 1);

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

// TEMPORARY DIAGNOSTIC: tries the TMDb proxy three ways and reports what
// happened, so we can see why HTTPS fails. Remove once TMDb works.
extern "C" JNIEXPORT jstring JNICALL
Java_com_hesper_app_NativeBridge_tlsDiag(JNIEnv* env, jclass) {
    auto probe = [](int mode) -> std::string {
        httplib::Client cli("https://hesper-tmdb.aquariusibeats.workers.dev");
        cli.set_connection_timeout(8);
        cli.set_read_timeout(8);
        if (mode == 1) cli.set_ca_cert_path("", "/system/etc/security/cacerts");
        if (mode == 2) cli.enable_server_certificate_verification(false);
        if (mode == 3) {
            const char* f = getenv("SSL_CERT_FILE");
            cli.set_ca_cert_path(f ? f : "", "");
        }
        auto r = cli.Get("/search/tv?query=friends");
        if (!r) return httplib::to_string(r.error());
        return "HTTP " + std::to_string(r->status);
    };
    std::string out = "default: " + probe(0) +
                      "\ncacerts dir: " + probe(1) +
                      "\nbundled file: " + probe(3) +
                      "\nno verify: " + probe(2);
    return env->NewStringUTF(out.c_str());
}
