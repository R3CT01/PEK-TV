import 'package:flutter/material.dart';

import 'api.dart';
import 'clock.dart';
import 'common.dart';
import 'dash_widgets.dart';
import 'detail.dart';
import 'plugin_pins.dart';
import 'plugin_ui.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart';
import 'widgets.dart';

/// The Dashboard tab (app_dashboard.js): a grid of widgets. Clock, Weather and plugin shortcuts are tiles (1 column, or 2 when
/// set to Wide); Continue Watching, Recently Added and Favorites are full-width rows of posters.
/// Customize (or press and hold a tile) = edit mode: move, resize or remove widgets, Add widget, Reset. The layout is saved per
/// profile and syncs to the profile's other devices as `s|dashboard` (same item as the web UI, see Cloud).
class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key, required this.padding, required this.onOpenResume, required this.onOpenFavorites, this.onOpenMusic});
  final EdgeInsets padding;
  final VoidCallback onOpenResume;
  final VoidCallback onOpenFavorites;

  /// Goes to the Music page (the music widgets' "See all" and empty states).
  final VoidCallback? onOpenMusic;

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

typedef _Node = ({Widget w, int span, bool full});

class _DashboardPageState extends State<DashboardPage> {
  late Future<(List<Movie>, List<Show>)> _lib = _load();
  Future<List<PluginInfo>> _plugins = _loadPlugins();
  bool _edit = false;

  Future<(List<Movie>, List<Show>)> _load() async {
    final m = await Api.movies().catchError((_) => <Movie>[]);
    final s = await Api.shows().catchError((_) => <Show>[]);
    return (m, s);
  }

  static Future<List<PluginInfo>> _loadPlugins() => Api.plugins().catchError((_) => <PluginInfo>[]);

  // ---------------- saved layout (_dashMove / _dashResize / _dashRemove / _dashAdd / _dashReset) ----------------

  void _move(List<DashItem> l, int i, int d) {
    final j = i + d;
    if (j < 0 || j >= l.length) return;
    final n = List.of(l);
    final x = n[i];
    n[i] = n[j];
    n[j] = x;
    Store.setDashboardItems(n);
  }

  void _resize(List<DashItem> l, int i) => Store.setDashboardItems([for (var k = 0; k < l.length; k++) k == i ? l[k].withSize(l[k].size == 'm' ? 's' : 'm') : l[k]]);

  void _remove(List<DashItem> l, int i) => Store.setDashboardItems([for (var k = 0; k < l.length; k++) if (k != i) l[k]]);

  void _startEdit() {
    if (!_edit) setState(() => _edit = true);
  }

