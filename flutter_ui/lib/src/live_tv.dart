import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'plugin_host.dart';

/// Live TV in the player (see FLUTTER_PLUGINS.md, "Live TV"). A plugin with the "live" permission starts a channel with
/// pek_ui.live_play(); when it also ships a `flutter.live` file, the player can ask it four things and draw the answers itself:
///
///   list   every channel (id, name, group, has guide info)
///   now    what is on and what is next, for the rows on screen
///   guide  the schedule of one channel between two times
///   url    the stream of a channel the person switched to
///
/// The plugin only answers; the picture, the guide and the keys are PEK TV's. pek_flutter.py cleans every question and
/// checks every stream address again before it gets here.

/// Which plugin's channels these are and which channel is playing ('' = the plugin did not name one).
class LiveSource {
  const LiveSource(this.pluginId, this.channelId);
  final String pluginId;
  final String channelId;
}

class LiveChannel {
  const LiveChannel(this.id, this.name, this.group, this.hasGuide);
  final String id, name, group;
  final bool hasGuide;
}

/// One programme: [start] and [end] are seconds since 1970.
class LiveProgramme {
  const LiveProgramme(this.start, this.end, this.title, [this.desc = '']);
  final int start, end;
  final String title, desc;

  static LiveProgramme? from(dynamic v) {
    if (v is! List || v.length < 3) return null;
    final s = (v[0] as num?)?.toInt(), e = (v[1] as num?)?.toInt();
    if (s == null || e == null || e <= s) return null;
    return LiveProgramme(s, e, '${v[2]}', v.length > 3 ? '${v[3] ?? ''}' : '');
  }

  bool isOn(int now) => start <= now && now < end;
  double progress(int now) => end > start ? ((now - start) / (end - start)).clamp(0.0, 1.0).toDouble() : 0.0;
}

class LiveNow {
  const LiveNow(this.cur, this.next);
  final LiveProgramme? cur, next;
}

int liveNowSec() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

String liveClock(int sec) {
  final d = DateTime.fromMillisecondsSinceEpoch(sec * 1000);
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
}

String liveSpan(int sec) {
  final m = (sec / 60).round();
  if (m < 1) return 'under a minute';
  if (m < 60) return '$m min';
  final h = m ~/ 60, r = m % 60;
  return r == 0 ? '$h h' : '$h h $r min';
}

/// Talks to the plugin and keeps what it said. One per open player; a slow or broken plugin only leaves things empty.
class LiveTv extends ChangeNotifier {
  LiveTv(this.pluginId);
  final String pluginId;

  List<LiveChannel> channels = const [];
  final Map<String, int> index = {};
  final Map<String, LiveNow> now = {};
  final Map<String, List<LiveProgramme>> guide = {};
  bool available = false; // the plugin answered `list`: the guide can be offered
  bool hasGuideData = false;
  bool loading = true;
  bool refreshing = false;
  String error = '';

  Timer? _timer;
  bool _disposed = false;
  final Set<String> _asked = {};
  Timer? _debounce;
  final Set<String> _queue = {};

