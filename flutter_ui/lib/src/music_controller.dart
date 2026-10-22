import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

import 'api.dart';
import 'mpv.dart';
import 'music_session.dart';
import 'store.dart';

/// Music playback for the Music page: a queue on top of the same libmpv engine the video player uses
/// (/api/music/stream/<id> is a plain audio URL). Starting a video stops the music ([suspend]).
class MusicController {
  MusicController._() {
    _p.ended.addListener(() {
      if (_p.ended.value && current.value != null) next(auto: true);
    });
    _session = MusicSession(this); // background play + lock-screen controls
    WidgetsBinding.instance.addObserver(_Lifecycle(this));
    Store.profile.addListener(_onProfile);
    _p.playing.addListener(_onPlaying);
  }
  // ignore: unused_field
  late final MusicSession _session;
  static final MusicController instance = MusicController._();

  final PekPlayer _p = PekPlayer.shared;

  final ValueNotifier<Track?> current = ValueNotifier(null);
  final ValueNotifier<List<Track>> queue = ValueNotifier(const []);

  /// The queue in the order it plays (a shuffled copy while shuffle is on). The full-screen player's Queue tab shows this.
  final ValueNotifier<List<Track>> playOrder = ValueNotifier(const []);
  final ValueNotifier<bool> shuffle = ValueNotifier(false);
  final ValueNotifier<bool> repeat = ValueNotifier(false);

  ValueNotifier<double> get position => _p.position;
  ValueNotifier<double> get duration => _p.duration;
  ValueNotifier<bool> get playing => _p.playing;
  ValueNotifier<bool> get buffering => _p.buffering;

  int _index = -1;
  List<Track> _orderList = const [];
  List<Track> get _order => _orderList;
  set _order(List<Track> v) {
    _orderList = v;
    playOrder.value = List.unmodifiable(v);
  }

  Future<void> playList(List<Track> tracks, int start) async {
    if (tracks.isEmpty) return;
    queue.value = List.of(tracks);
    _order = shuffle.value ? _shuffled(tracks, tracks[start]) : List.of(tracks);
    _index = _order.indexWhere((t) => t.id == tracks[start].id);
    _saveEnabled = true;
    await _load(_order[_index]);
  }

  /// Plays [tracks] from the start, or from a random song with shuffle turned on.
  Future<void> playAll(List<Track> tracks, {bool shuffle = false}) async {
    if (tracks.isEmpty) return;
    if (shuffle && !this.shuffle.value) toggleShuffle();
    await playList(tracks, shuffle ? math.Random().nextInt(tracks.length) : 0);
  }

  /// "Play next" (right after the playing song) or "Add to queue" (the end). Starts playing when nothing does.
  Future<void> enqueue(List<Track> tracks, {bool next = false}) async {
    if (tracks.isEmpty) return;
    final cur = current.value;
    if (cur == null || _order.isEmpty) {
      await playList(tracks, 0);
      return;
    }
    final order = List.of(_order)..insertAll(next ? _index + 1 : _order.length, tracks);
    _order = order;
    final q = List.of(queue.value);
    final qi = q.indexWhere((t) => t.id == cur.id);
    q.insertAll(next && qi >= 0 ? qi + 1 : q.length, tracks);
    queue.value = q;
    _saveQueue();
  }

  List<Track> _shuffled(List<Track> l, Track first) {
    final rest = List.of(l)..removeWhere((t) => t.id == first.id)..shuffle();
    return [first, ...rest];
  }

  Future<void> _load(Track t, {double startSec = 0}) async {
    _idle = false;
    _pendingPos = 0;
    current.value = t;
    _p.reset();
    _saveQueue();
    await _p.load(Api.musicStream(t.id), startSec: startSec, title: t.title);
  }

  Future<void> toggle() async {
    final t = current.value;
    if (t == null) return;
    if (_idle) {
      // Restored from the last session: nothing is loaded yet, so the first Play starts the song where it stopped.
      final pos = _pendingPos;
      await _load(t, startSec: pos);
      _session.refresh();
      return;
    }
    await _p.togglePause();
  }

  Future<void> seek(double sec) async {
    if (_idle) {
      _pendingPos = sec < 0 ? 0 : sec;
      _p.position.value = _pendingPos;
      _savePosition();
      return;
    }
    await _p.seek(sec);
  }

  /// Plays entry [i] of [playOrder] (a tap in the full-screen player's Queue tab).
  Future<void> jump(int i) async {
    if (i < 0 || i >= _order.length) return;
    _index = i;
    await _load(_order[i]);
  }

  Future<void> next({bool auto = false}) async {
    if (_order.isEmpty) return;
    if (auto && repeat.value) {
      await _load(_order[_index]);
      return;
    }
    if (_index + 1 >= _order.length) {
      if (auto && !repeat.value) {
        await stop();
        return;
      }
      _index = -1;
    }
    _index++;
    await _load(_order[_index]);
  }

  Future<void> prev() async {
    if (_order.isEmpty) return;
    if (_p.position.value > 5 || _index == 0) {
      await seek(0);
      return;
    }
    _index--;
    await _load(_order[_index]);
  }

