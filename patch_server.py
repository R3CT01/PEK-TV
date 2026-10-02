import re, sys
path = sys.argv[1] if len(sys.argv) > 1 else "backend/server.cpp"
s = open(path).read()
if "applyTls" in s:
    print("already patched"); sys.exit(0)

helper = '''// Android: use the CA bundle shipped inside the app (SSL_CERT_FILE) for
// HTTPS to the TMDb proxy. No-op everywhere else.
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
static void applyTls(httplib::Client& c) {
    const char* f = std::getenv("SSL_CERT_FILE");
    if (f && *f) c.set_ca_cert_path(f, "");
}
#else
static void applyTls(httplib::Client&) {}
#endif

'''
marker = "std::string HesperServer::resolveShowName("
assert marker in s, "marker not found"
s = s.replace(marker, helper + marker, 1)

s, n = re.subn(r'^(\s*)(httplib::Client client\(tmdbProxyUrl\(\)\);)',
               r'\1\2\n\1applyTls(client);', s, flags=re.M)
open(path, "w").write(s)
print("patched", n, "clients")
