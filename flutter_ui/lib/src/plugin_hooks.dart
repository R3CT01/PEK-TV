import 'dart:async';

import 'package:flutter/widgets.dart';

import 'api.dart';
import 'plugin_host.dart';
import 'library_match.dart';
import 'plugin_favorites.dart';
import 'profiles.dart';
import 'ratings.dart';
import 'store.dart';
import 'watched.dart';

/// Tells plugins that asked for the "playback" permission what PEK TV is doing, without any plugin screen being open
/// (see FLUTTER_PLUGINS.md, "Hooks"). The plugin's hooks.py gets on_event(event) for:
///
///   app_start       once per run, after the shell opened
///   tick            every few minutes while the app is open and nothing is playing, and when the app comes back to the front
///                   (lets a plugin bring in what happened elsewhere, e.g. Trakt, without waiting for the next start)
///   play / resume   playback started or continued
///   pause           playback paused
///   stop            the player closed, or the next episode took over
///   watched         the person marked movies / episodes watched or unwatched
///   rated           the person rated a movie, episode or show (1 to 10) or removed the rating (0)
///   favorited       the person added movies / shows to the favorites, or removed them
///   profile_removed a profile was deleted (or replaced by another account's): a plugin that keeps something per profile lets go of it
///
/// Every event is told which profile it belongs to (the one open when it happened; pek_ui.profile() in the plugin), so a plugin can
/// keep one account per profile (Trakt does). Whatever a hook asks PEK TV to change (marks, ratings, favorites) is applied to that
/// same profile: if another profile has been opened by the time the hook answers, the changes wait until that profile is open again.
///
/// Events for one plugin run one after the other, in the order they happened. A plugin that is slow, broken or missing
/// never holds up the player: every call is fire-and-forget. All Python checking (the permission, the field filter that
/// keeps file names and ids away from the plugin, the time limit) is in pek_flutter.py; this class only sends and
/// applies the few effects a hook may return (marking history watched).
class PluginHooks {
  static bool _listening = false;
  static bool _started = false;
  static Future<List<String>>? _loading;
  static final Map<String, Future<void>> _chain = {};
  static final Map<String, int> _pending = {}; // plugin id -> events queued or running (a tick never queues behind another)
  static final Map<String, List<(String, List)>> _deferred = {}; // profile id -> (plugin id, effects) that came back after another profile was opened
  static String _lastProfile = '';

  static const _tickEvery = Duration(minutes: 3);
  static DateTime _lastTick = DateTime.fromMillisecondsSinceEpoch(0);
  static bool _playing = false; // between play and stop: a tick must not delay a scrobble
  static DateTime _playingAt = DateTime.fromMillisecondsSinceEpoch(0);

  /// The folders of the installed plugins that asked for hooks. Loaded once, again after a plugin was installed or removed.
  static Future<List<String>> _plugins() {
    if (!_listening) {
      _listening = true;
      PluginHost.changed.addListener(() => _loading = null);
    }
    return _loading ??= _load();
  }

  static Future<List<String>> _load() async {
    try {
      final all = await Api.plugins();
      return [for (final p in all) if (p.hooks) p.folder];
    } catch (_) {
      _loading = null; // the server was not ready: ask again next time
      return const [];
    }
  }

  static void _send(Map<String, dynamic> event, {String? except, bool idleOnly = false, String? profile}) {
    final owner = profile ?? Store.profileId; // read now: the event belongs to the profile that is open as it happens
    unawaited(() async {
      final ids = await _plugins();
      for (final id in ids) {
        if (id == except) continue;
        if (idleOnly && (_pending[id] ?? 0) > 0) continue;
        _pending[id] = (_pending[id] ?? 0) + 1;
        final prev = _chain[id] ?? Future<void>.value();
        _chain[id] = prev.then((_) => _run(id, event, owner)).whenComplete(() {
          _pending[id] = (_pending[id] ?? 1) - 1;
        });
      }
    }());
  }

  static Future<void> _run(String id, Map<String, dynamic> event, String profile) async {
    try {
      final r = await PluginHost.hook(id, event, profile: profile);
      final fx = r['effects'];
      if (fx is! List || fx.isEmpty) return;
      if (Store.profileId == profile) {
        await _apply(id, fx);
      } else {
        // Another profile was opened while the plugin worked: marks, ratings and favorites belong to the profile the event was for,
        // so they wait until that profile is open again (a few at most; only kept while the app runs).
        final waiting = _deferred.putIfAbsent(profile, () => []);
        if (waiting.length < 20) waiting.add((id, fx));
      }
    } catch (_) {
      // a hook never breaks playback
    }
  }

