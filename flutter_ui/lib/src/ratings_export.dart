import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:share_plus/share_plus.dart';

import 'profiles.dart';
import 'ratings.dart';
import 'store.dart';

/// Watch history + ratings of the ACTIVE profile as files other services can import.
///
///  * CSV (movies only, Letterboxd is for films) in Letterboxd's import format (`Title, Year, Rating, Rating10, WatchedDate`). Trakt, Simkl and Letterboxd read it and
///    match films by title + year, so no ids are needed. Rating is 0.5 to 5 (half stars, exactly your 10-star rating halved);
///    Rating10 carries the 1 to 10 value for importers that read it.
///  * JSON: everything in one file (movies, episodes, and movie / episode / show ratings), plus a `trakt` block shaped like the bodies of Trakt's POST /sync/ratings and
///    /sync/history, for scripts or the Trakt plugin.
///
/// The Trakt plugin pushes new ratings and watches to Trakt directly, with no file; this export is for a one-off move or a backup.
class RatingsExport {
  static String _iso(int ms) => DateTime.fromMillisecondsSinceEpoch(ms, isUtc: true).toIso8601String().replaceFirst(RegExp(r'\.\d+Z$'), '.000Z');

  static String _date(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.year}-${two(d.month)}-${two(d.day)}';
  }

  static String _csv(String v) => (v.contains(',') || v.contains('"') || v.contains('\n')) ? '"${v.replaceAll('"', '""')}"' : v;

  /// One row per movie that was watched and/or rated.
  static List<({String title, int year, int at, int plays, int rating, int ratedAt})> _movies() {
    final byKey = <String, ({String title, int year, int at, int plays, int rating, int ratedAt})>{};
    for (final h in Store.history()) {
      if (h.kind != 'movie') continue;
      byKey[h.key] = (title: h.title, year: h.year, at: h.at, plays: h.count, rating: 0, ratedAt: 0);
    }
    for (final r in Ratings.all(kind: 'movie')) {
      final old = byKey[r.key];
      byKey[r.key] = (title: r.title, year: r.year, at: old?.at ?? 0, plays: old?.plays ?? 0, rating: r.rating, ratedAt: r.at);
    }
    final out = byKey.values.toList()..sort((a, b) => (b.at > 0 ? b.at : b.ratedAt).compareTo(a.at > 0 ? a.at : a.ratedAt));
    return out;
  }

  static String letterboxdCsv() {
    final b = StringBuffer('Title,Year,Rating,Rating10,WatchedDate\n');
    for (final m in _movies()) {
      final half = m.rating > 0 ? (m.rating / 2).toString() : '';
      b.writeln('${_csv(m.title)},${m.year > 0 ? m.year : ''},$half,${m.rating > 0 ? m.rating : ''},${m.at > 0 ? _date(m.at) : ''}');
    }
    return b.toString();
  }

  static String json() {
    final movies = _movies();
    final episodes = [for (final h in Store.history()) if (h.kind == 'episode') h];
    final episodeRatings = Ratings.all(kind: 'episode');
    final showRatings = Ratings.all(kind: 'show');
    final o = {
      'app': 'PEK TV',
      'format': 1,
      'exported': _iso(DateTime.now().millisecondsSinceEpoch),
      'profile': Profiles.current.name,
      'ratingScale': '1-10 stars (Trakt scale)',
      'movies': [
        for (final m in movies)
          {'title': m.title, 'year': m.year, 'watched_at': m.at > 0 ? _iso(m.at) : null, 'plays': m.plays, 'rating': m.rating > 0 ? m.rating : null, 'rated_at': m.ratedAt > 0 ? _iso(m.ratedAt) : null},
      ],
      'episodes': [
        for (final e in episodes) {'show': e.title, 'season': e.season, 'episode': e.episode, 'watched_at': _iso(e.at), 'plays': e.count},
      ],
      'episode_ratings': [
        for (final r in episodeRatings) {'show': r.title, 'season': r.season, 'episode': r.episode, 'rating': r.rating, 'rated_at': _iso(r.at)},
      ],
      'show_ratings': [
        for (final r in showRatings) {'show': r.title, 'rating': r.rating, 'rated_at': _iso(r.at)},
      ],
      'trakt': {
        'ratings': {
          'movies': [for (final m in movies) if (m.rating > 0) {'title': m.title, 'year': m.year, 'rating': m.rating, 'rated_at': _iso(m.ratedAt > 0 ? m.ratedAt : DateTime.now().millisecondsSinceEpoch)}],
          'shows': _ratedShowsBody(showRatings, episodeRatings),
        },
        'history': {
          'movies': [for (final m in movies) if (m.at > 0) {'title': m.title, 'year': m.year, 'watched_at': _iso(m.at)}],
          'shows': _showsBody(episodes),
        },
      },
    };
    return const JsonEncoder.withIndent('  ').convert(o);
  }

  /// Show and episode ratings in the body Trakt's POST /sync/ratings takes: a whole-show rating is its own entry, episodes go show > season.
  static List<Map<String, dynamic>> _ratedShowsBody(List<RatingEntry> shows, List<RatingEntry> episodes) {
    final out = <Map<String, dynamic>>[
      for (final r in shows) {'title': r.title, 'rating': r.rating, 'rated_at': _iso(r.at)},
    ];
    final bySeason = <String, Map<int, List<Map<String, dynamic>>>>{};
    for (final r in episodes) {
      bySeason.putIfAbsent(r.title, () => {}).putIfAbsent(r.season, () => []).add({'number': r.episode, 'rating': r.rating, 'rated_at': _iso(r.at)});
    }
    for (final s in bySeason.entries) {
      out.add({
        'title': s.key,
        'seasons': [for (final se in (s.value.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))) {'number': se.key, 'episodes': se.value}],
      });
    }
    return out;
  }

  /// Episodes grouped the way Trakt's history body wants them: show -> seasons -> episodes.
  static List<Map<String, dynamic>> _showsBody(List<HistoryEntry> episodes) {
    final shows = <String, Map<int, List<Map<String, dynamic>>>>{};
    for (final e in episodes) {
      shows.putIfAbsent(e.title, () => {}).putIfAbsent(e.season, () => []).add({'number': e.episode, 'watched_at': _iso(e.at)});
    }
    return [
      for (final s in shows.entries)
        {
          'title': s.key,
          'seasons': [for (final se in (s.value.entries.toList()..sort((a, b) => a.key.compareTo(b.key)))) {'number': se.key, 'episodes': se.value}],
        },
    ];
  }

  /// Writes [text] to a file and opens the share sheet. Falls back to the clipboard where there is no share sheet (a TV).
  static Future<String> share(String name, String mime, String text) async {
    try {
      final f = File('${Directory.systemTemp.path}/$name');
      await f.writeAsString(text, flush: true);
      await Share.shareXFiles([XFile(f.path, mimeType: mime, name: name)], subject: name);
      return 'Ready to share.';
    } catch (_) {
      await Clipboard.setData(ClipboardData(text: text));
      return 'Sharing is not available here, so the text was copied. Paste it into a file.';
    }
  }
}

