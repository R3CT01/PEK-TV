import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'common.dart';
import 'fields.dart';
import 'player.dart';
import 'store.dart';
import 'tokens.dart';
import 'torrent_search.dart';
import 'widgets.dart';

/// What the C++ server says about one running torrent (GET /api/torrent/<hash>/status).
class TorrentStatus {
  const TorrentStatus({
    required this.state,
    required this.ready,
    required this.file,
    required this.error,
    required this.peers,
    required this.downKBps,
    required this.bufferProgress,
    required this.fileSize,
  });
  final String state; // 'metadata' | 'downloading' | 'error' ...
  final bool ready;
  final String file;
  final String error;
  final int peers;
  final int downKBps;
  final double bufferProgress; // 0..1, how much of the play-ahead window is downloaded
  final int fileSize;

  factory TorrentStatus.fromJson(Map<String, dynamic> j) => TorrentStatus(
        state: '${j['state'] ?? ''}',
        ready: j['ready'] == true,
        file: '${j['file'] ?? ''}',
        error: '${j['error'] ?? ''}',
        peers: (j['peers'] as num?)?.toInt() ?? 0,
        downKBps: (j['downKBps'] as num?)?.toInt() ?? 0,
        bufferProgress: (j['bufferProgress'] as num?)?.toDouble() ?? 0,
        fileSize: (j['fileSize'] as num?)?.toInt() ?? 0,
      );

  static String speed(int kb) => kb >= 1024 ? '${(kb / 1024).toStringAsFixed(1)} MB/s' : '$kb KB/s';

  /// "42%  \u00b7 12 peers \u00b7 3.2 MB/s"
  String get line => '${(bufferProgress * 100).round()}% \u00b7 $peers peer${peers == 1 ? '' : 's'} \u00b7 ${speed(downKBps)}';
}

/// The torrent routes of the existing backend (backend/torrent_routes.cpp). Nothing in the backend changes.
class TorrentApi {
  static final http.Client _c = http.Client();

  static Future<bool> available() async {
    try {
      final r = await _c.get(Uri.parse('${Api.base}/api/torrent/info')).timeout(const Duration(seconds: 5));
      final o = jsonDecode(r.body);
      return o is Map && o['available'] == true;
    } catch (_) {
      return false;
    }
  }

  /// Starts the torrent and returns its hash. A pasted https .torrent link is vouched for first (the server only downloads
  /// .torrent files it was told about); a magnet link needs nothing.
  static Future<String> start(String source, {int season = 0, int episode = 0}) async {
    if (!source.startsWith('magnet:?')) {
      await Api.postForm('/api/torrent/allow', {'url': source});
    }
    final j = await Api.postForm('/api/torrent/start', {'source': source, 'season': '$season', 'episode': '$episode'});
    final h = '${j['hash'] ?? ''}';
    if (h.isEmpty) throw ApiError('Could not start the torrent.');
    return h;
  }

  static Future<TorrentStatus> status(String hash) async {
    final r = await _c.get(Uri.parse('${Api.base}/api/torrent/$hash/status')).timeout(const Duration(seconds: 10));
    final o = jsonDecode(utf8.decode(r.bodyBytes));
    if (r.statusCode != 200 || o is! Map) {
      throw ApiError(o is Map && o['error'] != null ? '${o['error']}' : 'The torrent is gone.');
    }
    return TorrentStatus.fromJson(Map<String, dynamic>.from(o));
  }