  Future<void> _add() async {
    _plugins = _loadPlugins(); // a plugin installed since the page opened
    try {
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        showDragHandle: true,
        backgroundColor: context.pek.tokens.glassStrong,
        builder: (c) => _AddWidget(plugins: _plugins),
      );
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not open the widget list: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ListenableBuilder(
      listenable: Listenable.merge([Store.changed, PluginPins.changed]),
      builder: (context, _) {
        final items = Store.dashboardItems();
        return ListView(
          padding: widget.padding,
          children: [
            Heading(
              'Dashboard',
              weather: true,
              // Done and Add widget used to sit in this line next to the weather pill; on a phone they did not fit, so the part
              // that stuck out could not be tapped. While editing they get their own line below (see the Wrap).
              trailing: _edit ? null : PekButton(compact: true, label: 'Customize', onTap: _startEdit),
            ),
            if (_edit)
              Padding(
                padding: EdgeInsets.only(bottom: 0.75 * rem),
                child: Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
                  PekButton(compact: true, shrink: true, label: 'Add widget', primary: true, autofocus: true, onTap: _add),
                  PekButton(compact: true, shrink: true, label: 'Done', onTap: () => setState(() => _edit = false)),
                ]),
              ),
            if (_edit)
              Padding(
                padding: EdgeInsets.only(bottom: rem),
                child: Text('Move, resize or remove widgets, then tap Done. Press and hold a tile to customize any time.', style: TextStyle(color: p.tokens.textMuted)),
              ),
            FutureBuilder<List<PluginInfo>>(
              future: _plugins,
              builder: (context, ps) => FutureBuilder<(List<Movie>, List<Show>)>(
                future: _lib,
                builder: (context, snap) {
                  final movies = snap.data?.$1 ?? const <Movie>[];
                  final shows = snap.data?.$2 ?? const <Show>[];
                  final plugins = ps.data ?? const <PluginInfo>[];
                  final nodes = <_Node>[];
                  for (var i = 0; i < items.length; i++) {
                    final n = _edit ? _editCard(context, items, i, plugins) : _widget(context, items[i], movies, shows, plugins);
                    if (n != null) nodes.add(n);
                  }
                  if (nodes.isEmpty) {
                    return items.isEmpty
                        ? const PekCard(title: 'Your dashboard is empty', subtitle: 'Tap Customize, then Add widget.')
                        : const PekCard(title: 'Nothing to show yet', subtitle: 'Watch something or add favorites and they will appear here.');
                  }
                  return _grid(context, nodes);
                },
              ),
            ),
          ],
        );
      },
    );
  }

  /// `.dash-grid`: auto-fill columns of at least 180px (11rem on a TV), 1rem gap (1.4rem on a TV). A tile spans 1 or 2 columns, a
  /// row of posters the whole width.
  Widget _grid(BuildContext context, List<_Node> nodes) {
    final p = context.pek;
    final rem = p.rem;
    final minW = p.isTv ? 11 * rem : 180.0;
    final gap = p.isTv ? 1.4 * rem : rem;
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      final cols = ((w + gap) / (minW + gap)).floor().clamp(1, 1000);
      final cell = (w - gap * (cols - 1)) / cols;
      final rows = <List<(Widget, int)>>[];
      var cur = <(Widget, int)>[];
      var used = 0;
      void flush() {
        if (cur.isNotEmpty) rows.add(cur);
        cur = <(Widget, int)>[];
        used = 0;
      }

      for (final n in nodes) {
        if (n.full) {
          flush();
          rows.add([(n.w, cols)]);
          continue;
        }
        final span = n.span.clamp(1, cols);
        if (used + span > cols) flush();
        cur.add((n.w, span));
        used += span;
        if (used >= cols) flush();
      }
      flush();
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final r in rows)
          Padding(
            padding: EdgeInsets.only(bottom: gap),
            child: IntrinsicHeight(
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (var i = 0; i < r.length; i++) ...[
                  if (i > 0) SizedBox(width: gap),
                  SizedBox(width: cell * r[i].$2 + gap * (r[i].$2 - 1), child: r[i].$1),
                ],
              ]),
            ),
          ),
      ]);
    });
  }

  // ---------------- widgets (normal view) ----------------

  _Node? _widget(BuildContext context, DashItem it, List<Movie> movies, List<Show> shows, List<PluginInfo> plugins) {
    final span = it.size == 'm' ? 2 : 1;
    switch (it.type) {
      case 'clock':
        return (w: ClockTile(onLongPress: _startEdit), span: span, full: false);
      case 'weather':
        return (w: WeatherTile(onLongPress: _startEdit), span: span, full: false);
      case 'plugin':
        final info = plugins.where((e) => e.folder == it.folder).firstOrNull;
        if (info == null) return null; // not installed: nothing to show (the edit view says so)
        return (
          w: DashTile(
            heading: info.name,
            body: 'Open plugin',
            onLongPress: _startEdit,
            onTap: () {
              if (!info.flutterScreen) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('This plugin has no screen for this app yet')));
                return;
              }
              openPluginScreen(context, pluginId: info.folder, title: info.name);
            },
          ),
          span: span,
          full: false,
        );
      case 'nowplaying':
        return (w: NowPlayingCard(onLongPress: _startEdit, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'forecast':
        return (w: ForecastCard(onLongPress: _startEdit), span: 1, full: true);
      case 'albums':
        return (w: AlbumsRow(onLongPress: _startEdit, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'playlists':
        return (w: PlaylistsRow(onLongPress: _startEdit, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'stats':
        return (w: LibraryStatsTile(onLongPress: _startEdit), span: span, full: false);
      case 'surprise':
        return (w: SurpriseTile(onLongPress: _startEdit), span: span, full: false);
      case 'pinned':
        final pinned = <PluginInfo>[
          for (final f in PluginPins.all)
            for (final e in plugins)
              if (e.folder == f) e,
        ];
        if (pinned.isEmpty) return null; // nothing pinned: nothing to show (pin plugins from the Plugins page)
        return (w: PinnedPluginsRow(plugins: pinned, onLongPress: _startEdit), span: 1, full: true);
      case 'shows':
        final list = shows.reversed.take(12).toList();
        if (list.isEmpty) return null;
        return _row(context, 'TV Shows', null, [
          for (final s in list)
            PosterCard(
              title: s.title,
              subtitle: '${s.episodeCount} episodes',
              poster: Api.showDetails(s.title),
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s))),
            ),
        ]);
      case 'upnext':
        final next = _upNext(shows);
        if (next.isEmpty) return null;
        return _row(context, 'Up Next', null, [
          for (final (show, ep) in next)
            PosterCard(
              title: show.title,
              subtitle: 'S${ep.season.toString().padLeft(2, '0')}E${ep.episode.toString().padLeft(2, '0')}',
              poster: Api.showDetails(show.title),
              onTap: () => playMedia(context, episodeItem(show, ep)),
            ),
        ]);
      case 'watched':
        final cells = <Widget>[];
        final seenShows = <String>{};
        for (final h in Store.history()) {
          if (cells.length >= 12) break;
          if (h.kind == 'movie') {
            final m = movies.where((e) => Store.normalize(e.title) == Store.normalize(h.title) && e.year == h.year).firstOrNull;
            if (m == null) continue; // watched somewhere else (a plugin): nothing to open here
            cells.add(PosterCard(title: m.title, subtitle: m.year > 0 ? '${m.year}' : '', poster: Api.movieDetails(m.id), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m)))));
          } else {
            final key = Store.normalize(h.title);
            if (!seenShows.add(key)) continue; // one card per show, its latest episode
            final sh = shows.where((e) => Store.normalize(e.title) == key).firstOrNull;
            if (sh == null) continue;
            final label = h.season > 0 && h.episode > 0 ? 'S${h.season.toString().padLeft(2, '0')}E${h.episode.toString().padLeft(2, '0')}' : 'Watched';
            cells.add(PosterCard(title: sh.title, subtitle: label, poster: Api.showDetails(sh.title), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: sh)))));
          }
        }
        if (cells.isEmpty) return null;
        return _row(context, 'Recently Watched', null, cells);
      case 'continue':
        final items = Store.resumeItems().take(12).toList();
        if (items.isEmpty) return null;
        return _row(context, 'Continue Watching', widget.onOpenResume, [
          for (final r in items)
            PosterCard(
              title: r.title,
              subtitle: r.duration > 0 ? '${(100 * r.position / r.duration).round()}% watched' : formatTime(r.position),
              // A library title uses its library artwork; a stream started from a plugin carries its own picture.
              poster: r.isTorrent ? Future.value(const Details(overview: '', poster: '')) : (r.kind == 'movie' ? Api.movieDetails(r.id) : Api.showDetails(r.showTitle)),
              fallbackImage: r.image,
              progress: r.duration > 0 ? r.position / r.duration : null,
              onTap: () => playMedia(context, r, startSec: r.position),
            ),
        ]);
      case 'recent':
        final items = movies.reversed.take(12).toList();
        if (items.isEmpty) return null;
        return _row(context, 'Recently Added', null, [
          for (final m in items)
            PosterCard(
              title: m.title,
              subtitle: m.year > 0 ? '${m.year}' : '',
              poster: Api.movieDetails(m.id),
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m))),
            ),
        ]);
      case 'favorites':
        final cells = <Widget>[];
        for (final f in Store.favorites().take(12)) {
          if (f.kind == 'movie') {
            final m = movies.where((e) => e.id == f.ref).firstOrNull;
            if (m != null) {
              cells.add(PosterCard(title: m.title, subtitle: m.year > 0 ? '${m.year}' : '', poster: Api.movieDetails(m.id), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m)))));
            }
          } else {
            final s = shows.where((e) => e.title == f.ref).firstOrNull;
            if (s != null) {
              cells.add(PosterCard(title: s.title, subtitle: '${s.episodeCount} episodes', poster: Api.showDetails(s.title), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s)))));
            }
          }
        }
        if (cells.isEmpty) return null;
        return _row(context, 'Favorites', widget.onOpenFavorites, cells);
    }
    return null;
  }

  /// Up Next: for each show with something in Watch History, the first episode after the last one watched that is not watched
  /// and not already in Continue Watching. The show watched most recently comes first.
  List<(Show, Episode)> _upNext(List<Show> shows) {
    final lastAt = <String, int>{};
    for (final h in Store.history()) {
      if (h.kind == 'episode') lastAt.putIfAbsent(Store.normalize(h.title), () => h.at); // history is newest first
    }
    final found = <(Show, Episode, int)>[];
    for (final sh in shows) {
      final at = lastAt[Store.normalize(sh.title)];
      if (at == null) continue;
      final eps = [for (final se in sh.seasons) ...se.episodes]..sort((a, b) => a.season != b.season ? a.season.compareTo(b.season) : a.episode.compareTo(b.episode));
      final last = eps.lastIndexWhere((e) => episodeWatched(sh, e));
      for (var i = last + 1; i < eps.length; i++) {
        if (episodeWatched(sh, eps[i])) continue;
        if (Store.progressFor(eps[i].id) == null) found.add((sh, eps[i], at));
        break;
      }
    }
    found.sort((a, b) => b.$3.compareTo(a.$3));
    return [for (final f in found.take(12)) (f.$1, f.$2)];
  }

  /// One widget: a heading (tap = see all) and a horizontal row of posters.
  _Node _row(BuildContext context, String title, VoidCallback? more, List<Widget> cells) {
    final p = context.pek;
    final rem = p.rem;
    final w = p.compact ? 110.0 : (p.isTv ? 8 * rem : 150.0);
    // Room under the poster for the title and the subtitle line (about 2.6 rem), growing with the phone's text size.
    final textRoom = (0.4 + 2.7 * MediaQuery.textScalerOf(context).scale(1.0)) * rem;
    return (
      full: true,
      span: 1,
      w: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700))),
          if (more != null) PekButton(compact: true, label: 'See all', onTap: more),
        ]),
        SizedBox(height: 0.75 * rem),
        SizedBox(
          height: w * 1.5 + textRoom,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            clipBehavior: Clip.none,
            itemCount: cells.length,
            separatorBuilder: (_, __) => SizedBox(width: 0.75 * rem),
            itemBuilder: (_, i) => SizedBox(width: w, child: Align(alignment: Alignment.topCenter, child: cells[i])),
          ),
        ),
      ]),
    );
  }

  // ---------------- widgets (customize view) ----------------

  _Node _editCard(BuildContext context, List<DashItem> l, int i, List<PluginInfo> plugins) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final it = l[i];
    final tile = Store.dashIsTile(it.type);
    String label = Store.dashTypes[it.type]!.$1;
    String desc = Store.dashTypes[it.type]!.$2;
    if (it.type == 'plugin') {
      final info = plugins.where((e) => e.folder == it.folder).firstOrNull;
      label = info?.name ?? it.folder;
      desc = info == null ? 'Plugin not installed' : 'Plugin shortcut';
    }
    return (
      full: !tile,
      span: it.size == 'm' ? 2 : 1,
      w: Container(
        padding: EdgeInsets.symmetric(horizontal: 1.5 * rem, vertical: 1.25 * rem),
        decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: t.border, width: 2)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text(label, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w600, letterSpacing: -0.2)),
          SizedBox(height: 0.5 * rem),
          Text(desc, style: TextStyle(fontSize: 0.92 * rem, color: t.textMuted, height: 1.35)),
          SizedBox(height: 0.8 * rem),
          Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            if (i > 0) PekButton(compact: true, label: '\u25b2 Up', onTap: () => _move(l, i, -1)),
            if (i < l.length - 1) PekButton(compact: true, label: '\u25bc Down', onTap: () => _move(l, i, 1)),
            if (tile) PekButton(compact: true, label: it.size == 'm' ? 'Size: Wide' : 'Size: Small', onTap: () => _resize(l, i)),
            PekButton(compact: true, label: 'Remove', onTap: () => _remove(l, i)),
          ]),
        ]),
      ),
    );
  }
}

