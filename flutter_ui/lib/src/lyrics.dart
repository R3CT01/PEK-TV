import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollDirection;

import 'api.dart';
import 'tokens.dart';

class LyricLine {
  const LyricLine(this.t, this.s);
  final double t;
  final String s;
}

/// "[01:23.45] words" lines, in time order (parseLrc in music_player.js).
List<LyricLine> parseLrc(String text) {
  final out = <LyricLine>[];
  final tag = RegExp(r'\[(\d+):(\d+(?:[.:]\d+)?)\]');
  for (final raw in text.split(RegExp(r'\r?\n'))) {
    final times = <double>[];
    var last = 0;
    for (final m in tag.allMatches(raw)) {
      times.add(int.parse(m.group(1)!) * 60 + (double.tryParse(m.group(2)!.replaceAll(':', '.')) ?? 0));
      last = m.end;
    }
    if (times.isEmpty) continue; // [ar:..] [ti:..] and other tags
    final words = raw.substring(last).replaceAll(RegExp(r'<\d+:\d+(?:[.:]\d+)?>'), '').trim();
    for (final t in times) {
      out.add(LyricLine(t, words));
    }
  }
  out.sort((a, b) => a.t.compareTo(b.t));
  return out;
}

class _Lyrics {
  const _Lyrics({this.lines, this.plain = '', this.failed = false});
  final List<LyricLine>? lines;
  final String plain;
  final bool failed;
  bool get none => lines == null && plain.isEmpty;
}

/// Synced lyrics light up line by line and scroll to keep the current line in the middle; tapping a line jumps there.
/// Songs with only plain lyrics show the text. Answers are kept in memory for the session (the backend keeps them on disk).
class LyricsPanel extends StatefulWidget {
  const LyricsPanel({super.key, required this.trackId, required this.position, required this.onSeek});
  final String trackId;
  final ValueNotifier<double> position;
  final void Function(double sec) onSeek;

  @override
  State<LyricsPanel> createState() => _LyricsPanelState();
}

class _LyricsPanelState extends State<LyricsPanel> {
  static final Map<String, _Lyrics> _cache = {};

  final ScrollController _scroll = ScrollController();
  _Lyrics? _res;
  int _active = -1;
  DateTime _manualUntil = DateTime.fromMillisecondsSinceEpoch(0);
  String _loadedFor = '';

  @override
  void initState() {
    super.initState();
    widget.position.addListener(_tick);
    _load();
  }

  @override
  void didUpdateWidget(LyricsPanel old) {
    super.didUpdateWidget(old);
    if (old.position != widget.position) {
      old.position.removeListener(_tick);
      widget.position.addListener(_tick);
    }
    if (old.trackId != widget.trackId) _load();
  }

  @override
  void dispose() {
    widget.position.removeListener(_tick);
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final id = widget.trackId;
    _loadedFor = id;
    final hit = _cache[id];
    if (hit != null) {
      setState(() {
        _res = hit;
        _active = -1;
      });
      return;
    }
    setState(() {
      _res = null;
      _active = -1;
    });
    final d = await Api.lyrics(id);
    if (!mounted || _loadedFor != id) return;
    _Lyrics r;
    if (d == null) {
      r = const _Lyrics(); // none (a network error is not remembered, but 404 and errors look alike here)
    } else {
      final lines = d.synced.isNotEmpty ? parseLrc(d.synced) : null;
      r = lines != null && lines.isNotEmpty ? _Lyrics(lines: lines, plain: d.plain) : _Lyrics(plain: d.plain);
      _cache[id] = r;
    }
    setState(() => _res = r);
  }

  double _lineH(BuildContext context) => 2.6 * context.pek.rem;

  void _tick() {
    final lines = _res?.lines;
    if (!mounted || lines == null) return;
    final pos = widget.position.value;
    var lo = 0, hi = lines.length - 1, a = -1;
    while (lo <= hi) {
      final mid = (lo + hi) >> 1;
      if (lines[mid].t <= pos) {
        a = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (a == _active) return;
    setState(() => _active = a);
    if (a >= 0 && DateTime.now().isAfter(_manualUntil) && _scroll.hasClients) {
      final h = _lineH(context);
      final target = (a * h - _scroll.position.viewportDimension / 2 + h / 2).clamp(0.0, _scroll.position.maxScrollExtent).toDouble();
      _scroll.animateTo(target, duration: const Duration(milliseconds: 350), curve: Curves.easeOut);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final r = _res;
    Widget msg(String s) => Center(child: Text(s, textAlign: TextAlign.center, style: TextStyle(color: t.textMuted)));
    if (r == null) return msg('Loading lyrics\u2026');
    if (r.none) return msg(r.failed ? 'Couldn\u2019t load lyrics.' : 'No lyrics found for this song.');
    final lines = r.lines;
    if (lines == null) {
      return SingleChildScrollView(padding: EdgeInsets.all(0.5 * rem), child: Text(r.plain, textAlign: TextAlign.center, style: TextStyle(color: t.text.withAlpha(220), height: 1.5)));
    }
    final h = _lineH(context);
    return NotificationListener<UserScrollNotification>(
      onNotification: (n) {
        if (n.direction != ScrollDirection.idle) _manualUntil = DateTime.now().add(const Duration(seconds: 4));
        return false;
      },
      child: ListView.builder(
        controller: _scroll,
        itemExtent: h,
        itemCount: lines.length,
        itemBuilder: (_, i) {
          final ln = lines[i];
          final on = i == _active;
          return InkWell(
            onTap: () {
              _manualUntil = DateTime.fromMillisecondsSinceEpoch(0);
              widget.onSeek(ln.t < 0 ? 0 : ln.t);
            },
            child: Center(
              child: Text(
                ln.s.isEmpty ? '\u266A' : ln.s,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
                style: TextStyle(
                  fontSize: on ? 1.15 * rem : rem,
                  fontWeight: on ? FontWeight.w800 : FontWeight.w500,
                  color: on ? t.text : (i < _active ? t.textMuted.withAlpha(140) : t.textMuted),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
