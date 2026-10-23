import 'dart:convert';
import 'dart:typed_data';

import 'plugin_github.dart';
import 'plugin_store.dart' show PluginFile, StoreException;
import 'plugin_zip.dart';
import 'skins.dart';
import 'tokens.dart';

/// A skin .zip that has been opened and checked, ready for the confirm screen. Nothing is stored until [SkinInstaller.install].
class PreparedSkin {
  const PreparedSkin({
    required this.id,
    required this.name,
    required this.author,
    required this.description,
    required this.version,
    required this.tokenCount,
    required this.tokens,
    required this.files,
    required this.skipped,
    this.source,
  });

  /// The slug (folder name, else skin name). The stored skin's id is [skinId].
  final String id;
  final String name, author, description, version;
  final int tokenCount;

  final PekTokens tokens;
  final List<PluginFile> files;
  final int skipped;

  /// null (a picked .zip counts as {'type': 'zip'}) or {'type': 'github', 'owner', 'repo', 'tag', 'kind'}.
  final Map<String, dynamic>? source;

  String get skinId => '${Skins.installedPrefix}$id';

  PreparedSkin withSource(Map<String, dynamic> s) => PreparedSkin(
        id: id, name: name, author: author, description: description, version: version, tokenCount: tokenCount,
        tokens: tokens, files: files, skipped: skipped, source: s,
      );

  PreparedSkin withId(String newId) => PreparedSkin(
        id: newId, name: name, author: author, description: description, version: version, tokenCount: tokenCount,
        tokens: tokens, files: files, skipped: skipped, source: source,
      );
}

/// Skins from a .zip or from GitHub: opening the zip, with the same checks as `backend/skin_install.h`
/// (what a skin may contain), with the same rules and the same messages:
///  - skin.json at the top of the zip or inside one folder, a zip is a plugin or a skin, never both
///  - data files only (json, md, txt, images, fonts), never code and never CSS (skin.css is refused); up to 60 files, 2 MB each, 6 MB in total
///
/// A skin is its colours and its corner size. This app keeps them in its own store (`Skins`), so nothing is sent to the server:
/// [checkFiles] is the gate here.
class SkinInstaller {
  static const maxFiles = 60;
  static const maxFileBytes = 2 * 1024 * 1024;
  static const maxTotalBytes = 6 * 1024 * 1024;
  static const maxManifest = 16 * 1024;
  static const maxZipBytes = 8 * 1024 * 1024;
  static const _maxPath = 120, _maxDepth = 6;

  /// The web UI's built-in skin ids plus this app's own, so a skin cannot pose as one of them.
  static const reservedIds = {'default', 'green', 'neon', 'ember', 'minimal', 'light', 'netflix'};

  /// Why a skin with a stylesheet is refused (the server and the web UI say the same).
  static const noCss = "skins can't contain CSS (skin.css): a skin is colours and a corner size only. Remove the .css file and try again.";