  void toggleShuffle() {
    shuffle.value = !shuffle.value;
    final cur = current.value;
    if (cur == null) return;
    _order = shuffle.value ? _shuffled(queue.value, cur) : List.of(queue.value);
    _index = _order.indexWhere((t) => t.id == cur.id);
    _saveQueue();
  }

  void toggleRepeat() {
    repeat.value = !repeat.value;
    _saveQueue();
  }

  Future<void> stop() async {
    _idle = false;
    _pendingPos = 0;
    _saveEnabled = false;
    unawaited(Store.strDel(_kQueue));
    unawaited(Store.strDel(_kPos));
    current.value = null;
    queue.value = const [];
    _order = const [];
    _index = -1;
    await _p.destroy();
    _p.reset();
  }

  /// A video is about to take the engine.
  void suspend() {
    _saveEnabled = false; // the saved song stays: it is offered again the next time the app opens
    _idle = false;
    _pendingPos = 0;
    current.value = null;
    queue.value = const [];
    _order = const [];
    _index = -1;
  }

  // ---------------------------------------------------------------- resume (per profile, like Spotify's player)

  static const _kQueue = 'pek_music_resume_v1'; // queue, play order, position in it, shuffle, repeat
  static const _kPos = 'pek_music_resume_pos_v1'; // song id + seconds: small, written every few seconds

  /// The restored song is shown (mini player, full-screen player) but nothing is loaded into the engine until Play.
  bool _idle = false;
  bool get restoredIdle => _idle;
  double _pendingPos = 0;
  bool _saveEnabled = false;
  Timer? _posTimer;

  /// Writes the queue. Skipped while nothing plays on purpose (after Stop, or while a video has the engine).
  void _saveQueue() {
    if (!_saveEnabled) return;
    final cur = current.value;
    if (cur == null || _order.isEmpty) return;
    try {
      unawaited(Store.strSet(_kQueue, jsonEncode({
        'queue': [for (final t in queue.value) t.toJson()],
        'order': [for (final t in _order) t.id],
        'index': _index,
        'shuffle': shuffle.value,
        'repeat': repeat.value,
      })));
      _savePosition();
    } catch (e) {
      debugPrint('music resume: $e');
    }
  }

  void _savePosition() {
    final cur = current.value;
    if (!_saveEnabled || cur == null) return;
    final pos = _idle ? _pendingPos : _p.position.value;
    unawaited(Store.strSet(_kPos, jsonEncode({'id': cur.id, 'pos': pos < 0 ? 0 : pos})));
  }

  // While a song plays, remember how far it got every few seconds (and when the app goes to the background).
  void _onPlaying() {
    _posTimer?.cancel();
    if (_p.playing.value && current.value != null) {
      _posTimer = Timer.periodic(const Duration(seconds: 5), (_) => _savePosition());
    }
  }

  /// Puts the last session's song back in the player, paused, for the active profile. Called once at start-up.
  void restore() {
    if (current.value != null) return; // something already plays
    try {
      final o = jsonDecode(Store.strGet(_kQueue) ?? '');
      if (o is! Map) return;
      final q = [for (final e in (o['queue'] as List? ?? const [])) if (e is Map) Track.fromJson(Map<String, dynamic>.from(e))];
      if (q.isEmpty) return;
      final byId = {for (final t in q) t.id: t};
      final order = [for (final id in (o['order'] as List? ?? const [])) if (byId[id] != null) byId[id]!];
      final list = order.isEmpty ? q : order;
      var idx = (o['index'] as num?)?.toInt() ?? 0;
      if (idx < 0 || idx >= list.length) idx = 0;
      var pos = 0.0;
      final pj = jsonDecode(Store.strGet(_kPos) ?? '{}');
      if (pj is Map && pj['id'] == list[idx].id) pos = (pj['pos'] as num?)?.toDouble() ?? 0;
      final t = list[idx];
      if (pos >= t.duration - 2 && t.duration > 0) pos = 0; // it had finished: start it over
      shuffle.value = o['shuffle'] == true;
      repeat.value = o['repeat'] == true;
      queue.value = List.of(q);
      _order = List.of(list);
      _index = idx;
      _idle = true;
      _pendingPos = pos;
      _saveEnabled = true;
      _p.reset();
      _p.playing.value = false;
      _p.buffering.value = false;
      _p.position.value = pos;
      _p.duration.value = t.duration;
      current.value = t;
    } catch (e) {
      debugPrint('music resume: $e');
    }
  }

  // Another profile became active: its own music comes back (the engine is stopped, the old profile's save stays as it is).
  void _onProfile() {
    final had = current.value != null;
    _saveEnabled = false;
    _posTimer?.cancel();
    if (had) {
      current.value = null;
      queue.value = const [];
      _order = const [];
      _index = -1;
      _idle = false;
      unawaited(_p.destroy().then((_) => _p.reset()));
    }
    restore();
  }
}

class _Lifecycle with WidgetsBindingObserver {
  _Lifecycle(this._mc);
  final MusicController _mc;
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) _mc._savePosition();
  }
}
