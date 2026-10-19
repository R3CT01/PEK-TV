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

  // ---------------------------------------------------------------- profiles (scoping)

  /// The active profile. The first profile, "p1", keeps using the original keys (so nothing has to be moved when profiles are
  /// switched on, exactly like the web UI); every other profile stores the same keys under `p/<id>/`.
  static String _pid = 'p1';
  static String get profileId => _pid;

  /// Changes whenever another profile becomes active.
  static final ValueNotifier<String> profile = ValueNotifier('p1');

  static void setProfile(String id) {
    _pid = id.isEmpty ? 'p1' : id;
    profile.value = _pid;
    _bump();
  }

  static String _sc(String key) => _pid == 'p1' ? key : 'p/$_pid/$key';

  /// Scoped (per profile) or device-wide JSON / string values for the cloud and profile code.
  static String? strGet(String key, {bool scoped = true}) => _p.getString(scoped ? _sc(key) : key);
  static Future<void> strSet(String key, String v, {bool scoped = true}) => _p.setString(scoped ? _sc(key) : key, v);
  static Future<void> strDel(String key, {bool scoped = true}) => _p.remove(scoped ? _sc(key) : key);

  static Map<String, dynamic> jsonMap(String key, {bool scoped = true}) => _map(scoped ? _sc(key) : key);
  static Future<void> setJsonMap(String key, Map<String, dynamic> v, {bool scoped = true}) => _p.setString(scoped ? _sc(key) : key, jsonEncode(v));

  /// Removes everything one profile owns (the removal reached us from the cloud, or the person deleted it).
  /// Favorites stay unless [keepFavorites] is false: they only exist on this device (the cloud keeps no library favorites).
  static Future<void> removeProfileData(String id, {bool keepFavorites = false}) async {
    if (id == 'p1') {
      for (final k in const ['pek_history_v1', 'pek_progress_v1', 'pek_favorites_v1', 'pek_dashboard_v1', 'pek_dash_v2', 'pek_skip_auto', 'pek_skip_online', 'pek_skin', 'pek_layout', 'pek_poster', 'pek_sync_cursor', 'pek_sync_last', 'pek_sync_seen', 'pek_sync_pending', 'pek_sync_pendingf', 'pek_fav_tombs']) {
        if (keepFavorites && (k == 'pek_favorites_v1' || k == 'pek_fav_tombs')) continue;
        await _p.remove(k);
      }
    } else {
      for (final k in _p.getKeys().where((k) => k.startsWith('p/$id/')).toList()) {
        if (keepFavorites && (k.endsWith('/pek_favorites_v1') || k.endsWith('/pek_fav_tombs'))) continue;
        await _p.remove(k);
      }
    }
    _bump();
  }

  /// Signing out of the account: every profile's data, the profile list and the sign-in leave this device (the cloud keeps them).
  static Future<void> wipeAccountData() async {
    for (final k in _p.getKeys().toList()) {
      if (k.startsWith('pek_sync_') || k.startsWith('pek_profiles')) {
        await _p.remove(k);
      } else if (k.startsWith('p/') && !k.endsWith('/pek_favorites_v1') && !k.endsWith('/pek_fav_tombs')) {
        await _p.remove(k);
      }
    }
    await removeProfileData('p1', keepFavorites: true);
    _pid = 'p1';
    _bump();
  }

  /// Forgets what the cloud already has, for every profile (a new sign-in gets a full two-way merge).
  static Future<void> clearSyncState(Iterable<String> profileIds) async {
    for (final id in profileIds) {
      for (final k in const ['pek_sync_cursor', 'pek_sync_last', 'pek_sync_seen', 'pek_sync_pending']) {
        await _p.remove(id == 'p1' ? k : 'p/$id/$k');
      }
    }
  }

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
  static bool get skipAuto => _p.getBool(_sc('pek_skip_auto')) ?? false;

  /// hesper_skip_online: look the times up in the online database for TV episodes (default on).
  static bool get skipOnline => _p.getBool(_sc('pek_skip_online')) ?? true;

  static Future<void> setSkipAuto(bool on) async {
    await _p.setBool(_sc('pek_skip_auto'), on);
    _bump();
  }

  static Future<void> setSkipOnline(bool on) async {
    await _p.setBool(_sc('pek_skip_online'), on);
    _bump();
  }

  /// The lyrics panel on Now Playing (hesper_music_fs_lyrics).
  static bool get musicLyrics => _p.getBool('pek_music_lyrics') ?? false;
  static Future<void> setMusicLyrics(bool on) => _p.setBool('pek_music_lyrics', on);

  // ---------------------------------------------------------------- watch history (a permanent "watched" record)

  static String get _historyKey => _sc('pek_history_v1');

  /// Finishing the same thing again within 12 hours counts as one watch.
  static const rewatchWindowMs = 12 * 60 * 60 * 1000;

  static String _norm(String s) => s.toLowerCase().replaceAll(RegExp(r'\s+'), ' ').trim();

  static String? historyKey(Progress p) {
    return keyFor(kind: p.kind, title: p.title, showTitle: p.showTitle, year: p.year, season: p.season, episode: p.episode);
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
    if (old is Map && old['deleted'] == null) {
      final e = HistoryEntry.fromJson(Map<String, dynamic>.from(old));
      if (now - e.at < rewatchWindowMs) {
        map[key] = e.copyWith(at: now).toJson(); // the same watch, seen again
      } else {
        map[key] = e.copyWith(at: now, count: e.count + 1).toJson();
      }
    } else {
      map[key] = HistoryEntry(key: key, kind: p.kind, title: p.kind == 'episode' ? p.showTitle : p.title, year: p.year, season: p.season, episode: p.episode, at: now, count: 1, updated: now).toJson();
    }
    await _p.setString(_historyKey, jsonEncode(map));
    _bump();
  }

  /// A removed item stays as `{deleted, updated}` so the removal syncs too.
  static Future<void> removeHistory(String key) async {
    final map = _map(_historyKey);
    if (map[key] is! Map || (map[key] as Map)['deleted'] != null) return;
    map[key] = {'deleted': 1, 'updated': DateTime.now().millisecondsSinceEpoch};
    await _p.setString(_historyKey, jsonEncode(map));
    _bump();
  }

  static Future<void> clearHistory() async {
    final map = _map(_historyKey);
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final k in map.keys.toList()) {
      final v = map[k];
      if (v is Map && v['deleted'] == null) map[k] = {'deleted': 1, 'updated': now};
    }
    await _p.setString(_historyKey, jsonEncode(map));
    _bump();
  }

  /// Raw maps for cloud sync (history items, resume points).
  static Map<String, dynamic> historyRaw() => _map(_historyKey);
  static Map<String, dynamic> progressRaw() => _map(_progressKey);
  static Future<void> writeHistoryRaw(Map<String, dynamic> m) => _p.setString(_historyKey, jsonEncode(m));
  static Future<void> writeProgressRaw(Map<String, dynamic> m) => _p.setString(_progressKey, jsonEncode(m));
  static void notifyChanged() => _bump();

  /// The cross-device identity of a movie / episode (same text as histKey() in sync.js). Null for anything else.
  static String? keyFor({required String kind, String title = '', String showTitle = '', int year = 0, int season = 0, int episode = 0}) {
    if (kind == 'movie') return _norm(title).isEmpty ? null : 'm|${_norm(title)}|$year';
    if (kind == 'episode') return _norm(showTitle).isEmpty ? null : 'e|${_norm(showTitle)}|$season|$episode';
    return null;
  }

  static String normalize(String s) => _norm(s);

  // ---------------------------------------------------------------- progress (Resume Watching)

  static String get _progressKey => _sc('pek_progress_v1');

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

  static String get _favKey => _sc('pek_favorites_v1');

  static List<Favorite> favorites() => _list(_favKey).map(Favorite.fromJson).toList();

  static bool isFavorite(String key) => _list(_favKey).any((e) => e['key'] == key);

  static Future<void> toggleFavorite(Favorite f) async {
    final l = _list(_favKey);
    final i = l.indexWhere((e) => e['key'] == f.key);
    final now = DateTime.now().millisecondsSinceEpoch;
    if (i >= 0) {
      final gone = l.removeAt(i);
      final tm = (gone['tmdb'] as num?)?.toInt() ?? 0;
      if (tm > 0) {
        // The removal is told to the cloud on the next sync.
        final tb = _map(_sc('pek_fav_tombs'));
        tb['${gone['type'] ?? (gone['kind'] == 'show' ? 'tv' : 'movie')}:$tm'] = now;
        await _p.setString(_sc('pek_fav_tombs'), jsonEncode(tb));
      }
    } else {
      final j = f.toJson();
      j['added'] = now;
      j['updated'] = now;
      l.insert(0, j);
    }
    await _p.setString(_favKey, jsonEncode(l));
    _bump();
  }

  /// Raw favorites and removal markers for the cloud sync.
  static List<Map<String, dynamic>> favRaw() => _list(_favKey);
  static Future<void> writeFavRaw(List<Map<String, dynamic>> l) => _p.setString(_favKey, jsonEncode(l));
  static Map<String, dynamic> favTombs() => _map(_sc('pek_fav_tombs'));
  static Future<void> writeFavTombs(Map<String, dynamic> m) => _p.setString(_sc('pek_fav_tombs'), jsonEncode(m));

  // ---------------------------------------------------------------- dashboard widgets

  static String get _dashKey => _sc('pek_dashboard_v1');
  static const dashTypes = <String, (String, String)>{
    'clock': ('Clock', 'The time and date'),
    'weather': ('Weather', 'Conditions for your city'),
    'continue': ('Continue Watching', 'Pick up where you left off'),
    'recent': ('Recently Added', 'Newest movies in your library'),
    'favorites': ('Favorites', 'Your saved movies and shows'),
  };
  static const dashDefault = ['clock', 'weather', 'continue', 'recent', 'favorites'];

  static List<String> dashboard() {
    final raw = _p.getStringList(_dashKey);
    if (raw == null) return List.of(dashDefault);
    var l = raw.where(dashTypes.containsKey).toList();
    // A dashboard saved before the clock became a widget keeps showing it (it was always on top).
    if (!(_p.getBool(_sc('pek_dash_v2')) ?? false) && !l.contains('clock')) l = ['clock', ...l];
    return l;
  }

  static Future<void> setDashboard(List<String> l) async {
    await _p.setBool(_sc('pek_dash_v2'), true);
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
  const Progress({
    required this.id,
    required this.title,
    required this.kind,
    required this.position,
    required this.duration,
    required this.updated,
    this.showTitle = '',
    this.year = 0,
    this.season = 0,
    this.episode = 0,
    this.torrent,
    this.image = '',
    this.origin = '',
  });
  final String id; // library file id (the /api/stream/<id> id), or "tor:<key>" for a torrent stream
  final String title; // what the player shows
  final String kind; // 'movie' | 'episode' | 'other' (a torrent with no movie / episode identity)
  final double position;
  final double duration;
  final int updated;
  final String showTitle;
  final int year;
  final int season; // episodes only (subtitle look-up needs them)
  final int episode;

  /// Set for a torrent stream: `{source, title, season, episode}` is everything needed to start the same release again.
  final Map<String, dynamic>? torrent;
  final String image; // artwork address when one was known
  final String origin; // where the watch was started ('' = the library, otherwise a name such as "Torrent")

  bool get isTorrent => torrent != null;

  factory Progress.fromJson(Map<String, dynamic> j) => _withNumbers(Progress._raw(j));

  static Progress _withNumbers(Progress p) {
    if (p.kind != 'episode' || (p.season > 0 && p.episode > 0)) return p;
    final m = RegExp(r'\bS(\d{1,2})E(\d{1,3})\b', caseSensitive: false).firstMatch(p.title);
    if (m == null) return p;
    return p._copy(season: int.parse(m.group(1)!), episode: int.parse(m.group(2)!));
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
        torrent: j['torrent'] is Map ? Map<String, dynamic>.from(j['torrent'] as Map) : null,
        image: '${j['image'] ?? ''}',
        origin: '${j['origin'] ?? ''}',
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'title': title,
        'kind': kind,
        'position': position,
        'duration': duration,
        'updated': updated,
        'showTitle': showTitle,
        'year': year,
        'season': season,
        'episode': episode,
        if (torrent != null) 'torrent': torrent,
        if (image.isNotEmpty) 'image': image,
        if (origin.isNotEmpty) 'origin': origin,
      };

  Progress _copy({double? position, double? duration, int? updated, int? season, int? episode}) => Progress(
        id: id,
        title: title,
        kind: kind,
        position: position ?? this.position,
        duration: duration ?? this.duration,
        updated: updated ?? this.updated,
        showTitle: showTitle,
        year: year,
        season: season ?? this.season,
        episode: episode ?? this.episode,
        torrent: torrent,
        image: image,
        origin: origin,
      );

  Progress at(double pos, double dur) => _copy(position: pos, duration: dur, updated: DateTime.now().millisecondsSinceEpoch);
}

