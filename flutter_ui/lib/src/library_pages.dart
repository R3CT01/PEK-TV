import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'detail.dart';
import 'fields.dart';
import 'pages.dart' show ResumeThumb;
import 'plugin_ui.dart' show PluginFavoritesSection;
import 'ratings.dart';
import 'ratings_export.dart';
import 'store.dart';
import 'suggest.dart';
import 'tokens.dart';
import 'watched.dart';
import 'widgets.dart';

// ====================================================================== Search (the web UI's search bar)

final Map<String, String> _foldMap = () {
  final m = <String, String>{};
  void add(String chars, String to) {
    for (final r in chars.runes) {
      m[String.fromCharCode(r)] = to;
    }
  }

  add('àáâãäåāăą', 'a');
  add('çćč', 'c');
  add('ďđ', 'd');
  add('èéêëēėęě', 'e');
  add('ğ', 'g');
  add('ìíîïīįı', 'i');
  add('ł', 'l');
  add('ñńň', 'n');
  add('òóôõöøōő', 'o');
  add('ŕř', 'r');
  add('śšşș', 's');
  add('ťţ', 't');
  add('ùúûüūůűų', 'u');
  add('ýÿ', 'y');
  add('źżž', 'z');
  return m;
}();

/// Capitals and accents ignored, like the server, so "amelie" finds "Amélie".
String foldText(String t) {
  final sb = StringBuffer();
  for (final r in t.toLowerCase().runes) {
    final c = String.fromCharCode(r);
    sb.write(_foldMap[c] ?? c);
  }
  return sb.toString().replaceAll(RegExp(r'[^a-z0-9\u0080-\uffff]+'), ' ').trim();
}

class _LibData {
  _LibData(this.movies, this.shows) : at = DateTime.now();
  final List<Movie> movies;
  final List<Show> shows;
  final DateTime at;
}

class _EpHit {
  const _EpHit(this.show, this.episode);
  final Show show;
  final Episode episode;
}

class SearchPage extends StatefulWidget {
  const SearchPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<SearchPage> createState() => _SearchPageState();
}

class _SearchPageState extends State<SearchPage> {
  static _LibData? _cache; // two minutes, like the web UI

  final _q = TextEditingController();
  Timer? _debounce;
  Timer? _sugTimer;
  int _seq = 0;

  String _genre = '';
  int _decade = 0;
  int _year = 0; // one exact year (wins over the decade)
  String _actor = '';
  String _director = '';
  String _pick = ''; // '' | 'genre' | 'decade' (decades and single years) | 'actor' | 'director'

