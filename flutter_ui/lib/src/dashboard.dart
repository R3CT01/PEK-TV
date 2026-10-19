import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'detail.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart';
import 'widgets.dart';

/// The Dashboard tab (app_dashboard.js): a clock and a stack of widgets, each one a row of posters.
/// Widgets here: Continue Watching, Recently Added, Favorites. Which ones show (and their order) is saved on the device.
/// Clock and Weather are widgets too (Weather: Open-Meteo, like plugins/weather). Plugin shortcut tiles need the plugin runtime.
class DashboardPage extends StatefulWidget {
  const DashboardPage({super.key, required this.padding, required this.onOpenResume, required this.onOpenFavorites});
  final EdgeInsets padding;
  final VoidCallback onOpenResume;
  final VoidCallback onOpenFavorites;

  @override
  State<DashboardPage> createState() => _DashboardPageState();
}

class _DashboardPageState extends State<DashboardPage> {
  late Future<(List<Movie>, List<Show>)> _lib = _load();
  Timer? _tick;
  DateTime _now = DateTime.now();

  Future<(List<Movie>, List<Show>)> _load() async {
    final m = await Api.movies().catchError((_) => <Movie>[]);
    final s = await Api.shows().catchError((_) => <Show>[]);
    return (m, s);
  }

  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 20), (_) {
      if (mounted) setState(() => _now = DateTime.now());
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  String get _time {
    final h = _now.hour % 12 == 0 ? 12 : _now.hour % 12;
    return '$h:${_now.minute.toString().padLeft(2, '0')} ${_now.hour < 12 ? 'AM' : 'PM'}';
  }

  String get _date {
    const d = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return '${d[_now.weekday - 1]}, ${m[_now.month - 1]} ${_now.day}';
  }

  Future<void> _customize() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: context.pek.tokens.glassStrong,
      builder: (c) => const _Customize(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final widgets = Store.dashboard();
        return ListView(
          padding: widget.padding,
          children: [
            Heading('Dashboard', trailing: PekButton(compact: true, label: 'Customize', onTap: _customize)),
            FutureBuilder<(List<Movie>, List<Show>)>(
              future: _lib,
              builder: (context, snap) {
                final movies = snap.data?.$1 ?? const <Movie>[];
                final shows = snap.data?.$2 ?? const <Show>[];
                if (widgets.isEmpty) return PekCard(title: 'Nothing on your dashboard', subtitle: 'Tap Customize to add widgets.');
                return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  for (final w in widgets) _widget(context, w, movies, shows),
                ]);
              },
            ),
          ],
        );
      },
    );
  }

  Widget _widget(BuildContext context, String type, List<Movie> movies, List<Show> shows) {
    switch (type) {
      case 'clock':
        return Padding(padding: EdgeInsets.only(bottom: 1.25 * context.pek.rem), child: PekCard(title: _time, subtitle: _date));
      case 'weather':
        return Padding(padding: EdgeInsets.only(bottom: 1.25 * context.pek.rem), child: const WeatherTile());
      case 'continue':
        final items = Store.resumeItems().take(12).toList();
        return _row(context, 'Continue Watching', 'Nothing to resume yet.', widget.onOpenResume, [
          for (final it in items)
            PosterCard(
              title: it.title,
              subtitle: it.duration > 0 ? '${(100 * it.position / it.duration).round()}% watched' : formatTime(it.position),
              poster: it.kind == 'movie' ? Api.movieDetails(it.id) : Api.showDetails(it.showTitle),
              onTap: () => playMedia(context, it, startSec: it.position),
            ),
        ]);
      case 'recent':
        final items = movies.reversed.take(12).toList();
        return _row(context, 'Recently Added', 'No movies yet.', null, [
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
        return _row(context, 'Favorites', 'Open a movie or show and tap \u2661 Favorite.', widget.onOpenFavorites, cells);
    }
    return const SizedBox.shrink();
  }

  /// One widget: a heading (tap = see all) and a horizontal row of posters.
  Widget _row(BuildContext context, String title, String empty, VoidCallback? more, List<Widget> cells) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final w = p.compact ? 110.0 : (p.isTv ? 8 * rem : 150.0);
    return Padding(
      padding: EdgeInsets.only(bottom: 1.5 * rem),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700))),
          if (more != null) PekButton(compact: true, label: 'See all', onTap: more),
        ]),
        SizedBox(height: 0.75 * rem),
        if (cells.isEmpty)
          Text(empty, style: TextStyle(color: t.textMuted))
        else
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
}

/// Add / remove / reorder the dashboard widgets (_dashAdd / _dashMove / _dashRemove / _dashReset in app_dashboard.js).
class _Customize extends StatelessWidget {
  const _Customize();

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final on = Store.dashboard();
        final off = Store.dashTypes.keys.where((k) => !on.contains(k)).toList();
        void move(int i, int d) {
          final l = List.of(on);
          final j = i + d;
          if (j < 0 || j >= l.length) return;
          final x = l[i];
          l[i] = l[j];
          l[j] = x;
          Store.setDashboard(l);
        }

        return SafeArea(
          child: SingleChildScrollView(
            padding: EdgeInsets.all(rem),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Customize dashboard', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
              SizedBox(height: rem),
              for (var i = 0; i < on.length; i++)
                ListRow(
                  title: Store.dashTypes[on[i]]!.$1,
                  subtitle: Store.dashTypes[on[i]]!.$2,
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    IconButton(onPressed: i == 0 ? null : () => move(i, -1), icon: const Icon(Icons.arrow_upward)),
                    IconButton(onPressed: i == on.length - 1 ? null : () => move(i, 1), icon: const Icon(Icons.arrow_downward)),
                    IconButton(onPressed: () => Store.setDashboard(on.where((e) => e != on[i]).toList()), icon: const Icon(Icons.close)),
                  ]),
                ),
              if (off.isNotEmpty) ...[
                SizedBox(height: rem),
                Text('Add', style: TextStyle(fontWeight: FontWeight.w600, color: p.tokens.textMuted)),
                SizedBox(height: 0.5 * rem),
                Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
                  for (final k in off) PekButton(compact: true, label: '+ ${Store.dashTypes[k]!.$1}', onTap: () => Store.setDashboard([...on, k])),
                ]),
              ],
              SizedBox(height: rem),
              PekButton(compact: true, label: 'Reset to default', onTap: () => Store.setDashboard(List.of(Store.dashDefault))),
            ]),
          ),
        );
      },
    );
  }
}
