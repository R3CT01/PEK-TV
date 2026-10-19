import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// On-device state for the Flutter UI (the web UI kept the same things in localStorage, which Flutter cannot read):
/// watch progress (Resume Watching), favorites and the dashboard layout. The C++ backend is not involved.
class Store {
  static late SharedPreferences _p;

  /// RESUME_MIN_SEC / RESUME_DONE_RATIO in app_config.js.
  static const resumeMinSec = 30;
  static const resumeDoneRatio = 0.95;

  /// Bumped whenever progress / favorites / dashboard change, so the screens showing them repaint.
  static final ValueNotifier<int> changed = ValueNotifier(0);

  static Future<void> init() async {
    _p = await SharedPreferences.getInstance();
  }

  static void _bump() => changed.value++;

  static Map<String, dynamic> _map(String key) {
    try {
      final o = jsonDecode(_p.getString(key) ?? '{}');
      return o is Map ? Map<String, dynamic>.from(o) : {};
    } catch (_) {
      return {};
    }
  }

  static List<Map<String, dynamic>> _list(String key) {
    try {
      final o = jsonDecode(_p.getString(key) ?? '[]');
      return o is List ? o.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : [];
    } catch (_) {
      return [];
    }
  }

  // ---------------------------------------------------------------- subtitles (Settings > Subtitles)

  /// pek_subs_lang / pek_subs_auto in subtitles.js: language code(s) such as "en" or "en,es"; auto-search on by default.
  static String get subsLang {
    final v = (_p.getString('pek_subs_lang') ?? 'en').trim();
    return v.isEmpty ? 'en' : v;
  }

  static bool get subsAuto => (_p.getString('pek_subs_auto') ?? '1') != '0';

  static Future<void> setSubsLang(String v) async {
    await _p.setString('pek_subs_lang', v.trim().isEmpty ? 'en' : v.trim());
    _bump();
  }

  static Future<void> setSubsAuto(bool on) async {
    await _p.setString('pek_subs_auto', on ? '1' : '0');
    _bump();
  }

  // ---------------------------------------------------------------- skip intro / lyrics preferences

  /// hesper_skip_auto: jump past intros and recaps without asking (default off).
  static bool get skipAuto => _p.getBool('pek_skip_auto') ?? false;

  /// hesper_skip_online: look the times up in the online database for TV episodes (default on).
  static bool get skipOnline => _p.getBool('pek_skip_online') ?? true;

  static Future<void> setSkipAuto(bool on) async {
    await _p.setBool('pek_skip_auto', on);
    _bump();
  }

  static Future<void> setSkipOnline(bool on) async {
    await _p.setBool('pek_skip_online', on);
    _bump();
  }

  /// The lyrics panel on Now Playing (hesper_music_fs_lyrics).
  static bool get musicLyrics => _p.getBool('pek_music_lyrics') ?? false;
  static Future<void> setMusicLyrics(bool on) => _p.setBool('pek_music_lyrics', on);

  // ---------------------------------------------------------------- watch history (a permanent "watched" record)

  static const _historyKey = 'pek_history_v1';

  /// Finishing the same thing again within 12 hours counts as one watch.
  static const rewatchWindowMs = 12 * 60 * 60 * 1000;

  static String _norm(String s) => s.toLowerCase().replaceAll(RegExp(r'\s+'), ' ').trim();

  static String? historyKey(Progress p) {
    if (p.kind == 'movie') return _norm(p.title).isEmpty ? null : 'm|${_norm(p.title)}|${p.year}';
    if (p.kind == 'episode') return _norm(p.showTitle).isEmpty ? null : 'e|${_norm(p.showTitle)}|${p.season}|${p.episode}';
    return null;
  }

  /// Most recently watched first.
  static List<HistoryEntry> history() {
    final out = _map(_historyKey).values.whereType<Map>().map((e) => HistoryEntry.fromJson(Map<String, dynamic>.from(e))).where((e) => e.key.isNotEmpty).toList();
    out.sort((a, b) => b.at.compareTo(a.at));
    return out;
  }