  bool _loading = false;
  String _message = 'Type a title, an actor, a genre or a year \u2014 or use the buttons above.';
  List<Movie> _movies = const [];
  List<Show> _shows = const [];
  List<_EpHit> _eps = const [];
  Facets? _facets;
  bool _facetsFailed = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _sugTimer?.cancel();
    _q.dispose();
    super.dispose();
  }

  bool get _filtering => _genre.isNotEmpty || _decade > 0 || _year > 0 || _actor.isNotEmpty || _director.isNotEmpty;

  /// The pickers with a name list: typing in the search box narrows them.
  bool get _namePick => _pick == 'actor' || _pick == 'director';

  Future<_LibData> _data() async {
    final c = _cache;
    if (c != null && DateTime.now().difference(c.at) < const Duration(minutes: 2)) return c;
    final r = await Future.wait([Api.movies(), Api.shows()]);
    return _cache = _LibData(r[0] as List<Movie>, r[1] as List<Show>);
  }

  /// Typing in the box: the drop-down under it is worked out from the library list (kept for two minutes), which is fetched
  /// the first time anyone types. The results below the box still only change when the person presses Search.
  void _typed(String v) {
    setState(() {});
    _sugTimer?.cancel();
    _sugTimer = Timer(const Duration(milliseconds: 150), () async {
      try {
        await _data();
      } catch (_) {
        return;
      }
      if (mounted) setState(() {});
    });
  }

  final Map<String, Future<String>> _thumbs = {}; // one poster look-up per title, so the list does not blink while typing

  Future<String> _thumb(String key, Future<Details> Function() load) => _thumbs.putIfAbsent(key, () => load().then((x) => x.poster).catchError((_) => ''));

  /// Up to six titles from the library that match what is typed (starts-with first), each with its poster at the side.
  List<SuggestItem> _suggestions() {
    final d = _cache;
    if (d == null || _pick.isNotEmpty) return const [];
    final q = foldText(_q.text.trim());
    final words = q.split(' ').where((w) => w.isNotEmpty).toList();
    if (words.isEmpty) return const [];
    int rank(String f) => f.startsWith(q) ? 0 : (f.split(' ').any((w) => w.startsWith(words.first)) ? 1 : 2);
    final hits = <(int, String, Object)>[];
    for (final m in d.movies) {
      final f = foldText(m.title);
      if (words.every(f.contains)) hits.add((rank(f), f, m));
    }
    for (final sh in d.shows) {
      final f = foldText(sh.title);
      if (words.every(f.contains)) hits.add((rank(f), f, sh));
    }
    hits.sort((a, b) => a.$1 != b.$1 ? a.$1.compareTo(b.$1) : a.$2.compareTo(b.$2));
    final out = <SuggestItem>[];
    for (final h in hits.take(6)) {
      final it = h.$3;
      if (it is Movie) {
        out.add(SuggestItem(
          title: it.title,
          sub: it.year > 0 ? '${it.year} \u00b7 Movie' : 'Movie',
          imageLater: _thumb('m:${it.id}', () => Api.movieDetails(it.id)),
          onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: it))),
        ));
      } else if (it is Show) {
        out.add(SuggestItem(
          title: it.title,
          sub: 'TV show',
          imageLater: _thumb('s:${it.title}', () => Api.showDetails(it.title)),
          onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: it))),
        ));
      }
    }
    return out;
  }

  void _onChanged(String v) {
    if (_pick.isNotEmpty && !_namePick) _pick = ''; // typing leaves the genre / year list
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), _run);
    setState(() {});
  }

  Future<void> _openPicker(String what) async {
    if (_pick == what) {
      setState(() => _pick = '');
      _run();
      return;
    }
    setState(() {
      _pick = what;
      _facets = null;
      _facetsFailed = false;
    });
    await _loadFacets();
  }

  Future<void> _loadFacets() async {
    final seq = ++_seq;
    final f = await Api.libraryFacets(_namePick ? _q.text.trim() : '');
    if (!mounted || seq != _seq) return;
    setState(() {
      _facets = f;
      _facetsFailed = f == null;
    });
  }

  void _choose({String? genre, int? decade, int? year, String? actor, String? director}) {
    setState(() {
      if (genre != null) _genre = genre;
      if (decade != null) {
        _decade = decade;
        _year = 0; // a decade and one year replace each other
      }
      if (year != null) {
        _year = year;
        _decade = 0;
      }
      if (actor != null) _actor = actor;
      if (director != null) _director = director;
      _pick = '';
      _q.clear();
    });
    _run();
  }

  void _off(String what) {
    setState(() {
      if (what == 'genre') _genre = '';
      if (what == 'decade') {
        _decade = 0;
        _year = 0;
      }
      if (what == 'actor') _actor = '';
      if (what == 'director') _director = '';
    });
    _run();
  }

  Future<void> _run() async {
    if (_pick.isNotEmpty) {
      if (_namePick) await _loadFacets();
      return;
    }
    final seq = ++_seq;
    final q = _q.text.trim();
    final words = foldText(q).split(' ').where((w) => w.isNotEmpty).toList();
    if (words.isEmpty && !_filtering) {
      setState(() {
        _loading = false;
        _movies = const [];
        _shows = const [];
        _eps = const [];
        _message = 'Type a title, an actor, a genre or a year \u2014 or use the buttons above.';
      });
      return;
    }
    setState(() => _loading = true);
    _LibData data;
    try {
      data = await _data();
    } catch (_) {
      if (mounted && seq == _seq) {
        setState(() {
          _loading = false;
          _movies = const [];
          _shows = const [];
          _eps = const [];
          _message = 'Could not reach your library. Is the server running?';
        });
      }
      return;
    }
    final meta = await Api.librarySearch(q, genre: _genre, decade: _decade, year: _year, actor: _actor, director: _director);
    if (!mounted || seq != _seq) return;
    if (_filtering && meta == null) {
      setState(() {
        _loading = false;
        _movies = const [];
        _shows = const [];
        _eps = const [];
        _message = 'Could not reach your library. Is the server running?';
      });
      return;
    }

    bool hit(String hay) {
      final h = foldText(hay);
      return words.every(h.contains);
    }

    final byId = {for (final m in data.movies) m.id: m};
    final showsByFold = <String, List<Show>>{};
    for (final s in data.shows) {
      showsByFold.putIfAbsent(foldText(s.title), () => []).add(s);
    }
    final metaMovies = meta == null ? <Movie>[] : [for (final id in meta.movies) if (byId[id] != null) byId[id]!];
    final metaShows = meta == null ? <Show>[] : [for (final t in meta.shows) ...(showsByFold[foldText(t)] ?? const <Show>[])];
    List<Movie> movies;
    List<Show> shows;
    if (_filtering) {
      // With a filter on, only the database's answer counts (it applies the filter).
      movies = metaMovies;
      shows = metaShows;
    } else {
      // Titles and file names found on this device come first, then whatever the database matched by actor, genre, year, studio ...
      final own = data.movies.where((m) => hit('${m.title} ${m.year > 0 ? m.year : ''} ${m.filename}')).toList();
      final ownShows = data.shows.where((s) => hit(s.title)).toList();
      movies = [...own, ...metaMovies.where((m) => !own.contains(m))];
      shows = [...ownShows, ...metaShows.where((s) => !ownShows.contains(s))];
    }
    movies = movies.take(48).toList();
    shows = shows.take(48).toList();

    final eps = <_EpHit>[];
    if (!_filtering) {
      String pad(int n) => n < 10 ? '0$n' : '$n';
      outer:
      for (final sh in data.shows) {
        for (final se in sh.seasons) {
          for (final e in se.episodes) {
            if (hit('${sh.title} season ${se.number} episode ${e.episode} s${pad(se.number)}e${pad(e.episode)} ${e.filename}')) {
              eps.add(_EpHit(sh, e));
              if (eps.length >= 30) break outer;
            }
          }
        }
      }
    }

    setState(() {
      _loading = false;
      _movies = movies;
      _shows = shows;
      _eps = eps;
      _message = movies.isEmpty && shows.isEmpty && eps.isEmpty
          ? (_filtering ? 'Nothing in your library matches these filters.' : 'Nothing in your library matches \u201c$q\u201d.')
          : '';
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;

    Widget filterBtn(String label, String what) => PekButton(compact: true, label: label, primary: _pick == what, onTap: () => _openPicker(what));
    Widget chip(String label, String what) => PekButton(compact: true, primary: true, label: '$label \u2715', onTap: () => _off(what));

    Widget heading(String s) => Padding(padding: EdgeInsets.only(top: rem, bottom: 0.5 * rem), child: Text(s, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700)));

    Widget grid(List<Widget> cells) => CustomScrollView(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          slivers: [PekGridSliver(count: cells.length, minWidth: p.compact ? 110 : 200, gap: p.compact ? 0.6 * rem : rem, builder: (_, i) => cells[i])],
        );

    final children = <Widget>[
      const Heading('Search', weather: true),
      SuggestAnchor(
        controller: _q,
        items: _suggestions(),
        field: PekField(label: 'Search your library', controller: _q, hint: 'Title, actor, director, genre or year', onChanged: _typed, onSubmitted: _run),
      ),
      Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
        filterBtn('Genre', 'genre'),
        filterBtn('Year', 'decade'),
        filterBtn('Actor', 'actor'),
        filterBtn('Director', 'director'),
        if (_genre.isNotEmpty) chip(_genre, 'genre'),
        if (_year > 0) chip('$_year', 'decade') else if (_decade > 0) chip('${_decade}s', 'decade'),
        if (_actor.isNotEmpty) chip(_actor, 'actor'),
        if (_director.isNotEmpty) chip('Dir. $_director', 'director'),
      ]),
    ];

    if (_pick.isNotEmpty) {
      final f = _facets;
      if (_facetsFailed) {
        children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text('Could not reach your library. Is the server running?', style: TextStyle(color: t.textMuted))));
      } else if (f == null) {
        children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text('Loading\u2026', style: TextStyle(color: t.textMuted))));
      } else {
        final items = _pick == 'genre' ? f.genres : _pick == 'decade' ? f.decades : _pick == 'director' ? f.directors : f.actors;
        if (f.indexingTotal > 0 && f.indexingDone < f.indexingTotal) {
          children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text('Reading details from your files\u2026 ${f.indexingDone} of ${f.indexingTotal}. More will appear as it goes.', style: TextStyle(color: t.textMuted))));
        }
        if (items.isEmpty) {
          children.add(Padding(
            padding: EdgeInsets.only(top: rem),
            child: Text(_pick == 'decade' ? 'No release years found yet.' : (_namePick && _q.text.trim().isNotEmpty ? 'No name matches \u201c${_q.text.trim()}\u201d.' : 'Nothing here yet. PEK TV reads genres, actors and directors from .nfo files (the Kodi kind) saved next to your movies and shows, after a scan.'), style: TextStyle(color: t.textMuted)),
          ));
        } else {
          if (_namePick) children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text('Type part of a name above to narrow the list.', style: TextStyle(color: t.textMuted))));
          children.add(SizedBox(height: rem));
          children.add(Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            for (final e in items)
              PekButton(
                compact: true,
                label: _pick == 'decade' ? '${e.key}s (${e.value})' : '${e.key} (${e.value})',
                onTap: () {
                  if (_pick == 'genre') _choose(genre: e.key);
                  if (_pick == 'decade') _choose(decade: int.tryParse(e.key) ?? 0);
                  if (_pick == 'actor') _choose(actor: e.key);
                  if (_pick == 'director') _choose(director: e.key);
                },
              ),
          ]));
          if (_pick == 'decade' && f.years.isNotEmpty) {
            // Or one exact year (the decades above are the quick way; this is for "1994").
            children.add(heading('Or one year'));
            children.add(Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
              for (final e in f.years) PekButton(compact: true, label: '${e.key} (${e.value})', onTap: () => _choose(year: int.tryParse(e.key) ?? 0)),
            ]));
          }
        }
      }
    } else {
      if (_loading) children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text('Searching\u2026', style: TextStyle(color: t.textMuted))));
      if (_message.isNotEmpty && !_loading) children.add(Padding(padding: EdgeInsets.only(top: rem), child: Text(_message, style: TextStyle(color: t.textMuted))));
      if (_movies.isNotEmpty) {
        children.add(heading('Movies'));
        children.add(grid([
          for (final m in _movies)
            ValueListenableBuilder<int>(
              valueListenable: Store.changed,
              builder: (context, _, __) => PosterCard(
                title: m.title,
                subtitle: ('${movieWatched(m) ? '\u2713 ' : ''}${m.year > 0 ? m.year : ''}').trim(),
                poster: Api.movieDetails(m.id),
                onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m))),
              ),
            ),
        ]));
      }
      if (_shows.isNotEmpty) {
        children.add(heading('TV Shows'));
        children.add(grid([
          for (final s in _shows)
            PosterCard(
              title: s.title,
              subtitle: '${s.episodeCount} episodes',
              poster: Api.showDetails(s.title),
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s))),
            ),
        ]));
      }
      if (_eps.isNotEmpty) {
        children.add(heading('Episodes'));
        for (final h in _eps) {
          children.add(ListRow(
            title: '${h.show.title} \u00b7 S${h.episode.season}E${h.episode.episode}',
            subtitle: h.episode.filename,
            onTap: () => playMedia(context, episodeItem(h.show, h.episode), startSec: Store.progressFor(h.episode.id)?.position ?? 0, nextFor: (cur) => nextEpisodeItem(h.show, cur.id)),
          ));
        }
      }
    }
    return ListView(padding: widget.padding, children: children);
  }
}

