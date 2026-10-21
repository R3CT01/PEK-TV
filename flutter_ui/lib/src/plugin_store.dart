import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'activity.dart';

import 'api.dart';
import 'plugin_host.dart';
import 'store.dart';

/// The PEK Store, Flutter side: the data half of `www/plugin_store.js` + `www/plugin_installer.js`.
///
///   list(shelf)      the plugins on the 'official' or 'community' shelf (the PEK Store worker, same one the web UI uses)
///   download(item)   fetches the chunks, checks the fingerprint, unpacks the files and reads plugin.json
///   check / install  hand the files to PEK TV's own server (/api/plugins/install). The server's safety checks decide
///                    what is allowed; nothing here installs anything by itself, the person confirms on a screen first.
class PekStoreApi {
  /// The PEK Store worker (the same address as PEK_STORE_API in www/plugin_store.js). See cloud/STORE-DEPLOY.md.
  static const base = 'https://pek-store.aquariusibeats.workers.dev';
  static final http.Client _client = http.Client();

  static Future<Map<String, dynamic>> _get(String path) async {
    http.Response r;
    try {
      r = await _client.get(Uri.parse('$base$path')).timeout(const Duration(seconds: 25));
    } catch (_) {
      throw const StoreException("Couldn't reach the PEK Store. Check your connection.");
    }
    Object? data;
    try {
      data = jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {}
    if (r.statusCode != 200 || data is! Map || data['ok'] == false) {
      throw StoreException(data is Map && data['error'] == 'not_found' ? 'That plugin is no longer in the store.' : 'The PEK Store gave an unexpected answer.');
    }
    return Map<String, dynamic>.from(data);
  }

  /// shelf: 'official' or 'community'.
  static Future<List<StoreItem>> list(String shelf) async {
    final j = await _get('/v1/store?shelf=${Uri.encodeQueryComponent(shelf)}&kind=plugin');
    return [for (final e in ((j['items'] as List?) ?? const [])) if (e is Map) StoreItem.fromJson(Map<String, dynamic>.from(e))];
  }

  /// Downloads an item and turns it into what the install screen needs. [onProgress] gets (chunk, of chunks).
  static Future<PreparedPlugin> download(StoreItem item, {void Function(int, int)? onProgress}) async {
    final parts = StringBuffer();
    for (var i = 0; i < item.chunks; i++) {
      onProgress?.call(i, item.chunks);
      final j = await _get('/v1/store/chunk?id=${Uri.encodeQueryComponent(item.id)}&fp=${Uri.encodeQueryComponent(item.fp)}&i=$i');
      parts.write('${j['data'] ?? ''}');
    }
    onProgress?.call(item.chunks, item.chunks);
    final bundle = parts.toString();
    if (fingerprint(bundle) != item.fp) throw const StoreException('The download was damaged. Try again.');
    final files = <PluginFile>[];
    try {
      final j = jsonDecode(bundle) as Map;
      for (final f in (j['files'] as List)) {
        final m = f as Map;
        files.add(PluginFile('${m['p']}', base64Decode('${m['d']}')));
      }
    } catch (_) {
      throw const StoreException('The download was damaged. Try again.');
    }
    return PreparedPlugin.fromFiles(item.id, files);
  }

  /// The same 64-bit fingerprint as fingerprint() in www/plugin_store.js (two 32-bit FNV-style hashes).
  static String fingerprint(String s) {
    const m = 0xFFFFFFFF;
    var h1 = 0x811c9dc5;
    var h2 = (0x01000193 ^ 0x9e3779b9) & m;
    for (var i = 0; i < s.length; i++) {
      final c = s.codeUnitAt(i);
      h1 = (((h1 ^ c) & m) * 0x01000193) & m;
      h2 = (((h2 ^ c) & m) * 0x85ebca6b) & m;
      h2 ^= h2 >> 13;
    }
    return h1.toRadixString(16).padLeft(8, '0') + (h2 & m).toRadixString(16).padLeft(8, '0');
  }
}

class StoreException implements Exception {
  const StoreException(this.message);
  final String message;
  @override
  String toString() => message;
}

class StoreItem {
  const StoreItem({required this.id, required this.name, required this.version, required this.author, required this.description, required this.size, required this.fp, required this.chunks});
  final String id, name, version, author, description, fp;
  final int size, chunks;

