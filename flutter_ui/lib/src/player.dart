import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'mpv.dart';
import 'theme.dart';

/// Full-screen player. The picture is a native libmpv surface behind Flutter, so this screen is transparent and only
/// draws the controls.
///
/// Remote / D-pad:  Select = play / pause   Left / Right = -10 s / +10 s   Up = show controls
///                  Down = audio and subtitles   Back = close
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key, required this.url, required this.title, this.startSec = 0});
  final String url;
  final String title;
  final double startSec;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  final PekPlayer _player = PekPlayer();
  bool _controls = true;
  Timer? _hide;
  double? _seekBase;
  Timer? _seekReset;
  double? _drag;

  @override
  void initState() {
    super.initState();
    _player.load(widget.url, startSec: widget.startSec, title: widget.title);
    _player.ended.addListener(_onEnded);
    _poke();
  }

  @override
  void dispose() {
    _hide?.cancel();
    _seekReset?.cancel();
    _player.ended.removeListener(_onEnded);
    unawaited(_player.destroy());
    _player.dispose();
    super.dispose();
  }

  void _onEnded() {
    if (_player.ended.value && mounted) Navigator.of(context).maybePop();
  }

  void _poke() {
    if (!_controls) setState(() => _controls = true);
    _hide?.cancel();
    _hide = Timer(const Duration(seconds: 4), () {
      if (mounted && _player.playing.value) setState(() => _controls = false);
    });
  }

  void _seekBy(double delta) {
    var t = (_seekBase ?? _player.position.value) + delta;
    if (t < 0) t = 0;
    final d = _player.duration.value;
    if (d > 0 && t > d - 1) t = d - 1;
    _seekBase = t; // key repeats add up instead of each starting from the last reported position
    _seekReset?.cancel();
    _seekReset = Timer(const Duration(milliseconds: 1500), () => _seekBase = null);
    _player.seek(t);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.gameButtonA || k == LogicalKeyboardKey.mediaPlayPause) {
      if (e is KeyDownEvent) _player.togglePause();
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.mediaRewind) {
      _seekBy(-10);
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.mediaFastForward) {
      _seekBy(10);
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowUp) {
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowDown && e is KeyDownEvent) {
      _tracks();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  Future<void> _tracks() async {
    _hide?.cancel();
    setState(() => _controls = true);
    await showDialog<void>(
      context: context,
      builder: (c) => ValueListenableBuilder<List<TrackInfo>>(
        valueListenable: _player.audio,
        builder: (_, audio, __) => ValueListenableBuilder<List<TrackInfo>>(
          valueListenable: _player.subtitles,
          builder: (_, subs, __) => SimpleDialog(
            title: const Text('Audio and subtitles'),
            children: [
              const Padding(padding: EdgeInsets.fromLTRB(24, 4, 24, 4), child: Text('Audio', style: TextStyle(color: Pek.muted))),
              for (final t in audio)
                SimpleDialogOption(
                  onPressed: () {
                    _player.setAudio(t.id);
                    Navigator.pop(c);
                  },
                  child: Text('${t.selected ? '● ' : ''}${t.label}'),
                ),
              const Padding(padding: EdgeInsets.fromLTRB(24, 12, 24, 4), child: Text('Subtitles', style: TextStyle(color: Pek.muted))),
              SimpleDialogOption(
                onPressed: () {
                  _player.setSubtitle(-1);
                  Navigator.pop(c);
                },
                child: Text('${subs.any((t) => t.selected) ? '' : '● '}Off'),
              ),
              for (final t in subs)
                SimpleDialogOption(
                  onPressed: () {
                    _player.setSubtitle(t.id);
                    Navigator.pop(c);
                  },
                  child: Text('${t.selected ? '● ' : ''}${t.label}'),
                ),
            ],
          ),
        ),
      ),
    );
    if (mounted) _poke();
  }

  String _fmt(double s) {
    final t = s.isNaN || s < 0 ? 0 : s.floor();
    final h = t ~/ 3600, m = (t % 3600) ~/ 60, sec = t % 60;
    String two(int n) => n.toString().padLeft(2, '0');
    return h > 0 ? '$h:${two(m)}:${two(sec)}' : '${two(m)}:${two(sec)}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent, // the video surface is behind Flutter
      body: Focus(
        autofocus: true,
        onKeyEvent: _onKey,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () {
            if (_controls) {
              _player.togglePause();
            }
            _poke();
          },
          child: Stack(
            fit: StackFit.expand,
            children: [
              Center(
                child: ValueListenableBuilder<bool>(
                  valueListenable: _player.buffering,
                  builder: (_, b, __) => b ? const CircularProgressIndicator() : const SizedBox.shrink(),
                ),
              ),
              IgnorePointer(
                ignoring: !_controls,
                child: AnimatedOpacity(
                  opacity: _controls ? 1 : 0,
                  duration: const Duration(milliseconds: 180),
                  child: _overlay(),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _overlay() {
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
          decoration: const BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0xCC000000), Color(0x00000000)]),
          ),
          child: Row(
            children: [
              IconButton(onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.arrow_back)),
              const SizedBox(width: 8),
              Expanded(child: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
              IconButton(onPressed: _tracks, icon: const Icon(Icons.subtitles_outlined)),
            ],
          ),
        ),
        const Spacer(),
        Container(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 20),
          decoration: const BoxDecoration(
            gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [Color(0xCC000000), Color(0x00000000)]),
          ),
          child: Row(
            children: [
              ValueListenableBuilder<bool>(
                valueListenable: _player.playing,
                builder: (_, p, __) => IconButton(
                  iconSize: 36,
                  onPressed: () {
                    _player.togglePause();
                    _poke();
                  },
                  icon: Icon(p ? Icons.pause : Icons.play_arrow),
                ),
              ),
              ValueListenableBuilder<double>(
                valueListenable: _player.position,
                builder: (_, pos, __) => Text(_fmt(_drag ?? pos)),
              ),
              Expanded(
                child: ValueListenableBuilder<double>(
                  valueListenable: _player.duration,
                  builder: (_, dur, __) => ValueListenableBuilder<double>(
                    valueListenable: _player.position,
                    builder: (_, pos, __) {
                      final max = dur > 0 ? dur : 1.0;
                      final v = (_drag ?? pos).clamp(0.0, max).toDouble();
                      return Slider(
                        value: v,
                        max: max,
                        onChanged: (x) => setState(() => _drag = x),
                        onChangeEnd: (x) {
                          _player.seek(x);
                          setState(() => _drag = null);
                          _poke();
                        },
                      );
                    },
                  ),
                ),
              ),
              ValueListenableBuilder<double>(
                valueListenable: _player.duration,
                builder: (_, dur, __) => Text(_fmt(dur)),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