// ====================================================================== Watch History (also holds what Resume Watching used to)

/// Asks before something is taken out of Watch History. Cancel has the focus, so a stray OK press on a remote keeps it.
Future<bool> confirmRemoveFromHistory(BuildContext context, String title) async {
  final p = context.pek;
  final t = p.tokens;
  final rem = p.rem;
  final yes = await showDialog<bool>(
    context: context,
    barrierColor: t.overlay,
    builder: (c) => Dialog(
      backgroundColor: t.glassStrong,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius), side: BorderSide(color: t.border)),
      child: Padding(
        padding: EdgeInsets.all(1.5 * rem),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Delete from watch history?', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.75 * rem),
            Text('Are you sure you want to delete "$title" from your watch history? Your files are not touched.', style: TextStyle(color: t.textMuted)),
            SizedBox(height: 1.25 * rem),
            Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
              PekButton(label: 'Yes, delete', primary: true, onTap: () => Navigator.pop(c, true)),
              PekButton(label: 'Cancel', autofocus: true, onTap: () => Navigator.pop(c, false)),
            ]),
          ],
        ),
      ),
    ),
  );
  return yes == true;
}

class HistoryPage extends StatelessWidget {
  const HistoryPage({super.key, required this.padding});
  final EdgeInsets padding;

  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  static String _when(int ms) {
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final day = DateTime(d.year, d.month, d.day);
    final diff = today.difference(day).inDays;
    if (diff == 0) return 'Today';
    if (diff == 1) return 'Yesterday';
    return '${_months[d.month - 1]} ${d.day}${d.year == now.year ? '' : ', ${d.year}'}';
  }

