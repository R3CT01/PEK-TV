import 'dart:async';

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'mpv.dart';
import 'store.dart';

/// Automatic subtitles: a port of www/subtitles.js (PekSubs). Subtitles come from the app's own backend
/// (/api/subtitles/search and /fetch), which asks one shared OpenSubtitles account kept in the cloud worker.
/// Nobody needs an account. Settings (language, automatic on / off) live in [Store].
///
/// Only things registered as a movie or a TV episode get a look-up: every search uses the shared quota, so
/// plugin streams, live TV and bare files never touch the service.
class Subs {
  static const languages = <(String, String)>[
    ('en', 'English'), ('es', 'Spanish'), ('fr', 'French'), ('de', 'German'), ('it', 'Italian'),
    ('pt-br', 'Portuguese (BR)'), ('pt-pt', 'Portuguese (PT)'), ('nl', 'Dutch'), ('ru', 'Russian'), ('ar', 'Arabic'),
    ('tr', 'Turkish'), ('pl', 'Polish'), ('ja', 'Japanese'), ('ko', 'Korean'), ('zh-cn', 'Chinese'),
  ];

  /// What the backend needs to find a subtitle: title (+ year for a movie, or season + episode for a show).
  static ({String title, int year, int season, int episode, String file})? identify(Progress? m, String file) {
    if (m == null) return null;
    if (m.kind == 'movie' && m.title.isNotEmpty) return (title: m.title, year: m.year, season: 0, episode: 0, file: file);
    if (m.kind == 'episode' && m.showTitle.isNotEmpty && m.season > 0 && m.episode > 0) {
      return (title: m.showTitle, year: 0, season: m.season, episode: m.episode, file: file);
    }
    return null;
  }

  static Future<List<SubResult>> search({required String title, int year = 0, int season = 0, int episode = 0, String file = ''}) async {
    final j = await Api.postForm('/api/subtitles/search', {
      'title': title,
      if (year > 0) 'year': '$year',
      if (season > 0) 'season': '$season',
      if (episode > 0) 'episode': '$episode',
      'lang': Store.subsLang,
      if (file.isNotEmpty) 'file': file,
    });
    final list = (j['results'] as List?) ?? const [];
    return list.whereType<Map>().map((e) => SubResult.fromJson(Map<String, dynamic>.from(e))).toList();
  }

  static Future<Map<String, dynamic>> download(String id) => Api.postForm('/api/subtitles/fetch', {'id': id});

  /// Settings > Subtitles > Test: a search for a well-known film proves the service answers.
  static Future<List<SubResult>> test() => search(title: 'The Matrix', year: 1999);
}

class SubResult {
  const SubResult({required this.id, required this.lang, required this.name, required this.score, required this.trusted, required this.hi, required this.ai, required this.downloads});
  final String id;
  final String lang;
  final String name;
  final num score;
  final bool trusted;
  final bool hi;
  final bool ai;
  final int downloads;

  factory SubResult.fromJson(Map<String, dynamic> j) => SubResult(
        id: '${j['id'] ?? ''}',
        lang: '${j['lang'] ?? ''}',
        name: '${j['name'] ?? j['title'] ?? 'Subtitle'}',
        score: (j['score'] as num?) ?? 0,
        trusted: j['trusted'] == true,
        hi: j['hi'] == true,
        ai: j['ai'] == true,
        downloads: (j['downloads'] as num?)?.toInt() ?? 0,
      );

  static String _count(int n) => n >= 1000000 ? '${(n / 1000000).toStringAsFixed(1)}M' : n >= 1000 ? '${(n / 1000).toStringAsFixed(1).replaceAll(RegExp(r'\.0$'), '')}k' : '$n';

  /// "Name  ·  EN · trusted · 12k downloads"
  String get label {
    var n = name.isEmpty ? 'Subtitle' : name;
    if (n.length > 46) n = '${n.substring(0, 45)}\u2026';
    final bits = [
      if (lang.isNotEmpty) lang.toUpperCase(),
      if (trusted) 'trusted',
      if (hi) 'HI',
      if (ai) 'auto-translated',
      if (downloads > 0) '${_count(downloads)} downloads',
    ];
    return bits.isEmpty ? n : '$n  \u00b7  ${bits.join(' \u00b7 ')}';
  }
}

