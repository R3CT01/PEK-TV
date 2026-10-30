import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api.dart' show Details;
import 'plugin_ui.dart' show openPluginScreen;
import 'ratings.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Recommended dashboard widget: a stack of poster rows, one per genre the person picked, with "Because you liked / watched"
/// rows on top once there is a rating or a watch to learn from. Titles come from TMDb (through the same proxy the rest of the app
/// uses), so people with no library, or only plugins, get suggestions too. A tap opens the title in TMDb Discover (where to watch,
/// trailer, open in a streaming plugin).
///
/// The picks (genres, titles marked "not interested", and that the widget was offered) live in [Recs], per profile, and ride along
/// with the dashboard setting (`s|dashboard`, key `recs`) so they follow the person to PEK Cloud and to other devices.

/// One genre the picker offers, with the TMDb genre ids that mean it for movies and for TV (0 = TMDb has none for that kind).
class RecGenre {
  const RecGenre(this.id, this.name, this.movie, this.tv);
  final String id;
  final String name;
  final int movie;
  final int tv;
}

const recGenres = <RecGenre>[
  RecGenre('action', 'Action', 28, 10759),
  RecGenre('adventure', 'Adventure', 12, 10759),
  RecGenre('animation', 'Animation', 16, 16),
  RecGenre('comedy', 'Comedy', 35, 35),
  RecGenre('crime', 'Crime', 80, 80),
  RecGenre('documentary', 'Documentary', 99, 99),
  RecGenre('drama', 'Drama', 18, 18),
  RecGenre('family', 'Family', 10751, 10751),
  RecGenre('fantasy', 'Fantasy', 14, 10765),
  RecGenre('history', 'History', 36, 0),
  RecGenre('horror', 'Horror', 27, 0),
  RecGenre('mystery', 'Mystery', 9648, 9648),
  RecGenre('reality', 'Reality', 0, 10764),
  RecGenre('romance', 'Romance', 10749, 0),
  RecGenre('scifi', 'Sci-Fi', 878, 10765),
  RecGenre('thriller', 'Thriller', 53, 0),
  RecGenre('war', 'War', 10752, 10768),
  RecGenre('western', 'Western', 37, 37),
];

// ====================================================================== the person's picks

class Recs {
  static const _k = 'pek_recs_v1';
  static const maxHidden = 30;

  /// Bumped when the picks change (the widget repaints).
  static final changed = ValueNotifier<int>(0);

  static Map<String, dynamic> _read() {
    try {
      final raw = Store.strGet(_k);
      if (raw != null && raw.isNotEmpty) {
        final o = jsonDecode(raw);
        if (o is Map) return Map<String, dynamic>.from(o);
      }
    } catch (_) {/* a bad value is just ignored */}
    return {};
  }

  static Future<void> _save(Map<String, dynamic> m, {bool edited = true}) async {
    await Store.strSet(_k, jsonEncode(m));
    changed.value++;
    if (edited) Store.dashEdited.value++; // the picks ride along with the dashboard: this tells the cloud sync
  }

  /// True once the widget was offered to this profile (added by default). Stays true after the person removes it, so it is never
  /// put back on its own.
  static bool get offered => _read()['o'] == 1;

  /// Something was picked or offered, so the dashboard setting has something to sync even if the layout was never edited.
  static bool get touched => _read().isNotEmpty;

  static List<String> get genres => cleanGenres(_read()['g']);
  static Set<String> get hidden => cleanHidden(_read()['n']).toSet();

  /// Only known genre ids, once each, in the order given. Pure, so it can be tested.
  static List<String> cleanGenres(dynamic raw) {
    if (raw is! List) return const [];
    final ok = {for (final g in recGenres) g.id};
    final out = <String>[];
    for (final e in raw) {
      if (e is String && ok.contains(e) && !out.contains(e)) out.add(e);
    }
    return out;
  }

  /// "Not interested" keys (`m603` movie, `t1396` show), at most [maxHidden], newest last. Pure.
  static List<String> cleanHidden(dynamic raw) {
    if (raw is! List) return const [];
    final out = <String>[];
    for (final e in raw) {
      if (e is String && RegExp(r'^[mt]\d{1,9}$').hasMatch(e) && !out.contains(e)) out.add(e);
    }
    return out.length > maxHidden ? out.sublist(out.length - maxHidden) : out;
  }