  Future<void> start() async {
    await _list();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => unawaited(_tick()));
  }

  Future<void> _list() async {
    final r = await PluginHost.live(pluginId, {'op': 'list'});
    if (_disposed) return;
    loading = false;
    final d = r['data'];
    if (r['ok'] != true || d is! Map) {
      available = false;
      error = '${r['error'] ?? ''}';
      notifyListeners();
      return;
    }
    final out = <LiveChannel>[];
    for (final c in (d['channels'] as List? ?? const [])) {
      if (c is List && c.length >= 4) out.add(LiveChannel('${c[0]}', '${c[1]}', '${c[2]}', c[3] == 1 || c[3] == true));
    }
    channels = out;
    index
      ..clear()
      ..addEntries([for (var i = 0; i < out.length; i++) MapEntry(out[i].id, i)]);
    hasGuideData = d['guide'] == true;
    refreshing = d['refreshing'] == true;
    available = out.isNotEmpty;
    notifyListeners();
  }

  /// Every 30 s: what is on moves forward; while the plugin is still reading its guide, ask for the channel list again.
  Future<void> _tick() async {
    if (_disposed) return;
    if (refreshing || !hasGuideData) {
      await _list();
      if (hasGuideData) {
        now.clear();
        _asked.clear();
      }
    }
    final ids = now.keys.toList();
    if (ids.isNotEmpty) {
      _asked.clear();
      await _askNow(ids);
    }
    notifyListeners(); // progress bars and "min left" move on
  }

  /// Asks what is on for these rows (only the ones not known yet), soon and in one go.
  void wantNow(Iterable<String> ids) {
    for (final id in ids) {
      if (!_asked.contains(id) && index.containsKey(id)) _queue.add(id);
    }
    if (_queue.isEmpty) return;
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 120), () {
      final batch = _queue.take(100).toList();
      _queue.removeAll(batch);
      unawaited(_askNow(batch));
    });
  }

  Future<void> _askNow(List<String> ids) async {
    _asked.addAll(ids);
    final r = await PluginHost.live(pluginId, {'op': 'now', 'ids': ids.take(200).toList()});
    if (_disposed) return;
    final d = r['data'];
    if (r['ok'] != true || d is! Map) return;
    for (final id in ids) {
      final v = d[id];
      if (v is List && v.length >= 2) now[id] = LiveNow(LiveProgramme.from(v[0]), LiveProgramme.from(v[1]));
    }
    notifyListeners();
  }

  /// The schedule of one channel for the next few hours (what the details pane lists).
  Future<void> loadGuide(String id) async {
    if (guide.containsKey(id)) return;
    guide[id] = const [];
    final from = liveNowSec() - 3600;
    final r = await PluginHost.live(pluginId, {'op': 'guide', 'ids': [id], 'from': from, 'to': from + 10 * 3600});
    if (_disposed) return;
    final d = r['data'];
    if (r['ok'] != true || d is! Map) {
      guide.remove(id);
      return;
    }
    guide[id] = [for (final p in (d[id] as List? ?? const [])) if (LiveProgramme.from(p) != null) LiveProgramme.from(p)!];
    notifyListeners();
  }

  /// The address of a channel, or null (the plugin did not know it, or its address was refused).
  Future<({String url, String title})?> url(String id) async {
    final r = await PluginHost.live(pluginId, {'op': 'url', 'id': id});
    final d = r['data'];
    if (r['ok'] != true || d is! Map || '${d['url']}'.isEmpty) return null;
    return (url: '${d['url']}', title: '${d['title'] ?? ''}');
  }

  String nameOf(String id) {
    final i = index[id];
    return i == null ? '' : channels[i].name;
  }

  String? neighbour(String id, int step) {
    if (channels.isEmpty) return null;
    final i = index[id];
    if (i == null) return channels.first.id;
    return channels[(i + step) % channels.length].id; // Dart's % is never negative here, so Up from the first channel wraps to the last
  }

  @override
  void dispose() {
    _disposed = true;
    _timer?.cancel();
    _debounce?.cancel();
    super.dispose();
  }
}

/// The video's rectangle while the guide is open: top left, 16:9, about a third of the width.
Rect liveVideoRect(Size screen) {
  final m = (screen.shortestSide * 0.03).clamp(12.0, 32.0).toDouble();
  final w = (screen.width * 0.36).clamp(160.0, screen.width * 0.6).toDouble();
  return Rect.fromLTWH(m, m, w, w * 9 / 16);
}

class _HoleClipper extends CustomClipper<Path> {
  const _HoleClipper(this.hole);
  final Rect hole;

  @override
  Path getClip(Size size) => Path()
    ..fillType = PathFillType.evenOdd
    ..addRect(Offset.zero & size)
    ..addRect(hole);

  @override
  bool shouldReclip(_HoleClipper old) => old.hole != hole;
}

/// The guide: the picture shrinks into the top left (the player moves it; this widget leaves that rectangle empty so it shows
/// through), the details of the highlighted channel sit beside it, and the channels go down below, each with what is on and what
/// follows. Up / Down move, OK watches, Left / Back close it. On a touch screen every row is a tap.
class LiveGuide extends StatefulWidget {
  const LiveGuide({super.key, required this.tv, required this.currentId, required this.onPick, required this.onClose});
  final LiveTv tv;
  final String currentId;
  final void Function(String id) onPick;
  final VoidCallback onClose;

  @override
  State<LiveGuide> createState() => _LiveGuideState();
}

class _LiveGuideState extends State<LiveGuide> {
  static const _rowH = 64.0;
  static const _bg = Color(0xFF0E0C0A);
  static const _fg = Color(0xFFF6F2EC);
  static const _muted = Color(0xFFB9B2A8);
  static const _accent = Color(0xFFF3EEE7);