enum SubsStatus { idle, searching, results, none, error }

/// One per playing video (Controller in subtitles.js). The player screen feeds it track changes and shows [toast]s.
class SubsController extends ChangeNotifier {
  SubsController({required this.player, required this.meta, required this.fileName, required this.toast});

  static const _autoDelay = Duration(milliseconds: 2500); // wait for the file's own subtitle tracks before deciding there are none
  static const _autoMinScore = 8; // the backend's ranking: below this the best match is too doubtful to switch on by itself
  static const menuResults = 12;

  final PekPlayer player;
  final Progress? meta;
  final String fileName;
  final void Function(String) toast;

  SubsStatus status = SubsStatus.idle;
  String error = '';
  List<SubResult> results = const [];
  SubResult? applied;

  bool _autoDone = false;
  bool _dead = false;
  int _gen = 0; // bumped when a new search starts, so a slow old one is ignored
  Timer? _timer;

  bool get available => Subs.identify(meta, fileName) != null;

  void _notify() {
    if (!_dead) notifyListeners();
  }

  @override
  void dispose() {
    _dead = true;
    _timer?.cancel();
    super.dispose();
  }

  /// The player tells us whenever the file's track list changes (and once when it opens, in case it never does).
  void onTracks() {
    if (_dead || _autoDone || !Store.subsAuto || !available) return;
    _timer?.cancel();
    _timer = Timer(_autoDelay, () {
      if (_dead || _autoDone) return;
      _autoDone = true;
      if (player.subtitles.value.isNotEmpty) return; // the file brings its own: leave it alone
      find(auto: true);
    });
  }

  /// auto = true: pick the best match and switch it on. auto = false: just fill the list for the menu.
  Future<void> find({required bool auto}) async {
    final q = Subs.identify(meta, fileName);
    if (_dead || q == null) return;
    final gen = ++_gen;
    status = SubsStatus.searching;
    error = '';
    _notify();
    if (auto) toast('Looking for subtitles\u2026');
    List<SubResult> list;
    try {
      list = await Subs.search(title: q.title, year: q.year, season: q.season, episode: q.episode, file: q.file);
    } catch (e) {
      if (gen != _gen || _dead) return;
      status = SubsStatus.error;
      error = e is ApiError ? e.message : 'Subtitle lookup failed.';
      _notify();
      if (auto) toast(error);
      return;
    }
    if (gen != _gen || _dead) return;
    results = list;
    if (list.isEmpty) {
      status = SubsStatus.none;
      _notify();
      if (auto) toast('No subtitles found for this one');
      return;
    }
    status = SubsStatus.results;
    _notify();
    if (!auto) return;
    if (list.first.score >= _autoMinScore) {
      await apply(list.first);
    } else {
      toast('Subtitles found. Pick one in the subtitle menu.');
    }
  }

  Future<void> apply(SubResult r) async {
    if (_dead) return;
    toast('Downloading subtitles\u2026');
    try {
      final f = await Subs.download(r.id);
      if (_dead) return;
      final url = Api.abs('${f['url'] ?? ''}');
      if (url.isEmpty) throw ApiError("Couldn't load those subtitles");
      await player.addSubtitle(url, r.label);
      applied = r;
      _notify();
      final n = r.name.length > 40 ? r.name.substring(0, 40) : r.name;
      toast('Subtitles on: ${r.lang.toUpperCase()}${n.isNotEmpty ? ' \u00b7 $n' : ''}');
    } catch (e) {
      toast(e is ApiError ? e.message : "Couldn't load those subtitles");
    }
  }

  /// Called when the menu opens: search if nothing has been searched yet.
  void openList() {
    if (available && (status == SubsStatus.idle || status == SubsStatus.error)) find(auto: false);
  }
}
