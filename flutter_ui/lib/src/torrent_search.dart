import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'activity.dart';

import 'api.dart';
import 'common.dart';
import 'fields.dart';
import 'store.dart';
import 'tokens.dart';
import 'torrent.dart';
import 'widgets.dart';

/// One release found by a search.
class TorrentResult {
  const TorrentResult({required this.title, required this.source, required this.size, required this.seeders, required this.quality, required this.pack});
  final String title;
  final String source; // magnet link (or an https .torrent link from Torznab)
  final int size;
  final int seeders;
  final int quality; // 480 / 720 / 1080 / 2160 or 0
  final bool pack; // a whole-season pack

  String get sizeText {
    if (size < 2) return 'size unknown';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    var v = size.toDouble();
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return '${i >= 3 ? v.toStringAsFixed(2) : v.round()} ${u[i]}';
  }

  String get subtitle => [
        if (quality > 0) '${quality == 2160 ? '4K' : '${quality}p'}',
        sizeText,
        '$seeders seeder${seeders == 1 ? '' : 's'}',
        if (pack) 'season pack',
      ].join(' \u00b7 ');
}

class _Raw {
  _Raw(this.title, this.source, this.seeders, this.size);
  final String title;
  final String source;
  final int seeders; // -1 = unknown
  final int size;
}

class _Query {
  const _Query(this.title, this.kind, this.year, this.season, this.episode);
  final String title;
  final String kind; // 'movie' | 'episode'
  final int year;
  final int season;
  final int episode;
}

/// Search over the sites you list. The sites are the ones you list (https address with {q}); their pages are
/// fetched by the existing backend route /api/torrent/fetch, so the backend is unchanged. A Torznab provider (Jackett / Prowlarr)
/// is asked directly. Results are filtered, scored and sorted best first.
class TorrentSearch {
  static const _kSites = 'pek_search_sites';
  static const _kTorznab = 'pek_torznab_url';
  static const _kTorznabKey = 'pek_torznab_key';
  static const _trackers = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.tracker.cl:1337/announce', 'udp://tracker.torrent.eu.org:451/announce'];
  static final http.Client _c = http.Client();

  // ---------------------------------------------------------------- settings (device-wide)

  static List<String> get sites {
    try {
      final o = jsonDecode(Store.strGet(_kSites, scoped: false) ?? '[]');
      return o is List ? o.map((e) => '$e').where((e) => e.isNotEmpty).toList() : <String>[];
    } catch (_) {
      return <String>[];
    }
  }

  static Future<void> setSites(List<String> l) => Store.strSet(_kSites, jsonEncode(l), scoped: false);
  static String get torznabUrl => Store.strGet(_kTorznab, scoped: false) ?? '';
  static String get torznabKey => Store.strGet(_kTorznabKey, scoped: false) ?? '';

  static Future<void> setTorznab(String url, String key) async {
    await Store.strSet(_kTorznab, url.trim(), scoped: false);
    await Store.strSet(_kTorznabKey, key.trim(), scoped: false);
  }

  static bool validSite(String s) => RegExp(r'^https://[^\s]+$').hasMatch(s) && s.contains('{q}');
  static bool get configured => sites.isNotEmpty || torznabUrl.isNotEmpty;

  // ---------------------------------------------------------------- text helpers

  static String normalize(String t) {
    var s = t.toLowerCase();
    const from = '\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f9\u00fa\u00fb\u00fc\u00fd\u00ff';
    const to = 'aaaaaaceeeeiiiinooooouuuuyy';
    for (var i = 0; i < from.length; i++) {
      s = s.replaceAll(from[i], to[i]);
    }
    return s.replaceAll('&', ' and ').replaceAll(RegExp('[\'\u2019`]'), '').replaceAll(RegExp(r'[^a-z0-9]+'), ' ').trim();
  }

  static String _pad2(int n) => n < 10 ? '0$n' : '$n';
  static int _num(Object? v) => int.tryParse('${v ?? ''}'.replaceAll(RegExp(r'[^\d]'), '')) ?? 0;

  static int qualityOf(String name) {
    final n = normalize(name);
    if (RegExp(r'\b(2160p|4k|uhd)\b').hasMatch(n)) return 2160;
    if (n.contains('1080p')) return 1080;
    if (n.contains('720p')) return 720;
    if (RegExp(r'\b(480p|dvdrip)\b').hasMatch(n)) return 480;
    return 0;
  }

  static int parseSize(String text) {
    final m = RegExp(r'(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB)\b', caseSensitive: false).firstMatch(text);
    if (m == null) return 0;
    final mult = {'k': 1024, 'm': 1048576, 'g': 1073741824, 't': 1099511627776}[m.group(2)![0].toLowerCase()]!;
    return ((double.tryParse(m.group(1)!.replaceAll(',', '.')) ?? 0) * mult).round();
  }

