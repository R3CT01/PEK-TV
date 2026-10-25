import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

import 'tokens.dart';
import 'widgets.dart';

/// A newer PEK TV on GitHub: the release's apk for THIS device's CPU type.
class AppRelease {
  const AppRelease({required this.tag, required this.version, required this.url, required this.size, required this.sha256, required this.notes, required this.installed});
  final String tag;
  final String version; // the tag without a leading "v"
  final String url;
  final int size;
  final String sha256; // '' when GitHub gave none
  final String notes;
  final String installed; // the version running now
}

/// Looks for a newer release of the app itself, downloads its apk and hands it to Android to install.
///
///  * A release is a tag push (v2.2.0) built by .github/workflows/build_android.yml, which attaches
///    PEK-TV-<version>-release-<arm64-v8a|armeabi-v7a>.apk. Those are marked "pre-release", which GitHub's /releases/latest
///    skips, so the release LIST is read and the newest one with a matching apk wins.
///  * The CPU type comes from the installed versionCode (build.gradle: ...1 = 32-bit, ...2 = 64-bit), so an update never
///    swaps a 64-bit install for a 32-bit one.
///  * Nothing is remembered: "Not now" only hides the screen for this run, and it comes back at the next start.
///  * Debug and dev builds (versionName ends in -debug or has -dev.) never check, and neither do local builds.
class AppUpdate {
  /// owner/repo that publishes the app's releases.
  static const repo = 'R3CT01/PEK-TV';

  static const _channel = MethodChannel('pek/update');

  /// At most this long at start-up: a slow connection must not hold the app back.
  static const checkTimeout = Duration(seconds: 4);

  /// "2.1.9" is newer than "2.1.8"; "2.1.9" is newer than "2.1.9-beta.2"; "-beta.10" is newer than "-beta.9".
  static int compare(String a, String b) {
    ({List<int> core, List<String> pre}) split(String v) {
      var t = v.trim().replaceFirst(RegExp(r'^[vV]'), '');
      t = t.replaceFirst(RegExp(r'\+.*$'), '');
      final dash = t.indexOf('-');
      final core = (dash < 0 ? t : t.substring(0, dash)).split('.').map((e) => int.tryParse(e) ?? 0).toList();
      final pre = dash < 0 ? <String>[] : t.substring(dash + 1).split('.');
      return (core: core, pre: pre);
    }

    final x = split(a), y = split(b);
    final n = x.core.length > y.core.length ? x.core.length : y.core.length;
    for (var i = 0; i < n; i++) {
      final d = (i < x.core.length ? x.core[i] : 0) - (i < y.core.length ? y.core[i] : 0);
      if (d != 0) return d.sign;
    }
    if (x.pre.isEmpty && y.pre.isEmpty) return 0;
    if (x.pre.isEmpty) return 1; // a release beats its own pre-releases
    if (y.pre.isEmpty) return -1;
    final m = x.pre.length > y.pre.length ? x.pre.length : y.pre.length;
    for (var i = 0; i < m; i++) {
      if (i >= x.pre.length) return -1;
      if (i >= y.pre.length) return 1;
      final p = int.tryParse(x.pre[i]), q = int.tryParse(y.pre[i]);
      final c = (p != null && q != null) ? p.compareTo(q) : x.pre[i].compareTo(y.pre[i]);
      if (c != 0) return c.sign;
    }
    return 0;
  }

  /// The version name of the running app ("2.2.0"), or null when the platform does not say.
  static Future<String?> installedVersion() async {
    try {
      final info = await _channel.invokeMapMethod<String, dynamic>('info');
      final name = '${info?['versionName'] ?? ''}';
      return name.isEmpty ? null : name;
    } catch (_) {
      return null;
    }
  }