  /// Stops the torrent and deletes its temporary data.
  static Future<void> stop(String hash) async {
    try {
      await _c.post(Uri.parse('${Api.base}/api/torrent/$hash/stop')).timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  static String streamUrl(String hash) => '${Api.base}/api/torrent/$hash/stream';
}

/// What to remember for Resume Watching and how to start a pasted release again.
class TorrentTitle {
  const TorrentTitle({required this.kind, required this.title, this.showTitle = '', this.year = 0, this.season = 0, this.episode = 0});
  final String kind; // 'movie' | 'episode' | 'other'
  final String title; // what the player shows
  final String showTitle;
  final int year;
  final int season;
  final int episode;

  static String _clean(String s) => s.replaceAll(RegExp(r'[._]+'), ' ').replaceAll(RegExp(r'\s+'), ' ').replaceAll(RegExp(r'[\s\-(\[]+$'), '').trim();

  /// The name inside a magnet link (`dn=`), or ''.
  static String nameOf(String source) {
    final m = RegExp(r'[?&]dn=([^&]+)', caseSensitive: false).firstMatch(source);
    if (m == null) return '';
    try {
      return Uri.decodeComponent(m.group(1)!.replaceAll('+', ' '));
    } catch (_) {
      return m.group(1)!;
    }
  }

  /// "Some.Show.S02E05.1080p..." -> episode; "Some.Movie.2019.1080p..." -> movie; anything else stays "other".
  static TorrentTitle parse(String raw, {String fallback = 'Torrent'}) {
    final name = raw.trim();
    if (name.isEmpty) return TorrentTitle(kind: 'other', title: fallback);
    final ep = RegExp(r'^(.*?)[\s._\-]+S(\d{1,2})[\s._\-]?E(\d{1,3})', caseSensitive: false).firstMatch(name);
    if (ep != null && _clean(ep.group(1)!).isNotEmpty) {
      final show = _clean(ep.group(1)!);
      final s = int.parse(ep.group(2)!), e = int.parse(ep.group(3)!);
      String two(int n) => n.toString().padLeft(2, '0');
      return TorrentTitle(kind: 'episode', title: '$show S${two(s)}E${two(e)}', showTitle: show, season: s, episode: e);
    }
    final mv = RegExp(r'^(.*?)[\s._(\[\-]+((?:19|20)\d\d)(?!\d)').firstMatch(name);
    if (mv != null && _clean(mv.group(1)!).isNotEmpty) {
      return TorrentTitle(kind: 'movie', title: _clean(mv.group(1)!), year: int.parse(mv.group(2)!));
    }
    return TorrentTitle(kind: 'other', title: _clean(name).isEmpty ? fallback : _clean(name));
  }

  /// The Resume Watching entry for this release (its id is the same one the cloud and other devices use for torrents).
  Progress track(String source, {String origin = 'Torrent'}) {
    final key = Store.keyFor(kind: kind, title: title, showTitle: showTitle, year: year, season: season, episode: episode) ?? 'o|${Store.normalize(title)}|0|0';
    return Progress(
      id: 'tor:$key',
      title: title,
      kind: kind,
      position: 0,
      duration: 0,
      updated: 0,
      showTitle: showTitle,
      year: year,
      season: season,
      episode: episode,
      torrent: {'source': source, 'title': title, 'season': season, 'episode': episode},
      origin: origin,
    );
  }
}

/// Starts a torrent behind a loading screen and opens the player when enough is downloaded.
Future<void> playTorrent(BuildContext context, {required Progress track, double startSec = 0}) async {
  final t = track.torrent;
  if (t == null) return;
  await Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => TorrentLoadingScreen(track: track, startSec: startSec)));
}

/// The "starting stream" box of torrent.js: contacts the swarm, shows how far the loading is, opens the player when ready.
class TorrentLoadingScreen extends StatefulWidget {
  const TorrentLoadingScreen({super.key, required this.track, this.startSec = 0});
  final Progress track;
  final double startSec;
  @override
  State<TorrentLoadingScreen> createState() => _TorrentLoadingScreenState();
}

class _TorrentLoadingScreenState extends State<TorrentLoadingScreen> {
  static const _noMetadata = Duration(seconds: 90);
  static const _noPeers = Duration(seconds: 120);

