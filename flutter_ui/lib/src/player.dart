import 'dart:async';
import 'dart:ui' show FontFeature;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'activity.dart';
import 'api.dart';
import 'cloud.dart';
import 'live_tv.dart';
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
  const PlayerScreen({super.key, required this.url, required this.title, this.startSec = 0, this.resume, this.nextFor, this.torrentHash, this.onClose, this.live});
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

  /// A live channel started by a plugin with the "live" permission (pek_ui.live_play). Live has no seek bar and no end; when the
  /// plugin ships a live file the player also gets the channel switcher and the TV guide (the tab on the right edge).
  final LiveSource? live;

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

  // Live TV (widget.live): the plugin's channels and guide, the channel playing, and the guide itself.
  LiveTv? _tv;
  String _liveId = '';
  late String _title = widget.title;
  bool _guideOpen = false;
  Rect? _rect;
  bool get _live => widget.live != null;
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
    final live = widget.live;
    if (live != null) {
      _liveId = live.channelId;
      _tv = LiveTv(live.pluginId)
        ..addListener(_onTv)
        ..start();
    }
    _player.ended.addListener(_onEnded);
    _player.failed.addListener(_onFailed);
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
    _rootNode.dispose();
    _playNode.dispose();
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
    _player.failed.removeListener(_onFailed);
    _player.playing.removeListener(_onPlaying);
    _player.subtitles.removeListener(_subs.onTracks);
    _player.chapters.removeListener(_onChapters);
    _player.position.removeListener(_onPos);
    _subs.dispose();
    _skip.dispose();
    _nextVisible.dispose();
    _countdown.dispose();
    _toastTimer?.cancel();
    _tv?.removeListener(_onTv);
    _tv?.dispose();
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

  // The file would not open (the host already showed a message): leave the player.
  void _onFailed() {
    if (!_player.failed.value || !mounted || _leaving) return;
    if (_live) {
      _toast('This channel is not working right now.'); // a dead stream must not close the player: the person is flicking through channels
      return;
    }
    Navigator.of(context).maybePop();
  }

  void _onEnded() {
    if (!_player.ended.value || !mounted || _leaving) return;
    if (_live) return; // a live stream that stops is not "the end of the film"
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
      if (mounted && _player.playing.value) {
        setState(() => _controls = false);
        // the buttons are out of the focus order while hidden: hand the remote back to the video
        if (ModalRoute.of(context)?.isCurrent ?? false) _rootNode.requestFocus();
      }
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

  // The root listens for the remote when no button has the focus; _playNode is the play / pause button, where Down from the
  // video lands. Left / Right / Up / Down then move between the buttons and OK presses the one that is lit.
  final FocusNode _rootNode = FocusNode(debugLabel: 'player');
  final FocusNode _playNode = FocusNode(debugLabel: 'player play');
  DateTime _lastSeekKey = DateTime.fromMillisecondsSinceEpoch(0);

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    if (_guideOpen) return KeyEventResult.ignored; // the guide has its own keys
    final k = e.logicalKey;
    final isOk = k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.gameButtonA;
    final isArrow = k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.arrowUp || k == LogicalKeyboardKey.arrowDown;
    // A button (back, rewind, play, forward, subtitles, Skip, Up next) has the focus: the arrows move between buttons by the
    // normal focus rules and OK presses the lit one. Keep the controls on screen while the person is using them.
    if (FocusManager.instance.primaryFocus != node && (isOk || isArrow)) {
      _poke();
      return KeyEventResult.ignored;
    }
    if (isOk || k == LogicalKeyboardKey.mediaPlayPause) {
      if (e is KeyDownEvent && context.pek.tvDevice && _skip.cur != null && k != LogicalKeyboardKey.mediaPlayPause) {
        _skip.skip(); // on a TV the button is already "highlighted": OK skips
        _poke();
        return KeyEventResult.handled;
      }
      if (e is KeyDownEvent) _player.togglePause();
      _poke();
      return KeyEventResult.handled;
    }
    if (_live) {
      // Live has nothing to seek: Right opens the guide, the channel keys switch channel.
      if (k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.mediaFastForward) {
        if (e is KeyDownEvent) _openGuide();
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.mediaRewind) {
        _poke();
        return KeyEventResult.handled;
      }
      if (k == LogicalKeyboardKey.channelUp || k == LogicalKeyboardKey.mediaTrackNext || k == LogicalKeyboardKey.channelDown || k == LogicalKeyboardKey.mediaTrackPrevious) {
        if (e is KeyDownEvent) _step(k == LogicalKeyboardKey.channelUp || k == LogicalKeyboardKey.mediaTrackNext ? 1 : -1);
        return KeyEventResult.handled;
      }
    }
    if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.mediaRewind || k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.mediaFastForward) {
      final back = k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.mediaRewind;
      if (e is KeyRepeatEvent) {
        // A held key repeats about 30 times a second: skip 10 s about 5 times a second, not 300 s a second.
        final now = DateTime.now();
        if (now.difference(_lastSeekKey) < const Duration(milliseconds: 200)) return KeyEventResult.handled;
        _lastSeekKey = now;
      }
      _seekBy(back ? -10 : 10);
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowUp) {
      _poke();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowDown) {
      // First press shows the controls; with them showing, Down moves onto the buttons (it no longer opens the subtitle menu).
      final wasShown = _controls;
      _poke();
      if (wasShown && e is KeyDownEvent) _playNode.requestFocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  // ------------------------------------------------------------------------------------------------ live TV

  void _onTv() {
    if (mounted) setState(() {}); // the guide tab appears once the plugin has answered `list`
  }

  /// The guide: the picture shrinks into the top left corner and keeps playing, the channels go down beside and below it.
  void _openGuide() {
    final tv = _tv;
    if (tv == null || !tv.available || _guideOpen) return;
    _hide?.cancel();
    setState(() {
      _guideOpen = true;
      _controls = false;
    });
    _applyRect(force: true);
  }

  void _closeGuide() {
    if (!_guideOpen) return;
    setState(() => _guideOpen = false);
    _rect = null;
    unawaited(_player.fullscreen().catchError((_) {}));
    _rootNode.requestFocus();
    _poke();
  }

  void _applyRect({bool force = false}) {
    final r = liveVideoRect(MediaQuery.sizeOf(context));
    if (!force && _rect == r) return;
    _rect = r;
    unawaited(_player.setMiniRect(r).catchError((_) {}));
  }

  /// OK on a channel in the guide: the playing one closes the guide (full screen), another one is tuned in.
  void _pick(String id) {
    if (id == _liveId) {
      _closeGuide();
    } else {
      unawaited(_switchTo(id));
    }
  }

  void _step(int by) {
    final id = _tv?.neighbour(_liveId, by);
    if (id != null) unawaited(_switchTo(id));
  }

  Future<void> _switchTo(String id) async {
    final tv = _tv;
    if (tv == null || id == _liveId) return;
    final r = await tv.url(id);
    if (!mounted) return;
    if (r == null) {
      _toast('That channel could not be opened.');
      return;
    }
    setState(() {
      _liveId = id;
      _title = r.title.isEmpty ? tv.nameOf(id) : r.title;
    });
    _player.reset();
    await _player.load(r.url, title: _title);
    if (_guideOpen && mounted) _applyRect(force: true); // load() always starts full screen
    unawaited(_banner(id));
  }

  /// "Name / Now: ... / Next: ..." for a moment after a channel change.
  Future<void> _banner(String id) async {
    final tv = _tv;
    if (tv == null) return;
    tv.wantNow([id]);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    if (!mounted || id != _liveId) return;
    final n = liveNowSec(), info = tv.now[id];
    final lines = [
      tv.nameOf(id),
      if (info?.cur != null) 'Now: ${info!.cur!.title} (${liveSpan(info.cur!.end - n)} left)',
      if (info?.next != null) 'Next: ${info!.next!.title}  ${liveClock(info.next!.start)}',
    ];
    _toast(lines.join('\n'));
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
    if (_guideOpen) {
      // a turned screen changes the corner the picture shrinks into
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _guideOpen) _applyRect();
      });
    }
    return PopScope(
      canPop: !_guideOpen, // Back closes the guide first, then the player
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _guideOpen) _closeGuide();
      },
      child: _screen(),
    );
  }

  Widget _screen() {
    return Scaffold(
      backgroundColor: Colors.transparent, // the video surface is behind Flutter
      body: Focus(
        focusNode: _rootNode,
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
              if (_live && !_guideOpen && (_tv?.available ?? false))
                Positioned(
                  right: 0,
                  top: 0,
                  bottom: 0,
                  child: Center(
                    child: AnimatedOpacity(
                      opacity: _controls ? 1 : 0,
                      duration: const Duration(milliseconds: 120),
                      child: IgnorePointer(ignoring: !_controls, child: LiveGuideTab(onTap: _openGuide)),
                    ),
                  ),
                ),
              if (_guideOpen && _tv != null) Positioned.fill(child: LiveGuide(tv: _tv!, currentId: _liveId, onPick: _pick, onClose: _closeGuide)),
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
              ExcludeFocus(
                excluding: !_controls || _guideOpen,
                child: IgnorePointer(
                ignoring: !_controls || _guideOpen,
                child: AnimatedOpacity(
                  opacity: _controls && !_guideOpen ? 1 : 0,
                  duration: const Duration(milliseconds: 120),
                  child: RepaintBoundary(child: Theme(data: ThemeData.dark(useMaterial3: true), child: DefaultTextStyle.merge(style: const TextStyle(color: Colors.white), child: _overlay()))),
                ),
              )),
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

  Widget _glassBtn(IconData icon, VoidCallback onTap, {double size = 44, double icon_ = 22, FocusNode? node}) {
    return _GlassButton(icon: icon, onTap: onTap, size: size, iconSize: icon_, focusNode: node);
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
              Expanded(child: Text(_title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 17.5, fontWeight: FontWeight.w600, letterSpacing: 0.2, color: _fg))),
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
              if (_live) const SizedBox(height: 8) else SizedBox(height: 30, child: ExcludeFocus(child: RepaintBoundary(child: _seekBar()))),
              const SizedBox(height: 4),
              // On a narrow phone the live bar (LIVE + 3 round buttons + guide + captions) is wider than the screen:
              // the LIVE label and the guide / captions buttons get their own row above the channel and play buttons.
              if (_live && MediaQuery.sizeOf(context).width < 480) ...[
                Row(children: [
                  const Icon(Icons.circle, size: 10, color: Color(0xFFE5484D)),
                  const SizedBox(width: 8),
                  Text('LIVE', style: timeStyle.copyWith(letterSpacing: 1.6)),
                  const Spacer(),
                  if (_tv?.available ?? false) ...[
                    _glassBtn(Icons.view_list, _openGuide),
                    const SizedBox(width: 12),
                  ],
                  _glassBtn(Icons.subtitles_outlined, _tracks),
                ]),
                const SizedBox(height: 12),
                Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                  _glassBtn(Icons.skip_previous, () { _step(-1); _poke(); }),
                  const SizedBox(width: 24),
                  ValueListenableBuilder<bool>(
                    valueListenable: _player.playing,
                    builder: (_, p, __) => _glassBtn(p ? Icons.pause : Icons.play_arrow, () { _player.togglePause(); _poke(); }, size: 56, icon_: 30, node: _playNode),
                  ),
                  const SizedBox(width: 24),
                  _glassBtn(Icons.skip_next, () { _step(1); _poke(); }),
                ]),
              ] else
              Row(
                children: [
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: _live
                          ? Row(mainAxisSize: MainAxisSize.min, children: [
                              const Icon(Icons.circle, size: 10, color: Color(0xFFE5484D)),
                              const SizedBox(width: 8),
                              Text('LIVE', style: timeStyle.copyWith(letterSpacing: 1.6)),
                            ])
                          : ValueListenableBuilder<double>(
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
                  _live ? _glassBtn(Icons.skip_previous, () { _step(-1); _poke(); }) : _glassBtn(Icons.replay_10, () { _seekBy(-10); _poke(); }),
                  const SizedBox(width: 16),
                  ValueListenableBuilder<bool>(
                    valueListenable: _player.playing,
                    builder: (_, p, __) => _glassBtn(p ? Icons.pause : Icons.play_arrow, () { _player.togglePause(); _poke(); }, size: 56, icon_: 30, node: _playNode),
                  ),
                  const SizedBox(width: 16),
                  _live ? _glassBtn(Icons.skip_next, () { _step(1); _poke(); }) : _glassBtn(Icons.forward_10, () { _seekBy(10); _poke(); }),
                  Expanded(
                    child: Align(
                      alignment: Alignment.centerRight,
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        if (_live && (_tv?.available ?? false)) ...[
                          _glassBtn(Icons.view_list, _openGuide),
                          const SizedBox(width: 12),
                        ],
                        _glassBtn(Icons.subtitles_outlined, _tracks),
                      ]),
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


/// A round player button that lights up when the remote is on it: it grows, turns light with a dark icon and gets a white ring,
/// so it is clear which button OK will press.
class _GlassButton extends StatefulWidget {
  const _GlassButton({required this.icon, required this.onTap, required this.size, required this.iconSize, this.focusNode});
  final IconData icon;
  final VoidCallback onTap;
  final double size, iconSize;
  final FocusNode? focusNode;

  @override
  State<_GlassButton> createState() => _GlassButtonState();
}

class _GlassButtonState extends State<_GlassButton> {
  bool _f = false;

  @override
  Widget build(BuildContext context) {
    return AnimatedScale(
      scale: _f ? 1.18 : 1.0,
      duration: const Duration(milliseconds: 120),
      child: Material(
        color: _f ? const Color(0xFFF6F2EC) : const Color(0xB31C1815),
        shape: CircleBorder(side: _f ? const BorderSide(color: Colors.white, width: 3) : BorderSide.none),
        elevation: 0,
        shadowColor: Colors.transparent,
        child: InkWell(
          focusNode: widget.focusNode,
          customBorder: const CircleBorder(),
          focusColor: Colors.transparent,
          onFocusChange: (v) => setState(() => _f = v),
          onTap: widget.onTap,
          child: SizedBox(width: widget.size, height: widget.size, child: Icon(widget.icon, size: widget.iconSize, color: _f ? const Color(0xFF1C1815) : const Color(0xFFF6F2EC))),
        ),
      ),
    );
  }
}
