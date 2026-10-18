import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class TrackInfo {
  const TrackInfo(this.id, this.label, this.selected);
  final int id;
  final String label;
  final bool selected;
}

/// The libmpv player. It lives in Kotlin (MpvController, unchanged engine); this is the Dart side of the channels.
/// Video is drawn on a native surface BEHIND Flutter, so the player screen just has a transparent background.
class PekPlayer {
  PekPlayer() {
    _sub = _events.receiveBroadcastStream().listen(_onEvent, onError: (_) {});
  }

  static const _method = MethodChannel('pek/mpv');
  static const _events = EventChannel('pek/mpv/events');
  static const _host = MethodChannel('pek/host');

  late final StreamSubscription<dynamic> _sub;

  final position = ValueNotifier<double>(0);
  final duration = ValueNotifier<double>(0);
  final playing = ValueNotifier<bool>(true);
  final buffering = ValueNotifier<bool>(true);
  final audio = ValueNotifier<List<TrackInfo>>(const []);
  final subtitles = ValueNotifier<List<TrackInfo>>(const []);
  final ended = ValueNotifier<bool>(false);

  void _onEvent(dynamic e) {
    if (e is! Map) return;
    final data = (e['data'] is Map) ? Map<String, dynamic>.from(e['data'] as Map) : <String, dynamic>{};
    switch (e['event']) {
      case 'time':
        position.value = (data['position'] as num?)?.toDouble() ?? 0;
        duration.value = (data['duration'] as num?)?.toDouble() ?? 0;
        break;
      case 'state':
        playing.value = data['playing'] == true;
        buffering.value = data['buffering'] == true;
        break;
      case 'tracks':
        audio.value = _tracks(data['audio']);
        subtitles.value = _tracks(data['subtitles']);
        break;
      case 'ended':
        ended.value = true;
        break;
    }
  }

  List<TrackInfo> _tracks(dynamic v) {
    if (v is! List) return const [];
    return v.whereType<Map>().map((m) => TrackInfo((m['id'] as num).toInt(), '${m['label']}', m['selected'] == true)).toList();
  }

  Future<void> load(String url, {double startSec = 0, String title = ''}) =>
      _method.invokeMethod('load', {'url': url, 'startSec': startSec, 'title': title});
  Future<void> play() => _method.invokeMethod('play');
  Future<void> pause() => _method.invokeMethod('pause');
  Future<void> seek(double sec) => _method.invokeMethod('seek', {'sec': sec < 0 ? 0.0 : sec});
  Future<void> setAudio(int id) => _method.invokeMethod('setAudio', {'id': id});
  Future<void> setSubtitle(int id) => _method.invokeMethod('setSubtitle', {'id': id});
  Future<void> destroy() => _method.invokeMethod('destroy');

  Future<void> togglePause() => playing.value ? pause() : play();

  void dispose() {
    _sub.cancel();
    position.dispose();
    duration.dispose();
    playing.dispose();
    buffering.dispose();
    audio.dispose();
    subtitles.dispose();
    ended.dispose();
  }

  // Host actions (MainActivity / FlutterHostActivity).
  static Future<void> classicUi() => _host.invokeMethod('classicUi');
  static Future<void> exitApp() => _host.invokeMethod('exit');
}