  /// The newest release that is newer than the running app, or null (up to date, offline, a debug build, anything unexpected).
  static Future<AppRelease?> check() async {
    try {
      final info = await _channel.invokeMapMethod<String, dynamic>('info');
      if (info == null) return null;
      final name = '${info['versionName']}';
      final code = (info['versionCode'] as num?)?.toInt() ?? 0;
      if (info['debuggable'] == true || name.endsWith('-debug') || name.contains('-dev.')) return null;
      final abi = switch (code % 10) { 1 => 'armeabi-v7a', 2 => 'arm64-v8a', _ => null };
      if (abi == null) return null; // a local build with both CPU types: not an installed release

      final r = await http
          .get(Uri.parse('https://api.github.com/repos/$repo/releases?per_page=15'), headers: {'Accept': 'application/vnd.github+json', 'User-Agent': 'PEK-TV'})
          .timeout(checkTimeout);
      if (r.statusCode != 200) return null;
      final list = jsonDecode(utf8.decode(r.bodyBytes));
      if (list is! List) return null;

      final prefix = 'https://github.com/$repo/releases/download/'.toLowerCase();
      AppRelease? best;
      for (final rel in list) {
        if (rel is! Map || rel['draft'] == true) continue;
        final tag = '${rel['tag_name'] ?? ''}';
        if (tag.isEmpty || !RegExp(r'\d').hasMatch(tag)) continue;
        final version = tag.replaceFirst(RegExp(r'^[vV]'), '');
        if (compare(version, name) <= 0) continue;
        if (best != null && compare(version, best.version) <= 0) continue;
        for (final a in ((rel['assets'] as List?) ?? const [])) {
          if (a is! Map) continue;
          final file = '${a['name'] ?? ''}';
          final url = '${a['browser_download_url'] ?? ''}';
          final size = (a['size'] as num?)?.toInt() ?? 0;
          if (!file.endsWith('-release-$abi.apk') || !url.toLowerCase().startsWith(prefix) || size <= 0) continue;
          final digest = '${a['digest'] ?? ''}'; // "sha256:<hex>" on current GitHub releases
          best = AppRelease(
            tag: tag,
            version: version,
            url: url,
            size: size,
            sha256: digest.startsWith('sha256:') ? digest.substring(7).toLowerCase() : '',
            notes: '${rel['body'] ?? ''}',
            installed: name,
          );
          break;
        }
      }
      return best;
    } catch (_) {
      return null; // offline, rate limited, malformed answer: just start the app
    }
  }

  /// Downloads the apk into the cache folder (progress 0..1) and checks it against GitHub's checksum when there is one.
  static Future<File> download(AppRelease rel, void Function(double) onProgress) async {
    final info = await _channel.invokeMapMethod<String, dynamic>('info');
    final dir = Directory('${info?['cacheDir']}/update');
    if (dir.existsSync()) dir.deleteSync(recursive: true); // older downloads
    dir.createSync(recursive: true);
    final file = File('${dir.path}/PEK-TV-${rel.version.replaceAll(RegExp(r'[^A-Za-z0-9._-]'), '_')}.apk');

    final client = http.Client();
    try {
      final resp = await client.send(http.Request('GET', Uri.parse(rel.url))..headers['User-Agent'] = 'PEK-TV').timeout(const Duration(seconds: 30));
      if (resp.statusCode != 200) throw const _UpdateError("GitHub wouldn't send the update. Try again in a moment.");
      final total = (resp.contentLength != null && resp.contentLength! > 0) ? resp.contentLength! : rel.size;
      final sink = file.openWrite();
      var got = 0;
      try {
        await for (final chunk in resp.stream.timeout(const Duration(seconds: 30))) {
          sink.add(chunk);
          got += chunk.length;
          onProgress((got / total).clamp(0.0, 1.0).toDouble());
        }
      } finally {
        await sink.close();
      }
      if (got != rel.size) throw const _UpdateError('The download was cut short. Try again.');
    } on _UpdateError {
      rethrow;
    } on TimeoutException {
      throw const _UpdateError('The download stalled. Check your connection and try again.');
    } catch (_) {
      throw const _UpdateError("The download failed. Check your connection and try again.");
    } finally {
      client.close();
    }

    if (rel.sha256.isNotEmpty) {
      final sum = (await sha256.bind(file.openRead()).first).toString();
      if (sum != rel.sha256) {
        file.deleteSync();
        throw const _UpdateError('The downloaded file did not match its checksum, so it was thrown away. Try again.');
      }
    }
    return file;
  }

  /// Hands the apk to Android. Returns null when started, 'needs_permission', or an error text.
  static Future<String?> install(File apk) => _channel.invokeMethod<String>('install', {'path': apk.path});

  static Future<void> openInstallSettings() => _channel.invokeMethod<void>('openInstallSettings');

  /// PackageInstaller's outcome after install() (the app is replaced and closed on success, so only failures arrive).
  static void listen(void Function(int status, String message) onStatus) {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'status' && call.arguments is Map) {
        final m = call.arguments as Map;
        onStatus((m['status'] as num?)?.toInt() ?? 1, '${m['message'] ?? ''}');
      }
    });
  }

  static void stopListening() => _channel.setMethodCallHandler(null);
}

class _UpdateError implements Exception {
  const _UpdateError(this.message);
  final String message;
}

enum _Step { ask, downloading, installing, permission, failed }

/// Shown at start-up while a newer PEK TV exists. "Update now" downloads and installs it; "Not now" opens the app,
/// and the screen is back at the next start until the person updates.
class AppUpdateScreen extends StatefulWidget {
  const AppUpdateScreen({super.key, required this.release, required this.onLater});
  final AppRelease release;
  final VoidCallback onLater;

  @override
  State<AppUpdateScreen> createState() => _AppUpdateScreenState();
}

class _AppUpdateScreenState extends State<AppUpdateScreen> {
  _Step _step = _Step.ask;
  double _progress = 0;
  String _error = '';

