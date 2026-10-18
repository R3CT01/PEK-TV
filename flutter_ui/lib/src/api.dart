import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// Talks to the existing C++ server (backend/server.cpp) on the loopback port. Nothing in the backend changes.
class Api {
  static const base = 'http://127.0.0.1:8080';
  static final http.Client _client = http.Client();

  static Future<dynamic> _get(String path) async {
    final r = await _client.get(Uri.parse('$base$path')).timeout(const Duration(seconds: 20));
    if (r.statusCode != 200) throw Exception('HTTP ${r.statusCode} for $path');
    return jsonDecode(utf8.decode(r.bodyBytes));
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
  static Future<int?> rescan() async {
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

  static Future<List<Movie>> movies() async {
    final j = await _get('/api/movies');
    final list = (j['movies'] as List?) ?? const [];
    return list.map((e) => Movie.fromJson(e as Map<String, dynamic>)).toList();
  }

  static Future<List<Show>> shows() async {
    final j = await _get('/api/shows');
    final list = (j['shows'] as List?) ?? const [];
    return list.map((e) => Show.fromJson(e as Map<String, dynamic>)).toList();
  }

  static final Map<String, Future<Details>> _details = {};
  static final _Pool _pool = _Pool(4);

  /// Poster + synopsis for a movie. Cached, and at most 4 lookups run at once so a big grid does not flood the box.
  static Future<Details> movieDetails(String id) => _details.putIfAbsent('m:$id', () => _pool.run(() async {
        final j = await _get('/api/movie-details?id=${Uri.encodeQueryComponent(id)}');
        return Details(overview: (j['overview'] ?? '') as String, poster: abs((j['poster'] ?? '') as String));
      }));

  static Future<Details> showDetails(String title) => _details.putIfAbsent('s:$title', () => _pool.run(() async {
        final j = await _get('/api/show-details?title=${Uri.encodeQueryComponent(title)}');
        return Details(overview: (j['overview'] ?? '') as String, poster: abs((j['poster'] ?? '') as String));
      }));

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
      var name = folder, desc = '', version = '';
      try {
        final m = await _get('/plugins/${Uri.encodeComponent(folder)}/plugin.json');
        name = '${m['name'] ?? folder}';
        desc = '${m['description'] ?? ''}';
        version = '${m['version'] ?? ''}';
      } catch (_) {}
      out.add(PluginInfo(folder: folder, name: name, description: desc, version: version, hasBackend: e['hasBackend'] == true));
    }
    return out;
  }

  static Future<bool> uninstallPlugin(String folder) async {
    final req = http.MultipartRequest('POST', Uri.parse('$base/api/plugins/uninstall'))..fields['id'] = folder;
    final r = await http.Response.fromStream(await _client.send(req).timeout(const Duration(seconds: 20)));
    return r.statusCode == 200;
  }

  // ---------------------------------------------------------------- Music (/api/music/*)

  static Future<MusicLibrary> musicLibrary() async {
    final a = await _get('/api/music/albums');
    final r = await _get('/api/music/artists');
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
  const PluginInfo({required this.folder, required this.name, required this.description, required this.version, required this.hasBackend});
  final String folder, name, description, version;
  final bool hasBackend;
}

class Track {
  const Track({required this.id, required this.title, required this.artist, required this.album, required this.albumId, required this.duration, required this.art});
  final String id, title, artist, album, albumId;
  final double duration;
  final bool art;
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

class MusicSearch {
  const MusicSearch({required this.artists, required this.albums, required this.songs});
  final List<Artist> artists;
  final List<Album> albums;
  final List<Track> songs;
}