  /// Another profile was opened: apply what hooks brought in for it while it was closed, and let the plugins bring in what is new
  /// for it (an `app_start` for that profile: Trakt imports into the profile that just opened, not the one that opened first).
  static void _profileChanged() {
    final now = Store.profileId;
    if (now == _lastProfile) return;
    _lastProfile = now;
    final waiting = _deferred.remove(now);
    if (waiting != null) {
      unawaited(() async {
        for (var i = 0; i < waiting.length; i++) {
          if (Store.profileId != now) {
            _deferred.putIfAbsent(now, () => []).addAll(waiting.sublist(i)); // opened another one again: keep the rest for later
            return;
          }
          await _apply(waiting[i].$1, waiting[i].$2);
        }
      }());
    }
    _send({'type': 'app_start'}, profile: now);
  }

  /// A profile was deleted: tell the plugins, as that profile, so they can let go of what they kept for it.
  static void profileRemoved(String id) {
    _deferred.remove(id);
    _send({'type': 'profile_removed'}, profile: id);
  }

  /// The only things a hook can ask for: marking movies / episodes watched (Python already checked the permission).
  static Future<void> _apply(String id, List fx) async {
    for (final e in fx) {
      if (e is! Map) continue;
      final op = e['op'];
      if (op == 'ratings.set_many') {
        // Ratings a plugin brought in (Trakt): {title, year, rating 0..10, at}. The plugin is not told about its own change.
        final raw = e['items'] is List ? e['items'] as List : const [];
        final items = <Map>[for (final it in raw.take(300)) if (it is Map) it];
        if (items.isNotEmpty) await Ratings.setFromPlugin(items, id);
        continue;
      }
      if (op == 'favorites.set_many') {
        // Favorites a plugin added or removed (Trakt): {kind, title, year, tmdb, at}. The plugin is not told about its own change.
        final raw = e['items'] is List ? e['items'] as List : const [];
        final items = <Map>[for (final it in raw.take(300)) if (it is Map) it];
        if (items.isNotEmpty) await PluginFavorites.setFromPlugin(items, e['value'] == true, id);
        continue;
      }
      if (op != 'watched.set' && op != 'watched.set_many') continue;
      final list = op == 'watched.set_many' ? (e['items'] is List ? e['items'] as List : const []) : [e];
      final items = <Progress>[];
      for (final it in list.take(300)) {
        if (it is! Map) continue;
        final p = _item(it);
        if (p != null) items.add(p);
      }
      // source: the plugin that asked, so it is not told about its own change (a Trakt import must not go back to Trakt).
      if (items.isNotEmpty && e['value'] != true) {
        // A removal carries "the time the plugin last looked" as its "at": a title finished here after that time stays watched.
        final lined = await LibraryMatch.resolve(items);
        final hist = {for (final h in Store.history()) h.key: h.at};
        final kept = <Progress>[
          for (final p in lined)
            if ((hist[Store.keyFor(kind: p.kind, title: p.title, showTitle: p.showTitle, year: p.year, season: p.season, episode: p.episode)] ?? 0) <= p.updated) p,
        ];
        items
          ..clear()
          ..addAll(kept);
      }
      if (items.isNotEmpty) await Watched.set(items, e['value'] == true, source: id);
    }
  }

  static Progress? _item(Map it) {
    final kind = '${it['kind']}';
    final title = '${it['title'] ?? ''}';
    // "at": when it was really watched (seconds since 1970), if the plugin knows; otherwise now.
    final now = Store.watchTimeFromSeconds(it['at']) ?? DateTime.now().millisecondsSinceEpoch;
    if (kind == 'movie') {
      final year = (it['year'] as num?)?.toInt() ?? 0;
      return Store.keyFor(kind: 'movie', title: title, year: year) == null ? null : Progress(id: '', title: title, kind: 'movie', position: 0, duration: 0, updated: now, year: year);
    }
    if (kind == 'episode') {
      final season = (it['season'] as num?)?.toInt() ?? 0;
      final episode = (it['episode'] as num?)?.toInt() ?? 0;
      return Store.keyFor(kind: 'episode', showTitle: title, season: season, episode: episode) == null
          ? null
          : Progress(id: '', title: title, kind: 'episode', position: 0, duration: 0, updated: now, showTitle: title, season: season, episode: episode);
    }
    return null;
  }

