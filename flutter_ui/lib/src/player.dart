import 'dart:async';
import 'dart:ui' show FontFeature;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'activity.dart';
import 'api.dart';
import 'cloud.dart';
import 'mpv.dart';
import 'music_controller.dart';
import 'plugin_hooks.dart';
import 'skip.dart';
import 'store.dart';
import 'subtitles.dart';
import 'theme.dart';
import 'tokens.dart';
import 'torrent.dart';

/// Full-screen player. The picture is a native libmpv surface behind Flutter, so this screen is transparent and only
/// draws the controls.
///
/// Remote / D-pad:  Select = play / pause   Left / Right = -10 s / +10 s   Up = show controls
///                  Down = audio and subtitles   Back = close
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({super.key, required this.url, required this.title, this.startSec = 0, this.resume, this.nextFor, this.torrentHash, this.onClose});
  final String url;
  final String title;
  final double startSec;

  /// What to record for Resume Watching (null = do not track).
  final Progress? resume;

  /// Which episode comes next ("Up next"); null = nothing to offer.
  final Progress? Function(Progress current)? nextFor;

  /// A torrent stream: while it buffers the player shows how far the loading is (peers, speed).
  final String? torrentHash;

  /// Called when the player closes for good (a torrent is stopped and its temporary data deleted).
  final VoidCallback? onClose;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  final PekPlayer _player = PekPlayer.shared;
  Timer? _save;
  bool _controls = true;
  Timer? _hide;
  double? _seekBase;
  Timer? _seekReset;
  double? _drag;
  late final SubsController _subs;
  late final SkipController _skip;

  // Up next: the next episode is offered for the last 5 minutes; if this one ends while the card is up it starts after a countdown.
  static const _nextShowLeft = 300.0; // seconds left when the card appears
  static const _nextMinLength = 300.0; // clips shorter than this never get a card
  static const _countdownFrom = 5;
  Progress? _next;
  bool _nextDismissed = false;
  bool _nextEverShown = false;
  bool _leaving = false; // replaced by the next episode: the shared player must not be torn down
  bool _hookStarted = false; // plugins with the "playback" permission were told playback began
  bool _hookPaused = false;
  final ValueNotifier<bool> _nextVisible = ValueNotifier(false);
  final ValueNotifier<int?> _countdown = ValueNotifier(null);
  Timer? _countTimer;
  String? _toastText;
  Timer? _toastTimer;

  @override
  void initState() {
    super.initState();
    Activity.playerEnter();
    MusicController.instance.suspend();
    _player.reset();
    _save = Timer.periodic(const Duration(seconds: 10), (_) => _record());
    _player.load(widget.url, startSec: widget.startSec, title: widget.title);
    _player.ended.addListener(_onEnded);
    _player.playing.addListener(_onPlaying);
    _subs = SubsController(player: _player, meta: widget.resume, fileName: widget.title, toast: _toast);
    _player.subtitles.addListener(_subs.onTracks);
    _subs.onTracks(); // also once at the start, in case the file never reports a track list
    _skip = SkipController(player: _player, meta: widget.resume);
    _player.chapters.addListener(_onChapters);
    _player.position.addListener(_onPos);
    unawaited(_skip.fetchRemote());
    final r = widget.resume;
    _next = r == null ? null : widget.nextFor?.call(r);
    _poke();
  }

  @override
  void dispose() {
    Activity.playerLeave();
    if (!_leaving) {
      _hook('stop');
      _record(notify: true); // when the next episode took over, this one was recorded as finished already
    }
    _save?.cancel();
    _hide?.cancel();
    _seekReset?.cancel();
    _countTimer?.cancel();
    _player.ended.removeListener(_onEnded);
    _player.playing.removeListener(_onPlaying);
    _player.subtitles.removeListener(_subs.onTracks);
    _player.chapters.removeListener(_onChapters);
    _player.position.removeListener(_onPos);
    _subs.dispose();
    _skip.dispose();
    _nextVisible.dispose();
    _countdown.dispose();
    _toastTimer?.cancel();
    if (!_leaving) {
      unawaited(_player.destroy());
      _player.reset();
    }
    widget.onClose?.call();
    if (Cloud.linked) Timer(const Duration(milliseconds: 800), () => Cloud.sync(light: true)); // push the new resume point
    super.dispose();
  }

  void _onChapters() => _skip.setChapters(_player.chapters.value, _player.duration.value);

  void _onPos() {
    if (!_hookStarted && !_leaving && _player.position.value > 0 && _player.playing.value && !_player.buffering.value) {
      _hookStarted = true;
      _hook('play');
    }
    _skip.tick(_player.position.value);
    final n = _next;
    if (n == null || _nextDismissed || _leaving) {
      if (_nextVisible.value) _nextVisible.value = false;
      return;
    }
    final dur = _player.duration.value, pos = _player.position.value;
    final show = dur >= _nextMinLength && dur - pos <= _nextShowLeft;
    if (show) _nextEverShown = true;
    if (show != _nextVisible.value) _nextVisible.value = show;
  }

  void _startCountdown() {
    if (_countTimer != null) return;
    _nextVisible.value = true;
    _countdown.value = _countdownFrom;
    _countTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      final left = (_countdown.value ?? 1) - 1;
      if (left <= 0) {
        t.cancel();
        _playNext();
      } else {
        _countdown.value = left;
      }
    });
  }

  void _cancelNext() {
    _countTimer?.cancel();
    _countTimer = null;
    _nextDismissed = true;
    _countdown.value = null;
    _nextVisible.value = false;
    if (_player.ended.value && mounted) Navigator.of(context).maybePop();
  }

  void _playNext() {
    final n = _next;
    if (n == null || _leaving || !mounted) return;
    _leaving = true;
    _countTimer?.cancel();
    final r = widget.resume;
    if (r != null) {
      final dur = _player.duration.value > 0 ? _player.duration.value : r.duration;
      Store.saveProgress(r.at(dur, dur), notify: true); // finished
      if (_hookStarted) PluginHooks.playback('stop', r, dur, dur);
      _hookStarted = false;
    }
    Navigator.of(context).pushReplacement(MaterialPageRoute<void>(
      builder: (_) => PlayerScreen(url: Api.streamUrl(n.id), title: n.title, resume: n, nextFor: widget.nextFor),
    ));
  }

  /// Tells plugins that asked for the "playback" permission (Trakt scrobbling and the like): play once the video really
  /// runs (the first position after buffering, so a file that never loads is never reported), then pause / resume, and
  /// stop when the player closes. The player's `playing` starts as true, so "play" cannot come from that notifier.
  void _onPlaying() {
    if (_leaving || !_hookStarted) return;
    if (!_player.playing.value) {
      if (_player.ended.value || _hookPaused) return;
      _hookPaused = true;
      _hook('pause');
    } else if (_hookPaused) {
      _hookPaused = false;
      _hook('resume');
    }
  }

  void _hook(String type) {
    final r = widget.resume;
    if (r == null || (type == 'stop' && !_hookStarted)) return;
    var pos = _player.position.value;
    if (type == 'play' && pos < 1) pos = widget.startSec; // the player may not have reported where it resumed yet
    PluginHooks.playback(type, r, pos, _player.duration.value > 0 ? _player.duration.value : r.duration);
  }

  /// _saveProgress() in app_watch.js: every ~10 s and when the player closes.
  void _record({bool notify = false}) {
    final r = widget.resume;
    if (r == null) return;
    final pos = _player.position.value, dur = _player.duration.value;
    if (dur <= 0 && pos <= 0) return;
    Store.saveProgress(r.at(pos, dur), notify: notify);
  }

  void _toast(String text) {
    if (!mounted) return;
    setState(() => _toastText = text);
    _toastTimer?.cancel();
    _toastTimer = Timer(const Duration(seconds: 3), () {
      if (mounted) setState(() => _toastText = null);
    });
  }

  /// The "Find subtitles online" rows of the audio / subtitle menu (menuItems() in subtitles.js).
  List<Widget> _onlineRows(BuildContext c) {
    Widget note(String text) => SimpleDialogOption(child: Text(text, style: const TextStyle(color: Pek.muted)));
    Widget retry() => SimpleDialogOption(onPressed: () => _subs.find(auto: false), child: const Text('Try again'));
    switch (_subs.status) {
      case SubsStatus.idle:
        return const [];
      case SubsStatus.searching:
        return [note('Searching\u2026')];
      case SubsStatus.error:
        return [note(_subs.error.isEmpty ? 'Subtitle lookup failed' : _subs.error), retry()];
      case SubsStatus.none:
        return [note('No subtitles found'), retry()];
      case SubsStatus.results:
        return [
          for (final r in _subs.results.take(SubsController.menuResults))
            SimpleDialogOption(
              onPressed: () {
                Navigator.pop(c);
                _subs.apply(r);
              },
              child: Text('${_subs.applied?.id == r.id ? '\u25cf ' : ''}${r.label}'),
            ),
        ];
    }
  }

  void _onEnded() {
    if (!_player.ended.value || !mounted || _leaving) return;
    if (_next != null && !_nextDismissed && _nextEverShown) {
      _startCountdown();
    } else {
      Navigator.of(context).maybePop();
    }
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
      if (e is KeyDownEvent && context.pek.tvDevice && _skip.cur != null && k != LogicalKeyboardKey.mediaPlayPause) {
        _skip.skip(); // on a TV the button is already "highlighted": OK skips
        _poke();
        return KeyEventResult.handled;
      }
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
    _subs.openList();
    await showDialog<void>(
      context: context,
      builder: (c) => AnimatedBuilder(
        animation: _subs,
        builder: (c, _) => ValueListenableBuilder<List<TrackInfo>>(
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
              if (_subs.available) ...[
                const Padding(padding: EdgeInsets.fromLTRB(24, 12, 24, 4), child: Text('Find subtitles online', style: TextStyle(color: Pek.muted))),
                ..._onlineRows(c),
              ],
            ],
          ),
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
                  builder: (_, b, __) => b ? (widget.torrentHash == null ? const CircularProgressIndicator() : TorrentBufferCard(hash: widget.torrentHash!)) : const SizedBox.shrink(),
                ),
              ),
              AnimatedPositioned(
                duration: const Duration(milliseconds: 200),
                right: 16,
                bottom: _controls ? 100 : 28,
                child: AnimatedBuilder(
                  animation: _skip,
                  builder: (_, __) {
                    final c = _skip.cur;
                    if (c == null) return const SizedBox.shrink();
                    return Theme(
                      data: ThemeData.dark(useMaterial3: true),
                      child: FilledButton.icon(
                        onPressed: () {
                          _skip.skip();
                          _poke();
                        },
                        icon: const Icon(Icons.skip_next),
                        label: Text(c.label),
                      ),
                    );
                  },
                ),
              ),
              Positioned(right: 16, top: 0, bottom: 0, child: Center(child: _nextCard())),
              if (_toastText != null)
                Positioned(
                  left: 24,
                  right: 24,
                  bottom: 110,
                  child: IgnorePointer(
                    child: Center(
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                        decoration: BoxDecoration(color: const Color(0xCC000000), borderRadius: BorderRadius.circular(10)),
                        child: Text(_toastText!, textAlign: TextAlign.center, style: const TextStyle(color: Colors.white, fontSize: 15)),
                      ),
                    ),
                  ),
                ),
              IgnorePointer(
                ignoring: !_controls,
                child: AnimatedOpacity(
                  opacity: _controls ? 1 : 0,
                  duration: const Duration(milliseconds: 120),
                  child: RepaintBoundary(child: Theme(data: ThemeData.dark(useMaterial3: true), child: DefaultTextStyle.merge(style: const TextStyle(color: Colors.white), child: _overlay()))),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The "Up next" card on the right: Play now / Dismiss, or a countdown once this episode has ended.
  Widget _nextCard() {
    return ValueListenableBuilder<bool>(
      valueListenable: _nextVisible,
      builder: (_, visible, __) {
        final n = _next;
        if (!visible || n == null) return const SizedBox.shrink();
        return ValueListenableBuilder<int?>(
          valueListenable: _countdown,
          builder: (_, left, __) => Container(
            width: 260,
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(color: const Color(0xE61C1815), borderRadius: BorderRadius.circular(14), border: Border.all(color: const Color(0x38F6F2EC))),
            child: Theme(
              data: ThemeData.dark(useMaterial3: true),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
                const Text('UP NEXT', style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, letterSpacing: 1.6, color: Colors.white70)),
                const SizedBox(height: 4),
                Text(n.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800, color: Colors.white)),
                if (left != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Playing in $left\u2026', style: const TextStyle(color: Colors.white70))),
                const SizedBox(height: 12),
                Row(children: [
                  Expanded(child: FilledButton(onPressed: _playNext, child: const Text('Play now'))),
                  const SizedBox(width: 8),
                  TextButton(onPressed: _cancelNext, child: Text(left != null ? 'Cancel' : 'Dismiss')),
                ]),
              ]),
            ),
          ),
        );
      },
    );
  }

  // Look of the player: dark glass buttons (rgba(28,24,21,.58) + 1px light border), warm off-white highlight,
  // 4px seek track with a 12px knob and halo, time on the left, transport in the middle, tracks + exit on the right.
  static const _glass = Color(0xB31C1815); // flat fill, no blur / border / shadow: cheap to draw on weak boxes
  static const _fg = Color(0xFFF6F2EC);
  static const _hi = Color(0xFFF3EEE7);

  Widget _glassBtn(IconData icon, VoidCallback onTap, {double size = 44, double icon_ = 22}) {
    return Material(
      color: _glass,
      shape: const CircleBorder(),
      elevation: 0,
      shadowColor: Colors.transparent,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(width: size, height: size, child: Icon(icon, size: icon_, color: _fg)),
      ),
    );
  }

  Widget _seekBar() {
    return ValueListenableBuilder<double>(
      valueListenable: _player.duration,
      builder: (_, dur, __) => ValueListenableBuilder<double>(
        valueListenable: _player.position,
        builder: (_, pos, __) {
          final max = dur > 0 ? dur : 1.0;
          final v = (_drag ?? pos).clamp(0.0, max).toDouble();
          return SliderTheme(
            data: SliderThemeData(
              trackHeight: 4,
              activeTrackColor: _hi,
              inactiveTrackColor: const Color(0x29F6F2EC),
              thumbColor: _hi,
              overlayColor: Colors.transparent,
              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6, elevation: 0, pressedElevation: 0),
              overlayShape: const RoundSliderOverlayShape(overlayRadius: 0),
              trackShape: const RoundedRectSliderTrackShape(),
            ),
            child: Slider(
              value: v,
              max: max,
              onChanged: (x) => setState(() => _drag = x),
              onChangeEnd: (x) {
                _player.seek(x);
                setState(() => _drag = null);
                _poke();
              },
            ),
          );
        },
      ),
    );
  }

  Widget _overlay() {
    const shade = Color(0xFF0E0C0A);
    final timeStyle = const TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: _fg, fontFeatures: [FontFeature.tabularFigures()]);
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.fromLTRB(22, 18, 22, 54),
          decoration: BoxDecoration(
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [shade.withAlpha(209), shade.withAlpha(0)]),
          ),
          child: Row(
            children: [
              _glassBtn(Icons.arrow_back, () => Navigator.of(context).maybePop()),
              const SizedBox(width: 12),
              Expanded(child: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17.5, fontWeight: FontWeight.w600, letterSpacing: 0.2, color: _fg))),
            ],
          ),
        ),
        const Spacer(),
        Container(
          padding: const EdgeInsets.fromLTRB(22, 58, 22, 16),
          decoration: BoxDecoration(
            gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [shade.withAlpha(230), shade.withAlpha(0)]),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(height: 30, child: RepaintBoundary(child: _seekBar())),
              const SizedBox(height: 4),
              Row(
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: ValueListenableBuilder<double>(
                        valueListenable: _player.position,
                        builder: (_, pos, __) => ValueListenableBuilder<double>(
                          valueListenable: _player.duration,
                          builder: (_, dur, __) => Text.rich(TextSpan(style: timeStyle, children: [
                            TextSpan(text: _fmt(_drag ?? pos)),
                            TextSpan(text: '  /  ', style: timeStyle.copyWith(color: _fg.withAlpha(115))),
                            TextSpan(text: _fmt(dur), style: timeStyle.copyWith(color: _fg.withAlpha(179))),
                          ])),
                        ),
                      ),
                    ),
                  ),
                  _glassBtn(Icons.replay_10, () { _seekBy(-10); _poke(); }),
                  const SizedBox(width: 16),
                  ValueListenableBuilder<bool>(
                    valueListenable: _player.playing,
                    builder: (_, p, __) => _glassBtn(p ? Icons.pause : Icons.play_arrow, () { _player.togglePause(); _poke(); }, size: 56, icon_: 30),
                  ),
                  const SizedBox(width: 16),
                  _glassBtn(Icons.forward_10, () { _seekBy(10); _poke(); }),
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: _glassBtn(Icons.subtitles_outlined, _tracks),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
