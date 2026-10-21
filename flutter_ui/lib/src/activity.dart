import 'dart:async';

import 'package:flutter/material.dart';

import 'music_controller.dart';
import 'store.dart';
import 'tokens.dart';

/// Port of www/activity.js: a small, quiet status line in the bottom right corner saying what PEK TV is doing in the background
/// ("Scanning your media folders...", "Syncing watch history..."). It is never focusable, ignores taps, is hidden while a video
/// plays or the keyboard is open, and sits above the phone's bottom bar and the mini player.
///
///   Activity.begin(id, text, detail: false)   something started (counted: every begin needs an end)
///   Activity.update(id, text)                 change the text of a running item
///   Activity.end(id, doneText)                finished; doneText stays a moment as "done"
///   Activity.note(text, detail: false)        a one-off message
/// `detail` items only show at the Detailed level (Settings > Background activity: Off / Basic / Detailed).
class Activity {
  static const levels = ['off', 'basic', 'detailed'];
  static const _key = 'pek_activity';
  static const _maxLines = 3;

  /// Bumped whenever the lines change.
  static final ValueNotifier<int> tick = ValueNotifier(0);

  /// True while a video is on screen (the line stays off the picture).
  static final ValueNotifier<bool> playerOpen = ValueNotifier(false);
  static int _players = 0;
  static void playerEnter() {
    _players++;
    playerOpen.value = true;
  }

  /// Counted, because the next episode's player opens before the old one is gone.
  static void playerLeave() {
    _players = _players > 0 ? _players - 1 : 0;
    playerOpen.value = _players > 0;
  }

  static final Map<String, _Item> _items = {};
  static int _seq = 0;
  static Timer? _redrawTimer;

  static String get level {
    final v = Store.strGet(_key, scoped: false);
    return levels.contains(v) ? v! : 'basic';
  }

  static Future<void> setLevel(String l) async {
    if (!levels.contains(l)) return;
    await Store.strSet(_key, l, scoped: false);
    if (l == 'off') _items.clear();
    else note('Background activity: ${l == 'basic' ? 'Basic' : 'Detailed'}');
    _redraw();
    Store.notifyChanged(); // the Settings rows repaint
  }

  static void begin(String id, String text, {bool detail = false}) {
    if (level == 'off') return;
    final it = _items[id];
    if (it != null && !it.done) {
      it.count++;
      if (text.isNotEmpty) it.text = _clip(text);
      it.t = _now();
    } else {
      _items[id] = _Item(text: _clip(text.isEmpty ? id : text), detail: detail, count: 1, order: ++_seq);
    }
    _redraw();
  }

  static void update(String id, String text) {
    if (level == 'off') return;
    final it = _items[id];
    if (it == null || it.done) return begin(id, text);
    it.text = _clip(text);
    it.t = _now();
    _redraw();
  }

  static void end(String id, [String? doneText]) {
    final it = _items[id];
    if (it == null || it.done) return;
    if (--it.count > 0) return; // another request of the same kind is still running
    it.done = true;
    if (doneText != null && doneText.isNotEmpty && level != 'off') {
      it.text = _clip(doneText);
      _expire(id, const Duration(milliseconds: 2500));
    } else {
      _expire(id, const Duration(milliseconds: 600));
    }
    _redraw();
  }

  static void note(String text, {bool detail = false}) {
    if (level == 'off') return;
    final id = 'note:${++_seq}';
    _items[id] = _Item(text: _clip(text), detail: detail, count: 0, order: _seq, done: true);
    _expire(id, const Duration(seconds: 3));
    _redraw();
  }

  /// Runs [work] as one activity item: [text] while it runs, then [okText] / [failText] (or [okText] from [result], when given).
  static Future<T> track<T>(String id, String text, Future<T> Function() work, {String? okText, String? failText, bool detail = false, String Function(T)? result}) async {
    begin(id, text, detail: detail);
    try {
      final r = await work();
      end(id, result != null ? result(r) : okText);
      return r;
    } catch (_) {
      end(id, failText);
      rethrow;
    }
  }

  static int _now() => DateTime.now().millisecondsSinceEpoch;
  static String _clip(String s) => s.length > 120 ? s.substring(0, 120) : s;

  static void _expire(String id, Duration d) {
    Timer(d, () {
      final it = _items[id];
      if (it != null && it.done) {
        _items.remove(id);
        _redraw();
      }
    });
  }

  /// Batches bursts of updates (a counting-down message does not repaint on every number).
  static void _redraw() {
    _redrawTimer ??= Timer(const Duration(milliseconds: 120), () {
      _redrawTimer = null;
      tick.value++;
    });
  }

  /// The lines to show now, oldest first (a stuck item fades out after 90 s).
  static List<_Item> visible() {
    final lv = level;
    final now = _now();
    final out = _items.values.where((it) => (lv == 'detailed' || (lv == 'basic' && !it.detail)) && (it.done || now - it.t < 90000)).toList()
      ..sort((a, b) => a.order.compareTo(b.order));
    return out.length > _maxLines ? out.sublist(out.length - _maxLines) : out;
  }
}

