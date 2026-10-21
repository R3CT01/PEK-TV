import 'package:flutter/material.dart';

import 'api.dart';
import 'clock.dart';
import 'common.dart';
import 'detail.dart';
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
  const DashboardPage({super.key, required this.padding, required this.onOpenResume, required this.onOpenFavorites});
  final EdgeInsets padding;
  final VoidCallback onOpenResume;
  final VoidCallback onOpenFavorites;

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
    setState(() => _plugins = _loadPlugins()); // a plugin installed since the page opened
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: context.pek.tokens.glassStrong,
      builder: (c) => _AddWidget(plugins: _plugins),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final items = Store.dashboardItems();
        return ListView(
          padding: widget.padding,
          children: [
            Heading(
              'Dashboard',
              weather: true,
              trailing: _edit
                  ? Row(mainAxisSize: MainAxisSize.min, children: [
                      PekButton(compact: true, primary: true, label: 'Done', onTap: () => setState(() => _edit = false)),
                      SizedBox(width: 0.5 * rem),
                      PekButton(compact: true, label: 'Add widget', onTap: _add),
                    ])
                  : PekButton(compact: true, label: 'Customize', onTap: _startEdit),
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
      case 'continue':
        final items = Store.resumeItems().take(12).toList();
        if (items.isEmpty) return null;
        return _row(context, 'Continue Watching', widget.onOpenResume, [
          for (final r in items)
            PosterCard(
              title: r.title,
              subtitle: r.duration > 0 ? '${(100 * r.position / r.duration).round()}% watched' : formatTime(r.position),
              poster: r.kind == 'movie' ? Api.movieDetails(r.id) : Api.showDetails(r.showTitle),
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

  /// One widget: a heading (tap = see all) and a horizontal row of posters.
  _Node _row(BuildContext context, String title, VoidCallback? more, List<Widget> cells) {
    final p = context.pek;
    final rem = p.rem;
    final w = p.compact ? 110.0 : (p.isTv ? 8 * rem : 150.0);
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
          height: w * 1.5 + 0.5 * rem,
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

/// "Add a widget" (`_renderDashAdd`): the built-in widgets that are not on the dashboard, a shortcut for each installed plugin
/// that has a screen in this app, and Reset to default.
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
          final rows = <Widget>[];
          for (final t in Store.dashDefault.where((t) => !have.contains(t))) {
            rows.add(ListRow(
              title: Store.dashTypes[t]!.$1,
              subtitle: Store.dashTypes[t]!.$2,
              onTap: () {
                Store.setDashboardItems([...on, DashItem(t, t)]);
                Navigator.pop(context);
              },
            ));
          }
          for (final pl in (snap.data ?? const <PluginInfo>[]).where((e) => e.folder != 'weather' && e.flutterScreen && RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(e.folder) && !have.contains('plugin:${e.folder}'))) {
            rows.add(ListRow(
              title: pl.name,
              subtitle: 'Plugin shortcut',
              onTap: () {
                Store.setDashboardItems([...on, DashItem('plugin:${pl.folder}', 'plugin', folder: pl.folder)]);
                Navigator.pop(context);
              },
            ));
          }
          if (rows.isEmpty) rows.add(Text('Everything is already on your dashboard.', style: TextStyle(color: p.tokens.textMuted)));
          rows.add(ListRow(
            title: 'Reset to default layout',
            subtitle: 'Clock, weather, continue watching, recently added, favorites',
            onTap: () {
              Store.setDashboardItems(Store.dashboardDefault());
              Navigator.pop(context);
            },
          ));
          return SafeArea(
            child: SingleChildScrollView(
              padding: EdgeInsets.all(rem),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('Add a widget', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
                SizedBox(height: rem),
                ...rows,
              ]),
            ),
          );
        },
      ),
    );
  }
}