  static String _magnetFrom(String hash, String name) => 'magnet:?xt=urn:btih:$hash&dn=${Uri.encodeComponent(name)}${_trackers.map((t) => '&tr=${Uri.encodeComponent(t)}').join()}';

  static String _unescape(String s) => s.replaceAll('&amp;', '&').replaceAll('&#38;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
  static String _strip(String html) => _unescape(html.replaceAll(RegExp(r'<script[\s\S]*?</script>|<style[\s\S]*?</style>', caseSensitive: false), ' ').replaceAll(RegExp(r'<[^>]+>'), ' ')).replaceAll(RegExp(r'\s+'), ' ').trim();

  // ---------------------------------------------------------------- reading a site's answer

  static dynamic _pick(Map o, List<String> keys) {
    for (final k in keys) {
      if (o[k] != null && '${o[k]}'.isNotEmpty) return o[k];
    }
    return '';
  }

  static List<Map>? _findItems(dynamic node, int depth) {
    if (depth > 3 || node == null) return null;
    if (node is List) {
      if (node.isNotEmpty && node.every((x) => x is Map) && node.any((x) => '${_pick(x as Map, ['name', 'title', 'torrent_name', 'release'])}'.isNotEmpty)) return node.cast<Map>();
      return null;
    }
    if (node is Map) {
      for (final v in node.values) {
        final f = _findItems(v, depth + 1);
        if (f != null) return f;
      }
    }
    return null;
  }

  static List<_Raw> _fromJson(dynamic data) {
    final out = <_Raw>[];
    for (final o in _findItems(data, 0) ?? <Map>[]) {
      final title = '${_pick(o, ['name', 'title', 'torrent_name', 'release'])}';
      var magnet = '${_pick(o, ['magnet', 'magnet_link', 'magnetLink', 'magnet_uri', 'magnetUri'])}';
      final hash = '${_pick(o, ['info_hash', 'infohash', 'infoHash', 'hash', 'btih'])}';
      if (!RegExp(r'^magnet:\?', caseSensitive: false).hasMatch(magnet)) magnet = RegExp(r'^[0-9a-f]{40}$', caseSensitive: false).hasMatch(hash) ? _magnetFrom(hash, title) : '';
      if (title.isEmpty || magnet.isEmpty) continue;
      out.add(_Raw(title, magnet, _num(_pick(o, ['seeders', 'seeds', 'seed', 'se'])), _num(_pick(o, ['size', 'size_bytes', 'bytes', 'total_size']))));
    }
    return out;
  }

  static List<_Raw> _fromHtml(String text) {
    final lower = text.toLowerCase();
    final out = <_Raw>[];
    final seen = <String>{};
    for (final m in RegExp(r'''href\s*=\s*["'](magnet:\?[^"']+)["']''', caseSensitive: false).allMatches(text)) {
      final href = _unescape(m.group(1)!);
      final hm = RegExp(r'btih:([0-9a-z]{32,40})', caseSensitive: false).firstMatch(href);
      if (hm == null) continue;
      final key = hm.group(1)!.toLowerCase();
      if (!seen.add(key)) continue;

      // The row around the link: a table row, list item or article, else a window of the page.
      var start = -1, end = -1;
      for (final tag in const ['<tr', '<li', '<article']) {
        final s = lower.lastIndexOf(tag, m.start);
        if (s >= 0 && m.start - s < 6000) {
          final e = lower.indexOf('</${tag.substring(1)}', m.start);
          if (e > 0 && e - s < 12000) {
            start = s;
            end = e;
            break;
          }
        }
      }
      if (start < 0) {
        start = math.max(0, m.start - 800);
        end = math.min(text.length, m.end + 800);
      }
      final row = text.substring(start, end);

      var title = '';
      final dn = RegExp(r'[?&]dn=([^&]+)', caseSensitive: false).firstMatch(href);
      if (dn != null) {
        try {
          title = Uri.decodeComponent(dn.group(1)!.replaceAll('+', ' '));
        } catch (_) {
          title = dn.group(1)!;
        }
      }
      if (title.length < 6) {
        for (final a in RegExp(r'<a\b([^>]*)>([\s\S]*?)</a>', caseSensitive: false).allMatches(row)) {
          if (RegExp('href\\s*=\\s*["\']magnet:', caseSensitive: false).hasMatch(a.group(1)!)) continue;
          final t = _strip(a.group(2)!);
          if (t.length > title.length) title = t;
        }
      }
      if (title.isEmpty) continue;

      var seeders = -1;
      final se = RegExp(r'''class\s*=\s*["']([^"']*seed[^"']*)["'][^>]*>([\s\S]*?)<''', caseSensitive: false).allMatches(row).where((x) => !x.group(1)!.toLowerCase().contains('leech')).firstOrNull;
      if (se != null && RegExp(r'\d').hasMatch(se.group(2)!)) seeders = _num(_strip(se.group(2)!));
      if (seeders < 0) {
        final cells = RegExp(r'<td[^>]*>([\s\S]*?)</td>', caseSensitive: false).allMatches(row).map((x) => _strip(x.group(1)!)).where((t) => RegExp(r'^\d[\d,]*$').hasMatch(t)).toList();
        if (cells.length >= 2) seeders = _num(cells.first);
      }
      out.add(_Raw(title, href, seeders, parseSize(_strip(row))));
    }
    return out;
  }

  static List<_Raw> _parseBody(String text) {
    final t = text.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        return _fromJson(jsonDecode(t));
      } catch (_) {}
    }
    return _fromHtml(t);
  }

  // Torznab (Jackett / Prowlarr): XML with <item> entries.
  static List<_Raw> _fromTorznab(String xml) {
    final out = <_Raw>[];
    for (final it in RegExp(r'<item>([\s\S]*?)</item>', caseSensitive: false).allMatches(xml)) {
      final b = it.group(1)!;
      String tag(String n) => _unescape(RegExp('<$n[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</$n>', caseSensitive: false).firstMatch(b)?.group(1)?.trim() ?? '');
      String attr(String n) => RegExp('<(?:torznab:)?attr\\s+name="$n"\\s+value="([^"]*)"', caseSensitive: false).firstMatch(b)?.group(1) ?? '';
      final title = tag('title');
      var source = _unescape(attr('magneturl'));
      if (!source.toLowerCase().startsWith('magnet:?')) {
        final hash = attr('infohash');
        if (RegExp(r'^[0-9a-f]{40}$', caseSensitive: false).hasMatch(hash)) {
          source = _magnetFrom(hash, title);
        } else {
          final enc = RegExp(r'<enclosure[^>]*url="([^"]+)"', caseSensitive: false).firstMatch(b)?.group(1) ?? '';
          source = _unescape(enc.isNotEmpty ? enc : tag('link'));
        }
      }
      if (title.isEmpty || source.isEmpty) continue;
      final size = _num(attr('size')) > 0 ? _num(attr('size')) : _num(tag('size'));
      final seeders = attr('seeders').isEmpty ? -1 : _num(attr('seeders'));
      out.add(_Raw(title, source, seeders, size));
    }
    return out;
  }

  // ---------------------------------------------------------------- filtering + scoring

  static String? _episodeMatch(String name, int s, int e) {
    final n = name.toLowerCase();
    if (RegExp('s0*$s[ ._-]?e0*$e(?!\\d)').hasMatch(n) || RegExp('(?:^|\\D)${s}x0*$e(?!\\d)').hasMatch(n)) return 'episode';
    if (RegExp('s0*$s(?!\\d|e)').hasMatch(n) || RegExp('season[ ._-]*0*$s(?!\\d)').hasMatch(n)) return 'pack';
    return null;
  }

  /// (score, pack, quality), or null when the result is dropped.
  static ({double score, bool pack, int quality})? _rate(_Raw item, _Query q) {
    final norm = normalize(item.title);
    final padded = ' $norm ';
    if (item.seeders == 0) return null;
    for (final t in normalize(q.title).split(' ').where((e) => e.isNotEmpty)) {
      if (!padded.contains(' $t ')) return null;
    }
    double total = 0;
    var pack = false;
    if (q.kind == 'episode' && q.season > 0 && q.episode > 0) {
      final k = _episodeMatch(item.title, q.season, q.episode);
      if (k == null) return null;
      pack = k == 'pack';
      total += pack ? 15 : 60;
    } else if (q.year > 0) {
      if (RegExp('(?:^|\\D)${q.year}(?!\\d)').hasMatch(item.title)) {
        total += 25;
      } else if (RegExp(r'(?:^|\D)(19|20)\d\d(?!\d)').hasMatch(item.title)) {
        return null; // a different year = a different film
      }
    }
    final ql = qualityOf(item.title);
    total += ql == 1080 ? 15 : ql == 2160 ? 12 : ql == 720 ? 8 : ql == 480 ? 2 : 0;
    if (RegExp(r'\b(cam|camrip|hdcam|ts|hdts|telesync|tc)\b').hasMatch(norm)) return null;
    if (item.seeders > 0) total += math.min(math.log(item.seeders + 1) / math.ln10 * 20, 60);
    return (score: total, pack: pack, quality: ql);
  }

  static String _words(_Query q) {
    var w = normalize(q.title);
    if (q.kind == 'episode' && q.season > 0 && q.episode > 0) {
      w += ' S${_pad2(q.season)}E${_pad2(q.episode)}';
    } else if (q.year > 0) {
      w += ' ${q.year}';
    }
    return w;
  }

  /// "dune 2021", "some show s02e05" or just "some title".
  static _Query _parseQuery(String text) {
    final t = text.trim();
    final ep = RegExp(r'^(.*?)[\s._\-]*S(\d{1,2})[\s._\-]?E(\d{1,3})\b', caseSensitive: false).firstMatch(t);
    if (ep != null && ep.group(1)!.trim().isNotEmpty) return _Query(ep.group(1)!.trim(), 'episode', 0, int.parse(ep.group(2)!), int.parse(ep.group(3)!));
    final y = RegExp(r'^(.*?)[\s(]+((?:19|20)\d\d)\)?$').firstMatch(t);
    if (y != null && y.group(1)!.trim().isNotEmpty) return _Query(y.group(1)!.trim(), 'movie', int.parse(y.group(2)!), 0, 0);
    return _Query(t, 'movie', 0, 0, 0);
  }

  // ---------------------------------------------------------------- searching

  static Future<List<_Raw>> _searchSite(String site, String words) async {
    final target = site.replaceAll('{q}', Uri.encodeComponent(words));
    final r = await _c.get(Uri.parse('${Api.base}/api/torrent/fetch?url=${Uri.encodeQueryComponent(target)}')).timeout(const Duration(seconds: 25));
    if (r.statusCode != 200) {
      var m = 'Request failed (${r.statusCode})';
      try {
        m = '${(jsonDecode(utf8.decode(r.bodyBytes)) as Map)['error'] ?? m}';
      } catch (_) {}
      throw ApiError(m);
    }
    return _parseBody(utf8.decode(r.bodyBytes, allowMalformed: true));
  }

  static Future<List<_Raw>> _searchTorznab(String words) async {
    var url = torznabUrl;
    final key = torznabKey;
    final sep = url.contains('?') ? '&' : '?';
    url = '$url${sep}t=search&q=${Uri.encodeQueryComponent(words)}${key.isNotEmpty && !url.contains('apikey=') ? '&apikey=${Uri.encodeQueryComponent(key)}' : ''}';
    final r = await _c.get(Uri.parse(url)).timeout(const Duration(seconds: 25));
    if (r.statusCode != 200) throw ApiError('The Torznab provider answered HTTP ${r.statusCode}.');
    return _fromTorznab(utf8.decode(r.bodyBytes, allowMalformed: true));
  }

  /// Best first. [errors] lists the sites that failed.
  static Future<({List<TorrentResult> results, List<String> errors})> search(String text) {
    final name = text.length > 40 ? text.substring(0, 40) : text;
    return Activity.track(
      'search',
      'Searching releases${name.isEmpty ? '' : ': $name'}\u2026',
      () => _searchInner(text),
      result: (r) => r.results.isEmpty ? 'No releases found' : '${r.results.length} releases found',
      failText: 'Release search failed',
    );
  }

  static Future<({List<TorrentResult> results, List<String> errors})> _searchInner(String text) async {
    final q = _parseQuery(text);
    final words = _words(q);
    final jobs = <Future<List<_Raw>>>[for (final s in sites) _searchSite(s, words), if (torznabUrl.isNotEmpty) _searchTorznab(words)];
    final items = <_Raw>[];
    final errors = <String>[];
    final settled = await Future.wait(jobs.map((j) => j.then((v) => (v, null as Object?), onError: (Object e) => (<_Raw>[], e))));
    for (final s in settled) {
      if (s.$2 == null) {
        items.addAll(s.$1);
      } else {
        errors.add(s.$2 is ApiError ? (s.$2 as ApiError).message : 'A site did not answer.');
      }
    }
    final seen = <String>{};
    final scored = <(TorrentResult, double)>[];
    for (final it in items) {
      final r = _rate(it, q);
      if (r == null) continue;
      final key = (RegExp(r'btih:([0-9a-z]+)', caseSensitive: false).firstMatch(it.source)?.group(1) ?? it.source).toLowerCase();
      if (!seen.add(key)) continue;
      scored.add((TorrentResult(title: it.title, source: it.source, size: it.size, seeders: math.max(0, it.seeders), quality: r.quality, pack: r.pack), r.score));
    }
    scored.sort((a, b) => b.$2.compareTo(a.$2));
    return (results: scored.take(25).map((e) => e.$1).toList(), errors: errors);
  }
}