  /// What goes to the cloud (null = nothing to send). Pure given the input, so it can be tested.
  static Map<String, dynamic>? cleanSync(dynamic o) {
    if (o is! Map) return null;
    final g = cleanGenres(o['g']);
    final n = cleanHidden(o['n']);
    final off = o['o'] == 1;
    if (!off && g.isEmpty && n.isEmpty) return null;
    return {'o': off ? 1 : 0, 'g': g, 'n': n};
  }

  static Map<String, dynamic>? syncValue() => cleanSync(_read());

  /// The cloud's copy arrived: once offered stays offered, the cloud's genres win (when it has any), "not interested" is the union.
  static Future<void> applySynced(dynamic o) async {
    final r = cleanSync(o);
    if (r == null) return;
    final mine = _read();
    final g = (r['g'] as List).isNotEmpty ? r['g'] : cleanGenres(mine['g']);
    final n = <String>[...cleanHidden(mine['n']), ...(r['n'] as List).cast<String>()];
    final merged = cleanHidden(n.toSet().toList());
    await _save({'o': (mine['o'] == 1 || r['o'] == 1) ? 1 : 0, 'g': g, 'n': merged}, edited: false);
  }

  static Future<void> setGenres(List<String> ids) async {
    final m = _read();
    m['g'] = cleanGenres(ids);
    m['o'] = 1;
    await _save(m);
  }

  static Future<void> hide(String key) async {
    final m = _read();
    m['n'] = cleanHidden([...cleanHidden(m['n']), key]);
    await _save(m);
  }

  static Future<void> markOffered() async {
    final m = _read();
    if (m['o'] == 1) return;
    m['o'] = 1;
    await _save(m);
  }

  /// Puts the widget on the dashboard of someone who had it saved before it existed (one time; never again after they remove it).
  /// A layout that was never edited already has it by default.
  static Future<void> offerWidget() async {
    if (offered) return;
    if (Store.dashboardChosen) {
      final items = Store.dashboardItems();
      if (!items.any((e) => e.type == 'recommend')) {
        final at = items.indexWhere((e) => e.type == 'continue');
        final n = List.of(items)..insert(at >= 0 ? at + 1 : (items.length < 2 ? items.length : 2), const DashItem('recommend', 'recommend'));
        await Store.setDashboardItems(n);
      }
    }
    await markOffered();
  }
}

// ====================================================================== what to show

class RecItem {
  const RecItem({required this.id, required this.tv, required this.title, required this.year, required this.poster, this.overview = ''});
  final int id;
  final bool tv;
  final String title;
  final int year;
  final String poster; // TMDb path ("/abc.jpg")
  final String overview;

  /// The "not interested" key: `m603` for a movie, `t1396` for a show.
  String get key => '${tv ? 't' : 'm'}$id';
  String get image => 'https://image.tmdb.org/t/p/w342$poster';
}

class RecRow {
  const RecRow(this.title, this.items);
  final String title;
  final List<RecItem> items;
}

/// A title the person liked or watched, to ask TMDb for similar ones.
class RecSeed {
  const RecSeed({required this.title, required this.tv, required this.year, required this.weight, required this.liked});
  final String title;
  final bool tv;
  final int year;
  final double weight;
  final bool liked; // rated 7 or more
}

class _Acc {
  _Acc(this.title, this.tv, this.year);
  final String title;
  final bool tv;
  final int year;
  double watched = 0;
  double rated = 0;
  bool liked = false;
  bool disliked = false;
}

class RecFeed {
  static const _base = 'https://hesper-tmdb.aquariusibeats.workers.dev'; // the proxy that holds the TMDb key
  static const _ttlMs = 6 * 3600 * 1000;
  static final _c = http.Client();
  static final _cache = <String, (int, Map<String, dynamic>)>{};

