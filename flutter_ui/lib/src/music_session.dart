import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'music_controller.dart';

/// Tells Android what is playing, so the music keeps going with the screen off or the app in the background and the
/// notification / lock screen / headset buttons work (Kotlin: FlutterMusic.kt -> MusicService, the same service the web UI uses).
///
/// Dart owns the queue, so Next / Previous / Stop come back here from the buttons; Play, Pause and Seek are answered in Kotlin.
class MusicSession {
  MusicSession(this._mc) {
    _channel.setMethodCallHandler(_onCall);
    _mc.current.addListener(_onTrack);
    _mc.playing.addListener(_schedule);
    _mc.buffering.addListener(_schedule);
    _mc.duration.addListener(_schedule);
    _mc.position.addListener(_onPosition);
  }

  final MusicController _mc;
  static const _channel = MethodChannel('pek/music');

  Timer? _debounce;
  bool _live = false;
  double _pushedPos = 0;
  DateTime _pushedAt = DateTime.now();
  bool _pushedPlaying = false;

  Future<void> _onCall(MethodCall call) async {
    if (call.method != 'remote') return;
    final a = (call.arguments is Map) ? (call.arguments as Map)['action'] : null;
    switch (a) {
      case 'next':
        await _mc.next();
        break;
      case 'prev':
        await _mc.prev();
        break;
      case 'stop':
        await _mc.stop();
        break;
    }
  }

  /// The restored song just started loading: tell Android about it now (see [MusicController.toggle]).
  void refresh() => _onTrack();

  void _onTrack() {
    final t = _mc.current.value;
    if (t != null && _mc.restoredIdle) return; // restored from the last session: no notification until Play

    if (t == null) {
      _debounce?.cancel();
      if (_live) {
        _live = false;
        _send('end');
      }
      return;
    }
    _live = true;
    _send('meta', {
      'title': t.title,
      'artist': t.artist,
      'album': t.album,
      'art': t.art ? Api.trackArt(t) : '',
    });
    _schedule();
  }

  // Many notifiers change at once when a song loads; send one state after they settle.
  void _schedule() {
    if (!_live) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 150), _push);
  }

  // The notification moves its own clock while playing; only correct it when the real position drifts (a seek, a skip).
  void _onPosition() {
    if (!_live) return;
    final expected = _pushedPlaying ? _pushedPos + DateTime.now().difference(_pushedAt).inMilliseconds / 1000.0 : _pushedPos;
    if ((_mc.position.value - expected).abs() > 2.0) _schedule();
  }

  void _push() {
    if (!_live) return;
    final t = _mc.current.value;
    final dur = _mc.duration.value > 0 ? _mc.duration.value : (t?.duration ?? 0);
    _pushedPos = _mc.position.value;
    _pushedAt = DateTime.now();
    _pushedPlaying = _mc.playing.value && !_mc.buffering.value;
    _send('state', {
      'active': _mc.playing.value,
      'buffering': _mc.buffering.value,
      'positionMs': (_pushedPos * 1000).round(),
      'durationMs': (dur * 1000).round(),
    });
  }

  Future<void> _send(String method, [Map<String, Object?>? args]) async {
    try {
      await _channel.invokeMethod(method, args);
    } catch (e) {
      debugPrint('music session: $e'); // a host without the service (desktop, tests): the music still plays in the app
    }
  }
}
