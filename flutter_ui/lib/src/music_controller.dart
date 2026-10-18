import 'package:flutter/foundation.dart';

import 'api.dart';
import 'mpv.dart';

/// Music playback for the Music page: a queue on top of the same libmpv engine the video player uses
/// (/api/music/stream/<id> is a plain audio URL). Starting a video stops the music ([suspend]).
class MusicController {
  MusicController._() {
    _p.ended.addListener(() {
      if (_p.ended.value && current.value != null) next(auto: true);
    });
  }
  static final MusicController instance = MusicController._();

  final PekPlayer _p = PekPlayer.shared;

  final ValueNotifier<Track?> current = ValueNotifier(null);
  final ValueNotifier<List<Track>> queue = ValueNotifier(const []);
  final ValueNotifier<bool> shuffle = ValueNotifier(false);
  final ValueNotifier<bool> repeat = ValueNotifier(false);

  ValueNotifier<double> get position => _p.position;
  ValueNotifier<double> get duration => _p.duration;
  ValueNotifier<bool> get playing => _p.playing;
  ValueNotifier<bool> get buffering => _p.buffering;

  int _index = -1;
  List<Track> _order = const []; // queue in play order (shuffled copy when shuffle is on)

  Future<void> playList(List<Track> tracks, int start) async {
    if (tracks.isEmpty) return;
    queue.value = List.of(tracks);
    _order = shuffle.value ? _shuffled(tracks, tracks[start]) : List.of(tracks);
    _index = _order.indexWhere((t) => t.id == tracks[start].id);
    await _load(_order[_index]);
  }

  List<Track> _shuffled(List<Track> l, Track first) {
    final rest = List.of(l)..removeWhere((t) => t.id == first.id)..shuffle();
    return [first, ...rest];
  }

  Future<void> _load(Track t) async {
    current.value = t;
    _p.reset();
    await _p.load(Api.musicStream(t.id), title: t.title);
  }

  Future<void> toggle() async {
    if (current.value == null) return;
    await _p.togglePause();
  }

  Future<void> seek(double sec) => _p.seek(sec);

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
      await _p.seek(0);
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
  }

  void toggleRepeat() => repeat.value = !repeat.value;

  Future<void> stop() async {
    current.value = null;
    queue.value = const [];
    _order = const [];
    _index = -1;
    await _p.destroy();
    _p.reset();
  }

  /// A video is about to take the engine.
  void suspend() {
    current.value = null;
    queue.value = const [];
    _order = const [];
    _index = -1;
  }
}