  /// What the feed is built from: a change here means the rows should be asked for again.
  static String signature(List<String> genres, int ratings, int hidden) => '${genres.join(',')}|${Store.history().length}|$ratings|$hidden';

  static Future<Map<String, dynamic>?> _get(String path) async {
    final now = DateTime.now().millisecondsSinceEpoch;
    final hit = _cache[path];
    if (hit != null && now - hit.$1 < _ttlMs) return hit.$2;
    try {
      final r = await _c.get(Uri.parse('$_base$path')).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) return null;
      final o = jsonDecode(utf8.decode(r.bodyBytes));
      if (o is! Map) return null;
      if (_cache.length > 150) _cache.clear();
      final m = Map<String, dynamic>.from(o);
      _cache[path] = (now, m);
      return m;
    } catch (_) {
      return null;
    }
  }

  /// The titles in a TMDb list answer. Anything without an id, a title or a poster is dropped. Pure, so it can be tested.
  static List<RecItem> parseResults(dynamic body, bool tv) {
    final out = <RecItem>[];
    final list = body is Map ? body['results'] : null;
    if (list is! List) return out;
    for (final e in list) {
      if (e is! Map) continue;
      final id = e['id'];
      final title = '${e[tv ? 'name' : 'title'] ?? ''}';
      final poster = '${e['poster_path'] ?? ''}';
      if (id is! num || id <= 0 || title.isEmpty || !RegExp(r'^/[A-Za-z0-9_\-]+\.(jpg|jpeg|png|webp)$').hasMatch(poster)) continue;
      final date = '${e[tv ? 'first_air_date' : 'release_date'] ?? ''}';
      out.add(RecItem(id: id.toInt(), tv: tv, title: title, year: date.length >= 4 ? int.tryParse(date.substring(0, 4)) ?? 0 : 0, poster: poster, overview: '${e['overview'] ?? ''}'));
    }
    return out;
  }

  /// One movie, one show, one movie, ... Pure.
  static List<RecItem> interleave(List<RecItem> a, List<RecItem> b) {
    final out = <RecItem>[];
    for (var i = 0; i < a.length || i < b.length; i++) {
      if (i < a.length) out.add(a[i]);
      if (i < b.length) out.add(b[i]);
    }
    return out;
  }

  /// Which titles to ask TMDb about: the ones rated 7+ and the ones watched most or lately. A title rated 4 or less is never a seed.
  /// Pure, so it can be tested.
  static List<RecSeed> seedsFrom(List<HistoryEntry> history, List<RatingEntry> ratings, int nowMs, {int take = 2}) {
    final acc = <String, _Acc>{};
    _Acc a(String title, bool tv, int year) => acc.putIfAbsent('${tv ? 't' : 'm'}|${Store.normalize(title)}', () => _Acc(title, tv, year));
    const recent = 45 * 24 * 3600 * 1000;
    for (final h in history) {
      if (h.title.isEmpty) continue;
      final tv = h.kind == 'episode';
      final x = a(h.title, tv, tv ? 0 : h.year);
      x.watched += tv ? 0.15 : 0.6; // an episode counts a little, a movie more
      if (h.count > 1) x.watched += 0.5; // watched again
      if (nowMs - h.at < recent) x.watched += tv ? 0.1 : 0.4;
    }
    for (final r in ratings) {
      if (r.title.isEmpty) continue;
      final tv = r.kind != 'movie';
      final x = a(r.title, tv, tv ? 0 : r.year);
      if (r.rating >= 8) {
        x.rated += 2;
        x.liked = true;
      } else if (r.rating == 7) {
        x.rated += 1;
        x.liked = true;
      } else if (r.rating <= 4) {
        x.disliked = true;
      }
    }
    final out = [
      for (final x in acc.values)
        if (!x.disliked && (x.watched.clamp(0.0, 1.5) + x.rated) > 0) RecSeed(title: x.title, tv: x.tv, year: x.year, weight: (x.watched.clamp(0.0, 1.5) + x.rated).toDouble(), liked: x.liked),
    ]..sort((a, b) => b.weight.compareTo(a.weight));
    return out.take(take).toList();
  }

  /// Names (normalized) of everything already watched or saved: not suggested again.
  static Set<String> _known() {
    final s = <String>{};
    for (final h in Store.history()) {
      s.add(Store.normalize(h.title));
    }
    for (final f in Store.favorites()) {
      s.add(Store.normalize(f.title));
    }
    for (final f in Store.pluginFavorites()) {
      s.add(Store.normalize('${f['title'] ?? ''}'));
    }
    return s;
  }

  static Future<List<RecItem>> _forSeed(RecSeed s) async {
    final q = Uri.encodeQueryComponent(s.title);
    final kind = s.tv ? 'tv' : 'movie';
    final found = await _get('/search/$kind?query=$q${!s.tv && s.year > 0 ? '&year=${s.year}' : ''}');
    final res = found?['results'];
    if (res is! List || res.isEmpty) return const [];
    Map? pick;
    for (final e in res) {
      if (e is Map && Store.normalize('${e[s.tv ? 'name' : 'title'] ?? ''}') == Store.normalize(s.title)) {
        pick = e;
        break;
      }
    }
    pick ??= res.first is Map ? res.first as Map : null;
    final id = pick?['id'];
    if (id is! num) return const [];
    final info = await _get('/$kind/${id.toInt()}?append_to_response=recommendations');
    return parseResults(info?['recommendations'], s.tv);
  }

  static Future<List<RecItem>> _forGenre(RecGenre g) async {
    // A different page of the popular list each day (of three), so the row is not the same every time.
    final page = 1 + (DateTime.now().day + g.id.length) % 3;
    String path(String kind, int id) => '/discover/$kind?with_genres=$id&sort_by=popularity.desc&vote_count.gte=300&include_adult=false&page=$page';
    final movies = g.movie > 0 ? await _get(path('movie', g.movie)) : null;
    final shows = g.tv > 0 ? await _get(path('tv', g.tv)) : null;
    return interleave(parseResults(movies, false), parseResults(shows, true));
  }

  /// The stacked rows: up to two "Because you ..." rows, then one row per picked genre. A title appears once, watched and
  /// "not interested" titles are left out. An empty list means nothing could be fetched (offline).
  static Future<List<RecRow>> build({required List<String> genres, required Set<String> hidden}) async {
    final known = _known();
    final seeds = seedsFrom(Store.history(), Ratings.all(), DateTime.now().millisecondsSinceEpoch);
    final personal = await Future.wait([for (final s in seeds) _forSeed(s)]);
    final byGenre = await Future.wait([
      for (final id in genres)
        if (recGenres.any((g) => g.id == id)) _forGenre(recGenres.firstWhere((g) => g.id == id)),
    ]);
    final names = [for (final id in genres) if (recGenres.any((g) => g.id == id)) recGenres.firstWhere((g) => g.id == id).name];
    final used = <String>{};
    List<RecItem> pickFrom(List<RecItem> l) {
      final out = <RecItem>[];
      for (final i in l) {
        if (out.length >= 20) break;
        if (hidden.contains(i.key) || used.contains(i.key) || known.contains(Store.normalize(i.title))) continue;
        out.add(i);
      }
      for (final i in out) {
        used.add(i.key);
      }
      return out;
    }

    final rows = <RecRow>[];
    for (var i = 0; i < seeds.length; i++) {
      final items = pickFrom(personal[i]);
      if (items.length >= 3) rows.add(RecRow(seeds[i].liked ? 'Because you liked ${seeds[i].title}' : 'Because you watched ${seeds[i].title}', items));
    }
    for (var i = 0; i < byGenre.length; i++) {
      final items = pickFrom(byGenre[i]);
      if (items.length >= 3) rows.add(RecRow(names[i], items));
    }
    return rows;
  }
}