/// A saved library title. [kind] is 'movie' (key = file id) or 'show' (key = show title).
class Favorite {
  const Favorite({required this.kind, required this.key, required this.title, this.year = 0, this.tmdb = 0, this.type = '', this.poster = '', this.added = 0, this.updated = 0});
  final String kind;
  final String key;
  final String title;
  final int year;

  /// The TMDb id the cloud knows this title by (0 = not looked up yet, -1 = TMDb has no match). Filled in by the sync.
  final int tmdb;
  final String type; // 'movie' | 'tv'
  final String poster; // TMDb poster path
  final int added;
  final int updated;

  static Favorite movie(String id, String title, int year) => Favorite(kind: 'movie', key: 'm:$id', title: title, year: year);
  static Favorite show(String title) => Favorite(kind: 'show', key: 's:$title', title: title);

  /// The id for movies, the title for shows.
  String get ref => key.substring(2);

  factory Favorite.fromJson(Map<String, dynamic> j) => Favorite(
        kind: '${j['kind'] ?? 'movie'}',
        key: '${j['key'] ?? ''}',
        title: '${j['title'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        tmdb: (j['tmdb'] as num?)?.toInt() ?? 0,
        type: '${j['type'] ?? ''}',
        poster: '${j['poster'] ?? ''}',
        added: (j['added'] as num?)?.toInt() ?? 0,
        updated: (j['updated'] as num?)?.toInt() ?? 0,
      );
  Map<String, dynamic> toJson() => {
        'kind': kind,
        'key': key,
        'title': title,
        'year': year,
        if (tmdb != 0) 'tmdb': tmdb,
        if (type.isNotEmpty) 'type': type,
        if (poster.isNotEmpty) 'poster': poster,
        if (added > 0) 'added': added,
        if (updated > 0) 'updated': updated,
      };
}

