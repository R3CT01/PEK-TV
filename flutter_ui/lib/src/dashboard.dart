import 'dart:async';

import 'package:flutter/gestures.dart' show DragStartBehavior;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'clock.dart';
import 'common.dart';
import 'dash_widgets.dart';
import 'detail.dart';
import 'plugin_pins.dart';
import 'plugin_host.dart' show PluginBack;
import 'plugin_ui.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Dashboard tab (app_dashboard.js): a grid of widgets. Clock and plugin shortcuts are tiles (1 column, or 2 when
/// set to Wide); Continue Watching, Recently Added and Favorites are full-width rows of posters.
/// Press and hold a widget (touch, held centre button, or the Menu key) for Move / Delete. Move lifts the widget: drag it up
/// or down and let go on a square to place it (D-pad: Up / Down to pick the square, centre button to place); Back leaves
/// move mode. Add widget (and Reset) is the button at the top. The layout is saved per profile and syncs to the profile's
/// other devices as `s|dashboard` (same item as the web UI, see Cloud).
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
  late Future<List<PluginInfo>> _plugins = _fetchPlugins();
  List<PluginInfo> _pl = const []; // the last plugin list, for names in the menu and the move squares

  // Move mode: [_liftId] is the widget being moved; [_hover] is the square it would be placed on (by drag or D-pad).
  bool _moving = false;
  String? _liftId;
  int _hover = -1;
  bool _dragging = false;
  double _dragY = 0; // global y of the finger
  final _scroll = ScrollController();
  final _stackKey = GlobalKey();
  final _slotKeys = <String, GlobalKey>{};
  Timer? _auto;
  late final bool Function() _backFn = _onBack;

  Future<(List<Movie>, List<Show>)> _load() async {
    final m = await Api.movies().catchError((_) => <Movie>[]);
    final s = await Api.shows().catchError((_) => <Show>[]);
    return (m, s);
  }

  Future<List<PluginInfo>> _fetchPlugins() async {
    final l = await Api.plugins().catchError((_) => <PluginInfo>[]);
    _pl = l;
    return l;
  }

  @override
  void dispose() {
    _auto?.cancel();
    _scroll.dispose();
    if (PluginBack.current == _backFn) PluginBack.current = null;
    super.dispose();
  }

  // ---------------- saved layout ----------------

  String _label(DashItem it) {
    if (it.type == 'plugin') return _pl.where((e) => e.folder == it.folder).firstOrNull?.name ?? it.folder;
    return Store.dashTypes[it.type]?.$1 ?? it.type;
  }

  String _desc(DashItem it) {
    if (it.type == 'plugin') return _pl.where((e) => e.folder == it.folder).isEmpty ? 'Plugin not installed' : 'Plugin shortcut';
    return Store.dashTypes[it.type]?.$2 ?? '';
  }

  /// Takes the widget at [from] out and puts it back at [to] (the index it ends up at).
  void _place(int from, int to) {
    final l = Store.dashboardItems();
    if (from < 0 || from >= l.length || to < 0 || to >= l.length || from == to) return;
    final n = List.of(l);
    n.insert(to, n.removeAt(from));
    Store.setDashboardItems(n);
  }

  void _resize(DashItem it) {
    final l = Store.dashboardItems();
    Store.setDashboardItems([for (final e in l) e.id == it.id ? e.withSize(e.size == 'm' ? 's' : 'm') : e]);
  }

  void _delete(String id) {
    final before = Store.dashboardItems();
    final gone = before.where((e) => e.id == id).firstOrNull;
    if (gone == null) return;
    Store.setDashboardItems([for (final e in before) if (e.id != id) e]);
    final name = _label(gone);
    ScaffoldMessenger.maybeOf(context)
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text('Deleted $name'), action: SnackBarAction(label: 'Undo', onPressed: () => Store.setDashboardItems(before))));
  }

  /// The press-and-hold menu of one widget.
  Future<void> _menu(String id) async {
    if (_moving) return;
    final it = Store.dashboardItems().where((e) => e.id == id).firstOrNull;
    if (it == null || !mounted) return;
    final p = context.pek;
    final tile = Store.dashIsTile(it.type);
    final what = await showDialog<String>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => SimpleDialog(
        backgroundColor: p.tokens.glassStrong,
        title: Text(_label(it), maxLines: 1, overflow: TextOverflow.ellipsis),
        children: [
          ListTile(autofocus: true, onTap: () => Navigator.pop(c, 'move'), leading: const Icon(Icons.open_with), title: const Text('Move')),
          if (tile)
            ListTile(onTap: () => Navigator.pop(c, 'size'), leading: const Icon(Icons.aspect_ratio), title: Text(it.size == 'm' ? 'Make small' : 'Make wide')),
          ListTile(onTap: () => Navigator.pop(c, 'delete'), leading: const Icon(Icons.delete_outline), title: const Text('Delete')),
        ],
      ),
    );
    if (!mounted) return;
    switch (what) {
      case 'move':
        _enterMove(it.id);
      case 'size':
        _resize(it);
      case 'delete':
        _delete(it.id);
    }
  }

  // ---------------- move mode ----------------

  void _enterMove(String id) {
    final i = Store.dashboardItems().indexWhere((e) => e.id == id);
    if (i < 0) return;
    setState(() {
      _moving = true;
      _liftId = id;
      _hover = i;
      _dragging = false;
    });
    PluginBack.current = _backFn;
    WidgetsBinding.instance.addPostFrameCallback((_) => _show(id));
  }

  void _exitMove() {
    _auto?.cancel();
    _auto = null;
    if (PluginBack.current == _backFn) PluginBack.current = null;
    if (!mounted) return;
    setState(() {
      _moving = false;
      _liftId = null;
      _hover = -1;
      _dragging = false;
    });
  }

  /// Back: leaves move mode (the shell asks this before it does anything else with Back).
  bool _onBack() {
    if (!_moving) return false;
    _exitMove();
    return true;
  }

  void _show(String id) {
    final ctx = _slotKeys[id]?.currentContext;
    if (ctx != null && ctx.mounted) Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 150), alignment: 0.5);
  }

  /// The square under global y: above the first one is the first, below the last one is the last.
  int _indexAt(List<DashItem> items, double gy) {
    for (var k = 0; k < items.length; k++) {
      final box = _slotKeys[items[k].id]?.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached) continue;
      if (gy <= box.localToGlobal(Offset.zero).dy + box.size.height) return k;
    }
    return items.length - 1;
  }

  void _dragStart(double gy) {
    setState(() {
      _dragging = true;
      _dragY = gy;
    });
    _auto?.cancel();
    _auto = Timer.periodic(const Duration(milliseconds: 16), (_) => _autoScroll());
  }

  void _dragMove(double gy) {
    final items = Store.dashboardItems();
    setState(() {
      _dragY = gy;
      _hover = _indexAt(items, gy);
    });
  }

  /// Near the top or bottom edge the list scrolls under the finger so far squares can be reached.
  void _autoScroll() {
    if (!_dragging || !_scroll.hasClients) return;
    final box = _stackKey.currentContext?.findRenderObject();
    if (box is! RenderBox || !box.attached) return;
    final top = box.localToGlobal(Offset.zero).dy;
    final bottom = top + box.size.height;
    const edge = 80.0;
    var dy = 0.0;
    if (_dragY < top + edge) {
      dy = -((top + edge - _dragY) / edge).clamp(0.0, 1.5) * 14;
    } else if (_dragY > bottom - edge) {
      dy = ((_dragY - (bottom - edge)) / edge).clamp(0.0, 1.5) * 14;
    }
    if (dy == 0) return;
    final to = (_scroll.offset + dy).clamp(_scroll.position.minScrollExtent, _scroll.position.maxScrollExtent);
    if (to == _scroll.offset) return;
    _scroll.jumpTo(to);
    final items = Store.dashboardItems();
    setState(() => _hover = _indexAt(items, _dragY));
  }

  /// Letting go: the widget is placed on the square it is over, and move mode stays on until Back.
  void _dragEnd() {
    _auto?.cancel();
    _auto = null;
    final items = Store.dashboardItems();
    final from = items.indexWhere((e) => e.id == _liftId);
    final to = _hover;
    setState(() => _dragging = false);
    if (from >= 0 && to >= 0 && to != from) {
      _place(from, to);
      setState(() => _hover = to.clamp(0, items.length - 1));
    }
  }

  void _dragCancel() {
    _auto?.cancel();
    _auto = null;
    final i = Store.dashboardItems().indexWhere((e) => e.id == _liftId);
    setState(() {
      _dragging = false;
      _hover = i;
    });
  }

  /// D-pad in move mode: Up / Down pick the square, the centre button places the widget there.
  KeyEventResult _moveKey(FocusNode node, KeyEvent e) {
    final k = e.logicalKey;
    final items = Store.dashboardItems();
    final from = items.indexWhere((x) => x.id == _liftId);
    if (from < 0) return KeyEventResult.ignored;
    final down = e is KeyDownEvent || e is KeyRepeatEvent;
    if (k == LogicalKeyboardKey.arrowUp || k == LogicalKeyboardKey.arrowDown) {
      if (down) {
        final to = ((_hover < 0 ? from : _hover) + (k == LogicalKeyboardKey.arrowUp ? -1 : 1)).clamp(0, items.length - 1);
        setState(() => _hover = to);
        WidgetsBinding.instance.addPostFrameCallback((_) {
          final ctx = _slotKeys[items[to].id]?.currentContext;
          if (ctx != null && ctx.mounted) Scrollable.ensureVisible(ctx, duration: const Duration(milliseconds: 100), alignment: 0.5);
        });
      }
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowRight) return KeyEventResult.handled; // stay in the list
    if (k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.gameButtonA) {
      if (e is KeyDownEvent && _hover >= 0) {
        final to = _hover;
        _place(from, to);
        setState(() => _hover = to);
      }
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.escape) {
      if (e is KeyDownEvent) _exitMove();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.delete || k == LogicalKeyboardKey.backspace || k == LogicalKeyboardKey.gameButtonY) {
      if (e is KeyDownEvent) _deleteLifted();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  /// Delete from move mode (widgets that are empty right now do not show on the dashboard, so this is how they go).
  void _deleteLifted() {
    final id = _liftId;
    if (id == null) return;
    final items = Store.dashboardItems();
    final i = items.indexWhere((e) => e.id == id);
    if (i < 0) return;
    _delete(id);
    final left = [for (final e in items) if (e.id != id) e];
    if (left.isEmpty) {
      _exitMove();
      return;
    }
    final next = left[i.clamp(0, left.length - 1)];
    setState(() {
      _liftId = next.id;
      _hover = left.indexOf(next);
    });
  }

  Future<void> _add() async {
    _plugins = _fetchPlugins(); // a plugin installed since the page opened
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
        if (_moving) return _moveView(context, items);
        return ListView(
          padding: widget.padding,
          children: [
            Heading(
              'Dashboard',
              weather: true,
              trailing: PekButton(compact: true, label: 'Add widget', onTap: _add),
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
                  for (final it in items) {
                    final n = _widget(context, it, movies, shows, plugins);
                    if (n != null) nodes.add((w: _Holdable(onHold: () => _menu(it.id), child: n.w), span: n.span, full: n.full));
                  }
                  if (nodes.isEmpty) {
                    return items.isEmpty
                        ? const PekCard(title: 'Your dashboard is empty', subtitle: 'Tap Add widget.')
                        : const PekCard(title: 'Nothing to show yet', subtitle: 'Watch something or add favorites and they will appear here. Press and hold a widget to move or delete it.');
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
    void hold() => _menu(it.id);
    switch (it.type) {
      case 'clock':
        return (w: ClockTile(onLongPress: hold), span: span, full: false);
      case 'weather':
        return (w: WeatherCard(onLongPress: hold), span: 1, full: true);
      case 'plugin':
        final info = plugins.where((e) => e.folder == it.folder).firstOrNull;
        if (info == null) return null; // not installed: nothing to show (the edit view says so)
        return (
          w: DashTile(
            heading: info.name,
            body: 'Open plugin',
            onLongPress: hold,
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
        return (w: NowPlayingCard(onLongPress: hold, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'albums':
        return (w: AlbumsRow(onLongPress: hold, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'playlists':
        return (w: PlaylistsRow(onLongPress: hold, onOpenMusic: widget.onOpenMusic), span: 1, full: true);
      case 'stats':
        return (w: LibraryStatsTile(onLongPress: hold), span: span, full: false);
      case 'surprise':
        return (w: SurpriseTile(onLongPress: hold), span: span, full: false);
      case 'pinned':
        final pinned = <PluginInfo>[
          for (final f in PluginPins.all)
            for (final e in plugins)
              if (e.folder == f) e,
        ];
        if (pinned.isEmpty) return null; // nothing pinned: nothing to show (pin plugins from the Plugins page)
        return (w: PinnedPluginsRow(plugins: pinned, onLongPress: hold), span: 1, full: true);
      case 'shows':
        final list = shows.reversed.take(12).toList();
        if (list.isEmpty) return null;
        return _row(context, 'TV Shows', null, [
          for (final s in list)
            PosterCard(onLongPress: hold, holdSelect: true, 
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
            PosterCard(onLongPress: hold, holdSelect: true, 
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
            cells.add(PosterCard(onLongPress: hold, holdSelect: true, title: m.title, subtitle: m.year > 0 ? '${m.year}' : '', poster: Api.movieDetails(m.id), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m)))));
          } else {
            final key = Store.normalize(h.title);
            if (!seenShows.add(key)) continue; // one card per show, its latest episode
            final sh = shows.where((e) => Store.normalize(e.title) == key).firstOrNull;
            if (sh == null) continue;
            final label = h.season > 0 && h.episode > 0 ? 'S${h.season.toString().padLeft(2, '0')}E${h.episode.toString().padLeft(2, '0')}' : 'Watched';
            cells.add(PosterCard(onLongPress: hold, holdSelect: true, title: sh.title, subtitle: label, poster: Api.showDetails(sh.title), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: sh)))));
          }
        }
        if (cells.isEmpty) return null;
        return _row(context, 'Recently Watched', null, cells);
      case 'continue':
        final items = Store.resumeItems().take(12).toList();
        if (items.isEmpty) return null;
        return _row(context, 'Continue Watching', widget.onOpenResume, [
          for (final r in items)
            PosterCard(onLongPress: hold, holdSelect: true, 
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
            PosterCard(onLongPress: hold, holdSelect: true, 
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
              cells.add(PosterCard(onLongPress: hold, holdSelect: true, title: m.title, subtitle: m.year > 0 ? '${m.year}' : '', poster: Api.movieDetails(m.id), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m)))));
            }
          } else {
            final s = shows.where((e) => e.title == f.ref).firstOrNull;
            if (s != null) {
              cells.add(PosterCard(onLongPress: hold, holdSelect: true, title: s.title, subtitle: '${s.episodeCount} episodes', poster: Api.showDetails(s.title), onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s)))));
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

  // ---------------- move mode ----------------

  Widget _moveView(BuildContext context, List<DashItem> items) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final pad = widget.padding;
    final lift = items.where((e) => e.id == _liftId).firstOrNull;
    final from = items.indexWhere((e) => e.id == _liftId);
    final sqH = 4.6 * rem;
    for (final it in items) {
      _slotKeys.putIfAbsent(it.id, () => GlobalKey());
    }
    Widget square(int k, {bool floating = false}) {
      final it = items[k];
      final isLift = it.id == _liftId;
      final target = _hover == k && !isLift;
      final faded = isLift && _dragging && !floating;
      Widget box = AnimatedContainer(
        duration: const Duration(milliseconds: 90),
        height: sqH,
        padding: EdgeInsets.symmetric(horizontal: rem),
        decoration: BoxDecoration(
          color: floating ? t.glassStrong : (target ? t.accent.withAlpha(46) : t.surface),
          borderRadius: BorderRadius.circular(t.radius),
          border: Border.all(color: isLift || target ? t.accent : t.border, width: isLift || target ? 2 : 1),
          boxShadow: floating ? [BoxShadow(color: Colors.black.withAlpha(110), blurRadius: 18, offset: const Offset(0, 6))] : null,
        ),
        child: Row(children: [
          SizedBox(
            width: 2.2 * rem,
            child: isLift ? Icon(Icons.drag_indicator, color: t.accent) : Text('${k + 1}', style: TextStyle(color: t.textMuted, fontWeight: FontWeight.w700)),
          ),
          Expanded(
            child: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(_label(it), maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600)),
              Text(
                isLift ? (floating ? 'Let go on a square to place it' : 'Moving') : (target ? 'Place here' : _desc(it)),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 0.85 * rem, color: isLift || target ? t.accent : t.textMuted),
              ),
            ]),
          ),
        ]),
      );
      if (faded) box = Opacity(opacity: 0.35, child: box);
      if (isLift && !floating) {
        // Only the lifted widget drags; the other squares scroll the list as usual.
        box = GestureDetector(
          behavior: HitTestBehavior.opaque,
          dragStartBehavior: DragStartBehavior.down,
          onVerticalDragStart: (d) => _dragStart(d.globalPosition.dy),
          onVerticalDragUpdate: (d) => _dragMove(d.globalPosition.dy),
          onVerticalDragEnd: (_) => _dragEnd(),
          onVerticalDragCancel: _dragCancel,
          child: box,
        );
      }
      return box;
    }

    double floatTop() {
      final box = _stackKey.currentContext?.findRenderObject();
      if (box is! RenderBox || !box.attached) return 0;
      return box.globalToLocal(Offset(0, _dragY)).dy - sqH / 2;
    }

    final hint = p.isTv
        ? 'Up / Down choose a square, OK places it. Back when you are done.'
        : 'Drag it up or down and let go on a square to place it. Back when you are done.';
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Padding(
        padding: EdgeInsets.fromLTRB(pad.left, pad.top, pad.right, 0),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(lift == null ? 'Move' : 'Moving ${_label(lift)}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.5 * rem, fontWeight: FontWeight.w800)),
          SizedBox(height: 0.35 * rem),
          Text(hint, style: TextStyle(color: t.textMuted)),
          SizedBox(height: 0.7 * rem),
          Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            PekButton(compact: true, shrink: true, label: 'Delete', onTap: _deleteLifted),
            PekButton(compact: true, shrink: true, label: 'Done', primary: true, onTap: _exitMove),
          ]),
          SizedBox(height: 0.8 * rem),
        ]),
      ),
      Expanded(
        child: Focus(
          autofocus: true,
          onKeyEvent: _moveKey,
          child: Stack(key: _stackKey, children: [
            SingleChildScrollView(
              controller: _scroll,
              padding: EdgeInsets.fromLTRB(pad.left, 0, pad.right, pad.bottom + rem),
              child: Column(children: [
                for (var k = 0; k < items.length; k++)
                  Padding(
                    key: _slotKeys[items[k].id],
                    padding: EdgeInsets.only(bottom: 0.6 * rem),
                    child: square(k),
                  ),
              ]),
            ),
            if (_dragging && from >= 0)
              Positioned(
                left: pad.left,
                right: pad.right,
                top: floatTop(),
                height: sqH,
                child: IgnorePointer(child: square(from, floating: true)),
              ),
          ]),
        ),
      ),
    ]);
  }
}

/// Wraps one dashboard widget so a press-and-hold on touch, or the Menu / X button on a remote, opens its menu. (Holding the
/// centre button is handled by the tiles themselves, see `holdSelect` in [PekFocusable].)
class _Holdable extends StatelessWidget {
  const _Holdable({required this.child, required this.onHold});
  final Widget child;
  final VoidCallback onHold;

  @override
  Widget build(BuildContext context) {
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: (node, e) {
        if (e.logicalKey == LogicalKeyboardKey.contextMenu || e.logicalKey == LogicalKeyboardKey.gameButtonX) {
          if (e is KeyDownEvent) onHold();
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: GestureDetector(behavior: HitTestBehavior.translucent, onLongPress: onHold, child: child),
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