  factory StoreItem.fromJson(Map<String, dynamic> j) => StoreItem(
        id: '${j['id'] ?? ''}',
        name: '${j['name'] ?? j['id'] ?? ''}',
        version: '${j['version'] ?? ''}',
        author: '${j['author'] ?? ''}',
        description: '${j['description'] ?? ''}',
        size: (j['size'] as num?)?.toInt() ?? 0,
        fp: '${j['fp'] ?? ''}',
        chunks: (j['chunks'] as num?)?.toInt() ?? 0,
      );
}

class PluginFile {
  const PluginFile(this.path, this.data);
  final String path;
  final Uint8List data;
}

class PluginWarning {
  const PluginWarning(this.title, this.text, this.button);
  final String title, button;
  final List<String> text;
}

/// A plugin unpacked in memory, with plugin.json read the way the sandbox reads it (normalizeManifest in
/// plugin_sandbox.js) so the screen shows what will really be allowed.
class PreparedPlugin {
  PreparedPlugin({
    required this.id,
    required this.name,
    required this.version,
    required this.author,
    required this.description,
    required this.warning,
    required this.network,
    required this.perms,
    required this.stream,
    required this.navTab,
    required this.files,
    required this.hasBackend,
    required this.hasFlutterScreen,
    required this.hasWebScreen,
  });

  final String id, name, version, author, description, navTab;
  final PluginWarning? warning;
  final List<String> network;
  final Set<String> perms; // storage, library, torrent, favorites, providers, plugins, live, watched, device
  final bool stream, hasBackend, hasFlutterScreen, hasWebScreen;
  final List<PluginFile> files;

  static const permissionNames = ['storage', 'library', 'torrent', 'favorites', 'providers', 'plugins', 'live', 'watched', 'device'];
  static final _host = RegExp(r'^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$');
  static final _ip = RegExp(r'^[\d.]+$');

  static PreparedPlugin fromFiles(String id, List<PluginFile> files) {
    final pj = files.where((f) => f.path == 'plugin.json').firstOrNull;
    if (pj == null) throw const StoreException('The download has no plugin.json.');
    Object? raw;
    try {
      raw = jsonDecode(utf8.decode(pj.data, allowMalformed: false).replaceFirst('\uFEFF', ''));
    } catch (_) {
      throw const StoreException('plugin.json is not valid JSON.');
    }
    if (raw is! Map) throw const StoreException('plugin.json must be a JSON object.');
    String str(Object? v, int max) => v is String ? v.substring(0, math.min(v.length, max)) : '';

    // Plugins are Python only: no JavaScript of any kind, and a screen.py for this UI.
    final js = files.where((f) => RegExp(r'\.m?js$', caseSensitive: false).hasMatch(f.path)).firstOrNull;
    if (js != null) {
      throw StoreException('This plugin includes JavaScript (${js.path}). PEK TV only installs plugins written in Python, so plugins with .js files are no longer accepted.');
    }
    if (!files.any((f) => f.path == 'screen.py')) {
      throw const StoreException('This plugin has no screen.py. PEK TV only installs plugins with a Python screen.');
    }
    if (raw['flutter'] is! Map) {
      throw const StoreException('plugin.json needs a "flutter" entry, for example "flutter": {"screen": "screen.py"}.');
    }

    final perms = raw['permissions'] is Map ? raw['permissions'] as Map : const {};
    final net = <String>[];
    if (perms['network'] is List) {
      for (final h in perms['network'] as List) {
        if (h is String && _host.hasMatch(h) && !_ip.hasMatch(h.replaceFirst('*.', ''))) net.add(h);
      }
    }
    final on = {for (final n in permissionNames) if (perms[n] == true) n};
    final provides = raw['provides'] is Map ? raw['provides'] as Map : const {};
    final ui = raw['ui'] is Map ? raw['ui'] as Map : const {};
    var navTab = ui['navTab'] is String ? (ui['navTab'] as String).replaceAll(RegExp(r"[^A-Za-z0-9 &+'.-]"), '').trim() : '';
    if (navTab.length > 20) navTab = navTab.substring(0, 20);
    final name = str(raw['name'], 60);
    return PreparedPlugin(
      id: id,
      name: name.isEmpty ? id : name,
      version: str(raw['version'], 20),
      author: str(raw['author'], 80),
      description: str(raw['description'], 200),
      warning: _warning(raw['warning']),
      network: net,
      perms: on,
      stream: provides['stream'] == true,
      navTab: navTab,
      files: files,
      hasBackend: files.any((f) => f.path == 'backend.py'),
      hasFlutterScreen: raw['flutter'] is Map && files.any((f) => f.path == 'screen.py'),
      hasWebScreen: files.any((f) => f.path == 'ui.js'),
    );
  }

