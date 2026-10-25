import 'dart:async';

import 'package:flutter/material.dart';

import 'cloud.dart';
import 'library_match.dart';
import 'plugin_hooks.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// What is being rated: a movie, one episode, or a whole show. For an episode and a show [title] is the SHOW's title.
typedef RateTarget = ({String kind, String title, int year, int season, int episode});

/// A target plus the rating (0 = removed): what plugins are told (the `rated` hook event).
typedef RatedItem = ({String kind, String title, int year, int season, int episode, int rating});

/// One rating of a profile (1 to 10 stars, the same scale Trakt uses).
class RatingEntry {
  const RatingEntry({required this.key, required this.kind, required this.title, required this.year, required this.season, required this.episode, required this.rating, required this.at, required this.updated});
  final String key; // m|title|year, e|show|season|episode (the Watch History keys) or s|show
  final String kind; // 'movie' | 'episode' | 'show'
  final String title; // the movie's title, or the show's title for an episode and a show
  final int year;
  final int season;
  final int episode;
  final int rating; // 1..10
  final int at; // when it was rated (ms since epoch)
  final int updated; // last change (sync)

  String get label {
    if (kind == 'episode') {
      String two(int n) => n.toString().padLeft(2, '0');
      return '$title \u00b7 S${two(season)}E${two(episode)}';
    }
    return kind == 'movie' && year > 0 ? '$title ($year)' : title;
  }

  static String kindOfKey(String key) => key.startsWith('e|') ? 'episode' : key.startsWith('s|') ? 'show' : 'movie';

  static RatingEntry? fromJson(Map<String, dynamic> j) {
    if (j['deleted'] != null) return null;
    final r = (j['rating'] as num?)?.toInt() ?? 0;
    final key = '${j['key'] ?? ''}';
    if (key.isEmpty || r < 1 || r > Ratings.max) return null;
    return RatingEntry(
      key: key,
      kind: kindOfKey(key),
      title: '${j['title'] ?? ''}',
      year: (j['year'] as num?)?.toInt() ?? 0,
      season: (j['season'] as num?)?.toInt() ?? 0,
      episode: (j['episode'] as num?)?.toInt() ?? 0,
      rating: r,
      at: (j['at'] as num?)?.toInt() ?? 0,
      updated: (j['updated'] as num?)?.toInt() ?? (j['at'] as num?)?.toInt() ?? 0,
    );
  }

  Map<String, dynamic> toJson() => {'key': key, 'kind': kind, 'title': title, 'year': year, 'season': season, 'episode': episode, 'rating': rating, 'at': at, 'updated': updated > 0 ? updated : at};
}

/// Movie, episode and show ratings, kept per profile (like Watch History) and backed up to PEK Cloud by the same sync.
///
/// The record lives in [Store] under `pek_ratings_v1`, keyed like history (`m|title|year`, `e|show|season|episode`) plus
/// `s|show` for a whole show. Removing a rating leaves a `{deleted, updated}` marker so the removal syncs too. Plugins with the
/// "playback" permission are told about every change (the `rated` hook event); a plugin can also set ratings
/// (`pek_ui.set_ratings_many`), which is how Trakt ratings come in.
class Ratings {
  static const max = 10;
  static Timer? _timer;

  static RateTarget movie(String title, int year) => (kind: 'movie', title: title, year: year, season: 0, episode: 0);
  static RateTarget episode(String show, int season, int episode) => (kind: 'episode', title: show, year: 0, season: season, episode: episode);
  static RateTarget show(String title) => (kind: 'show', title: title, year: 0, season: 0, episode: 0);

  /// The history-style key of a target (null when it has no usable title).
  static String? keyFor(RateTarget t) {
    switch (t.kind) {
      case 'movie':
        return Store.keyFor(kind: 'movie', title: t.title, year: t.year);
      case 'episode':
        return Store.keyFor(kind: 'episode', showTitle: t.title, season: t.season, episode: t.episode);
      case 'show':
        final n = Store.normalize(t.title);
        return n.isEmpty ? null : 's|$n';
    }
    return null;
  }

  static String? keyOf(String title, int year) => keyFor(movie(title, year)); // movies (older callers)

  /// Newest rating first. [kind] limits it to 'movie', 'episode' or 'show'.
  static List<RatingEntry> all({String? kind}) {
    final out = <RatingEntry>[];
    Store.ratingsRaw().forEach((k, v) {
      if (v is Map) {
        final e = RatingEntry.fromJson(Map<String, dynamic>.from(v));
        if (e != null && (kind == null || e.kind == kind)) out.add(e);
      }
    });
    out.sort((a, b) => b.at.compareTo(a.at));
    return out;
  }