// ====================================================================== the Torrents page sections

class TorrentSearchSections extends StatefulWidget {
  const TorrentSearchSections({super.key});
  @override
  State<TorrentSearchSections> createState() => _TorrentSearchSectionsState();
}

class _TorrentSearchSectionsState extends State<TorrentSearchSections> {
  final _q = TextEditingController();
  final _site = TextEditingController();
  late final TextEditingController _tzUrl = TextEditingController(text: TorrentSearch.torznabUrl);
  late final TextEditingController _tzKey = TextEditingController(text: TorrentSearch.torznabKey);
  bool _busy = false;
  String _note = '';
  String _siteNote = '';
  List<TorrentResult> _results = const [];

  @override
  void dispose() {
    _q.dispose();
    _site.dispose();
    _tzUrl.dispose();
    _tzKey.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    final text = _q.text.trim();
    if (text.isEmpty || _busy) return;
    if (!TorrentSearch.configured) {
      setState(() => _note = 'Add a search site or a Torznab provider below first.');
      return;
    }
    setState(() {
      _busy = true;
      _note = 'Searching\u2026';
      _results = const [];
    });
    try {
      final r = await TorrentSearch.search(text);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _results = r.results;
        _note = r.results.isEmpty
            ? (r.errors.isNotEmpty ? r.errors.first : 'Nothing found. Try fewer words, or the title with its year (or S01E02 for an episode).')
            : (r.errors.isEmpty ? '' : '${r.errors.length} site(s) did not answer.');
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _note = 'The search failed.';
        });
      }
    }
  }

  void _addSite() {
    final s = _site.text.trim();
    if (!TorrentSearch.validSite(s)) {
      setState(() => _siteNote = 'The address must start with https:// and contain {q} where the search word goes.');
      return;
    }
    final l = TorrentSearch.sites;
    if (!l.contains(s)) l.add(s);
    TorrentSearch.setSites(l);
    setState(() {
      _site.clear();
      _siteNote = 'Added.';
    });
  }

  void _removeSite(String s) {
    TorrentSearch.setSites(TorrentSearch.sites.where((e) => e != s).toList());
    setState(() => _siteNote = 'Removed.');
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Section(
        title: 'Search',
        hint: 'Search the sites you added below. Type a title, a title and year ("dune 2021"), or an episode ("some show s02e05").',
        children: [
          PekField(label: 'Title', controller: _q, onSubmitted: _go),
          Align(alignment: Alignment.centerLeft, child: PekButton(label: _busy ? 'Searching\u2026' : 'Search', primary: true, onTap: _busy ? null : _go)),
          if (_note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.6 * rem), child: Text(_note, style: TextStyle(color: t.textMuted))),
          SizedBox(height: 0.6 * rem),
          for (final r in _results)
            ListRow(
              title: r.title,
              subtitle: r.subtitle,
              onTap: () => playTorrent(context, track: TorrentTitle.parse(r.title).track(r.source)),
            ),
        ],
      ),
      Section(
        title: 'Search sites',
        hint: 'Open a torrent site in a browser, search for anything, then copy the address and replace your search word with {q}, for example https://example.org/search?q={q}. Only add sites you are allowed to use.',
        children: [
          for (final s in TorrentSearch.sites) ListRow(title: s, subtitle: 'Select to remove', onTap: () => _removeSite(s)),
          PekField(label: 'Site address', controller: _site, hint: 'https://example.org/search?q={q}', onSubmitted: _addSite),
          Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Add site', onTap: _addSite)),
          if (_siteNote.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.6 * rem), child: Text(_siteNote, style: TextStyle(color: t.textMuted))),
        ],
      ),
      Section(
        title: 'Torznab provider (optional)',
        hint: 'Jackett or Prowlarr on your network. Paste its Torznab address (for example http://192.168.1.10:9117/api/v2.0/indexers/all/results/torznab/api) and its API key. Results are merged with the sites above.',
        children: [
          PekField(label: 'Torznab address', controller: _tzUrl),
          PekField(label: 'API key', controller: _tzKey, obscure: true),
          Align(
            alignment: Alignment.centerLeft,
            child: PekButton(
              label: 'Save provider',
              onTap: () async {
                await TorrentSearch.setTorznab(_tzUrl.text, _tzKey.text);
                if (mounted) setState(() => _siteNote = _tzUrl.text.trim().isEmpty ? 'Provider removed.' : 'Provider saved.');
              },
            ),
          ),
        ],
      ),
    ]);
  }
}