/// "Add a widget" (`_renderDashAdd`): every built-in widget that is not on the dashboard yet, in groups (Music, Weather and time,
/// Movies and shows, Plugins), a shortcut for each installed plugin that has a screen in this app, and Reset to default.
class _AddWidget extends StatelessWidget {
  const _AddWidget({required this.plugins});
  final Future<List<PluginInfo>> plugins;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) => FutureBuilder<List<PluginInfo>>(
        future: plugins,
        builder: (context, snap) {
          final on = Store.dashboardItems();
          final have = {for (final w in on) w.id};
          Widget label(String text) => Padding(
                padding: EdgeInsets.only(top: 0.9 * rem, bottom: 0.3 * rem),
                child: Text(text.toUpperCase(), style: TextStyle(fontSize: 0.78 * rem, letterSpacing: 1.1, fontWeight: FontWeight.w700, color: p.tokens.textMuted)),
              );
          final rows = <Widget>[];
          var first = true;
          for (final (group, types) in Store.dashGroups) {
            final left = [for (final t in types) if (!have.contains(t)) t];
            if (left.isEmpty) continue;
            rows.add(label(group));
            for (final t in left) {
              rows.add(ListRow(
                autofocus: first,
                title: Store.dashTypes[t]!.$1,
                subtitle: Store.dashTypes[t]!.$2,
                trailing: Icon(Icons.add_circle_outline, color: p.tokens.accent),
                onTap: () {
                  Store.setDashboardItems([...on, DashItem(t, t)]);
                  Navigator.pop(context);
                },
              ));
              first = false;
            }
          }
          final shortcuts = (snap.data ?? const <PluginInfo>[])
              .where((e) => e.folder != 'weather' && e.flutterScreen && RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(e.folder) && !have.contains('plugin:${e.folder}'))
              .toList();
          if (shortcuts.isNotEmpty) {
            rows.add(label('Plugin shortcuts'));
            for (final pl in shortcuts) {
              rows.add(ListRow(
                autofocus: first,
                title: pl.name,
                subtitle: 'A tile that opens ${pl.name}',
                trailing: Icon(Icons.add_circle_outline, color: p.tokens.accent),
                onTap: () {
                  Store.setDashboardItems([...on, DashItem('plugin:${pl.folder}', 'plugin', folder: pl.folder)]);
                  Navigator.pop(context);
                },
              ));
              first = false;
            }
          } else if (snap.connectionState != ConnectionState.done) {
            rows.add(Padding(padding: EdgeInsets.only(top: 0.6 * rem), child: Text('Looking for plugins\u2026', style: TextStyle(color: p.tokens.textMuted))));
          }
          if (rows.isEmpty) rows.add(Text('Everything is already on your dashboard.', style: TextStyle(color: p.tokens.textMuted)));
          rows.add(label('Layout'));
          rows.add(ListRow(
            autofocus: first,
            title: 'Reset to default layout',
            subtitle: 'Clock, weather, continue watching, recently added, favorites',
            onTap: () {
              Store.setDashboardItems(Store.dashboardDefault());
              Navigator.pop(context);
            },
          ));
          return SafeArea(
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(rem, 0, rem, rem),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Add a widget', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
                ...rows,
              ]),
            ),
          );
        },
      ),
    );
  }
}