  /// The profile's rating of [t], 0 when it has none.
  static int ofTarget(RateTarget t) {
    final key = keyFor(t);
    if (key == null) return 0;
    final v = Store.ratingsRaw()[key];
    return v is Map ? (RatingEntry.fromJson(Map<String, dynamic>.from(v))?.rating ?? 0) : 0;
  }

  static int of(String title, int year) => ofTarget(movie(title, year));
  static int ofEpisode(String show, int season, int ep) => ofTarget(episode(show, season, ep));
  static int ofShow(String title) => ofTarget(show(title));

  /// Rates a movie 1..10; 0 removes the rating. Returns false when nothing changed.
  static Future<bool> rate(String title, int year, int rating) => rateTarget(movie(title, year), rating);

  /// Rates [t] 1..10; 0 removes the rating. Returns false when nothing changed.
  static Future<bool> rateTarget(RateTarget t, int rating) async {
    final key = keyFor(t);
    if (key == null) return false;
    final r = rating.clamp(0, max);
    final changed = await _write(key, t, r, DateTime.now().millisecondsSinceEpoch);
    if (!changed) return false;
    _syncSoon();
    PluginHooks.rated([(kind: t.kind, title: t.title, year: t.year, season: t.season, episode: t.episode, rating: r)]);
    return true;
  }

  /// Ratings a plugin brought in (Trakt). [items] are `{kind (movie by default), title, year, season, episode, rating (0 = removed),
  /// at (seconds since 1970 or 0)}`. Titles are lined up with the library's own first (see library_match.dart). The plugin [source]
  /// is not told about its own change.
  static Future<void> setFromPlugin(List<Map> items, String source) async {
    final list = <Map>[
      for (final it in items)
        if (it['title'] != null && '${it['title']}'.trim().isNotEmpty && const {'movie', 'episode', 'show'}.contains('${it['kind'] ?? 'movie'}')) it,
    ];
    if (list.isEmpty) return;
    int n(Object? v) => (v as num?)?.toInt() ?? 0;
    String kindOf(Map it) => '${it['kind'] ?? 'movie'}';
    // library_match lines up movies and episodes; a show is looked up as the first episode of the show, only for its title
    final shaped = [
      for (final it in list)
        if (kindOf(it) == 'movie')
          Progress(id: '', title: '${it['title']}', kind: 'movie', position: 0, duration: 0, updated: 0, year: n(it['year']))
        else
          Progress(id: '', title: '${it['title']}', kind: 'episode', position: 0, duration: 0, updated: 0, showTitle: '${it['title']}', season: kindOf(it) == 'show' ? 1 : n(it['season']), episode: kindOf(it) == 'show' ? 1 : n(it['episode'])),
    ];
    final resolved = await LibraryMatch.resolve(shaped);
    final changed = <RatedItem>[];
    final now = DateTime.now().millisecondsSinceEpoch;
    _cache = null;
    try {
      for (var i = 0; i < list.length; i++) {
        final p = resolved[i];
        final kind = kindOf(list[i]);
        final RateTarget t = kind == 'movie' ? movie(p.title, p.year) : kind == 'episode' ? episode(p.showTitle, n(list[i]['season']), n(list[i]['episode'])) : show(p.showTitle);
        final key = keyFor(t);
        if (key == null) continue;
        final r = n(list[i]['rating']).clamp(0, max);
        final plugAt = Store.watchTimeFromSeconds(list[i]['at']);
        final at = plugAt ?? now;
        // A rating made here after the plugin's own date wins: the plugin's older copy must not overwrite it.
        final cur = (_cache ??= Store.ratingsRaw())[key];
        // (for a removal the plugin's "at" is the time it last looked)
        if (plugAt != null && cur is Map && cur['deleted'] == null && n(cur['at']) > plugAt) continue;
        if (await _write(key, t, r, at, updated: now, batch: true)) changed.add((kind: t.kind, title: t.title, year: t.year, season: t.season, episode: t.episode, rating: r));
      }
    } finally {
      _cache = null;
    }
    if (changed.isEmpty) return;
    await Store.flushRatings();
    Store.notifyChanged();
    _syncSoon();
    PluginHooks.rated(changed, except: source);
  }

  static Map<String, dynamic>? _cache; // only while a plugin batch is being applied