  String _line = 'Contacting the swarm\u2026';
  double _frac = 0.03;
  String? _error;
  bool _cancelled = false;
  bool _opened = false;
  String _hash = '';

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    final t = widget.track.torrent!;
    try {
      _hash = await TorrentApi.start('${t['source']}', season: (t['season'] as num?)?.toInt() ?? 0, episode: (t['episode'] as num?)?.toInt() ?? 0);
      if (_cancelled) {
        unawaited(TorrentApi.stop(_hash));
        return;
      }
      final t0 = DateTime.now();
      var lastGood = DateTime.now();
      for (;;) {
        if (_cancelled || !mounted) return;
        final s = await TorrentApi.status(_hash);
        if (_cancelled || !mounted) return;
        if (s.state == 'error') throw ApiError(s.error.isEmpty ? 'The torrent failed.' : s.error);
        if (s.state == 'metadata') {
          setState(() {
            _line = 'Getting the file list\u2026 (${s.peers} peers)';
            _frac = 0.05;
          });
          if (DateTime.now().difference(t0) > _noMetadata) throw ApiError('Couldn\u2019t get this torrent\u2019s file list. It may have no seeders.');
        } else if (s.ready) {
          break;
        } else {
          if (s.peers > 0 || s.downKBps > 0) lastGood = DateTime.now();
          setState(() {
            _line = 'Loading ${s.line}${s.file.isEmpty ? '' : '\n${s.file}'}${s.fileSize > 0 ? '\n${formatBytes(s.fileSize)}' : ''}';
            _frac = 0.1 + 0.9 * s.bufferProgress;
          });
          if (DateTime.now().difference(lastGood) > _noPeers) throw ApiError('No one is sending data for this release. Try another one.');
        }
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
      if (_cancelled || !mounted) {
        unawaited(TorrentApi.stop(_hash));
        return;
      }
      _opened = true;
      final hash = _hash;
      await Navigator.pushReplacement(
        context,
        MaterialPageRoute<void>(
          builder: (_) => PlayerScreen(
            url: TorrentApi.streamUrl(hash),
            title: widget.track.title,
            startSec: widget.startSec,
            resume: widget.track,
            torrentHash: hash,
            onClose: () => unawaited(TorrentApi.stop(hash)),
          ),
        ),
      );
    } catch (e) {
      if (_hash.isNotEmpty) unawaited(TorrentApi.stop(_hash));
      if (mounted && !_cancelled) setState(() => _error = e is ApiError ? e.message : 'Could not start this torrent.');
    }
  }

  void _cancel() {
    _cancelled = true;
    if (_hash.isNotEmpty) unawaited(TorrentApi.stop(_hash));
    if (mounted) Navigator.of(context).maybePop();
  }

