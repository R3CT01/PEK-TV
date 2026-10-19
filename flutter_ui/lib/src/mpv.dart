import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class Chapter {
  const Chapter(this.title, this.time);
  final String title;
  final double time; // seconds
}

class TrackInfo {
  const TrackInfo(this.id, this.label, this.selected);
  final int id;
  final String label;
  final bool selected;
}

/// The libmpv player. It lives in Kotlin (MpvController, unchanged engine); this is the Dart side of the channels.
/// Video is drawn on a native surface BEHIND Flutter, so the player screen just has a transparent background.
class PekPlayer {
  PekPlayer._() {
    _sub = _events.receiveBroadcastStream().listen(_onEvent, onError: (_) {});
  }

  /// The host forwards events to ONE listener, so the video screen and the music player share this instance
  /// (one libmpv engine anyway).
  static final PekPlayer shared = PekPlayer._();

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
  final chapters = ValueNotifier<List<Chapter>>(const []);

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
        final ch = data['chapters'];
        if (ch is List && ch.isNotEmpty) {
          chapters.value = ch.whereType<Map>().map((c) => Chapter('${c['title'] ?? ''}', (c['time'] as num?)?.toDouble() ?? 0)).toList();
        }
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
  /// An extra subtitle file at [url] (loaded and switched on at once).
  Future<void> addSubtitle(String url, String label) => _method.invokeMethod('addSubtitle', {'url': url, 'label': label});
  Future<void> destroy() => _method.invokeMethod('destroy');

  Future<void> togglePause() => playing.value ? pause() : play();

  /// Forget the finished item (the shared instance itself lives for the whole app).
  void reset() {
    position.value = 0;
    duration.value = 0;
    playing.value = true;
    buffering.value = true;
    audio.value = const [];
    subtitles.value = const [];
    chapters.value = const [];
    ended.value = false;
  }

  // Host actions (MainActivity / FlutterHostActivity).
  /// Same test the web UI used for html.pek-tv: false on Android TV / leanback boxes.
  static Future<bool> isPhone() async {
    try {
      return (await _host.invokeMethod<bool>('isPhone').timeout(const Duration(seconds: 2))) ?? true;
    } catch (_) {
      return true;
    }
  }

  /// Lets Wi-Fi multicast through while searching the network for shared folders.
  static Future<void> setMulticast(bool on) async {
    try {
      await _host.invokeMethod('setMulticast', {'on': on});
    } catch (_) {}
  }

  static Future<void> classicUi() => _host.invokeMethod('classicUi');
  static Future<void> exitApp() => _host.invokeMethod('exit');
}

/// What the screen / TV / receiver can do, and the switches for it (Settings > Video output / Audio output).
/// Lives in Kotlin (MpvController); every call can fail on a host without the player, so callers treat errors as "not available".
class VideoOutput {
  const VideoOutput({required this.matchRate, required this.hdr, required this.displayHdr});
  final bool matchRate;
  final bool hdr;
  final bool displayHdr;
}

class AudioOutput {
  const AudioOutput({required this.on, required this.known, required this.formats});
  final Set<String> on; // codecs switched on
  final bool known; // false = the device did not say what it supports
  final Set<String> formats; // codecs the device reports it can take untouched
}

class PekOutput {
  static const _c = MethodChannel('pek/output');

  static Future<VideoOutput> video() async {
    final m = Map<String, dynamic>.from(await _c.invokeMethod<Map>('video') ?? const {});
    return VideoOutput(matchRate: m['matchRate'] == true, hdr: m['hdr'] == true, displayHdr: m['displayHdr'] == true);
  }

  static Future<void> setMatchRate(bool on) => _c.invokeMethod('setMatchRate', {'on': on});
  static Future<void> setHdr(bool on) => _c.invokeMethod('setHdr', {'on': on});

  static Future<AudioOutput> audio() async {
    final m = Map<String, dynamic>.from(await _c.invokeMethod<Map>('audio') ?? const {});
    Set<String> strs(dynamic v) => v is List ? v.map((e) => '$e').toSet() : <String>{};
    return AudioOutput(on: strs(m['on']), known: m['known'] == true, formats: strs(m['formats']));
  }

  static Future<void> setPassthrough(String codec, bool on) => _c.invokeMethod('setPassthrough', {'codec': codec, 'on': on});
}
