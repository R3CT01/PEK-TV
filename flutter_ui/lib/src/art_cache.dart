import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// Keeps what was looked up online on the device, so posters, titles and synopses show at once after a restart and still
/// show when the internet is gone.
///
///  * pictures (posters, episode photos ...): one file per address under the app's cache folder, pruned to about 300 MB
///  * small text files (details.json = synopsis + poster address per title, movies.json / shows.json = the last library
///    lists) under the app's files folder
///
/// Pictures served by the app's own server (127.0.0.1) are not copied: they are already on the device.
class ArtCache {
  static const _host = MethodChannel('pek/host');
  static const _maxBytes = 300 * 1024 * 1024;
  static const _keepBytes = 240 * 1024 * 1024;

  static Directory? _imgDir;
  static Directory? _dataDir;
  static Future<void>? _ready;
  static final http.Client _client = http.Client();

  /// Addresses whose file is known to exist, so a grid that scrolls back does not wait on a disk check again.
  static final Map<String, File> _known = HashMap();
  static final Map<String, Future<File?>> _inflight = {};
  static int _running = 0;
  static final Queue<Completer<void>> _waiting = Queue();
  static const _parallel = 6;

  static Future<void> init() => _ready ??= _init();

  static Future<void> _init() async {
    Directory? files, cache;
    try {
      final m = await _host.invokeMapMethod<String, String>('dirs').timeout(const Duration(seconds: 2));
      if (m != null && m['files'] != null && m['cache'] != null) {
        files = Directory(m['files']!);
        cache = Directory(m['cache']!);
      }
    } catch (_) {}
    files ??= Directory('${Directory.systemTemp.path}/pek_files');
    cache ??= Directory('${Directory.systemTemp.path}/pek_cache');
    try {
      _dataDir = await Directory('${files.path}/pek_lists').create(recursive: true);
      _imgDir = await Directory('${cache.path}/pek_art').create(recursive: true);
      unawaited(_prune());
    } catch (_) {
      // No writable folder: everything below quietly does nothing and the app loads pictures from the network as before.
    }
  }

  // ---------------------------------------------------------------- small text files

  static Future<String?> readText(String name) async {
    await init();
    final d = _dataDir;
    if (d == null) return null;
    try {
      final f = File('${d.path}/$name');
      if (await f.exists()) return await f.readAsString();
    } catch (_) {}
    return null;
  }

  static Future<void> writeText(String name, String text) async {
    await init();
    final d = _dataDir;
    if (d == null) return;
    try {
      final tmp = File('${d.path}/$name.part');
      await tmp.writeAsString(text, flush: true);
      await tmp.rename('${d.path}/$name'); // a file is either the old text or the new text, never half of it
    } catch (_) {}
  }

  // ---------------------------------------------------------------- pictures

  static bool _cacheable(String url) => url.startsWith('http') && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost');

  static String _name(String url) => sha1.convert(utf8.encode(url)).toString();

  /// The file for [url] if it was seen in this run (no disk check needed).
  static File? knownFile(String url) => _known[url];

  /// The picture's file: from disk if it is there, else downloaded and kept. null = not available (offline, an error, or an
  /// address that is not worth keeping); the caller then falls back to loading it from the network.
  static Future<File?> file(String url) {
    if (!_cacheable(url)) return Future.value(null);
    final k = _known[url];
    if (k != null) return Future.value(k);
    return _inflight.putIfAbsent(url, () => _withRetry(url).whenComplete(() => _inflight.remove(url)));
  }

  /// A try gives up after 4 seconds (the 6th try used to sit for 20 s and block the other pictures, actors included);
  /// a failed picture is asked for again, up to 3 times. The pause between tries happens outside the queue, so a
  /// failing picture never holds a place that another one could use.
  static const _tryTimeouts = [Duration(seconds: 4), Duration(seconds: 4), Duration(seconds: 6)];
  static final Set<String> _gone = HashSet(); // answers that will not change (404 ...): not asked again this run

  static Future<File?> _withRetry(String url) async {
    for (var i = 0; i < _tryTimeouts.length; i++) {
      if (_gone.contains(url)) return null;
      final f = await _limited(() => _fetch(url, _tryTimeouts[i]));
      if (f != null) return f;
      if (i < _tryTimeouts.length - 1) await Future<void>.delayed(Duration(milliseconds: 500 * (i + 1)));
    }
    return null;
  }

  /// Whether a failed picture is worth asking for again later (false after a 404 and the like).
  static bool retryable(String url) => !_gone.contains(url);

  static Future<T> _limited<T>(Future<T> Function() job) async {
    if (_running >= _parallel) {
      final c = Completer<void>();
      _waiting.add(c);
      await c.future;
    }
    _running++;
    try {
      return await job();
    } finally {
      _running--;
      if (_waiting.isNotEmpty) _waiting.removeFirst().complete();
    }
  }

  static Future<File?> _fetch(String url, Duration timeout) async {
    await init();
    final d = _imgDir;
    if (d == null) return null;
    final f = File('${d.path}/${_name(url)}');
    try {
      if (await f.exists() && await f.length() > 0) {
        _known[url] = f;
        return f;
      }
    } catch (_) {}
    try {
      final r = await _client.get(Uri.parse(url)).timeout(timeout);
      if (r.statusCode == 404 || r.statusCode == 403 || r.statusCode == 410) _gone.add(url);
      if (r.statusCode != 200 || r.bodyBytes.isEmpty) return null;
      final tmp = File('${f.path}.part');
      await tmp.writeAsBytes(r.bodyBytes, flush: true);
      await tmp.rename(f.path);
      _known[url] = f;
      return f;
    } catch (_) {
      return null;
    }
  }