  // ------------------------------------------------------------------------------------------ what PEK TV reports

  /// Once per run (for the profile that is open): lets a plugin bring in what happened elsewhere. From then on the plugin
  /// also gets a `tick` every few minutes (and when the app returns to the front) so a watch marked elsewhere shows up
  /// while PEK TV is open. Every profile opened later gets its own `app_start`, so each profile's account is brought up to date.
  static void appStart() {
    if (_started) return;
    _started = true;
    _lastProfile = Store.profileId;
    Store.profile.addListener(_profileChanged);
    Profiles.onRemoved = profileRemoved;
    _send({'type': 'app_start'});
    _lastTick = DateTime.now();
    Timer.periodic(_tickEvery, (_) => _tick(const Duration(minutes: 1)));
    WidgetsBinding.instance.addObserver(_Life());
  }

  /// One `tick`, unless something is playing (a slow tick must never hold up a scrobble), one was sent very recently, or the
  /// plugin is still busy with the last event. A player that never reported its stop stops counting after six hours.
  static void _tick(Duration gap) {
    final now = DateTime.now();
    if (_playing && now.difference(_playingAt) < const Duration(hours: 6)) return;
    if (now.difference(_lastTick) < gap) return;
    _lastTick = now;
    _send({'type': 'tick'}, idleOnly: true);
  }

  static void _resumed() => _tick(const Duration(seconds: 30));

  /// [type] is play, pause, resume or stop. Only movies and episodes are reported (a torrent with no identity is not).
  static void playback(String type, Progress p, double position, double duration) {
    _playing = type != 'stop';
    _playingAt = DateTime.now();
    if (p.kind != 'movie' && p.kind != 'episode') return;
    final title = p.kind == 'episode' ? p.showTitle : p.title;
    if (title.trim().isEmpty) return;
    _send({
      'type': type,
      'kind': p.kind,
      'title': title,
      'year': p.year,
      'season': p.season,
      'episode': p.episode,
      'position': position,
      'duration': duration,
    });
  }

  /// Movies / episodes the person just marked watched ([on]) or unwatched. [except] is the plugin that made the change itself.
  static void watched(Iterable<Progress> items, bool on, {String? except}) {
    final list = [
      for (final p in items)
        if (p.kind == 'movie' || p.kind == 'episode')
          {'kind': p.kind, 'title': p.kind == 'episode' ? p.showTitle : p.title, 'year': p.year, 'season': p.season, 'episode': p.episode},
    ];
    for (var i = 0; i < list.length; i += 300) {
      _send({'type': 'watched', 'items': list.sublist(i, i + 300 > list.length ? list.length : i + 300), 'value': on}, except: except);
    }
  }

  /// Movies, episodes and shows the person just rated ([rating] 1..10, 0 = the rating was removed). [except] is the plugin that made
  /// the change itself.
  static void rated(List<RatedItem> items, {String? except}) {
    final list = [
      for (final r in items) {'kind': r.kind, 'title': r.title, 'year': r.year, 'season': r.season, 'episode': r.episode, 'rating': r.rating},
    ];
    for (var i = 0; i < list.length; i += 300) {
      _send({'type': 'rated', 'items': list.sublist(i, i + 300 > list.length ? list.length : i + 300)}, except: except);
    }
  }

  /// Movies and shows the person just added to ([value] true) or removed from (false) the favorites. [except] is the plugin that made
  /// the change itself.
  static void favorited(List<({String kind, String title, int year, int tmdb})> items, bool value, {String? except}) {
    final list = [for (final f in items) {'kind': f.kind, 'title': f.title, 'year': f.year, 'tmdb': f.tmdb}];
    for (var i = 0; i < list.length; i += 300) {
      _send({'type': 'favorited', 'value': value, 'items': list.sublist(i, i + 300 > list.length ? list.length : i + 300)}, except: except);
    }
  }
}

class _Life with WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) PluginHooks._resumed();
  }
}
