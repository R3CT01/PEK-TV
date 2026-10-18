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
