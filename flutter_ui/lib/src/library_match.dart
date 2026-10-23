import 'dart:async';

import 'api.dart';
import 'store.dart';

/// Lines up the titles a plugin reports (Trakt's, say) with the titles the library holds, so a watch imported from
/// elsewhere gets the ✓ on the right movie / show.
///
/// Watch History is keyed by title text (`m|title|year`, `e|show|season|episode`, the same keys the web UI and the cloud
/// use), so "The Office" from Trakt and "The Office (US)" in the library are two different things. Before a plugin's
/// "mark watched" is stored, [resolve] swaps its title (and a movie's year) for the library's own, but only where exactly
/// one library title fits. Anything else is left exactly as the plugin sent it, so nothing is lost and nothing is guessed.
///
/// What counts as the same title: capitals, accents, punctuation and spaces do not matter, "&" is "and", a leading
/// "The" / "A" / "An" is ignored, and a closing "(2005)" or "(US)" is ignored. A movie's year may be one off (release dates
/// differ between sources). Two library movies that both fit (a 1999 and a 2000 title with the same name and no year given)
/// are ambiguous, so the item is left alone.
///
/// The plugin is never shown the library: this runs inside PEK TV, after the plugin has answered.
class LibraryMatch {
  static Future<_Index?>? _index;
  static DateTime _builtAt = DateTime.fromMillisecondsSinceEpoch(0);
  static const _keepFor = Duration(minutes: 5);

  /// [items] with library titles swapped in where one clear match exists. Never throws and never waits long: when the
  /// library cannot be read the items come back unchanged.
  static Future<List<Progress>> resolve(List<Progress> items) async {
    try {
      final idx = await _get();
      if (idx == null || idx.isEmpty) return items;
      return [for (final p in items) idx.map(p)];
    } catch (_) {
      return items;
    }
  }

  /// The library as it was read a few minutes ago (a rescan shows up within [_keepFor]).
  static Future<_Index?> _get() {
    final now = DateTime.now();
    if (_index == null || now.difference(_builtAt) > _keepFor) {
      _builtAt = now;
      _index = _build();
    }
    return _index!;
  }

  static Future<_Index?> _build() async {
    try {
      final movies = await Api.movies().timeout(const Duration(seconds: 5));
      final shows = await Api.shows().timeout(const Duration(seconds: 5));
      return _Index(movies, shows);
    } catch (_) {
      _builtAt = DateTime.fromMillisecondsSinceEpoch(0); // the server was not ready: ask again next time
      return null;
    }
  }
}

class _Index {
  _Index(List<Movie> movies, List<Show> shows) {
    for (final m in movies) {
      final k = _key(m.title);
      if (k.isNotEmpty) (_movies[k] ??= <Movie>[]).add(m);
    }
    for (final s in shows) {
      final k = _key(s.title);
      if (k.isNotEmpty) (_shows[k] ??= <String>{}).add(s.title);
    }
  }

  final Map<String, List<Movie>> _movies = {};
  final Map<String, Set<String>> _shows = {};

  bool get isEmpty => _movies.isEmpty && _shows.isEmpty;

  Progress map(Progress p) {
    if (p.kind == 'movie') return _movie(p);
    if (p.kind == 'episode') return _episode(p);
    return p;
  }

  Progress _movie(Progress p) {
    final list = _movies[_key(p.title)];
    if (list == null) return p;
    Movie? pick;
    // The same year first, then a year off by one. No year on either side fits any year.
    for (final slack in const [0, 1]) {
      final fit = <String, Movie>{};
      for (final m in list) {
        if (p.year == 0 || m.year == 0 || (m.year - p.year).abs() <= slack) fit['${m.title}|${m.year}'] = m;
      }
      if (fit.length == 1) {
        pick = fit.values.first;
        break;
      }
      if (fit.length > 1) return p; // two different library movies fit: do not guess
    }
    if (pick == null) return p;
    if (pick.title == p.title && pick.year == p.year) return p;
    return Progress(id: '', title: pick.title, kind: 'movie', position: 0, duration: 0, updated: p.updated, year: pick.year);
  }

  Progress _episode(Progress p) {
    final names = _shows[_key(p.showTitle)];
    if (names == null || names.length != 1) return p; // not in the library, or two shows share the name
    final name = names.first;
    if (name == p.showTitle) return p;
    return Progress(id: '', title: name, kind: 'episode', position: 0, duration: 0, updated: p.updated, showTitle: name, season: p.season, episode: p.episode);
  }
}

final Map<String, String> _fold = () {
  final m = <String, String>{};
  void add(String chars, String to) {
    for (final r in chars.runes) {
      m[String.fromCharCode(r)] = to;
    }
  }

  add('àáâãäåāăą', 'a');
  add('çćč', 'c');
  add('ďđ', 'd');
  add('èéêëēėęě', 'e');
  add('ğ', 'g');
  add('ìíîïīįı', 'i');
  add('ł', 'l');
  add('ñńň', 'n');
  add('òóôõöøōő', 'o');
  add('ŕř', 'r');
  add('śšşș', 's');
  add('ťţ', 't');
  add('ùúûüūůűų', 'u');
  add('ýÿ', 'y');
  add('źżž', 'z');
  return m;
}();

/// The text two spellings of one title have in common (see [LibraryMatch]).
String _key(String title) {
  final cleaned = title
      .replaceAll(RegExp(r'\s*\((?:\d{4}|[A-Za-z]{2,3})\)\s*$'), '') // "(2005)", "(US)"
      .replaceAll('&', ' and ')
      .replaceAll(RegExp(r"['’`´]"), '')
      .toLowerCase();
  final sb = StringBuffer();
  for (final r in cleaned.runes) {
    final c = String.fromCharCode(r);
    sb.write(_fold[c] ?? c);
  }
  // Letters of any script stay; spaces, symbols and punctuation ("WALL·E", "Spider-Man", "Mr. Robot") are only separators.
  final words = sb.toString().replaceAll(RegExp(r'[^a-z0-9\u00c0-\u1fff\u2e80-\uffff]+'), ' ').trim().replaceFirst(RegExp(r'^(the|a|an) '), '');
  return words.replaceAll(' ', '');
}