class _Item {
  _Item({required this.text, required this.detail, required this.count, required this.order, this.done = false}) : t = DateTime.now().millisecondsSinceEpoch;
  String text;
  final bool detail;
  int count;
  bool done;
  final int order;
  int t;
}

/// The corner lines. Mounted once above every route (main.dart).
class ActivityOverlay extends StatelessWidget {
  const ActivityOverlay({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final keyboard = MediaQuery.of(context).viewInsets.bottom > 0;
    return ValueListenableBuilder<bool>(
      valueListenable: Activity.playerOpen,
      builder: (context, playing, _) => ValueListenableBuilder<int>(
        valueListenable: Activity.tick,
        builder: (context, _, __) {
          final lines = playing || keyboard ? const <_Item>[] : Activity.visible();
          if (lines.isEmpty) return const SizedBox.shrink();
          return ValueListenableBuilder(
            valueListenable: MusicController.instance.current,
            builder: (context, track, _) {
              // Phones: clear the bottom bar (and the mini player when music is queued); elsewhere a small corner margin.
              final lift = (p.narrow ? 66.0 : 8.0) + (track != null && p.narrow ? 68.0 : 0.0);
              final fs = (p.narrow ? 11.0 : 12.0);
              return Positioned(
                right: (p.narrow ? 8 : 10) + p.safeX,
                bottom: lift + MediaQuery.of(context).padding.bottom + p.safeY,
                child: IgnorePointer(
                  child: ExcludeSemantics(
                    child: ConstrainedBox(
                      constraints: BoxConstraints(maxWidth: (p.size.width * 0.7).clamp(0, 420).toDouble()),
                      child: Opacity(
                        opacity: 0.85,
                        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                          for (final it in lines)
                            Padding(
                              padding: const EdgeInsets.only(top: 3),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                                decoration: BoxDecoration(color: const Color(0xB80F121A), borderRadius: BorderRadius.circular(999)),
                                child: Row(mainAxisSize: MainAxisSize.min, children: [
                                  _Dot(color: it.done ? const Color(0xFF4CC38A) : t.accent, pulse: !it.done),
                                  const SizedBox(width: 6),
                                  Flexible(child: Text(it.text, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: fs, height: 1.3, color: const Color(0xFFE8EDF5), decoration: TextDecoration.none, fontWeight: FontWeight.w400))),
                                ]),
                              ),
                            ),
                        ]),
                      ),
                    ),
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// `.ha-dot`: 7px, pulsing while the item runs (steady green when done; still when the system asks for reduced motion).
class _Dot extends StatefulWidget {
  const _Dot({required this.color, required this.pulse});
  final Color color;
  final bool pulse;
  @override
  State<_Dot> createState() => _DotState();
}

class _DotState extends State<_Dot> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1000))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final still = !widget.pulse || MediaQuery.of(context).disableAnimations;
    return AnimatedBuilder(
      animation: _c,
      builder: (_, __) => Opacity(
        opacity: still ? 1 : 0.35 + 0.65 * Curves.easeInOut.transform(_c.value),
        child: Container(width: 7, height: 7, decoration: BoxDecoration(color: widget.color, shape: BoxShape.circle)),
      ),
    );
  }
}

/// Port of www/busy.js: a ring over the screen when a request to the PEK TV server takes more than half a second (removing a
/// folder, browsing folders, loading a big library). Background chatter (progress polling, poster / detail lookups) is ignored.
class Busy {
  static const _ignore = ['/api/scan-status', '/api/discover', '/api/status', '/api/plugins', '/api/skins', '/api/movie-details', '/api/show-details', '/api/episode-details'];
  static const _delay = Duration(milliseconds: 500);

  static final ValueNotifier<bool> visible = ValueNotifier(false);
  static int _pending = 0;
  static Timer? _timer;

  static bool _tracked(String path) {
    final p = path.split('?').first;
    return p.startsWith('/api/') && !_ignore.contains(p);
  }

  /// Wraps a request: the ring appears if it is still running after 0.5 s.
  static Future<T> run<T>(String path, Future<T> Function() request) async {
    if (!_tracked(path)) return request();
    _pending++;
    _timer ??= visible.value ? null : Timer(_delay, () {
      _timer = null;
      if (_pending > 0) visible.value = true;
    });
    try {
      return await request();
    } finally {
      _pending = _pending > 0 ? _pending - 1 : 0;
      if (_pending == 0) {
        _timer?.cancel();
        _timer = null;
        visible.value = false;
      }
    }
  }
}

/// `.hs-slow`: a dim layer with a ring in the middle, never takes a tap or a key.
class BusyRing extends StatelessWidget {
  const BusyRing({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<bool>(
      valueListenable: Busy.visible,
      builder: (context, on, _) => on
          ? Positioned.fill(
              child: IgnorePointer(
                child: ColoredBox(color: const Color(0x40000000), child: Center(child: CircularProgressIndicator(color: context.pek.tokens.accent))),
              ),
            )
          : const SizedBox.shrink(),
    );
  }
}
