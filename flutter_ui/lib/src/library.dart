import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'detail.dart';
import 'common.dart';
import 'pages.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Movies / TV Shows tabs: `_renderHeader(title, showRefresh)` + `_renderLibrary(tab)` in app_library.js.
class LibraryPage extends StatefulWidget {
  const LibraryPage({super.key, required this.tab, required this.title, required this.padding});
  final String tab; // 'movies' | 'shows'
  final String title;
  final EdgeInsets padding;

  @override
  State<LibraryPage> createState() => _LibraryPageState();
}

class _LibraryPageState extends State<LibraryPage> {
  late Future<List<Object>> _data = _load();
  bool _refreshing = false;
  bool _scanning = false; // any scan on the server: startup, Refresh, or a source that was just added
  int _cooldown = 0;
  Timer? _timer;
  Timer? _watch;
  bool _polling = false;

  @override
  void initState() {
    super.initState();
    _watch = Timer.periodic(const Duration(seconds: 2), (_) => _checkScan());
    _checkScan();
  }

  /// Asks the server whether it is scanning; when a scan has just finished the library is read again.
  Future<void> _checkScan() async {
    if (_polling) return;
    _polling = true;
    final now = await Api.scanning();
    _polling = false;
    if (!mounted) return;
    final was = _scanning;
    if (now != was) {
      setState(() => _scanning = now);
      if (was && !now && !_refreshing) {
        Api.forgetLibrary();
        setState(() => _data = _load());
      }
    }
  }

  Future<List<Object>> _load() async => widget.tab == 'movies' ? await Api.movies() : await Api.shows();

  @override
  void dispose() {
    _timer?.cancel();
    _watch?.cancel();
    super.dispose();
  }

  void _startCooldown(int seconds) {
    _timer?.cancel();
    setState(() => _cooldown = seconds);
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      setState(() => _cooldown = _cooldown - 1);
      if (_cooldown <= 0) t.cancel();
    });
  }

  /// rescan() in app_sources.js: POST /api/rescan, poll /api/scan-status for up to a minute, then reload the library.
  Future<void> _rescan() async {
    if (_refreshing || _cooldown > 0) return;
    _startCooldown(10);
    setState(() => _refreshing = true);
    try {
      final wait = await Api.rescan();
      if (wait != null) {
        _startCooldown(wait);
      } else {
        for (var i = 0; i < 60; i++) {
          await Future<void>.delayed(const Duration(seconds: 1));
          if (!await Api.scanning()) break;
        }
      }
    } catch (_) {}
    if (!mounted) return;
    Api.forgetLibrary();
    setState(() {
      _refreshing = false;
      _data = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;

    final blocked = _refreshing || _cooldown > 0;
    final label = _refreshing ? 'Scanning\u2026' : (_cooldown > 0 ? 'Refresh ($_cooldown' 's)' : 'Refresh');
    final refresh = PekButton(
      compact: true,
      label: label,
      onTap: blocked ? null : _rescan,
      leading: Spin(spinning: _refreshing, child: Text('\u21bb', style: TextStyle(fontSize: 1.1 * rem, height: 1, color: t.accent))),
    );

    final header = Padding(
      padding: EdgeInsets.only(bottom: (p.isTv ? 2 : 1.5) * rem),
      child: Row(
        children: [
          Expanded(child: Text(widget.title, style: TextStyle(fontSize: 2 * rem, fontWeight: FontWeight.w700))),
          SizedBox(width: rem),
          refresh,
        ],
      ),
    );

    return CustomScrollView(
      slivers: [
        SliverPadding(
          padding: widget.padding.copyWith(bottom: 0),
          sliver: SliverToBoxAdapter(child: header),
        ),
        if (_scanning || _refreshing)
          SliverPadding(
            padding: EdgeInsets.only(left: widget.padding.left, right: widget.padding.right),
            sliver: const SliverToBoxAdapter(child: ScanLine(label: 'Scanning your library\u2026')),
          ),
        FutureBuilder<List<Object>>(
          future: _data,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return SliverPadding(
                padding: widget.padding.copyWith(top: 0),
                sliver: SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(2 * rem), child: Text('Loading your library\u2026', style: TextStyle(color: t.textMuted)))),
              );
            }
            if (snap.hasError) {
              return SliverPadding(
                padding: widget.padding.copyWith(top: 0),
                sliver: const SliverToBoxAdapter(child: PekCard(title: 'Could not load library', subtitle: 'The backend did not respond. Is the server running?')),
              );
            }
            final items = snap.data ?? const <Object>[];
            if (items.isEmpty) return _empty(context);
            return SliverPadding(
              padding: widget.padding.copyWith(top: 0),
              sliver: PekGridSliver(
                count: items.length,
                // .sx-poster-grid: minmax(200px, 1fr), gap 1rem (1.25rem on TV); on small screens 110px and 0.6rem.
                minWidth: p.compact ? 110 : 200,
                gap: p.compact ? 0.6 * rem : (p.isTv ? 1.25 : 1) * rem,
                builder: (context, i) => _cell(context, items[i], i),
              ),
            );
          },
        ),
      ],
    );
  }

  Widget _cell(BuildContext context, Object item, int i) {
    if (item is Movie) {
      return PosterCard(
        title: item.title,
        subtitle: item.year > 0 ? '${item.year}' : '',
        poster: Api.movieDetails(item.id),
        onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: item))),
      );
    }
    final s = item as Show;
    return PosterCard(
      title: s.title,
      subtitle: '${s.episodeCount} episodes',
      poster: Api.showDetails(s.title),
      onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s))),
    );
  }

  /// _renderEmptyLibrary(): "No movies yet" + the add-source button (Settings > Media sources).
  Widget _empty(BuildContext context) {
    final rem = context.pek.rem;
    final what = widget.tab == 'movies' ? 'movies' : 'shows';
    return SliverPadding(
      padding: widget.padding.copyWith(top: 0),
      sliver: SliverToBoxAdapter(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PekCard(
              title: _scanning ? 'Scanning your library\u2026' : 'No $what yet',
              subtitle: _scanning ? 'Your $what appear here when the scan finishes.' : 'Add a media folder and PEK TV will scan it and sort your videos here.',
            ),
            SizedBox(height: 1.25 * rem),
            PekButton(
              label: 'Add a source',
              primary: true,
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (c) => SubScreen(title: 'Settings', body: SettingsPage(padding: c.pek.pagePad)))),
            ),
          ],
        ),
      ),
    );
  }
}