  static Future<void> recordWatched(Progress p) async {
    final key = historyKey(p);
    if (key == null) return;
    final map = _map(_historyKey);
    final now = DateTime.now().millisecondsSinceEpoch;
    final old = map[key];
    if (old is Map) {
      final e = HistoryEntry.fromJson(Map<String, dynamic>.from(old));
      if (now - e.at < rewatchWindowMs) {
        map[key] = e.copyWith(at: now).toJson(); // the same watch, seen again
      } else {
        map[key] = e.copyWith(at: now, count: e.count + 1).toJson();
      }
    } else {
      map[key] = HistoryEntry(key: key, kind: p.kind, title: p.kind == 'episode' ? p.showTitle : p.title, year: p.year, season: p.season, episode: p.episode, at: now, count: 1).toJson();
    }
    await _p.setString(_historyKey, jsonEncode(map));
    _bump();
  }

  static Future<void> removeHistory(String key) async {
    final map = _map(_historyKey)..remove(key);
    await _p.setString(_historyKey, jsonEncode(map));
    _bump();
  }

  static Future<void> clearHistory() async {
    await _p.remove(_historyKey);
    _bump();
  }

  // ---------------------------------------------------------------- progress (Resume Watching)

  static const _progressKey = 'pek_progress_v1';

  /// Items with something worth resuming, most recently watched first.
  static List<Progress> resumeItems() {
    final out = _map(_progressKey).values.whereType<Map>().map((e) => Progress.fromJson(Map<String, dynamic>.from(e))).where((e) => e.id.isNotEmpty && e.position >= resumeMinSec).toList();
    out.sort((a, b) => b.updated.compareTo(a.updated));
    return out;
  }

  static Progress? progressFor(String id) {
    final m = _map(_progressKey)[id];
    if (m is! Map) return null;
    final p = Progress.fromJson(Map<String, dynamic>.from(m));
    return p.position >= resumeMinSec ? p : null;
  }

  /// _saveProgress() in app_watch.js: finished or barely started = nothing to resume.
  static Future<void> saveProgress(Progress p, {bool notify = false}) async {
    final map = _map(_progressKey);
    final finished = p.duration > 0 && p.position / p.duration >= resumeDoneRatio;
    if (finished) await recordWatched(p);
    if (finished || p.position < resumeMinSec) {
      map.remove(p.id);
    } else {
      map[p.id] = p.toJson();
    }
    await _p.setString(_progressKey, jsonEncode(map));
    if (notify) _bump();
  }

  static Future<void> removeProgress(String id) async {
    final map = _map(_progressKey)..remove(id);
    await _p.setString(_progressKey, jsonEncode(map));
    _bump();
  }

  // ---------------------------------------------------------------- favorites

  static const _favKey = 'pek_favorites_v1';

  static List<Favorite> favorites() => _list(_favKey).map(Favorite.fromJson).toList();

  static bool isFavorite(String key) => _list(_favKey).any((e) => e['key'] == key);

  static Future<void> toggleFavorite(Favorite f) async {
    final l = _list(_favKey);
    final i = l.indexWhere((e) => e['key'] == f.key);
    if (i >= 0) {
      l.removeAt(i);
    } else {
      l.insert(0, f.toJson());
    }
    await _p.setString(_favKey, jsonEncode(l));
    _bump();
  }

  // ---------------------------------------------------------------- dashboard widgets

  static const _dashKey = 'pek_dashboard_v1';
  static const dashTypes = <String, (String, String)>{
    'continue': ('Continue Watching', 'Pick up where you left off'),
    'recent': ('Recently Added', 'Newest movies in your library'),
    'favorites': ('Favorites', 'Your saved movies and shows'),
  };
  static const dashDefault = ['continue', 'recent', 'favorites'];

  static List<String> dashboard() {
    final raw = _p.getStringList(_dashKey);
    if (raw == null) return List.of(dashDefault);
    return raw.where(dashTypes.containsKey).toList();
  }

  static Future<void> setDashboard(List<String> l) async {
    await _p.setStringList(_dashKey, l);
    _bump();
  }

  // ---------------------------------------------------------------- small settings

  static bool getBool(String k, bool d) => _p.getBool(k) ?? d;
  static Future<void> setBool(String k, bool v) async {
    await _p.setBool(k, v);
    _bump();
  }
}

class Progress {
  const Progress({required this.id, required this.title, required this.kind, required this.position, required this.duration, required this.updated, this.showTitle = '', this.year = 0, this.season = 0, this.episode = 0});
  final String id; // library file id (the /api/stream/<id> id)
  final String title; // what the player shows
  final String kind; // 'movie' | 'episode'
  final double position;
  final double duration;
  final int updated;
  final String showTitle;
  final int year;
  final int season; // episodes only (subtitle look-up needs them)
  final int episode;