  static Future<bool> _write(String key, RateTarget t, int rating, int at, {int? updated, bool batch = false}) async {
    final map = batch ? (_cache ??= Store.ratingsRaw()) : Store.ratingsRaw();
    final now = updated ?? DateTime.now().millisecondsSinceEpoch;
    final old = map[key];
    final cur = old is Map ? (RatingEntry.fromJson(Map<String, dynamic>.from(old))?.rating ?? 0) : 0;
    if (cur == rating) return false;
    if (rating == 0) {
      map[key] = {'deleted': 1, 'updated': now};
    } else {
      map[key] = RatingEntry(key: key, kind: t.kind, title: t.title, year: t.year, season: t.season, episode: t.episode, rating: rating, at: at, updated: now).toJson();
    }
    if (batch) {
      Store.pendingRatings = map;
    } else {
      await Store.writeRatingsRaw(map);
      Store.notifyChanged();
    }
    return true;
  }

  static void _syncSoon() {
    _cache = null;
    if (!Cloud.linked) return;
    _timer?.cancel();
    _timer = Timer(const Duration(seconds: 2), () => unawaited(Cloud.sync(light: true)));
  }

  /// Tells the cloud about a change that was written some other way.
  static void syncSoon() => _syncSoon();
}

/// The rating target of a Watch History entry (a movie, or an episode of a show).
RateTarget targetOfHistory(HistoryEntry e) => e.kind == 'episode' ? Ratings.episode(e.title, e.season, e.episode) : Ratings.movie(e.title, e.year);

// ====================================================================== UI

/// Ten tappable stars. Tapping the star that is already the rating removes it. On a remote, left / right moves between the stars
/// and select rates.
class StarRating extends StatelessWidget {
  const StarRating({super.key, required this.value, required this.onChanged, this.autofocus = false});
  final int value; // 0 = not rated
  final ValueChanged<int> onChanged; // 0 = remove
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final size = 1.9 * p.rem;
    return FittedBox(
      fit: BoxFit.scaleDown,
      alignment: Alignment.centerLeft,
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        for (var i = 1; i <= Ratings.max; i++)
          PekFocusable(
            autofocus: autofocus && (value == 0 ? i == 1 : i == value),
            radius: 999,
            padding: EdgeInsets.all(0.15 * p.rem),
            background: Colors.transparent,
            onTap: () => onChanged(i == value ? 0 : i),
            child: Icon(i <= value ? Icons.star_rounded : Icons.star_outline_rounded, size: size, color: i <= value ? const Color(0xFFFFC107) : t.textMuted),
          ),
      ]),
    );
  }
}

String _noun(String kind) => kind == 'episode' ? 'episode' : kind == 'show' ? 'show' : 'movie';

/// "Your rating" block for a movie, episode or show page.
class RatingPanel extends StatelessWidget {
  const RatingPanel({super.key, required this.title, this.year = 0, this.kind = 'movie', this.season = 0, this.episode = 0});
  final String title; // for an episode and a show: the show's title
  final int year;
  final String kind;
  final int season;
  final int episode;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final target = (kind: kind, title: title, year: year, season: season, episode: episode);
    final v = Ratings.ofTarget(target);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(v > 0 ? 'Your rating: $v / ${Ratings.max}' : 'Rate this ${_noun(kind)}', style: TextStyle(fontWeight: FontWeight.w700, color: t.text)),
      SizedBox(height: 0.35 * p.rem),
      StarRating(value: v, onChanged: (n) => Ratings.rateTarget(target, n)),
    ]);
  }
}

/// A small rating sheet (the Watch History page uses it).
Future<void> showRateDialog(BuildContext context, {required String title, int year = 0, String kind = 'movie', int season = 0, int episode = 0}) {
  final target = (kind: kind, title: title, year: year, season: season, episode: episode);
  String two(int n) => n.toString().padLeft(2, '0');
  final heading = kind == 'episode' ? '$title \u00b7 S${two(season)}E${two(episode)}' : (kind == 'movie' && year > 0 ? '$title ($year)' : title);
  return showDialog<void>(
    context: context,
    builder: (c) => ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (c, _, __) {
        final v = Ratings.ofTarget(target);
        return AlertDialog(
          title: Text(heading),
          content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(v > 0 ? 'Your rating: $v / ${Ratings.max}' : 'Not rated yet'),
            const SizedBox(height: 8),
            StarRating(value: v, autofocus: true, onChanged: (n) => Ratings.rateTarget(target, n)),
          ]),
          actions: [TextButton(onPressed: () => Navigator.pop(c), child: const Text('Done'))],
        );
      },
    ),
  );
}
