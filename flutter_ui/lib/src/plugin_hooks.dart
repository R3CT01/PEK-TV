import 'dart:async';

import 'package:flutter/widgets.dart';

import 'api.dart';
import 'plugin_host.dart';
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

  static void _send(Map<String, dynamic> event, {String? except, bool idleOnly = false}) {
    unawaited(() async {
      final ids = await _plugins();
      for (final id in ids) {
        if (id == except) continue;
        if (idleOnly && (_pending[id] ?? 0) > 0) continue;
        _pending[id] = (_pending[id] ?? 0) + 1;
        final prev = _chain[id] ?? Future<void>.value();
        _chain[id] = prev.then((_) => _run(id, event)).whenComplete(() {
          _pending[id] = (_pending[id] ?? 1) - 1;
        });
      }
    }());
  }

  static Future<void> _run(String id, Map<String, dynamic> event) async {
    try {
      final r = await PluginHost.hook(id, event);
      final fx = r['effects'];
      if (fx is List) await _apply(id, fx);
    } catch (_) {
      // a hook never breaks playback
    }
  }

  /// The only things a hook can ask for: marking movies / episodes watched (Python already checked the permission).
  static Future<void> _apply(String id, List fx) async {
    for (final e in fx) {
      if (e is! Map) continue;
      final op = e['op'];
      if (op != 'watched.set' && op != 'watched.set_many') continue;
      final list = op == 'watched.set_many' ? (e['items'] is List ? e['items'] as List : const []) : [e];
      final items = <Progress>[];
      for (final it in list.take(300)) {
        if (it is! Map) continue;
        final p = _item(it);
        if (p != null) items.add(p);
      }
      // source: the plugin that asked, so it is not told about its own change (a Trakt import must not go back to Trakt).
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

  /// Once per run (the first profile that opens): lets a plugin bring in what happened elsewhere. From then on the plugin
  /// also gets a `tick` every few minutes (and when the app returns to the front) so a watch marked elsewhere shows up
  /// while PEK TV is open.
  static void appStart() {
    if (_started) return;
    _started = true;
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
}

class _Life with WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) PluginHooks._resumed();
  }
}