  /// plugin.json "warning": a screen the author wants shown before the install screen (plain text, length capped).
  static PluginWarning? _warning(Object? w) {
    if (w == null || w == false) return null;
    final obj = w is Map ? w : {'text': w};
    final rawText = obj['text'] is List ? obj['text'] as List : [obj['text']];
    final text = [for (final t in rawText) if (t is String && t.trim().isNotEmpty) t.trim().substring(0, math.min(t.trim().length, 400))].take(5).toList();
    if (text.isEmpty) return null;
    String pick(Object? v, String fallback, int max) => v is String && v.trim().isNotEmpty ? v.trim().substring(0, math.min(v.trim().length, max)) : fallback;
    return PluginWarning(pick(obj['title'], 'Before you install', 60), text, pick(obj['button'], 'I understand, continue', 40));
  }

  /// What the confirm screen lists, in plain words (the same sentences as the web UI's install screen).
  List<String> describe({required bool replaced, required String shelf, List<String> notice = const []}) {
    final l = <String>[
      // shelf: 'official' / 'community' (the PEK Store), 'zip' (a file the person picked) or 'github' (notice has the details).
      if (shelf == 'official') 'From the PEK Store, Official shelf (published by the PEK owner).',
      if (shelf == 'community') 'From the PEK Store, Community shelf: made by another person and approved by the owner.',
      if (shelf == 'zip') 'Unverified plugin from a .zip file you chose. PEK TV did not make, review or approve it; its developer is responsible for it.',
      ...notice,
      [if (version.isNotEmpty) 'Version $version', if (author.isNotEmpty) 'by $author'].join(' \u00b7 '),
      description,
      network.isNotEmpty ? 'Can connect to: ${network.join(', ')}' : 'No network access',
      if (perms.contains('storage')) 'Can keep its own private data',
      if (perms.contains('library')) 'Its Python code can read the titles and years in your library (never file names or folders).',
      if (perms.contains('torrent')) 'Can search for releases and start torrent streams through PEK TV (it never sees your provider key). Streams download and upload from your connection.',
      if (perms.contains('favorites')) 'Can add titles to your Favorites and remove them (it sees only which titles are favorites).',
      if (perms.contains('watched')) 'Can see which movies and episodes you have marked as watched and mark them watched or unwatched (it sees nothing else from your history).',
      if (perms.contains('device')) 'Can see what this device can play (which video codecs its hardware decodes, screen size, HDR support) so it can pick releases that run smoothly. No identifiers.',
      if (perms.contains('providers')) 'Can show \u201cWatch on Netflix / Hulu / \u2026\u201d buttons. PEK TV decides what they open: the service\u2019s app on Android, its website elsewhere.',
      if (perms.contains('plugins')) 'Can list your plugins that play titles and open one of them when you tap a button.',
      if (perms.contains('live')) 'Can play live TV streams from web addresses in PEK TV\u2019s player. The stream\u2019s server sees your internet address.',
      if (stream) 'Offers itself as a way to play movies and shows, so other plugins can show a \u201cPlay with $name\u201d button.',
      if (navTab.isNotEmpty) 'Adds a \u201c$navTab\u201d entry to PEK TV.',
      if (hasFlutterScreen) 'Its screen is Python code that runs in the same sandbox when you open it. It can only draw the screen and ask PEK TV for the things listed here.',
      if (hasBackend) 'Includes Python code that runs on this device after a restart. PEK TV only runs it if it declares its permissions and passes a safety scan, and then it can only reach the hosts listed above and its own data folder.',
      if (replaced) 'This replaces the version you already have (its saved data is kept).',
      'It runs in a sandbox and can only do the things listed here. Only install plugins from people you trust.',
    ];
    return [for (final s in l) if (s.isNotEmpty) s];
  }
}

class InstallResult {
  const InstallResult({required this.ok, required this.error, required this.replaced});
  final bool ok;
  final String error;
  final bool replaced;
}

/// Plugin upload and the "where did this come from" note shown on the Plugins page.
class PluginInstaller {
  static const _sourcesKey = 'pek_plugin_sources';