  /// Bytes the saved pictures take.
  static Future<int> size() async {
    await init();
    final d = _imgDir;
    if (d == null) return 0;
    var total = 0;
    try {
      await for (final e in d.list()) {
        if (e is File) total += await e.length();
      }
    } catch (_) {}
    return total;
  }

  /// Deletes the saved pictures and the saved synopses (details.json). They are fetched again when needed; the saved
  /// movie / show lists stay.
  static Future<void> clear() async {
    await init();
    _known.clear();
    final d = _imgDir;
    if (d != null) {
      try {
        await for (final e in d.list()) {
          try {
            await e.delete();
          } catch (_) {}
        }
      } catch (_) {}
    }
    final dd = _dataDir;
    if (dd != null) {
      try {
        final f = File('${dd.path}/details.json');
        if (await f.exists()) await f.delete();
      } catch (_) {}
    }
  }

  /// A file that would not decode (cut off, or not a picture): drop it so the next look-up downloads it again.
  static void forget(String url) {
    final f = _known.remove(url);
    if (f != null) {
      try {
        f.deleteSync();
      } catch (_) {}
    }
  }

  /// Once per start: when the pictures take more than 300 MB, the least recently written go until 240 MB are left.
  static Future<void> _prune() async {
    final d = _imgDir;
    if (d == null) return;
    try {
      final files = <File>[];
      var total = 0;
      await for (final e in d.list()) {
        if (e is! File) continue;
        if (e.path.endsWith('.part')) {
          try {
            await e.delete();
          } catch (_) {}
          continue;
        }
        files.add(e);
        total += await e.length();
      }
      if (total <= _maxBytes) return;
      final stamped = <(File, DateTime, int)>[];
      for (final f in files) {
        final st = await f.stat();
        stamped.add((f, st.modified, st.size));
      }
      stamped.sort((a, b) => a.$2.compareTo(b.$2));
      for (final s in stamped) {
        if (total <= _keepBytes) break;
        try {
          await s.$1.delete();
          total -= s.$3;
        } catch (_) {}
      }
    } catch (_) {}
  }
}

/// A picture from the network that is kept on the device: the first time it is downloaded, after that it comes from disk.
/// Same look and options as `Image.network`; when the cache cannot be used it simply loads the picture from the network.
class ArtImage extends StatefulWidget {
  const ArtImage(this.url, {super.key, this.fit = BoxFit.cover, this.cacheWidth, this.width, this.height, this.errorBuilder});
  final String url;
  final BoxFit fit;
  final int? cacheWidth; // decode small: weak TV boxes run out of memory on full-size posters
  final double? width;
  final double? height;
  final ImageErrorWidgetBuilder? errorBuilder;

  @override
  State<ArtImage> createState() => _ArtImageState();
}

class _ArtImageState extends State<ArtImage> {
  /// A picture that would not load is asked for again after 4, 6, 8 and 10 seconds (the covers used to stay empty until the
  /// app was restarted). The error picture only shows once the last try has failed.
  static const _maxRetries = 4;

  File? _file;
  Future<File?>? _pending;
  bool _fileBroken = false;
  int _retries = 0;
  int _gen = 0;
  Timer? _retryTimer;

  @override
  void initState() {
    super.initState();
    _resolve();
  }

  @override
  void didUpdateWidget(ArtImage old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _retryTimer?.cancel();
      _retries = 0;
      _fileBroken = false;
      _resolve();
    }
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    super.dispose();
  }

  void _resolve() {
    _file = ArtCache.knownFile(widget.url);
    _pending = _file == null ? ArtCache.file(widget.url) : null;
  }

  /// Both the disk copy and the network picture failed: try the whole thing again shortly.
  void _scheduleRetry() {
    if (_retries >= _maxRetries || (_retryTimer?.isActive ?? false) || !ArtCache.retryable(widget.url)) return;
    _retryTimer = Timer(Duration(seconds: 4 + 2 * _retries), () {
      if (!mounted) return;
      setState(() {
        _retries++;
        _gen++;
        _fileBroken = false;
        _resolve();
      });
    });
  }

  Widget _failed(BuildContext context, Object e, StackTrace? st) {
    if (_retries < _maxRetries && ArtCache.retryable(widget.url)) {
      _scheduleRetry();
      return const SizedBox.shrink();
    }
    return widget.errorBuilder?.call(context, e, st) ?? const SizedBox.shrink();
  }

  Widget _network() => Image.network(
        widget.url,
        key: ValueKey('net$_gen'),
        fit: widget.fit,
        cacheWidth: widget.cacheWidth,
        width: widget.width,
        height: widget.height,
        gaplessPlayback: true,
        errorBuilder: _failed,
      );

  Widget _disk(File f) => Image.file(
        f,
        fit: widget.fit,
        cacheWidth: widget.cacheWidth,
        width: widget.width,
        height: widget.height,
        gaplessPlayback: true,
        errorBuilder: (context, e, st) {
          // The saved copy is damaged: delete it (the next look-up downloads it again) and show the network picture now.
          ArtCache.forget(widget.url);
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (mounted && !_fileBroken) setState(() => _fileBroken = true);
          });
          return const SizedBox.shrink();
        },
      );

  @override
  Widget build(BuildContext context) {
    if (_fileBroken) return _network();
    final f = _file;
    if (f != null) return _disk(f);
    return FutureBuilder<File?>(
      key: ValueKey('fb$_gen'),
      future: _pending,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const SizedBox.shrink();
        final got = snap.data;
        return got != null ? _disk(got) : _network();
      },
    );
  }
}
