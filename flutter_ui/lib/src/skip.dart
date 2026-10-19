import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'mpv.dart';
import 'store.dart';

/// A stretch of the video that can be skipped: an intro or a recap.
class SkipSpan {
  const SkipSpan(this.id, this.kind, this.start, this.end, this.src);
  final String id;
  final String kind; // 'intro' | 'recap'
  final double start;
  final double end;
  final String src; // 'chapter' | 'remote'

  String get label => kind == 'recap' ? 'Skip Recap' : 'Skip Intro';
}

/// Skip Intro / Skip Recap, fully automatic (www/skip_segments.js). Nobody marks anything. The spans come from
///   1. chapters inside the file called "Intro", "Opening", "Recap", "Previously on ...", then
///   2. times from a community database, looked up for episodes of a show (/api/skip-segments, can be turned off).
/// Auto-skip ([Store.skipAuto]) acts on either.
class SkipController extends ChangeNotifier {
  SkipController({required this.player, required this.meta});

  final PekPlayer player;
  final Progress? meta;

  static const _chapterLead = 1.5;
  static const _endMargin = 2.0; // no button in the last 2 s of a span
  static final _reRecap = RegExp(r'\b(re-?cap|previously(\s+on)?|last\s+time|story\s+so\s+far)\b', caseSensitive: false);
  static final _reIntro = RegExp(r'\b(intro|opening(\s+(credits|theme|titles?|sequence))?|op\s?\d*|title\s+sequence|main\s+titles?)\b', caseSensitive: false);

  List<SkipSpan> spans = const []; // from chapters
  List<SkipSpan> remote = const []; // from the database
  SkipSpan? cur; // the span the button offers right now
  final Set<String> _autoDone = {};
  bool _remoteTried = false;
  bool _dead = false;

  @override
  void dispose() {
    _dead = true;
    super.dispose();
  }

  void _notify() {
    if (!_dead) notifyListeners();
  }

  // ---------------- chapters -> spans ----------------

  void setChapters(List<Chapter> list, double duration) {
    final out = <SkipSpan>[];
    for (var i = 0; i < list.length; i++) {
      final c = list[i];
      if (c.title.isEmpty) continue;
      final end = i + 1 < list.length ? list[i + 1].time : (duration > 0 ? duration : 0.0);
      final len = end - c.time;
      if (!(len >= 8 && len <= 400)) continue; // too short / too long to be an intro or recap
      String kind = '';
      if (_reRecap.hasMatch(c.title)) {
        kind = 'recap';
      } else if (_reIntro.hasMatch(c.title) && len <= 300) {
        kind = 'intro';
      }
      if (kind.isNotEmpty) out.add(SkipSpan('c$i', kind, c.time, end, 'chapter'));
    }
    spans = out;
    _autoDone.clear();
    _notify();
  }

  // ---------------- the online database ----------------

  Future<void> fetchRemote() async {
    final m = meta;
    if (_remoteTried || m == null || !Store.skipOnline) return;
    if (m.kind != 'episode' || m.showTitle.isEmpty || m.episode <= 0) return;
    _remoteTried = true;
    const delays = [0, 8, 25, 60]; // seconds: the server may still be looking the show up
    for (var n = 0; n < delays.length; n++) {
      if (n > 0) await Future<void>.delayed(Duration(seconds: delays[n]));
      if (_dead || !Store.skipOnline) return;
      try {
        final j = await Api.skipSegments(m.showTitle, m.season, m.episode);
        if (j['found'] == true && j['data'] != null) {
          final r = _remoteSpans(j['data'], player.duration.value);
          if (r.isNotEmpty) {
            remote = r;
            _notify();
          }
          return; // answered (with or without usable times): no need to ask again
        }
      } catch (_) {}
    }
  }