  factory Progress.fromJson(Map<String, dynamic> j) => _withNumbers(Progress._raw(j));

  static Progress _withNumbers(Progress p) {
    if (p.kind != 'episode' || (p.season > 0 && p.episode > 0)) return p;
    final m = RegExp(r'\bS(\d{1,2})E(\d{1,3})\b', caseSensitive: false).firstMatch(p.title);
    if (m == null) return p;
    return Progress(id: p.id, title: p.title, kind: p.kind, position: p.position, duration: p.duration, updated: p.updated, showTitle: p.showTitle, year: p.year, season: int.parse(m.group(1)!), episode: int.parse(m.group(2)!));
  }

  factory Progress._raw(Map<String, dynamic> j) => Progress(
        id: '${j['id'] ?? ''}',
        title: '${j['title'] ?? ''}',
        kind: '${j['kind'] ?? 'movie'}',
        position: (j['position'] as num?)?.toDouble() ?? 0,
        duration: (j['duration'] as num?)?.toDouble() ?? 0,
        updated: (j['updated'] as num?)?.toInt() ?? 0,
        showTitle: '${j['showTitle'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        season: (j['season'] as num?)?.toInt() ?? 0,
        episode: (j['episode'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'kind': kind, 'position': position, 'duration': duration, 'updated': updated, 'showTitle': showTitle, 'year': year, 'season': season, 'episode': episode};

  Progress at(double pos, double dur) => Progress(id: id, title: title, kind: kind, position: pos, duration: dur, updated: DateTime.now().millisecondsSinceEpoch, showTitle: showTitle, year: year, season: season, episode: episode);
}

/// A saved library title. [kind] is 'movie' (key = file id) or 'show' (key = show title).
class Favorite {
  const Favorite({required this.kind, required this.key, required this.title, this.year = 0});
  final String kind;
  final String key;
  final String title;
  final int year;

  static Favorite movie(String id, String title, int year) => Favorite(kind: 'movie', key: 'm:$id', title: title, year: year);
  static Favorite show(String title) => Favorite(kind: 'show', key: 's:$title', title: title);

  /// The id for movies, the title for shows.
  String get ref => key.substring(2);

  factory Favorite.fromJson(Map<String, dynamic> j) => Favorite(kind: '${j['kind'] ?? 'movie'}', key: '${j['key'] ?? ''}', title: '${j['title'] ?? ''}', year: (j['year'] as num?)?.toInt() ?? 0);
  Map<String, dynamic> toJson() => {'kind': kind, 'key': key, 'title': title, 'year': year};
}

/// One finished movie or episode in Watch History.
class HistoryEntry {
  const HistoryEntry({required this.key, required this.kind, required this.title, required this.year, required this.season, required this.episode, required this.at, required this.count});
  final String key;
  final String kind; // 'movie' | 'episode'
  final String title; // movie title, or the show's title for an episode
  final int year;
  final int season;
  final int episode;
  final int at; // when it was last finished (ms since epoch)
  final int count; // how many separate watches

  factory HistoryEntry.fromJson(Map<String, dynamic> j) => HistoryEntry(
        key: '${j['key'] ?? ''}',
        kind: '${j['kind'] ?? 'movie'}',
        title: '${j['title'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        season: (j['season'] as num?)?.toInt() ?? 0,
        episode: (j['episode'] as num?)?.toInt() ?? 0,
        at: (j['at'] as num?)?.toInt() ?? 0,
        count: (j['count'] as num?)?.toInt() ?? 1,
      );

  Map<String, dynamic> toJson() => {'key': key, 'kind': kind, 'title': title, 'year': year, 'season': season, 'episode': episode, 'at': at, 'count': count};

  HistoryEntry copyWith({int? at, int? count}) =>
      HistoryEntry(key: key, kind: kind, title: title, year: year, season: season, episode: episode, at: at ?? this.at, count: count ?? this.count);

  String get label {
    if (kind == 'episode') {
      String two(int n) => n.toString().padLeft(2, '0');
      return '$title \u00b7 S${two(season)}E${two(episode)}';
    }
    return year > 0 ? '$title ($year)' : title;
  }
}