  @override
  void initState() {
    super.initState();
    AppUpdate.listen(_onInstallStatus);
  }

  @override
  void dispose() {
    AppUpdate.stopListening();
    super.dispose();
  }

  // PackageInstaller.STATUS_*: 3 = the person said no, 5 = conflicts with the installed app (different signing key), ...
  void _onInstallStatus(int status, String message) {
    if (!mounted || status == 0 || status == -1) return; // 0 = installed, -1 = Android is asking the person
    setState(() {
      _step = _Step.failed;
      _error = switch (status) {
        3 => 'The update was cancelled.',
        2 => 'Android blocked the update. Check Install unknown apps for PEK TV in Settings.',
        5 => "Android says this update doesn't match the installed PEK TV (it was signed with a different key).",
        6 => 'Not enough free storage for the update.',
        7 => "This update isn't compatible with this device.",
        _ => message.isEmpty ? 'The update could not be installed.' : 'The update could not be installed: $message',
      };
    });
  }

  Future<void> _start() async {
    setState(() {
      _step = _Step.downloading;
      _progress = 0;
      _error = '';
    });
    try {
      final apk = await AppUpdate.download(widget.release, (p) {
        if (mounted) setState(() => _progress = p);
      });
      if (!mounted) return;
      setState(() => _step = _Step.installing);
      final res = await AppUpdate.install(apk);
      if (!mounted) return;
      if (res == 'needs_permission') {
        setState(() => _step = _Step.permission);
      } else if (res != null) {
        setState(() {
          _step = _Step.failed;
          _error = res;
        });
      }
      // null: Android has it now. Its own screen appears (or the update just happens) and the app restarts when done.
    } on _UpdateError catch (e) {
      if (mounted) {
        setState(() {
          _step = _Step.failed;
          _error = e.message;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _step = _Step.failed;
          _error = 'The update failed. Try again.';
        });
      }
    }
  }

  String _mb(int bytes) => '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final rel = widget.release;
    final busy = _step == _Step.downloading || _step == _Step.installing;
    final notes = rel.notes.replaceAll(RegExp(r'[#*`>]'), '').replaceAll(RegExp(r'\n{2,}'), '\n').trim();

    final String title = switch (_step) {
      _Step.downloading => 'Downloading update\u2026',
      _Step.installing => 'Installing\u2026',
      _Step.permission => 'Allow installing updates',
      _Step.failed => "Couldn't update",
      _Step.ask => 'A new version is available',
    };
    final String body = switch (_step) {
      _Step.downloading => '${(_progress * 100).round()}% of ${_mb(rel.size)}',
      _Step.installing => 'Android will ask you to confirm. PEK TV restarts when it is done.',
      _Step.permission => "Android needs your OK first: turn on \u201cAllow from this source\u201d for PEK TV, come back and choose Update now again. You only do this once.",
      _Step.failed => _error,
      _Step.ask => 'PEK TV ${rel.version} is ready (you have ${rel.installed}).',
    };

    return Scaffold(
      backgroundColor: t.bg,
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(maxWidth: 30 * rem),
            child: SingleChildScrollView(
              padding: EdgeInsets.symmetric(horizontal: 1.5 * rem, vertical: rem),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.system_update, size: 3 * rem, color: t.accent),
                  SizedBox(height: rem),
                  Text(title, textAlign: TextAlign.center, style: TextStyle(fontSize: 1.5 * rem, fontWeight: FontWeight.w700, color: t.text)),
                  SizedBox(height: 0.6 * rem),
                  Text(body, textAlign: TextAlign.center, style: TextStyle(fontSize: 0.95 * rem, color: t.textMuted, height: 1.35)),
                  if (_step == _Step.downloading) ...[
                    SizedBox(height: rem),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(999),
                      child: LinearProgressIndicator(value: _progress == 0 ? null : _progress, minHeight: 0.5 * rem, color: t.accent, backgroundColor: t.surface),
                    ),
                  ],
                  if (_step == _Step.ask && notes.isNotEmpty) ...[
                    SizedBox(height: rem),
                    Text(notes, maxLines: 5, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: TextStyle(fontSize: 0.8 * rem, color: t.textMuted, height: 1.35)),
                  ],
                  SizedBox(height: 1.6 * rem),
                  if (_step == _Step.permission) ...[
                    PekButton(label: 'Open settings', primary: true, autofocus: true, onTap: () => unawaited(AppUpdate.openInstallSettings())),
                    SizedBox(height: 0.6 * rem),
                    PekButton(label: 'Update now', onTap: _start),
                  ] else if (!busy) ...[
                    PekButton(label: _step == _Step.failed ? 'Try again' : 'Update now', primary: true, autofocus: true, onTap: _start),
                  ],
                  if (!busy) ...[
                    SizedBox(height: 0.6 * rem),
                    PekButton(label: 'Not now', onTap: widget.onLater),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