  @override
  void dispose() {
    // Left without the player taking over (Back, an error): the temporary data goes.
    if (!_opened && _hash.isNotEmpty) {
      _cancelled = true;
      unawaited(TorrentApi.stop(_hash));
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return PopScope(
      canPop: true,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) _cancelled = true;
      },
      child: Scaffold(
        backgroundColor: t.bg,
        body: Center(
          child: Padding(
            padding: EdgeInsets.all(1.5 * rem),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 28 * rem),
              child: Container(
                padding: EdgeInsets.all(1.5 * rem),
                decoration: BoxDecoration(color: t.glassStrong, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: t.border)),
                child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(widget.track.title, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
                  SizedBox(height: 0.75 * rem),
                  if (_error != null)
                    Text(_error!, style: const TextStyle(color: Colors.redAccent))
                  else ...[
                    Text(_line, style: TextStyle(color: t.textMuted)),
                    SizedBox(height: 0.9 * rem),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: LinearProgressIndicator(value: _frac.clamp(0.03, 1.0), minHeight: 0.5 * rem, color: t.accent, backgroundColor: t.surface),
                    ),
                  ],
                  SizedBox(height: 1.25 * rem),
                  PekButton(label: _error != null ? 'Close' : 'Cancel', autofocus: true, onTap: _cancel),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shown in the middle of the player while a torrent stream is buffering (for example right after scrubbing): how far the
/// loading is, how many peers and how fast. Only polls while it is on screen.
class TorrentBufferCard extends StatefulWidget {
  const TorrentBufferCard({super.key, required this.hash});
  final String hash;
  @override
  State<TorrentBufferCard> createState() => _TorrentBufferCardState();
}

class _TorrentBufferCardState extends State<TorrentBufferCard> {
  TorrentStatus? _s;
  Timer? _t;

  @override
  void initState() {
    super.initState();
    _poll();
    _t = Timer.periodic(const Duration(seconds: 1), (_) => _poll());
  }

  Future<void> _poll() async {
    try {
      final s = await TorrentApi.status(widget.hash);
      if (mounted) setState(() => _s = s);
    } catch (_) {}
  }

  @override
  void dispose() {
    _t?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = _s;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      decoration: BoxDecoration(color: const Color(0xCC000000), borderRadius: BorderRadius.circular(14)),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const SizedBox(width: 34, height: 34, child: CircularProgressIndicator(strokeWidth: 3)),
        const SizedBox(height: 10),
        const Text('Loading\u2026', style: TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
        if (s != null) ...[
          const SizedBox(height: 4),
          Text(s.line, style: const TextStyle(color: Color(0xFFCCCCCC), fontSize: 13)),
        ],
        if (s != null) ...[
          const SizedBox(height: 8),
          SizedBox(width: 180, child: LinearProgressIndicator(value: s.bufferProgress.clamp(0.0, 1.0), minHeight: 4, color: Colors.white, backgroundColor: const Color(0x44FFFFFF))),
        ],
      ]),
    );
  }
}

// ====================================================================== More > Torrents

/// Search the sites you added (or a Torznab provider), or paste a magnet link / https .torrent link, and play it. A release
/// streams through the built-in engine, shows a loading screen, and is remembered in Resume Watching like anything else.
class TorrentsPage extends StatefulWidget {
  const TorrentsPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<TorrentsPage> createState() => _TorrentsPageState();
}

class _TorrentsPageState extends State<TorrentsPage> {
  final _link = TextEditingController();
  final _name = TextEditingController();
  late final Future<bool> _available = TorrentApi.available();
  String _error = '';

  @override
  void dispose() {
    _link.dispose();
    _name.dispose();
    super.dispose();
  }

  void _play() {
    final src = _link.text.trim();
    final ok = src.startsWith('magnet:?') || RegExp(r'^https://[^\s]+$').hasMatch(src);
    if (!ok) {
      setState(() => _error = 'Paste a magnet link (magnet:?\u2026) or an https link to a .torrent file.');
      return;
    }
    setState(() => _error = '');
    final raw = _name.text.trim().isNotEmpty ? _name.text.trim() : TorrentTitle.nameOf(src);
    final parsed = TorrentTitle.parse(raw);
    playTorrent(context, track: parsed.track(src));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final t = p.tokens;
    return ListView(padding: widget.padding, children: [
      const Heading('Torrents'),
      FutureBuilder<bool>(
        future: _available,
        builder: (context, snap) {
          final text = !snap.hasData
              ? 'Checking the torrent engine\u2026'
              : snap.data == true
                  ? 'Torrent playback is built into this PEK TV.'
                  : 'This build of PEK TV does not include the torrent engine, so releases cannot be played.';
          return Padding(padding: EdgeInsets.only(bottom: rem), child: Text(text, style: TextStyle(color: t.textMuted)));
        },
      ),
      const TorrentSearchSections(),
      Section(
        title: 'Play a release',
        hint: 'Paste a magnet link or a .torrent link. It shows how far it has loaded, plays when enough is downloaded, and appears in Resume Watching.',
        children: [
          PekField(label: 'Magnet or .torrent link', controller: _link, hint: 'magnet:?xt=urn:btih:\u2026', onSubmitted: _play),
          PekField(label: 'Title (optional, otherwise the name in the link)', controller: _name, onSubmitted: _play),
          if (_error.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Text(_error, style: const TextStyle(color: Colors.redAccent))),
          Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Play', primary: true, onTap: _play)),
        ],
      ),
      Text(
        'Only play what you have the right to watch. A release named like "Show S02E05" or "Movie 2019" is matched to episodes and movies, so its watch history and resume point follow you to your other devices.',
        style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem),
      ),
    ]);
  }
}