  final ScrollController _scroll = ScrollController();
  final FocusNode _focus = FocusNode(debugLabel: 'live guide');
  late int _sel;
  Timer? _detail;

  LiveTv get tv => widget.tv;

  @override
  void initState() {
    super.initState();
    _sel = tv.index[widget.currentId] ?? 0;
    tv.addListener(_changed);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _focus.requestFocus();
      _reveal(jump: true);
      _wantRows();
      _wantDetail();
    });
  }

  @override
  void dispose() {
    tv.removeListener(_changed);
    _detail?.cancel();
    _scroll.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    setState(() {});
    _wantRows(); // after the plugin's guide arrived the rows ask again (rows already asked are skipped, so this never loops)
  }

  String get _selId => tv.channels.isEmpty ? '' : tv.channels[_sel.clamp(0, tv.channels.length - 1).toInt()].id;

  void _move(int by) {
    if (tv.channels.isEmpty) return;
    setState(() => _sel = (_sel + by).clamp(0, tv.channels.length - 1).toInt());
    _reveal();
    _wantRows();
    _wantDetail();
  }

  void _reveal({bool jump = false}) {
    if (!_scroll.hasClients) return;
    final view = _scroll.position.viewportDimension;
    final target = (_sel * _rowH - (view - _rowH) / 2).clamp(0.0, _scroll.position.maxScrollExtent).toDouble();
    if (jump) {
      _scroll.jumpTo(target);
    } else {
      _scroll.animateTo(target, duration: const Duration(milliseconds: 120), curve: Curves.easeOut);
    }
  }

  /// Rows around the highlighted one get their "now / next".
  void _wantRows() {
    final lo = (_sel - 8).clamp(0, tv.channels.length).toInt(), hi = (_sel + 14).clamp(0, tv.channels.length).toInt();
    tv.wantNow([for (var i = lo; i < hi; i++) tv.channels[i].id]);
  }

  /// The details pane follows the highlight, but only once it stays put for a moment (holding Down must not ask for every channel).
  void _wantDetail() {
    _detail?.cancel();
    _detail = Timer(const Duration(milliseconds: 250), () {
      if (mounted && _selId.isNotEmpty) unawaited(tv.loadGuide(_selId));
    });
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.arrowDown) {
      _move(1);
    } else if (k == LogicalKeyboardKey.arrowUp) {
      _move(-1);
    } else if (k == LogicalKeyboardKey.pageDown || k == LogicalKeyboardKey.channelDown || k == LogicalKeyboardKey.mediaTrackNext) {
      _move(8);
    } else if (k == LogicalKeyboardKey.pageUp || k == LogicalKeyboardKey.channelUp || k == LogicalKeyboardKey.mediaTrackPrevious) {
      _move(-8);
    } else if (k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.gameButtonA) {
      if (e is KeyDownEvent && _selId.isNotEmpty) widget.onPick(_selId);
    } else if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowRight || k == LogicalKeyboardKey.escape || k == LogicalKeyboardKey.goBack) {
      if (e is KeyDownEvent) widget.onClose();
    } else {
      return KeyEventResult.ignored;
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final video = liveVideoRect(size);
    final m = video.left;
    final listTop = video.bottom + m;
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: _onKey,
      child: Theme(
        data: ThemeData.dark(useMaterial3: true),
        child: DefaultTextStyle.merge(
          style: const TextStyle(color: _fg),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () {}, // taps in the guide are never the player's "pause"
            child: Stack(children: [
              Positioned.fill(child: ClipPath(clipper: _HoleClipper(video), child: const ColoredBox(color: _bg))),
              Positioned(left: video.right + m, top: m, right: m, height: video.height, child: _details()),
              Positioned(left: m, right: m, top: listTop, bottom: m, child: _list()),
            ]),
          ),
        ),
      ),
    );
  }

  Widget _details() {
    if (tv.channels.isEmpty) return const SizedBox.shrink();
    final id = _selId;
    final ch = tv.channels[tv.index[id] ?? 0];
    final n = liveNowSec();
    final sched = tv.guide[id] ?? const <LiveProgramme>[];
    final upcoming = [for (final p in sched) if (p.end > n) p];
    final cur = upcoming.isNotEmpty && upcoming.first.isOn(n) ? upcoming.first : null;
    final rest = cur == null ? upcoming : upcoming.skip(1).toList();
    final fallback = tv.now[id]?.cur;
    final shown = cur ?? fallback;
    return ClipRect(
      child: SingleChildScrollView(
        physics: const NeverScrollableScrollPhysics(),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(ch.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800, letterSpacing: 1.2, color: _muted)),
          const SizedBox(height: 4),
          if (shown == null)
            Text(ch.hasGuide ? 'Loading\u2026' : 'No guide information for this channel.', style: const TextStyle(fontSize: 18, color: _muted))
          else ...[
            Text(shown.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text('${liveClock(shown.start)} \u2013 ${liveClock(shown.end)}${shown.isOn(n) ? '  \u00b7  ${liveSpan(shown.end - n)} left' : ''}', style: const TextStyle(fontSize: 14, color: _muted)),
            if (shown.desc.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(shown.desc, maxLines: 3, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 14.5, height: 1.25)),
            ],
          ],
          if (rest.isNotEmpty) ...[
            const SizedBox(height: 8),
            for (final p in rest.take(2))
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text('${liveClock(p.start)}  ${p.title}${p.desc.isEmpty ? '' : ' \u2014 ${p.desc}'}', maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13.5, color: _muted)),
              ),
          ],
        ]),
      ),
    );
  }

  Widget _list() {
    if (tv.channels.isEmpty) return const SizedBox.shrink();
    return Container(
      decoration: BoxDecoration(color: const Color(0xFF16130F), borderRadius: BorderRadius.circular(12)),
      clipBehavior: Clip.antiAlias,
      child: ListView.builder(
        controller: _scroll,
        itemExtent: _rowH,
        itemCount: tv.channels.length,
        itemBuilder: (_, i) => _row(i),
      ),
    );
  }

  Widget _row(int i) {
    final ch = tv.channels[i];
    final selected = i == _sel;
    final playing = ch.id == widget.currentId;
    final n = liveNowSec();
    final info = tv.now[ch.id];
    final cur = info?.cur, next = info?.next;
    return InkWell(
      onTap: () {
        setState(() => _sel = i);
        _wantDetail();
        widget.onPick(ch.id);
      },
      child: Container(
        decoration: BoxDecoration(
          color: selected ? const Color(0xFF2A241D) : Colors.transparent,
          border: Border(left: BorderSide(color: selected ? _accent : Colors.transparent, width: 4), bottom: const BorderSide(color: Color(0x14F6F2EC))),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: Row(children: [
          SizedBox(
            width: 210,
            child: Row(children: [
              Icon(playing ? Icons.play_arrow : Icons.tv, size: 18, color: playing ? _accent : _muted),
              const SizedBox(width: 8),
              Expanded(child: Text(ch.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, fontWeight: selected ? FontWeight.w800 : FontWeight.w600))),
            ]),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 3,
            child: cur == null
                ? Text(info == null ? '' : 'No guide information', maxLines: 1, style: const TextStyle(fontSize: 13.5, color: _muted))
                : Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(cur.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                    const SizedBox(height: 4),
                    Row(children: [
                      Expanded(child: ClipRRect(borderRadius: BorderRadius.circular(2), child: LinearProgressIndicator(value: cur.progress(n), minHeight: 3, backgroundColor: const Color(0x29F6F2EC), color: _accent))),
                      const SizedBox(width: 8),
                      Text('${liveSpan(cur.end - n)} left', style: const TextStyle(fontSize: 12, color: _muted)),
                    ]),
                  ]),
          ),
          const SizedBox(width: 12),
          Expanded(
            flex: 2,
            child: next == null ? const SizedBox.shrink() : Text('${liveClock(next.start)}  ${next.title}', maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13.5, color: _muted)),
          ),
        ]),
      ),
    );
  }
}

/// The little tab on the right edge of the live picture: tap it (or press Right on the remote) to open the guide.
class LiveGuideTab extends StatelessWidget {
  const LiveGuideTab({super.key, required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xB31C1815),
      borderRadius: const BorderRadius.horizontal(left: Radius.circular(12)),
      child: InkWell(
        borderRadius: const BorderRadius.horizontal(left: Radius.circular(12)),
        onTap: onTap,
        child: const SizedBox(
          width: 26,
          height: 84,
          child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
            Icon(Icons.chevron_left, size: 22, color: Color(0xFFF6F2EC)),
            SizedBox(height: 2),
            RotatedBox(quarterTurns: 3, child: Text('GUIDE', style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w800, letterSpacing: 1.4, color: Color(0xFFF6F2EC)))),
          ]),
        ),
      ),
    );
  }
}