  static const _allowed = {'json', 'md', 'txt', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf'};
  static const notASkin = 'This is a plugin, not a skin. Install it from Plugins.';

  // ------------------------------------------------------------------ checks (backend/skin_install.h)

  static String _ext(String path) {
    final name = path.split('/').last;
    final dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  }

  /// '' when the path is fine, else the reason (`checkRelativePath`).
  static String checkPath(String p) {
    if (p.isEmpty) return 'a file has an empty name';
    if (p.length > _maxPath) return 'a file path is too long: ${p.substring(0, 40)}...';
    if (p.startsWith('/')) return 'absolute paths are not allowed: $p';
    var depth = 0;
    for (final part in p.split('/')) {
      if (part.isEmpty) return 'bad path (empty folder name): $p';
      if (part == '.' || part == '..') return 'bad path (. or ..): $p';
      if (part.startsWith('.')) return 'hidden files are not allowed: $p';
      if (part.length > 64) return 'a file or folder name is too long in: $p';
      if (part.endsWith('.') || part.endsWith(' ')) return 'bad file name: $p';
      for (final c in part.codeUnits) {
        if (c < 0x20 || c == 0x7f || '\\:*?"<>|'.codeUnits.contains(c)) return 'bad character in file name: $p';
      }
      if (++depth > _maxDepth) return 'folders are nested too deeply: $p';
    }
    return '';
  }

  /// '' when every file is allowed, else the reason (`checkFiles`).
  static String checkFiles(List<PluginFile> files) {
    if (files.isEmpty) return 'the skin has no files';
    if (files.length > maxFiles) return 'too many files (limit $maxFiles)';
    final seen = <String>{};
    var total = 0, manifest = false;
    for (final f in files) {
      final why = checkPath(f.path);
      if (why.isNotEmpty) return why;
      if (!seen.add(f.path.toLowerCase())) return 'the same file appears twice: ${f.path}';
      if (f.data.length > maxFileBytes) return '${f.path} is too large (limit 2 MB per file)';
      total += f.data.length;
      if (total > maxTotalBytes) return 'the skin is too large (limit 6 MB in total)';
      if (f.path == 'plugin.json' || f.path == 'ui.js' || f.path == 'backend.py') return notASkin;
      final ext = _ext(f.path);
      if (ext == 'js' || ext == 'py') return "skins can't contain code: ${f.path}";
      if (ext == 'css') return noCss;
      if (!_allowed.contains(ext)) return 'file type not allowed in skins: ${f.path}';
      if (f.path == 'skin.json') {
        manifest = true;
        if (f.data.length > maxManifest) return 'skin.json is too large';
        final text = utf8.decode(f.data, allowMalformed: true).replaceFirst('\uFEFF', '').trimLeft();
        if (!text.startsWith('{')) return 'skin.json is not a JSON object';
        if (!text.contains('"name"')) return 'skin.json needs a "name"';
        if (text.toLowerCase().contains('url(')) return "skin.json can't use url(). Use a plain gradient for bgImage.";
      }
    }
    return manifest ? '' : 'skin.json is missing';
  }

  // ------------------------------------------------------------------ opening a zip

  static bool _junk(String path) => path.split('/').any((part) => part.startsWith('.') || part.toLowerCase() == '__macosx');

  /// Where [name] is in the zip: '' (at the top), 'folder/' (inside the one folder that holds everything) or null.
  static String? _locate(List<PluginFile> entries, String name) {
    bool has(String p) => entries.any((e) => e.path == p);
    if (has(name)) return '';
    final tops = {for (final e in entries) e.path.split('/').first};
    if (tops.length == 1) {
      final top = tops.first;
      if (entries.every((e) => e.path.startsWith('$top/')) && has('$top/$name')) return '$top/';
    }
    return null;
  }

  /// Opens a skin .zip in memory and checks it. Throws a [StoreException] with a plain message.
  /// [fileName] only names the skin when nothing else does. Nothing is stored.
  static PreparedSkin prepare(Uint8List bytes, {required String fileName}) {
    if (bytes.length > maxZipBytes) throw const StoreException('that file is too large to be a skin (limit 6 MB)');
    var entries = PluginZip.read(bytes);
    final before = entries.length;
    entries = [for (final e in entries) if (!_junk(e.path)) e];
    final skipped = before - entries.length;
    if (entries.isEmpty) throw const StoreException('the zip is empty');

    final skinAt = _locate(entries, 'skin.json');
    final pluginAt = _locate(entries, 'plugin.json');
    if (pluginAt != null) {
      throw StoreException(skinAt != null
          ? 'This zip has both plugin.json and skin.json, so PEK TV can\u2019t tell whether it is a plugin or a skin.'
          : notASkin);
    }
    if (skinAt == null) throw const StoreException('skin.json was not found. It must be at the top of the zip, or inside one folder.');
    final folder = skinAt.isEmpty ? '' : skinAt.substring(0, skinAt.length - 1);
    final files = [for (final e in entries) PluginFile(e.path.substring(skinAt.length), e.data)];
    return fromFiles(files, folder: folder, fileName: fileName, skipped: skipped);
  }

  /// Checks files that are already unpacked (a zip's contents, or what [prepare] found).
  static PreparedSkin fromFiles(List<PluginFile> files, {String folder = '', String fileName = '', int skipped = 0}) {
    Object? raw;
    try {
      raw = jsonDecode(utf8.decode(files.firstWhere((f) => f.path == 'skin.json').data).replaceFirst('\uFEFF', ''));
    } catch (_) {
      throw const StoreException('skin.json is not valid JSON');
    }
    if (raw is! Map) throw const StoreException('skin.json must be a JSON object');
    final name = raw['name'];
    if (name is! String || name.trim().isEmpty) throw const StoreException('skin.json needs a \u201cname\u201d');
    final tokensRaw = raw['tokens'];
    if (tokensRaw != null && tokensRaw is! Map) {
      throw const StoreException('\u201ctokens\u201d in skin.json must be an object of colours and sizes');
    }
    String str(Object? v, int max) {
      final s = v is String ? v.trim() : '';
      return s.length > max ? s.substring(0, max) : s;
    }

    final id = [PluginZip.slug(folder), PluginZip.slug(name), PluginZip.slug(fileName), 'skin'].firstWhere((s) => s.isNotEmpty);
    if (reservedIds.contains(id)) {
      throw StoreException('\u201c$id\u201d is the id of a skin that ships with PEK TV. Rename the skin (or the folder inside the zip) and try again.');
    }
    final why = checkFiles(files);
    if (why.isNotEmpty) throw StoreException(why);

    final tokenMap = (tokensRaw as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{};
    final tokens = SkinJson.tokensFrom(tokenMap);
    if (tokens == null) {
      throw const StoreException('This skin has no colours or corner size that this app can use.');
    }
    if (SkinJson.unreadable(tokens)) {
      throw const StoreException('This skin would make the text hard to read (its text colour is too close to its background or cards).');
    }
    return PreparedSkin(
      id: id,
      name: str(name, 60),
      author: str(raw['author'], 80),
      description: str(raw['description'], 200),
      version: str(raw['version'], 20),
      tokenCount: tokenMap.length,
      tokens: tokens,
      files: files,
      skipped: skipped,
    );
  }

  // ------------------------------------------------------------------ install / remove

  /// The skin already installed under this one's id, or null.
  static Skin? existing(PreparedSkin p) {
    for (final s in Skins.customSkins) {
      if (s.id == p.skinId) return s;
    }
    return null;
  }

  /// Stores the skin (a skin with the same id is updated, and repaints at once if it is in use). Returns the stored skin.
  static Future<Skin> install(PreparedSkin p) async {
    final skin = Skin(p.skinId, p.name, p.description, p.tokens,
        custom: true, author: p.author, version: p.version, source: p.source ?? const {'type': 'zip'});
    await Skins.saveCustom(skin);
    return skin;
  }

  /// Removes an installed skin. A profile that was using it goes back to PEK Ember.
  static Future<void> remove(Skin s) => Skins.deleteCustom(s.id);

  // ------------------------------------------------------------------ GitHub

  /// Downloads a GitHub release file (or the source) and opens it as a skin. A source zip unpacks into a folder named after
  /// the commit, which changes every time, so the repository name becomes the skin's id and a later update replaces it.
  static Future<PreparedSkin> fromGithub(GithubRelease rel, GithubOption opt) async {
    final bytes = await PekGithub.downloadBytes(rel, opt);
    var prep = prepare(bytes, fileName: opt.kind == 'asset' ? opt.label : '${rel.repo}.zip');
    if (opt.kind == 'source') {
      final id = PluginZip.slug(rel.repo);
      if (id.isNotEmpty && !reservedIds.contains(id)) prep = prep.withId(id);
    }
    return prep.withSource({'type': 'github', 'owner': rel.owner, 'repo': rel.repo, 'tag': rel.tag, 'kind': opt.kind});
  }
}