  Future<void> _clear(BuildContext context) async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Clear watch history?'),
        content: const Text('This forgets everything you have finished watching on this device. Your files are not touched.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Clear')),
        ],
      ),
    );
    if (yes == true) {
      await Store.clearHistory();
      Watched.syncSoon();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final items = Store.history();
        final resume = Store.resumeItems();
        Widget sub(String text) => Padding(padding: EdgeInsets.only(top: 0.25 * rem, bottom: 0.6 * rem), child: Text(text, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w600, letterSpacing: -0.2)));
        return ListView(padding: padding, children: [
          const Heading('Watch History', weather: true),
          if (resume.isNotEmpty) ...[
            sub('Continue watching'),
            for (final it in resume)
              ListRow(
                leading: ResumeThumb(item: it),
                title: it.title,
                subtitle: it.duration > 0 ? '${formatTime(it.position)} of ${formatTime(it.duration)}' : 'Stopped at ${formatTime(it.position)}',
                onTap: () => playResumeOrStart(context, it),
                trailing: IconButton(
                  tooltip: 'Remove',
                  icon: Icon(Icons.close, color: p.tokens.textMuted),
                  onPressed: () async {
                    if (await confirmRemoveFromHistory(context, it.title)) await Store.removeProgress(it.id);
                  },
                ),
              ),
            SizedBox(height: rem),
            if (items.isNotEmpty) sub('Finished'),
          ],
          if (items.isEmpty && resume.isEmpty)
            const PekCard(title: 'Nothing watched yet', subtitle: 'Anything you stop partway through, and every movie or episode you finish, shows up here.')
          else if (items.isNotEmpty) ...[
            Padding(
              padding: EdgeInsets.only(bottom: rem),
              child: Wrap(spacing: 0.75 * rem, runSpacing: 0.5 * rem, children: [
                PekButton(compact: true, label: 'Clear history', onTap: () => _clear(context)),
                PekButton(compact: true, label: 'Export history & ratings', onTap: () => showExportSheet(context)),
              ]),
            ),
            for (final e in items)
              ListRow(
                title: e.label,
                subtitle: '${_when(e.at)}${e.count > 1 ? ' \u00b7 watched ${e.count} times' : ''}${Ratings.ofTarget(targetOfHistory(e)) > 0 ? ' \u00b7 \u2605 ${Ratings.ofTarget(targetOfHistory(e))}/${Ratings.max}' : ''}',
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  IconButton(
                    tooltip: 'Rate',
                    icon: Icon(Ratings.ofTarget(targetOfHistory(e)) > 0 ? Icons.star_rounded : Icons.star_outline_rounded),
                    onPressed: () => showRateDialog(context, title: e.title, year: e.year, kind: e.kind, season: e.season, episode: e.episode),
                  ),
                  IconButton(tooltip: 'Remove', icon: const Icon(Icons.close), onPressed: () async {
                    if (!await confirmRemoveFromHistory(context, e.label)) return;
                    await Store.removeHistory(e.key);
                    Watched.syncSoon();
                  }),
                ]),
              ),
          ],
          const PluginFavoritesSection(),
        ]);
      },
    );
  }
}