  /// POST /api/plugins/install (a dry run first, to learn whether it is allowed and whether it replaces one).
  static Future<InstallResult> send(PreparedPlugin p, {required bool dry}) {
    if (dry) return _send(p, dry: true);
    return Activity.track('install', 'Installing ${p.name}\u2026', () => _send(p, dry: false), result: (r) => r.ok ? 'Installed ${p.name}' : 'Plugin install failed', failText: 'Plugin install failed');
  }

  static Future<InstallResult> _send(PreparedPlugin p, {required bool dry}) async {
    final boundary = '----pekstore${DateTime.now().microsecondsSinceEpoch}';
    final body = BytesBuilder();
    void write(String s) => body.add(utf8.encode(s));
    void field(String name, String value) {
      write('--$boundary\r\nContent-Disposition: form-data; name="$name"\r\n\r\n$value\r\n');
    }

    field('id', p.id);
    if (dry) field('dry', '1');
    // Each file = a "path" field and a "file" part, in the same order (the server pairs them by position).
    for (final f in p.files) {
      field('path', f.path);
      write('--$boundary\r\nContent-Disposition: form-data; name="file"; filename="f"\r\nContent-Type: application/octet-stream\r\n\r\n');
      body.add(f.data);
      write('\r\n');
    }
    write('--$boundary--\r\n');
    http.Response r;
    try {
      r = await http.post(Uri.parse('${Api.base}/api/plugins/install'), headers: {'Content-Type': 'multipart/form-data; boundary=$boundary'}, body: body.takeBytes()).timeout(const Duration(seconds: 90));
    } catch (_) {
      throw const StoreException("Couldn't reach PEK TV's server.");
    }
    if (r.statusCode == 413) throw const StoreException('That plugin is too large to upload.');
    Object? j;
    try {
      j = jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {}
    if (j is! Map) throw StoreException('The server gave an unexpected answer (${r.statusCode}).');
    return InstallResult(ok: j['ok'] == true, error: '${j['error'] ?? ''}', replaced: j['replaced'] == true);
  }

  /// Remembers where a plugin came from, shown under its name on the Plugins page: 'official' / 'community' (store shelf),
  /// 'zip' (a picked file) or a GitHub map {type: 'github', owner, repo, tag}.
  static Future<void> rememberSource(String id, Object source) async {
    final m = Store.jsonMap(_sourcesKey, scoped: false);
    m[id] = source;
    await Store.setJsonMap(_sourcesKey, m, scoped: false);
  }

  static Future<void> forgetSource(String id) async {
    final m = Store.jsonMap(_sourcesKey, scoped: false);
    if (m.remove(id) != null) await Store.setJsonMap(_sourcesKey, m, scoped: false);
  }

  /// The raw remembered source (a String or a Map), or null.
  static Object? sourceOf(String id) => Store.jsonMap(_sourcesKey, scoped: false)[id];

  /// null when nothing is known (built in, or installed in the classic UI).
  static String? sourceLabel(String id) {
    final s = sourceOf(id);
    if (s == 'official') return 'PEK Store official';
    if (s == 'community') return 'approved \u00b7 community store';
    if (s == 'zip') return 'third party \u00b7 from a .zip file';
    if (s is Map && s['type'] == 'github') return 'unverified \u00b7 from GitHub ${s['owner']}/${s['repo']}';
    return null;
  }

  /// After an install or a removal: restart any open screen of that plugin and tell the menus to reload.
  static Future<void> changed(String id) async {
    await PluginHost.close(id);
    PluginHost.changed.value++;
  }
}
