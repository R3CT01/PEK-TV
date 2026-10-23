import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'api.dart';
import 'plugin_store.dart';
import 'plugin_zip.dart';
import 'store.dart';

/// Install a plugin from GitHub by name (owner/repo), for plugins that are NOT in the PEK Store.
/// Install a plugin from GitHub, with these rules:
///  - PEK TV lists nothing. The person types the name; there is no catalog of repositories.
///  - The zip goes through exactly the same checks as one the person picked (the server's safety checks, the permissions
///    screen, a confirm). Nothing from GitHub gets extra trust and nothing installs or updates by itself.
///  - Plugins that came from here are labelled "unverified".
///  - A switch in Settings turns it off; PEK_ALLOW_GITHUB=0 turns it off in the server.
/// The download itself is done by the server (`POST /api/plugins/github-zip`, backend/github_install.h): release files are
/// not reliably readable from an app, and the server only fetches the two link shapes it allows.
class PekGithub {
  static final _owner = RegExp(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$');
  static final _repo = RegExp(r'^[A-Za-z0-9._-]{1,100}$');
  static final _seg = RegExp(r'^[A-Za-z0-9._+%~-]{1,200}$');
  static const maxZip = 10 * 1024 * 1024;

  // ------------------------------------------------------------------ settings (the web UI's localStorage keys)
  static const _onKey = 'pek_github_enabled'; // '0' = switched off (anything else = on)
  static const _warnedKey = 'pek_github_warned'; // '1' = the first-time warning was accepted

  static bool get enabled => Store.strGet(_onKey, scoped: false) != '0';
  static Future<void> setEnabled(bool on) => Store.strSet(_onKey, on ? '1' : '0', scoped: false);
  static bool get warned => Store.strGet(_warnedKey, scoped: false) == '1';
  static Future<void> setWarned() => Store.strSet(_warnedKey, '1', scoped: false);

  /// "owner/repo", "github.com/owner/repo" or a full link -> (owner, repo), or null.
  static ({String owner, String repo})? parseRepo(String text) {
    var t = text.trim().replaceFirst(RegExp(r'^https?://', caseSensitive: false), '').replaceFirst(RegExp(r'^www\.', caseSensitive: false), '');
    t = t.replaceFirst(RegExp(r'^github\.com/', caseSensitive: false), '').replaceFirst(RegExp(r'[?#].*$'), '').replaceFirst(RegExp(r'/+$'), '');
    final parts = t.split('/');
    if (parts.length < 2) return null;
    final owner = parts[0];
    final repo = parts[1].replaceFirst(RegExp(r'\.git$', caseSensitive: false), '');
    if (!_owner.hasMatch(owner) || !_repo.hasMatch(repo) || repo == '.' || repo == '..') return null;
    return (owner: owner, repo: repo);
  }

  static Future<http.Response> _api(String path) async {
    http.Response r;
    try {
      r = await http.get(Uri.parse('https://api.github.com$path'), headers: {'Accept': 'application/vnd.github+json', 'User-Agent': 'PEK-TV'}).timeout(const Duration(seconds: 25));
    } catch (_) {
      throw const StoreException("Couldn't reach GitHub. Check your connection.");
    }
    if (r.statusCode == 403 || r.statusCode == 429) {
      throw const StoreException('GitHub is limiting requests from this connection. Try again in a few minutes.');
    }
    return r;
  }

  static Map<String, dynamic> _json(http.Response r) {
    try {
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (j is Map) return Map<String, dynamic>.from(j);
    } catch (_) {}
    return const {};
  }

  /// What can be installed from owner/repo: the latest release's .zip files and its source code.
  static Future<GithubRelease> findRelease(String owner, String repo) async {
    final name = '$owner/$repo';
    final base = '/repos/$owner/$repo';
    final res = await _api('$base/releases/latest');
    final options = <GithubOption>[];

    if (res.statusCode == 404) {
      // No release: say so clearly, or fall back to the repository's own source code.
      final rr = await _api(base);
      if (rr.statusCode == 404) throw StoreException('GitHub has no public repository called $name. Check the spelling.');
      if (rr.statusCode != 200) throw StoreException('GitHub gave an unexpected answer (HTTP ${rr.statusCode}).');
      final branch = '${_json(rr)['default_branch'] ?? ''}';
      if (branch.isNotEmpty && _seg.hasMatch(Uri.encodeComponent(branch))) {
        options.add(GithubOption(kind: 'source', label: 'Source code ($branch branch, no release)', size: 0, url: 'https://api.github.com$base/zipball/${Uri.encodeComponent(branch)}'));
      }
      return GithubRelease(owner: owner, repo: repo, tag: '', options: options);
    }
    if (res.statusCode != 200) throw StoreException('GitHub gave an unexpected answer (HTTP ${res.statusCode}).');
    final rel = _json(res);
    final tag = '${rel['tag_name'] ?? ''}';
    final prefix = 'https://github.com/$owner/$repo/releases/download/'.toLowerCase();
    for (final a in ((rel['assets'] as List?) ?? const [])) {
      if (a is! Map) continue;
      final url = '${a['browser_download_url'] ?? ''}';
      final file = '${a['name'] ?? ''}';
      final size = (a['size'] as num?)?.toInt() ?? 0;
      if (!file.toLowerCase().endsWith('.zip') || !url.toLowerCase().startsWith(prefix)) continue;
      if (size <= 0 || size > maxZip) continue; // empty, or too big to be a plugin
      options.add(GithubOption(kind: 'asset', label: file, size: size, url: url));
    }
    final zipball = '${rel['zipball_url'] ?? ''}';
    if (zipball.startsWith('https://api.github.com$base/zipball/')) {
      options.add(GithubOption(kind: 'source', label: 'Source code of ${tag.isEmpty ? 'this release' : tag}', size: 0, url: zipball));
    }
    return GithubRelease(owner: owner, repo: repo, tag: tag, options: options);
  }

  /// Downloads one option through the server and returns the zip's bytes (a plugin or a skin: the caller unpacks it).
  static Future<Uint8List> downloadBytes(GithubRelease rel, GithubOption opt) async {
    http.Response r;
    try {
      r = await http.post(Uri.parse('${Api.base}/api/plugins/github-zip'), body: {'owner': rel.owner, 'repo': rel.repo, 'url': opt.url}).timeout(const Duration(seconds: 90));
    } catch (_) {
      throw const StoreException("Couldn't reach PEK TV's server.");
    }
    final type = r.headers['content-type'] ?? '';
    if (r.statusCode != 200 || type.startsWith('application/json')) {
      var msg = '';
      try {
        msg = '${_json(r)['error'] ?? ''}';
      } catch (_) {}
      throw StoreException(msg.isEmpty ? 'The download failed.' : msg);
    }
    return r.bodyBytes;
  }

  /// Downloads one option through the server and unpacks it like a picked .zip.
  static Future<PreparedPlugin> download(GithubRelease rel, GithubOption opt) async {
    final bytes = await downloadBytes(rel, opt);
    var prep = PluginZip.prepare(bytes, fileName: opt.kind == 'asset' ? opt.label : '${rel.repo}.zip');
    // A source zip unpacks into a folder named after the commit, which changes every time: use the repository name so
    // a later update replaces the same plugin.
    if (opt.kind == 'source') {
      final id = PluginZip.slug(rel.repo);
      if (id.isNotEmpty) prep = PluginZip.withId(prep, id);
    }
    return prep;
  }
}

class GithubOption {
  const GithubOption({required this.kind, required this.label, required this.size, required this.url});
  final String kind; // 'asset' (a .zip attached to the release) or 'source'
  final String label, url;
  final int size;
}

class GithubRelease {
  const GithubRelease({required this.owner, required this.repo, required this.tag, required this.options});
  final String owner, repo, tag;
  final List<GithubOption> options;
}