/// The "Export history & ratings" sheet on the Watch History page.
Future<void> showExportSheet(BuildContext context) {
  final who = Profiles.current.name;
  final stamp = RatingsExport._date(DateTime.now().millisecondsSinceEpoch);
  void say(String m) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(m)));
  return showModalBottomSheet<void>(
    context: context,
    builder: (c) => SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 16, 16, 4), child: Text('Export $who\u2019s history and ratings', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16))),
        const Padding(
          padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Text('Only this profile is exported. With the Trakt plugin signed in, new ratings and watches already go to Trakt by themselves.'),
        ),
        ListTile(
          autofocus: true,
          leading: const Icon(Icons.table_chart_outlined),
          title: const Text('CSV for Trakt / Letterboxd / Simkl import'),
          subtitle: const Text('Movies only: title, year, rating (half stars and 1\u201310), watched date'),
          onTap: () async {
            Navigator.pop(c);
            say(await RatingsExport.share('pek-tv-$stamp.csv', 'text/csv', RatingsExport.letterboxdCsv()));
          },
        ),
        ListTile(
          leading: const Icon(Icons.data_object),
          title: const Text('Full backup (JSON)'),
          subtitle: const Text('Movies, episodes, movie / episode / show ratings, plus Trakt-shaped bodies'),
          onTap: () async {
            Navigator.pop(c);
            say(await RatingsExport.share('pek-tv-$stamp.json', 'application/json', RatingsExport.json()));
          },
        ),
        ListTile(
          leading: const Icon(Icons.copy),
          title: const Text('Copy CSV to clipboard'),
          onTap: () async {
            Navigator.pop(c);
            await Clipboard.setData(ClipboardData(text: RatingsExport.letterboxdCsv()));
            say('CSV copied.');
          },
        ),
      ]),
    ),
  );
}