// ====================================================================== the widget

class RecommendWidget extends StatefulWidget {
  const RecommendWidget({super.key, required this.onLongPress, required this.onRemove});

  /// The dashboard's own menu for this widget (Move / Delete).
  final VoidCallback onLongPress;

  /// Removes the widget from the dashboard (with Undo).
  final VoidCallback onRemove;

  @override
  State<RecommendWidget> createState() => _RecommendWidgetState();
}

class _RecommendWidgetState extends State<RecommendWidget> {
  Future<List<RecRow>>? _future;
  String _sig = '';

  @override
  void initState() {
    super.initState();
    Recs.changed.addListener(_repaint);
  }

  @override
  void dispose() {
    Recs.changed.removeListener(_repaint);
    super.dispose();
  }

  void _repaint() {
    if (mounted) setState(() {});
  }

  Future<void> _pick() async {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final chosen = <String>{...Recs.genres};
    final save = await showDialog<bool>(
      context: context,
      barrierColor: t.overlay,
      builder: (c) => StatefulBuilder(
        builder: (c, setD) => Dialog(
          backgroundColor: t.glassStrong,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius), side: BorderSide(color: t.border)),
          child: Padding(
            padding: EdgeInsets.all(1.5 * rem),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('What do you like to watch?', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
                SizedBox(height: 0.5 * rem),
                Text('Pick a few genres. You get a row of movies and shows for each, and the picks get better as you watch and rate. Saved to your account, so you are not asked again.', style: TextStyle(color: t.textMuted, fontSize: 0.9 * rem)),
                SizedBox(height: rem),
                Flexible(
                  child: SingleChildScrollView(
                    child: Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
                      for (final g in recGenres)
                        _GenreChip(
                          label: g.name,
                          on: chosen.contains(g.id),
                          autofocus: g == recGenres.first,
                          onTap: () => setD(() => chosen.contains(g.id) ? chosen.remove(g.id) : chosen.add(g.id)),
                        ),
                    ]),
                  ),
                ),
                SizedBox(height: 1.25 * rem),
                Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
                  PekButton(label: chosen.isEmpty ? 'Pick at least one' : 'Save', primary: true, onTap: chosen.isEmpty ? null : () => Navigator.pop(c, true)),
                  PekButton(label: 'Cancel', onTap: () => Navigator.pop(c, false)),
                ]),
              ],
            ),
          ),
        ),
      ),
    );
    if (save == true) {
      // Keep the order the genres are listed in, so rows do not jump around.
      await Recs.setGenres([for (final g in recGenres) if (chosen.contains(g.id)) g.id]);
    }
  }

  void _open(RecItem i) {
    unawaited(openPluginScreen(context, pluginId: 'tmdb-discover', title: i.title, launch: {'type': i.tv ? 'tv' : 'movie', 'id': i.id, 'title': i.title, 'year': i.year}));
  }

  Future<void> _cardMenu(RecItem i) async {
    final p = context.pek;
    final what = await showDialog<String>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => SimpleDialog(
        backgroundColor: p.tokens.glassStrong,
        title: Text(i.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        children: [
          ListTile(autofocus: true, onTap: () => Navigator.pop(c, 'fav'), leading: const Icon(Icons.favorite_border), title: const Text('Add to favorites')),
          ListTile(onTap: () => Navigator.pop(c, 'no'), leading: const Icon(Icons.visibility_off_outlined), title: const Text('Not interested')),
          ListTile(onTap: () => Navigator.pop(c, 'widget'), leading: const Icon(Icons.open_with), title: const Text('Move or delete this widget')),
        ],
      ),
    );
    if (!mounted) return;
    switch (what) {
      case 'fav':
        await Store.addPluginFavorite(plugin: 'tmdb-discover', type: i.tv ? 'tv' : 'movie', id: i.id, title: i.title, year: i.tv ? 0 : i.year, posterPath: i.poster);
        if (mounted) ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('${i.title} added to Favorites')));
      case 'no':
        await Recs.hide(i.key);
      case 'widget':
        widget.onLongPress();
    }
  }

  Widget _card(BuildContext context, String title, String text, List<Widget> buttons) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return GestureDetector(
      onLongPress: widget.onLongPress,
      child: Container(
        width: double.infinity,
        padding: EdgeInsets.all(1.25 * rem),
        decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: t.border)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700)),
          SizedBox(height: 0.4 * rem),
          Text(text, style: TextStyle(color: t.textMuted)),
          SizedBox(height: rem),
          Wrap(spacing: 0.75 * rem, runSpacing: 0.5 * rem, children: buttons),
        ]),
      ),
    );
  }

  Widget _rowOf(BuildContext context, RecRow row) {
    final p = context.pek;
    final rem = p.rem;
    final w = p.compact ? 110.0 : (p.isTv ? 8 * rem : 150.0);
    final textRoom = (0.4 + 2.7 * MediaQuery.textScalerOf(context).scale(1.0)) * rem;
    return Padding(
      padding: EdgeInsets.only(bottom: rem),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(row.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600)),
        SizedBox(height: 0.6 * rem),
        SizedBox(
          height: w * 1.5 + textRoom,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            clipBehavior: Clip.none,
            itemCount: row.items.length,
            separatorBuilder: (_, __) => SizedBox(width: 0.75 * rem),
            itemBuilder: (_, k) {
              final i = row.items[k];
              return SizedBox(
                width: w,
                child: Align(
                  alignment: Alignment.topCenter,
                  child: PosterCard(
                    title: i.title,
                    subtitle: [if (i.year > 0) '${i.year}', i.tv ? 'Show' : 'Movie'].join(' \u00b7 '),
                    poster: Future.value(const Details(overview: '', poster: '')),
                    fallbackImage: i.image,
                    holdSelect: true,
                    onTap: () => _open(i),
                    onLongPress: () => _cardMenu(i),
                  ),
                ),
              );
            },
          ),
        ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final genres = Recs.genres;
    if (genres.isEmpty) {
      return _card(context, 'Recommended for you', 'Pick a few genres you like and we will suggest movies and shows to watch. The more you watch and rate, the better the picks get. Your choice is saved to your account.', [
        PekButton(label: 'Pick genres', primary: true, shrink: true, onTap: _pick),
        PekButton(label: 'Remove widget', shrink: true, onTap: widget.onRemove),
      ]);
    }
    final sig = RecFeed.signature(genres, Ratings.all().length, Recs.hidden.length);
    if (_future == null || sig != _sig) {
      _sig = sig;
      _future = RecFeed.build(genres: genres, hidden: Recs.hidden);
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Recommended for you', style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700)),
      SizedBox(height: 0.5 * rem),
      Wrap(spacing: 0.75 * rem, runSpacing: 0.5 * rem, children: [
        PekButton(compact: true, shrink: true, label: 'Edit genres', onTap: _pick),
        PekButton(compact: true, shrink: true, label: 'Remove widget', onTap: widget.onRemove),
      ]),
      SizedBox(height: 0.9 * rem),
      FutureBuilder<List<RecRow>>(
        future: _future,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Padding(padding: EdgeInsets.symmetric(vertical: rem), child: Text('Finding things you might like\u2026', style: TextStyle(color: t.textMuted)));
          }
          final rows = snap.data ?? const <RecRow>[];
          if (rows.isEmpty) {
            return _card(context, 'No picks right now', 'We could not load recommendations. Check your connection and try again.', [
              PekButton(
                label: 'Try again',
                primary: true,
                shrink: true,
                onTap: () => setState(() {
                  _sig = '';
                  _future = null;
                }),
              ),
            ]);
          }
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final r in rows) _rowOf(context, r)]);
        },
      ),
    ]);
  }
}

class _GenreChip extends StatelessWidget {
  const _GenreChip({required this.label, required this.on, required this.onTap, this.autofocus = false});
  final String label;
  final bool on;
  final bool autofocus;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return PekFocusable(
      autofocus: autofocus,
      onTap: onTap,
      radius: 20,
      background: on ? t.accent.withAlpha(46) : t.surface,
      borderColor: on ? t.accent : t.border,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: 0.9 * rem, vertical: 0.55 * rem),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          if (on) Padding(padding: EdgeInsets.only(right: 0.35 * rem), child: Icon(Icons.check, size: 1.0 * rem, color: t.accent)),
          Text(label, style: TextStyle(fontSize: 0.95 * rem, fontWeight: on ? FontWeight.w700 : FontWeight.w500, color: on ? t.text : t.textMuted)),
        ]),
      ),
    );
  }
}