/// One finished movie or episode in Watch History.
class HistoryEntry {
  const HistoryEntry({required this.key, required this.kind, required this.title, required this.year, required this.season, required this.episode, required this.at, required this.count, this.updated = 0});
  final String key;
  final String kind; // 'movie' | 'episode'
  final String title; // movie title, or the show's title for an episode
  final int year;
  final int season;
  final int episode;
  final int at; // when it was last finished (ms since epoch)
  final int count; // how many separate watches
  final int updated; // last change (sync); 0 = same as [at]

  factory HistoryEntry.fromJson(Map<String, dynamic> j) => HistoryEntry(
        key: '${j['key'] ?? ''}',
        kind: '${j['kind'] ?? 'movie'}',
        title: '${j['title'] ?? ''}',
        year: (j['year'] as num?)?.toInt() ?? 0,
        season: (j['season'] as num?)?.toInt() ?? 0,
        episode: (j['episode'] as num?)?.toInt() ?? 0,
        at: (j['at'] as num?)?.toInt() ?? 0,
        count: (j['count'] as num?)?.toInt() ?? 1,
        updated: (j['updated'] as num?)?.toInt() ?? 0,
      );

  Map<String, dynamic> toJson() => {'key': key, 'kind': kind, 'title': title, 'year': year, 'season': season, 'episode': episode, 'at': at, 'count': count, 'updated': updated > 0 ? updated : at};

  HistoryEntry copyWith({int? at, int? count}) =>
      HistoryEntry(key: key, kind: kind, title: title, year: year, season: season, episode: episode, at: at ?? this.at, count: count ?? this.count, updated: DateTime.now().millisecondsSinceEpoch);

  String get label {
    if (kind == 'episode') {
      String two(int n) => n.toString().padLeft(2, '0');
      return '$title \u00b7 S${two(season)}E${two(episode)}';
    }
    return year > 0 ? '$title ($year)' : title;
  }
}