  static double _num(dynamic v) {
    if (v is num) return v.isFinite ? v.toDouble() : double.nan;
    if (v is! String || v.isEmpty) return double.nan;
    final parts = v.trim().split(':'); // "mm:ss" / "hh:mm:ss" / "12.5"
    if (parts.length > 3) return double.nan;
    var t = 0.0;
    for (final p in parts) {
      final x = double.tryParse(p);
      if (p.isEmpty || x == null) return double.nan;
      t = t * 60 + x;
    }
    return t;
  }

  static double _pick(Map o, List<String> names, bool ms) {
    for (final n in names) {
      if (o[n] != null) {
        final x = _num(o[n]);
        if (!x.isNaN) return ms ? x / 1000 : x;
      }
    }
    return double.nan;
  }

  /// The exact shape of the database answer is not relied on: walk it and take every object that has a type
  /// ("intro" / "recap") and a start and end time, in seconds or milliseconds.
  static List<SkipSpan> _remoteSpans(dynamic data, double duration) {
    final out = <SkipSpan>[];
    final seen = <String>{};

    String kindOf(dynamic t) {
      final s = '$t'.toLowerCase();
      if (RegExp(r'recap|previously').hasMatch(s)) return 'recap';
      if (RegExp(r'intro|opening').hasMatch(s)) return 'intro';
      return '';
    }

    void add(String kind, dynamic o) {
      if (o is! Map) return;
      var a = _pick(o, const ['start_sec', 'startSec', 'start_seconds', 'start', 'from', 'start_time', 'startTime'], false);
      var b = _pick(o, const ['end_sec', 'endSec', 'end_seconds', 'end', 'to', 'end_time', 'endTime'], false);
      if (a.isNaN) a = _pick(o, const ['start_ms', 'startMs', 'start_time_ms'], true);
      if (b.isNaN) b = _pick(o, const ['end_ms', 'endMs', 'end_time_ms'], true);
      if (a.isNaN || b.isNaN) return;
      if (b - a > 600 && (b - a) / 1000 >= 5 && (b - a) / 1000 <= 600) {
        a /= 1000; // it was milliseconds
        b /= 1000;
      }
      if (!(b - a >= 5 && b - a <= 600) || a < 0) return; // not a plausible intro / recap
      if (duration > 0 && a >= duration - 5) return;
      if (seen.contains(kind)) return; // first (best-ranked) one per kind
      seen.add(kind);
      out.add(SkipSpan('r$kind', kind, a, duration > 0 ? math.min(b, duration) : b, 'remote'));
    }

    void walk(dynamic v, int depth) {
      if (v == null || depth > 5) return;
      if (v is List) {
        for (final x in v) {
          walk(x, depth + 1);
        }
        return;
      }
      if (v is! Map) return;
      final t = kindOf(v['segment_type'] ?? v['segmentType'] ?? v['type'] ?? v['kind'] ?? v['label'] ?? '');
      if (t.isNotEmpty) add(t, v);
      v.forEach((k, val) {
        final kk = kindOf(k);
        if (kk.isNotEmpty && val is Map) add(kk, val);
        if (kk.isNotEmpty && val is List) {
          for (final x in val) {
            add(kk, x);
          }
        }
        if (val is Map || val is List) walk(val, depth + 1);
      });
    }

    walk(data, 0);
    return out;
  }

  // ---------------- while playing ----------------

  SkipSpan? _find(double pos) {
    for (final s in [...spans, ...remote]) {
      if (pos >= s.start - _chapterLead && pos < s.end - _endMargin) return s; // chapters first, then the database
    }
    return null;
  }

  /// Called as the playback position moves.
  void tick(double pos) {
    if (_dead) return;
    final seg = _find(pos);
    if (seg?.id != cur?.id) {
      cur = seg;
      _notify();
    }
    if (seg != null && Store.skipAuto && !_autoDone.contains(seg.id) && pos >= seg.start - 0.3) {
      skip();
    }
  }

  void skip() {
    final c = cur;
    if (c == null) return;
    _autoDone.add(c.id);
    player.seek(c.end);
  }
}
