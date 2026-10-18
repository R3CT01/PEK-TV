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
  const Progress({required this.id, required this.title, required this.kind, required this.position, required this.duration, required this.updated, this.showTitle = '', this.year = 0});
  final String id; // library file id (the /api/stream/<id> id)
  final String title; // what the player shows
  final String kind; // 'movie' | 'episode'
  final double position;
  final double duration;
  final int updated;
  final String showTitle;
  final int year;

  factory Progress.fromJson(Map<String, dynamic> j) => Progress(
        id: '${j['id'] ?? ''}',
        title: '${j['title'] ?? ''}',
        kind: '${j['kind'] ?? 'movie'}',
        position: (j['position'] as num?)?.toDouble() ?? 0,
        duration: (j['duration'] as num?)?.toDouble() ?? 0,
        updated: (j['updated'] as num?)?.toInt() ?? 0,
        showTitle: '${j['showTitle'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => {'id': id, 'title': title, 'kind': kind, 'position': position, 'duration': duration, 'updated': updated, 'showTitle': showTitle, 'year': year};

  Progress at(double pos, double dur) => Progress(id: id, title: title, kind: kind, position: pos, duration: dur, updated: DateTime.now().millisecondsSinceEpoch, showTitle: showTitle, year: year);
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
