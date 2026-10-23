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
      for (final k in const ['pek_history_v1', 'pek_progress_v1', 'pek_favorites_v1', 'pek_dashboard_v1', 'pek_dashboard_v3', 'pek_dash_v2', 'pek_skip_auto', 'pek_skip_online', 'pek_skin', 'pek_custom_skins', 'pek_skin_tombs', 'pek_layout', 'pek_poster', 'pek_sync_cursor', 'pek_sync_last', 'pek_sync_seen', 'pek_sync_pending', 'pek_sync_pendingf', 'pek_sync_setmeta', 'pek_fav_tombs', 'pek_plugin_favs_v1']) {
        if (keepFavorites && (k == 'pek_favorites_v1' || k == 'pek_fav_tombs' || k == 'pek_plugin_favs_v1')) continue;
        await _p.remove(k);
      }
    } else {
      for (final k in _p.getKeys().where((k) => k.startsWith('p/$id/')).toList()) {
        if (keepFavorites && (k.endsWith('/pek_favorites_v1') || k.endsWith('/pek_fav_tombs') || k.endsWith('/pek_plugin_favs_v1'))) continue;
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
      } else if (k.startsWith('p/') && !k.endsWith('/pek_favorites_v1') && !k.endsWith('/pek_fav_tombs') && !k.endsWith('/pek_plugin_favs_v1')) {
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

  static String? _watchedRaw;
  static Set<String> _watchedSet = const {};
  static Set<String> _watchedTitleSet = const {};

  /// Keys (`m|title|year`, `e|show|season|episode`) of everything currently in Watch History; removed items are left out.
  /// Cached until the history changes, so a grid of posters can ask once per card.
  static Set<String> watchedKeys() {
    final raw = _p.getString(_historyKey) ?? '{}';
    if (_watchedRaw == raw) return _watchedSet;
    final out = <String>{};
    final titles = <String>{};
    _map(_historyKey).forEach((k, v) {
      if (v is! Map || v['deleted'] != null) return;
      out.add(k);
      if (k.startsWith('m|')) {
        final parts = k.split('|');
        if (parts.length >= 3) titles.add(parts.sublist(1, parts.length - 1).join('|'));
      }
    });
    _watchedRaw = raw;
    _watchedSet = out;
    _watchedTitleSet = titles;
    return out;
  }

  /// Normalized titles of the movies in Watch History, whatever their year (for posters that carry no year).
  static Set<String> watchedMovieTitles() {
    watchedKeys();
    return _watchedTitleSet;
  }

  /// Every live `m|title|year` key for this title (a poster with no year can stand for any of them).
  static List<String> watchedMovieKeysFor(String title) {
    final t = _norm(title);
    return [for (final k in watchedKeys()) if (k.startsWith('m|$t|') && k.indexOf('|', 3 + t.length) < 0) k];
  }

  /// Plugin posters: when a poster names no year, match it by title alone (Settings > Plugin posters). Per device.
  static bool get pluginWatchedLoose => _p.getBool('pek_plugin_watched_loose') ?? true;
  static Future<void> setPluginWatchedLoose(bool on) async {
    await _p.setBool('pek_plugin_watched_loose', on);
    _bump();
  }

  /// Is this movie / episode marked watched (the web UI's `_watchedLookup()`)? For an episode [showTitle] is the show's title.
  static bool isWatched({required String kind, String title = '', String showTitle = '', int year = 0, int season = 0, int episode = 0}) {
    final key = keyFor(kind: kind, title: title, showTitle: showTitle, year: year, season: season, episode: episode);
    return key != null && watchedKeys().contains(key);
  }

  /// "Mark as watched / unwatched" for many items in one write and one repaint (the web UI's `_setWatched` / `_setSeasonWatched`,
  /// and plugins). Marking watched adds an entry like finishing the item would (one already watched is left alone); marking
  /// unwatched leaves a `{deleted, updated}` marker so the removal syncs too. Returns true when something changed.
  ///
  /// [keepTime] (plugins only): the entry is dated with the item's own `updated` (when it was really watched, e.g. from Trakt)
  /// instead of now, as long as that time is sane (2000 .. tomorrow). `updated` on the entry itself stays now, so the cloud
  /// still sees the change as new.
  static Future<bool> setWatched(Iterable<Progress> items, bool on, {List<Progress>? changedOut, bool keepTime = false}) async {
    final map = _map(_historyKey);
    final now = DateTime.now().millisecondsSinceEpoch;
    var changed = false;
    for (final p in items) {
      final key = historyKey(p);
      if (key == null) continue;
      final old = map[key];
      final alive = old is Map && old['deleted'] == null;
      if (on) {
        if (alive) continue;
        map[key] = HistoryEntry(key: key, kind: p.kind, title: p.kind == 'episode' ? p.showTitle : p.title, year: p.year, season: p.season, episode: p.episode, at: keepTime ? watchTimeOr(p.updated, now) : now, count: 1, updated: now).toJson();
      } else {
        if (!alive) continue;
        map[key] = {'deleted': 1, 'updated': now};
      }
      changed = true;
      changedOut?.add(p);
    }
    if (changed) {
      await _p.setString(_historyKey, jsonEncode(map));
      _bump();
    }
    return changed;
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

  /// A watch time from a plugin: seconds since 1970 (as Python sends it) -> milliseconds, or null when missing or not believable.
  static int? watchTimeFromSeconds(Object? seconds) {
    final s = seconds is num ? seconds.toInt() : 0;
    return s >= 946684800 && s * 1000 <= DateTime.now().millisecondsSinceEpoch + 86400000 ? s * 1000 : null;
  }

  /// [ms] when it is a believable watch time (2000 .. tomorrow), else [fallback].
  static int watchTimeOr(int ms, int fallback) => ms >= 946684800000 && ms <= fallback + 86400000 ? ms : fallback;

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

  // ---------------------------------------------------------------- favorites saved by plugin screens
  // The Flutter twin of pek.favorites in the web sandbox: one list shared by every plugin ("movie:603" / "tv:1396"),
  // kept per profile on this device. Library favorites above are separate (they are files, these are TMDb titles).

  static String get _pluginFavKey => _sc('pek_plugin_favs_v1');

  static List<Map<String, dynamic>> pluginFavorites() => _list(_pluginFavKey);

  static List<String> pluginFavoriteKeys() => pluginFavorites().map((e) => '${e['key']}').toList();

  static Future<void> addPluginFavorite({required String plugin, required String type, required int id, required String title, int year = 0, String posterPath = ''}) async {
    if ((type != 'movie' && type != 'tv') || id <= 0) return;
    final key = '$type:$id';
    final l = _list(_pluginFavKey);
    if (l.any((e) => e['key'] == key)) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    l.insert(0, {'key': key, 'type': type, 'id': id, 'title': title, 'year': year, 'posterPath': posterPath, 'plugin': plugin, 'added': now, 'updated': now});
    await _p.setString(_pluginFavKey, jsonEncode(l));
    // Added again after having been removed: the new favorite wins over the old removal (the cloud sync reads these).
    final tombs = _map(_sc('pek_fav_tombs'));
    if (tombs.remove(key) != null) await _p.setString(_sc('pek_fav_tombs'), jsonEncode(tombs));
    _bump();
  }

  static Future<void> removePluginFavorite(String key) async {
    final l = _list(_pluginFavKey);
    final n = l.length;
    l.removeWhere((e) => e['key'] == key);
    if (l.length == n) return;
    await _p.setString(_pluginFavKey, jsonEncode(l));
    // The removal is told to the cloud on the next sync (the same markers library favorites use: 'movie:603').
    final tombs = _map(_sc('pek_fav_tombs'));
    tombs[key] = DateTime.now().millisecondsSinceEpoch;
    await _p.setString(_sc('pek_fav_tombs'), jsonEncode(tombs));
    _bump();
  }

  /// Raw plugin favorites for the cloud sync.
  static List<Map<String, dynamic>> pluginFavRaw() => _list(_pluginFavKey);
  static Future<void> writePluginFavRaw(List<Map<String, dynamic>> l) => _p.setString(_pluginFavKey, jsonEncode(l));

  /// Raw favorites and removal markers for the cloud sync.
  static List<Map<String, dynamic>> favRaw() => _list(_favKey);
  static Future<void> writeFavRaw(List<Map<String, dynamic>> l) => _p.setString(_favKey, jsonEncode(l));
  static Map<String, dynamic> favTombs() => _map(_sc('pek_fav_tombs'));
  static Future<void> writeFavTombs(Map<String, dynamic> m) => _p.setString(_sc('pek_fav_tombs'), jsonEncode(m));

  // ---------------------------------------------------------------- dashboard widgets

  static String get _dashKey => _sc('pek_dashboard_v1'); // the older list of widget types (read once, then replaced by v3)
  static String get _dashKey3 => _sc('pek_dashboard_v3'); // JSON list of {id, type, size, folder?}: the same shape the web UI saves
  static const dashTypes = <String, (String, String)>{
    'clock': ('Clock', 'The time and date'),
    'weather': ('Weather', 'Conditions for your city'),
    'continue': ('Continue Watching', 'Pick up where you left off'),
    'recent': ('Recently Added', 'Newest movies in your library'),
    'favorites': ('Favorites', 'Your saved movies and shows'),
    'plugin': ('Plugin', 'A shortcut to a plugin'),
    // Added with the Add widget list (dash_widgets.dart). The web UI does not know these and drops them if it saves the layout.
    'nowplaying': ('Now Playing', 'The song that is playing, with controls'),
    'forecast': ('Forecast', 'Scroll through the next hours or days'),
    'albums': ('Albums', 'A row of albums from your music'),
    'playlists': ('Playlists', 'Your playlists in a row'),
    'shows': ('TV Shows', 'A row of shows from your library'),
    'pinned': ('Pinned plugins', 'The plugins you pinned, as a row of icons'),
    'stats': ('Library', 'How many movies, shows and songs you have'),
    'surprise': ('Surprise me', 'Opens a random movie from your library'),
    'upnext': ('Up Next', 'The next episode of the shows you are watching'),
    'watched': ('Recently Watched', 'What you finished lately'),
  };
  static const dashDefault = ['clock', 'weather', 'continue', 'recent', 'favorites'];

  /// What the Add widget list offers, in groups (the built-in widgets; plugin shortcuts are listed under them).
  static const dashGroups = <(String, List<String>)>[
    ('Music', ['nowplaying', 'playlists', 'albums']),
    ('Weather and time', ['clock', 'weather', 'forecast']),
    ('Movies and shows', ['continue', 'upnext', 'recent', 'watched', 'shows', 'favorites', 'stats', 'surprise']),
    ('Plugins', ['pinned']),
  ];

  /// Tiles (a small box, 1 or 2 columns wide) versus rows of posters (full width): `tile: true` in DASH_TYPES.
  static bool dashIsTile(String type) => const {'clock', 'weather', 'plugin', 'stats', 'surprise'}.contains(type);

  static List<DashItem> dashboardDefault() => [for (final t in dashDefault) DashItem(t, t)];

  /// Port of _readDash: unknown types, bad plugin folders and repeats are dropped; an empty list is the person's own choice.
  static List<DashItem> cleanDashboard(dynamic raw) {
    if (raw is! List) return dashboardDefault();
    final seen = <String>{};
    final out = <DashItem>[];
    for (final w in raw) {
      if (w is! Map) continue;
      final type = w['type'];
      if (type is! String || !dashTypes.containsKey(type) || out.length >= 40) continue;
      final folder = type == 'plugin' ? '${w['folder'] ?? ''}' : '';
      if (type == 'plugin' && !RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(folder)) continue;
      final id = type == 'plugin' ? 'plugin:$folder' : type;
      if (!seen.add(id)) continue;
      out.add(DashItem(id, type, size: w['size'] == 'm' ? 'm' : 's', folder: folder));
    }
    return out;
  }

  static List<DashItem> dashboardItems() {
    final v3 = _p.getString(_dashKey3);
    if (v3 != null) {
      try {
        return cleanDashboard(jsonDecode(v3));
      } catch (_) {}
    }
    final raw = _p.getStringList(_dashKey);
    if (raw == null) return dashboardDefault();
    var l = raw.where((t) => dashTypes.containsKey(t) && t != 'plugin').toList();
    // A dashboard saved before the clock became a widget keeps showing it (it was always on top).
    if (!(_p.getBool(_sc('pek_dash_v2')) ?? false) && !l.contains('clock')) l = ['clock', ...l];
    return [for (final t in l) DashItem(t, t)];
  }

  /// True once a dashboard was saved on this device (so there is something to sync).
  static bool get dashboardChosen => _p.getString(_dashKey3) != null || _p.getStringList(_dashKey) != null;

  /// Bumped only when the person changes the dashboard here: Cloud sync listens to it.
  static final ValueNotifier<int> dashEdited = ValueNotifier(0);

  /// A change made here: repaints, and [dashEdited] tells the sync to send it.
  static Future<void> setDashboardItems(List<DashItem> l) async {
    await _p.setString(_dashKey3, jsonEncode([for (final w in l) w.toJson()]));
    _bump();
    dashEdited.value++;
  }

  /// A change that came from the cloud: stored and repainted, but not sent back.
  static Future<void> applyDashboardFromCloud(List<DashItem> l) async {
    await _p.setString(_dashKey3, jsonEncode([for (final w in l) w.toJson()]));
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


/// One widget on the dashboard (app_dashboard.js `{ id, type, size, folder }`). size: 's' = small, 'm' = wide (tiles only).
class DashItem {
  const DashItem(this.id, this.type, {this.size = 's', this.folder = ''});
  final String id, type, size, folder;

  DashItem withSize(String s) => DashItem(id, type, size: s, folder: folder);

  Map<String, dynamic> toJson() => {'id': id, 'type': type, 'size': size, if (folder.isNotEmpty) 'folder': folder};
}
