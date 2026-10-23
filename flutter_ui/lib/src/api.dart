import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'activity.dart' show Busy;
import 'art_cache.dart';

/// Talks to the existing C++ server (backend/server.cpp) on the loopback port. Nothing in the backend changes.
class Api {
  static const base = 'http://127.0.0.1:8080';
  static final http.Client _client = http.Client();

  /// A slow request shows the loading ring (Busy), like busy.js did for fetch().
  static Future<dynamic> _get(String path, {Duration timeout = const Duration(seconds: 20)}) => Busy.run(path, () => _getRaw(path, timeout));

  static Future<dynamic> _getRaw(String path, [Duration timeout = const Duration(seconds: 20)]) async {
    final r = await _client.get(Uri.parse('$base$path')).timeout(timeout);
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode} for $path');
    return jsonDecode(utf8.decode(r.bodyBytes, allowMalformed: true));
  }

  /// POST a form and return the JSON object. The backend answers `{ok:false, error}` on failure; that text is what the person sees.
  static Future<Map<String, dynamic>> postForm(String path, Map<String, String> body) => Busy.run(path, () => _postFormRaw(path, body));

  static Future<Map<String, dynamic>> _postFormRaw(String path, Map<String, String> body) async {
    http.Response r;
    try {
      r = await _client.post(Uri.parse('$base$path'), headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body: body).timeout(const Duration(seconds: 30));
    } catch (_) {
      throw ApiError('Could not reach the app. Check your connection.');
    }
    Map<String, dynamic>? j;
    try {
      final o = jsonDecode(utf8.decode(r.bodyBytes));
      if (o is Map) j = Map<String, dynamic>.from(o);
    } catch (_) {}
    if (r.statusCode != 200 || j == null || j['ok'] == false) {
      throw ApiError(j?['error'] != null ? '${j!['error']}' : 'Subtitle lookup failed (HTTP ${r.statusCode}).');
    }
    return j;
  }

  /// MainActivity starts the server before opening this screen, so this normally succeeds on the first try.
  static Future<bool> waitForServer() async {
    for (var i = 0; i < 60; i++) {
      try {
        final r = await _client.get(Uri.parse('$base/api/status')).timeout(const Duration(seconds: 2));
        if (r.statusCode == 200) return true;
      } catch (_) {}
      await Future<void>.delayed(const Duration(milliseconds: 250));
    }
    return false;
  }

  /// POST /api/rescan. Returns null when the scan started, or the seconds to wait when the server said "too soon" (429).
  static Future<int?> rescan() => Busy.run('/api/rescan', _rescanRaw);

  static Future<int?> _rescanRaw() async {
    final r = await _client.post(Uri.parse('$base/api/rescan')).timeout(const Duration(seconds: 20));
    if (r.statusCode == 429) {
      try {
        return ((jsonDecode(r.body) as Map)['retry_after'] as num?)?.toInt() ?? 10;
      } catch (_) {
        return 10;
      }
    }
    return null;
  }

  static Future<bool> scanning() async {
    try {
      final j = await _get('/api/scan-status');
      return j['scanning'] == true;
    } catch (_) {
      return false;
    }
  }

  /// A rescan changes what the library holds, so cached lookups and lists are dropped.
  static void forgetLibrary() => _details.clear();

  // The last lists are kept on the device (art_cache.dart): if the server cannot answer, the titles still show.
  static List<Movie> _movieList(dynamic j) => (((j as Map)['movies'] as List?) ?? const []).map((e) => Movie.fromJson(e as Map<String, dynamic>)).toList();
  static List<Show> _showList(dynamic j) => (((j as Map)['shows'] as List?) ?? const []).map((e) => Show.fromJson(e as Map<String, dynamic>)).toList();

  static Future<List<Movie>> movies() async {
    try {
      final j = await _get('/api/movies');
      final list = _movieList(j);
      unawaited(ArtCache.writeText('movies.json', jsonEncode(j)));
      return list;
    } catch (_) {
      final t = await ArtCache.readText('movies.json');
      if (t != null) {
        try {
          return _movieList(jsonDecode(t));
        } catch (_) {}
      }
      rethrow;
    }
  }

  static Future<List<Show>> shows() async {
    try {
      final j = await _get('/api/shows');
      final list = _showList(j);
      unawaited(ArtCache.writeText('shows.json', jsonEncode(j)));
      return list;
    } catch (_) {
      final t = await ArtCache.readText('shows.json');
      if (t != null) {
        try {
          return _showList(jsonDecode(t));
        } catch (_) {}
      }
      rethrow;
    }
  }

  static final Map<String, Future<Details>> _details = {};
  static final _Pool _pool = _Pool(4);

  /// Poster + synopsis for a movie. Cached, and at most 4 lookups run at once so a big grid does not flood the box.
  static Future<Details> movieDetails(String id) => _cachedDetails('m:$id', () async {
        final j = await _get('/api/movie-details?id=${Uri.encodeQueryComponent(id)}');
        return Details(overview: (j['overview'] ?? '') as String, poster: abs((j['poster'] ?? '') as String));
      });

  static Future<Details> showDetails(String title) => _cachedDetails('s:$title', () async {
        final j = await _get('/api/show-details?title=${Uri.encodeQueryComponent(title)}');
        return Details(overview: (j['overview'] ?? '') as String, poster: abs((j['poster'] ?? '') as String));
      });

  static final Map<String, Future<EpisodeInfo>> _episodeInfo = {};

  /// Title, synopsis and still picture of one episode: the library's own .nfo / thumbnail first, else TMDb (the server
  /// does that). Kept for this run; a lookup that failed is asked again the next time the page opens.
  static Future<EpisodeInfo> episodeDetails(String show, int season, int episode) {
    final key = '$show|$season|$episode';
    return _episodeInfo.putIfAbsent(key, () async {
      try {
        final j = await _get('/api/episode-details?show=${Uri.encodeQueryComponent(show)}&season=$season&episode=$episode');
        return EpisodeInfo(name: '${j['name'] ?? ''}', overview: '${j['overview'] ?? ''}', still: abs('${j['still'] ?? ''}'));
      } catch (_) {
        _episodeInfo.remove(key);
        return const EpisodeInfo(name: '', overview: '', still: '');
      }
    });
  }

  /// Lookups that failed or came back without a poster (e.g. while offline): [forgetFailedDetails] lets them run again.
  static final Set<String> _noArt = {};

  /// A lookup that fails (the server is busy scanning, the TMDb proxy is slow or rate-limiting a screenful of requests) is
  /// tried again after 2 s and 6 s, and one that still has nothing is forgotten after a short rest, so the next time the
  /// screen is built it asks again. Before, the first failure was kept until Refresh, which left posters blank.
  static const _detailRetryWaits = [Duration(seconds: 2), Duration(seconds: 6)];

  static void _forgetDetailSoon(String key, Duration after) {
    _noArt.add(key);
    Timer(after, () {
      _details.remove(key);
      _noArt.remove(key);
    });
  }

  static Future<Details> _cachedDetails(String key, Future<Details> Function() load) => _details.putIfAbsent(key, () async {
        final saved = await _savedDetail(key);
        if (saved != null) return saved; // looked up in an earlier run: no request, works offline
        Object? lastError;
        for (var attempt = 0; attempt <= _detailRetryWaits.length; attempt++) {
          try {
            final d = await _pool.run(load);
            if (d.poster.isEmpty) {
              _forgetDetailSoon(key, const Duration(seconds: 60)); // no picture (yet): ask again later
            } else {
              _noArt.remove(key);
              unawaited(_saveDetail(key, d));
            }
            return d;
          } catch (e) {
            lastError = e;
            if (attempt < _detailRetryWaits.length) await Future<void>.delayed(_detailRetryWaits[attempt]);
          }
        }
        _forgetDetailSoon(key, const Duration(seconds: 20));
        throw lastError!;
      });

  // ---- details kept on disk: synopsis + poster address per title. Only pictures from the internet are kept (a poster the
  // library itself has comes from the local server, which answers at once and may change when the files do).
  static const _detailsTtl = Duration(days: 30);
  static const _detailsMax = 6000;
  static Future<Map<String, dynamic>>? _diskLoad;
  static Timer? _diskSave;

  static Future<Map<String, dynamic>> _disk() => _diskLoad ??= () async {
        final t = await ArtCache.readText('details.json');
        if (t != null) {
          try {
            final o = jsonDecode(t);
            if (o is Map) return Map<String, dynamic>.from(o);
          } catch (_) {}
        }
        return <String, dynamic>{};
      }();

  static Future<Details?> _savedDetail(String key) async {
    try {
      final e = (await _disk())[key];
      if (e is! Map) return null;
      final poster = '${e['p'] ?? ''}';
      final at = (e['t'] as num?)?.toInt() ?? 0;
      if (!poster.startsWith('https://')) return null;
      if (DateTime.now().millisecondsSinceEpoch - at > _detailsTtl.inMilliseconds) return null;
      return Details(overview: '${e['o'] ?? ''}', poster: poster);
    } catch (_) {
      return null;
    }
  }

  static Future<void> _saveDetail(String key, Details d) async {
    if (!d.poster.startsWith('https://')) return;
    final m = await _disk();
    m[key] = {'o': d.overview, 'p': d.poster, 't': DateTime.now().millisecondsSinceEpoch};
    if (m.length > _detailsMax) {
      for (final k in m.keys.take(m.length - _detailsMax + 1000).toList()) {
        m.remove(k);
      }
    }
    _diskSave?.cancel();
    _diskSave = Timer(const Duration(seconds: 3), () => unawaited(ArtCache.writeText('details.json', jsonEncode(m))));
  }

  /// Back online: forget the lookups that had no result so the next screen build asks again.
  static void forgetFailedDetails() {
    for (final k in _noArt) {
      _details.remove(k);
    }
    _noArt.clear();
  }

  // ---------------------------------------------------------------- Duplicates / Unknown / Sources / Plugins

  static Future<DuplicatesResult> duplicates() async {
    final j = await _get('/api/duplicates');
    return DuplicatesResult(
      wastedTotal: (j['wastedTotal'] as num?)?.toInt() ?? 0,
      groups: ((j['groups'] as List?) ?? const []).map((e) => DupGroup.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  static Future<List<FileRow>> unknown() async {
    final j = await _get('/api/unknown');
    return ((j['files'] as List?) ?? const []).map((e) => FileRow.fromJson(e as Map<String, dynamic>)).toList();
  }

  static Future<List<String>> sources() async {
    final j = await _get('/api/sources');
    return ((j['sources'] as List?) ?? const []).map((e) => '$e').toList();
  }

  // ---------------------------------------------------------------- network folders (SMB / NFS / FTP / WebDAV / DLNA)

  static Future<void> discoverStart() async {
    try {
      await _client.post(Uri.parse('$base/api/discover')).timeout(const Duration(seconds: 10));
    } catch (_) {}
  }

  static Future<NetDiscovery> discoverPoll() async {
    final j = await _get('/api/discover');
    return NetDiscovery(
      scanning: j['scanning'] == true,
      unsupported: ((j['unsupported'] as List?) ?? const []).map((e) => '$e').toList(),
      hosts: ((j['hosts'] as List?) ?? const []).whereType<Map>().map((e) => NetHost.fromJson(Map<String, dynamic>.from(e))).toList(),
    );
  }

  /// POST /api/net/browse. The reply is `{ok, ...}`; `auth` asks for a login, `canTypeShare` for a typed share name.
  static Future<Map<String, dynamic>> netBrowse(String url, {String? user, String? pass}) async {
    final r = await _client
        .post(Uri.parse('$base/api/net/browse'), body: {'url': url, if (user != null) 'user': user, if (pass != null) 'pass': pass})
        .timeout(const Duration(seconds: 60));
    final o = jsonDecode(utf8.decode(r.bodyBytes));
    return o is Map ? Map<String, dynamic>.from(o) : <String, dynamic>{'ok': false, 'error': 'Could not open that location.'};
  }

  /// Adds a network location as a media source. Returns null on success, or the text to show.
  static Future<String?> addNetSource(String url, {String user = '', String pass = ''}) async {
    try {
      final r = await _client
          .post(Uri.parse('$base/api/sources'), body: {'path': url, if (user.isNotEmpty) 'user': user, if (user.isNotEmpty) 'pass': pass})
          .timeout(const Duration(seconds: 60));
      if (r.statusCode == 200) return null;
      try {
        final o = jsonDecode(utf8.decode(r.bodyBytes));
        if (o is Map && o['message'] != null) return '${o['message']}';
      } catch (_) {}
      return 'Could not add that folder.';
    } catch (_) {
      return 'Could not reach the PEK TV server.';
    }
  }

  // ---------------------------------------------------------------- library search (the NFO database: genre, actor, year ...)

  /// {movies: [file ids], shows: [show titles]} or null when the server could not answer.
  static Future<({List<String> movies, List<String> shows})?> librarySearch(String q, {String genre = '', int decade = 0, String actor = ''}) async {
    String qs(String type) =>
        '/api/library/search?type=$type&limit=60&q=${Uri.encodeQueryComponent(q)}${genre.isNotEmpty ? '&genre=${Uri.encodeQueryComponent(genre)}' : ''}'
        '${decade > 0 ? '&decade=$decade' : ''}${actor.isNotEmpty ? '&actor=${Uri.encodeQueryComponent(actor)}' : ''}';
    try {
      final r = await Future.wait([_get(qs('movies')), _get(qs('shows'))]);
      return (
        movies: ((r[0]['movies'] as List?) ?? const []).map((e) => '$e').toList(),
        shows: ((r[1]['shows'] as List?) ?? const []).map((e) => '$e').toList(),
      );
    } catch (_) {
      return null;
    }
  }

  /// Genres, decades and actors found in the library (movies and shows together).
  static Future<Facets?> libraryFacets(String actorQ) async {
    String u(String type) => '/api/library/facets?type=$type&limit=60&q=${Uri.encodeQueryComponent(actorQ)}';
    try {
      final r = await Future.wait([_get(u('movies')), _get(u('shows'))]);
      Map<String, int> sum(String key, String nameKey) {
        final out = <String, int>{};
        for (final j in r) {
          for (final x in ((j[key] as List?) ?? const []).whereType<Map>()) {
            out['${x[nameKey]}'] = (out['${x[nameKey]}'] ?? 0) + ((x['count'] as num?)?.toInt() ?? 0);
          }
        }
        return out;
      }

      List<MapEntry<String, int>> top(Map<String, int> m, int Function(MapEntry<String, int>, MapEntry<String, int>) by) =>
          (m.entries.toList()..sort(by)).take(60).toList();
      int byCount(MapEntry<String, int> a, MapEntry<String, int> b) => b.value != a.value ? b.value - a.value : a.key.compareTo(b.key);
      Map? idx;
      for (final j in r) {
        final i = j['indexing'];
        if (i is Map && ((i['total'] as num?) ?? 0) > 0) {
          idx = i;
          break;
        }
      }
      return Facets(
        genres: top(sum('genres', 'name'), byCount),
        decades: top(sum('decades', 'decade'), (a, b) => (int.tryParse(b.key) ?? 0) - (int.tryParse(a.key) ?? 0)),
        actors: top(sum('actors', 'name'), byCount),
        indexingDone: (idx?['done'] as num?)?.toInt() ?? 0,
        indexingTotal: (idx?['total'] as num?)?.toInt() ?? 0,
      );
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------- skip intro / recap, lyrics, online art

  /// GET /api/skip-segments: {found, imdb, data}. Throws on a network error so the caller can retry.
  static Future<Map<String, dynamic>> skipSegments(String show, int season, int episode) async {
    final j = await _get('/api/skip-segments?show=${Uri.encodeQueryComponent(show)}&season=$season&episode=$episode');
    return j is Map ? Map<String, dynamic>.from(j) : <String, dynamic>{};
  }

  /// {synced, plain} or null when there are no lyrics (404) or online lookups are off.
  static Future<({String synced, String plain})?> lyrics(String trackId) async {
    try {
      final r = await _client.get(Uri.parse('$base/api/music/lyrics?track=${Uri.encodeQueryComponent(trackId)}')).timeout(const Duration(seconds: 20));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(utf8.decode(r.bodyBytes));
      if (j is! Map) return null;
      return (synced: '${j['synced'] ?? ''}', plain: '${j['plain'] ?? ''}');
    } catch (_) {
      return null;
    }
  }

  /// {available, enabled} for "Online art & lyrics".
  static Future<({bool available, bool enabled})> musicOnline() async {
    final j = await _get('/api/music/online');
    return (available: j['available'] == true, enabled: j['enabled'] == true);
  }

  static Future<void> setMusicOnline(bool on) async {
    await _client.post(Uri.parse('$base/api/music/online?enabled=${on ? 1 : 0}')).timeout(const Duration(seconds: 20));
  }

  /// DELETE /api/sources?path=... (the folder is only forgotten, never deleted).
  static Future<void> removeSource(String path) async {
    await _client.delete(Uri.parse('$base/api/sources?path=${Uri.encodeQueryComponent(path)}')).timeout(const Duration(seconds: 20));
    forgetLibrary();
  }

  /// The browse endpoint behind the folder picker: {path, parent, dirs: [...]}.
  static Future<Map<String, dynamic>> browse([String path = '']) async =>
      Map<String, dynamic>.from(await _get('/api/browse${path.isEmpty ? '' : '?path=${Uri.encodeQueryComponent(path)}'}') as Map);

  /// POST /api/sources?path=... confirms a folder as a source (the server starts a scan).
  static Future<bool> addSource(String path) async {
    final r = await _client.post(Uri.parse('$base/api/sources?path=${Uri.encodeQueryComponent(path)}')).timeout(const Duration(seconds: 20));
    forgetLibrary();
    return r.statusCode == 200;
  }

  /// Installed plugins: the folder list from the server plus each plugin.json (served from /plugins/<folder>/).
  static Future<List<PluginInfo>> plugins() async {
    final j = await _get('/api/plugins');
    final out = <PluginInfo>[];
    for (final e in ((j['plugins'] as List?) ?? const [])) {
      final folder = '${(e as Map)['folder']}';
      var name = folder, desc = '', version = '', navTab = '', icon = '';
      var flutterScreen = false;
      var streamer = false;
      var hooks = false;
      try {
        final m = await _get('/plugins/${Uri.encodeComponent(folder)}/plugin.json');
        name = '${m['name'] ?? folder}';
        desc = '${m['description'] ?? ''}';
        version = '${m['version'] ?? ''}';
        // "flutter": {"screen": "screen.py"} marks a plugin that has a Python screen for this UI (FLUTTER_PLUGINS.md).
        flutterScreen = m['flutter'] is Map;
        final prov = m['provides'];
        streamer = prov is Map && prov['stream'] == true; // can play a title another plugin hands over
        final perms = m['permissions'];
        final fl = m['flutter'];
        hooks = perms is Map && perms['playback'] == true && fl is Map && fl['hooks'] is String;
        final ui = m['ui'];
        if (ui is Map) navTab = '${ui['navTab'] ?? ''}';
        final ic = '${m['icon'] ?? ''}';
        if (RegExp(r'^[A-Za-z0-9._-]{1,60}\.(png|jpe?g|webp|gif)$', caseSensitive: false).hasMatch(ic)) icon = '$base/plugins/${Uri.encodeComponent(folder)}/$ic';
      } catch (_) {}
      out.add(PluginInfo(folder: folder, name: name, description: desc, version: version, hasBackend: e['hasBackend'] == true, flutterScreen: flutterScreen, navTab: navTab, streamer: streamer, hooks: hooks, builtin: e['builtin'] == true, icon: icon));
    }
    return out;
  }

  /// Folder names of the installed plugins, or null when the list could not be read.
  static Future<List<String>?> pluginFolders() async {
    try {
      final j = await _get('/api/plugins');
      final l = (j is Map) ? j['plugins'] : null;
      if (l is! List) return null;
      return [for (final e in l) if (e is Map) '${e['folder']}'];
    } catch (_) {
      return null;
    }
  }

  /// GET /api/plugins/files: the plugin's own files (never data/) as (path, size, mtime), or null.
  static Future<List<({String path, int size, int mtime})>?> pluginFiles(String id) async {
    try {
      final j = await _get('/api/plugins/files?id=${Uri.encodeQueryComponent(id)}');
      final l = (j is Map && j['ok'] == true) ? j['files'] : null;
      if (l is! List) return null;
      return [for (final e in l) if (e is Map) (path: '${e['path']}', size: (e['size'] as num?)?.toInt() ?? 0, mtime: (e['mtime'] as num?)?.toInt() ?? 0)];
    } catch (_) {
      return null;
    }
  }

  /// GET /api/plugins/file: the bytes of one of the plugin's files.
  static Future<Uint8List> pluginFile(String id, String path) async {
    final r = await _client.get(Uri.parse('$base/api/plugins/file?id=${Uri.encodeQueryComponent(id)}&path=${Uri.encodeQueryComponent(path)}')).timeout(const Duration(seconds: 30));
    if (r.statusCode != 200) throw Exception('read');
    return r.bodyBytes;
  }

  static Future<bool> uninstallPlugin(String folder) async {
    final req = http.MultipartRequest('POST', Uri.parse('$base/api/plugins/uninstall'))..fields['id'] = folder;
    final r = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 20)));
    return r.statusCode == 200;
  }

  // ---------------------------------------------------------------- Music (/api/music/*)

  /// GET /api/music/status: whether the music scan runs, how many songs / albums / artists are published and how many files it has seen.
  static Future<MusicStatus> musicStatus() async {
    final j = await _get('/api/music/status');
    int n(String k) => (j[k] as num?)?.toInt() ?? 0;
    return MusicStatus(scanning: j['scanning'] == true, tracks: n('tracks'), albums: n('albums'), artists: n('artists'), scanned: n('scanned'));
  }

  static Future<MusicLibrary> musicLibrary() async {
    // A big library (thousands of songs) on a busy phone can take longer than 20 s, and the server can be mid-scan: wait longer
    // and ask once more before giving up. The error that is thrown at the end says what went wrong (shown on the Music page).
    const wait = Duration(seconds: 60);
    Future<List<dynamic>> ask() => Future.wait([_get('/api/music/albums', timeout: wait), _get('/api/music/artists', timeout: wait)]);
    List<dynamic> both;
    try {
      both = await ask();
    } catch (_) {
      await Future<void>.delayed(const Duration(seconds: 1));
      both = await ask();
    }
    final a = both[0], r = both[1];
    return MusicLibrary(
      scanning: a['scanning'] == true || r['scanning'] == true,
      albums: ((a['albums'] as List?) ?? const []).map((e) => Album.fromJson(e as Map<String, dynamic>)).toList(),
      artists: ((r['artists'] as List?) ?? const []).map((e) => Artist.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  /// One page of songs; [total] says how many there are in all.
  static Future<(int, List<Track>)> musicSongs({int offset = 0, int limit = 200, String q = ''}) async {
    final j = await _get('/api/music/songs?limit=$limit&offset=$offset&q=${Uri.encodeQueryComponent(q)}');
    return ((j['total'] as num?)?.toInt() ?? 0, ((j['songs'] as List?) ?? const []).map((e) => Track.fromJson(e as Map<String, dynamic>)).toList());
  }

  static Future<(Album, List<Track>)> musicAlbum(String id) async {
    final j = await _get('/api/music/album?id=${Uri.encodeQueryComponent(id)}');
    final album = Album.fromJson(j as Map<String, dynamic>);
    final tracks = ((j['list'] as List?) ?? const []).map((e) => Track.fromJson({...(e as Map<String, dynamic>), 'album': album.title, 'albumId': album.id, 'art': album.art})).toList();
    return (album, tracks);
  }

  static Future<(Artist, List<Album>)> musicArtist(String id) async {
    final j = await _get('/api/music/artist?id=${Uri.encodeQueryComponent(id)}');
    return (Artist.fromJson(j as Map<String, dynamic>), ((j['albums'] as List?) ?? const []).map((e) => Album.fromJson(e as Map<String, dynamic>)).toList());
  }

  static Future<MusicSearch> musicSearch(String q) async {
    final j = await _get('/api/music/search?q=${Uri.encodeQueryComponent(q)}');
    return MusicSearch(
      artists: ((j['artists'] as List?) ?? const []).map((e) => Artist.fromJson(e as Map<String, dynamic>)).toList(),
      albums: ((j['albums'] as List?) ?? const []).map((e) => Album.fromJson(e as Map<String, dynamic>)).toList(),
      songs: ((j['songs'] as List?) ?? const []).map((e) => Track.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  static String musicStream(String id) => '$base/api/music/stream/${Uri.encodeComponent(id)}';
  static String albumArt(String id) => '$base/api/music/art?album=${Uri.encodeQueryComponent(id)}';
  static String artistArt(String id) => '$base/api/music/art?artist=${Uri.encodeQueryComponent(id)}';
  static String trackArt(Track t) => t.albumId.isNotEmpty ? albumArt(t.albumId) : '$base/api/music/art?track=${Uri.encodeQueryComponent(t.id)}';

  static String streamUrl(String id) => '$base/api/stream/${Uri.encodeComponent(id)}';

  static String abs(String p) {
    if (p.isEmpty) return '';
    return p.startsWith('http') ? p : '$base$p';
  }
}

class _Pool {
  _Pool(this.limit);
  final int limit;
  int _running = 0;
  final Queue<Completer<void>> _waiting = Queue();

  Future<T> run<T>(Future<T> Function() job) async {
    if (_running >= limit) {
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
}

class Details {
  const Details({required this.overview, required this.poster});
  final String overview;
  final String poster;
}

/// One episode's title, full synopsis and still picture address (any of them may be empty).
class EpisodeInfo {
  const EpisodeInfo({required this.name, required this.overview, required this.still});
  final String name;
  final String overview;
  final String still;
}

class Movie {
  const Movie({required this.id, required this.title, required this.year, required this.filename});
  final String id;
  final String title;
  final int year;
  final String filename;

  factory Movie.fromJson(Map<String, dynamic> j) => Movie(
        id: '${j['id']}',
        title: '${j['title'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        filename: '${j['filename'] ?? ''}',
      );
}

class Episode {
  const Episode({required this.id, required this.season, required this.episode, required this.filename});
  final String id;
  final int season;
  final int episode;
  final String filename;

  factory Episode.fromJson(Map<String, dynamic> j) => Episode(
        id: '${j['id']}',
        season: (j['season'] as num?)?.toInt() ?? 0,
        episode: (j['episode'] as num?)?.toInt() ?? 0,
        filename: '${j['filename'] ?? ''}',
      );
}

class Season {
  const Season({required this.number, required this.episodes});
  final int number;
  final List<Episode> episodes;

  factory Season.fromJson(Map<String, dynamic> j) => Season(
        number: (j['season'] as num?)?.toInt() ?? 0,
        episodes: ((j['episodes'] as List?) ?? const []).map((e) => Episode.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class Show {
  const Show({required this.title, required this.episodeCount, required this.seasons});
  final String title;
  final int episodeCount;
  final List<Season> seasons;

  factory Show.fromJson(Map<String, dynamic> j) => Show(
        title: '${j['showTitle'] ?? ''}',
        episodeCount: (j['episodeCount'] as num?)?.toInt() ?? 0,
        seasons: ((j['seasons'] as List?) ?? const []).map((e) => Season.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class FileRow {
  const FileRow({required this.filename, required this.path, this.size = 0});
  final String filename;
  final String path;
  final int size;
  factory FileRow.fromJson(Map<String, dynamic> j) => FileRow(filename: '${j['filename'] ?? ''}', path: '${j['path'] ?? ''}', size: (j['size'] as num?)?.toInt() ?? 0);
}

class DupGroup {
  const DupGroup({required this.kind, required this.label, required this.wasted, required this.files});
  final String kind; // movie | episode | size
  final String label;
  final int wasted;
  final List<FileRow> files;
  factory DupGroup.fromJson(Map<String, dynamic> j) => DupGroup(
        kind: '${j['kind'] ?? ''}',
        label: '${j['label'] ?? ''}',
        wasted: (j['wasted'] as num?)?.toInt() ?? 0,
        files: ((j['files'] as List?) ?? const []).map((e) => FileRow.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class DuplicatesResult {
  const DuplicatesResult({required this.wastedTotal, required this.groups});
  final int wastedTotal;
  final List<DupGroup> groups;
}

class PluginInfo {
  const PluginInfo({required this.folder, required this.name, required this.description, required this.version, required this.hasBackend, this.flutterScreen = false, this.navTab = '', this.streamer = false, this.hooks = false, this.builtin = false, this.icon = ''});
  final String folder, name, description, version;

  /// Ships with PEK TV (weather, tmdb-discover, skin-maker): it cannot be removed, only updated from the PEK Store.
  final bool builtin;

  /// Address of the plugin's picture (plugin.json "icon"), '' = none.
  final String icon;
  final bool hasBackend;

  /// plugin.json has a "flutter" entry: the plugin ships a Python screen (screen.py) this UI can draw.
  final bool flutterScreen;

  /// plugin.json "ui.navTab": the label for the plugin's own entry in the menu ('' = none).
  final String navTab;

  /// plugin.json "provides": {"stream": true}: other plugins may open it on a title ("Play with ...").
  final bool streamer;

  /// plugin.json has the "playback" permission and "flutter": {"hooks": "hooks.py"}: PEK TV tells it what is played (plugin_hooks.dart).
  final bool hooks;
}

class Track {
  const Track({required this.id, required this.title, required this.artist, required this.album, required this.albumId, required this.duration, required this.art});
  final String id, title, artist, album, albumId;
  final double duration;
  final bool art;
  /// The slim form kept in a playlist (what the song needs to be listed and played again).
  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'artist': artist, 'album': album, 'albumId': albumId, 'duration': duration, 'art': art};
  factory Track.fromJson(Map<String, dynamic> j) => Track(
        id: '${j['id']}',
        title: '${j['title'] ?? ''}',
        artist: '${j['artist'] ?? ''}',
        album: '${j['album'] ?? ''}',
        albumId: '${j['albumId'] ?? ''}',
        duration: (j['duration'] as num?)?.toDouble() ?? 0,
        art: j['art'] != false,
      );
}

class Album {
  const Album({required this.id, required this.title, required this.artist, required this.year, required this.tracks, required this.art});
  final String id, title, artist;
  final int year, tracks;
  final bool art;
  factory Album.fromJson(Map<String, dynamic> j) => Album(
        id: '${j['id']}',
        title: '${j['title'] ?? ''}',
        artist: '${j['artist'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        tracks: (j['tracks'] is num) ? (j['tracks'] as num).toInt() : 0,
        art: j['art'] == true,
      );
}

class Artist {
  const Artist({required this.id, required this.name, required this.albums, required this.tracks, required this.art});
  final String id, name;
  final int albums, tracks;
  final bool art;
  factory Artist.fromJson(Map<String, dynamic> j) => Artist(
        id: '${j['id']}',
        name: '${j['name'] ?? ''}',
        albums: (j['albums'] is num) ? (j['albums'] as num).toInt() : 0,
        tracks: (j['tracks'] as num?)?.toInt() ?? 0,
        art: j['art'] == true || j['photo'] == true,
      );
}

class MusicLibrary {
  const MusicLibrary({required this.scanning, required this.albums, required this.artists});
  final bool scanning;
  final List<Album> albums;
  final List<Artist> artists;
}

class MusicStatus {
  const MusicStatus({required this.scanning, required this.tracks, required this.albums, required this.artists, required this.scanned});
  final bool scanning;
  final int tracks, albums, artists, scanned;
  String get key => '$tracks/$albums/$artists';
}

class MusicSearch {
  const MusicSearch({required this.artists, required this.albums, required this.songs});
  final List<Artist> artists;
  final List<Album> albums;
  final List<Track> songs;
}

/// An error whose text is fit to show as it is.
class ApiError implements Exception {
  ApiError(this.message);
  final String message;
  @override
  String toString() => message;
}

class NetHost {
  const NetHost({required this.name, required this.address, required this.label, required this.url});
  final String name;
  final String address;
  final String label; // "SMB share", "FTP server" ...
  final String url;

  factory NetHost.fromJson(Map<String, dynamic> j) => NetHost(name: '${j['name'] ?? ''}', address: '${j['address'] ?? ''}', label: '${j['label'] ?? ''}', url: '${j['url'] ?? ''}');
}

class NetDiscovery {
  const NetDiscovery({required this.scanning, required this.unsupported, required this.hosts});
  final bool scanning;
  final List<String> unsupported; // protocols this build can find but not open
  final List<NetHost> hosts;
}

class Facets {
  const Facets({required this.genres, required this.decades, required this.actors, required this.indexingDone, required this.indexingTotal});
  final List<MapEntry<String, int>> genres;
  final List<MapEntry<String, int>> decades; // key = the decade year (1990)
  final List<MapEntry<String, int>> actors;
  final int indexingDone;
  final int indexingTotal;
}
