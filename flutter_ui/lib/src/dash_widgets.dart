import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'api.dart';
import 'clock.dart';
import 'common.dart';
import 'detail.dart';
import 'music.dart' show Art, AlbumScreen;
import 'music_controller.dart';
import 'music_fullscreen.dart' show openNowPlaying;
import 'playlist_ui.dart' show PlaylistScreen;
import 'playlists.dart';
import 'plugin_store_ui.dart' show PluginPicture;
import 'plugin_ui.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart';
import 'widgets.dart';

/// The extra Dashboard modules (Add widget > Music, Weather, Library, Plugins). Each one is a self-contained widget: it loads
/// what it needs, keeps itself up to date and takes `onLongPress` so a press-and-hold still opens Customize.
///
/// Full-width modules: [NowPlayingCard], [ForecastCard], [AlbumsRow], [PlaylistsRow], [PinnedPluginsRow].
/// Tiles (1 or 2 columns): [LibraryStatsTile], [SurpriseTile].

final _mc = MusicController.instance;

/// A heading (with an optional "See all") over a horizontal row of cells, all [cellW] wide and [cellH] high.
class DashRow extends StatelessWidget {
  const DashRow({super.key, required this.title, required this.cellW, required this.cellH, required this.cells, this.more, this.onLongPress});
  final String title;
  final double cellW, cellH;
  final List<Widget> cells;
  final VoidCallback? more;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return GestureDetector(
      onLongPress: onLongPress,
      behavior: HitTestBehavior.translucent,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700))),
          if (more != null) PekButton(compact: true, label: 'See all', onTap: more),
        ]),
        SizedBox(height: 0.75 * rem),
        SizedBox(
          height: cellH,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            clipBehavior: Clip.none,
            itemCount: cells.length,
            separatorBuilder: (_, __) => SizedBox(width: 0.75 * rem),
            itemBuilder: (_, i) => SizedBox(width: cellW, child: cells[i]),
          ),
        ),
      ]),
    );
  }
}

/// A square picture with a title and a line under it (albums, playlists).
class SquareCard extends StatelessWidget {
  const SquareCard({super.key, required this.title, required this.subtitle, required this.artUrl, required this.size, required this.onTap});
  final String title, subtitle, artUrl;
  final double size;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return PekFocusable(
      onTap: onTap,
      radius: 12,
      padding: EdgeInsets.all(0.25 * rem),
      focusScale: p.isTv ? 1.04 : 1.0,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Art(url: artUrl, size: size - 0.5 * rem, radius: 10),
        SizedBox(height: 0.4 * rem),
        Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 0.92 * rem)),
        Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
      ]),
    );
  }
}

double _cell(PekScope p) => p.compact ? 120.0 : (p.isTv ? 9 * p.rem : 150.0);

// ====================================================================== Now Playing

/// The music that is playing now: cover, title, artist, a progress bar and the controls. Tap = the full-screen player. When
/// nothing is loaded it says so (tap = go to Music).
class NowPlayingCard extends StatelessWidget {
  const NowPlayingCard({super.key, this.onLongPress, this.onOpenMusic});
  final VoidCallback? onLongPress;
  final VoidCallback? onOpenMusic;

  Widget _ctl(IconData icon, String tip, VoidCallback? on, {bool active = false, double? size}) {
    return Builder(builder: (context) {
      final t = context.pek.tokens;
      return IconButton(
        tooltip: tip,
        visualDensity: VisualDensity.compact,
        iconSize: size ?? 26,
        color: active ? t.accent : t.text,
        onPressed: on,
        icon: Icon(icon),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ValueListenableBuilder<Track?>(
      valueListenable: _mc.current,
      builder: (context, cur, _) {
        if (cur == null) {
          return DashTile(heading: 'Nothing playing', body: 'Start a song in Music and it shows up here.', onTap: onOpenMusic, onLongPress: onLongPress);
        }
        return PekFocusable(
          onTap: () => openNowPlaying(context),
          onLongPress: onLongPress,
          radius: t.radius,
          background: t.surface,
          padding: EdgeInsets.all(1.1 * rem),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Art(url: Api.trackArt(cur), size: 5.5 * rem, radius: 12),
              SizedBox(width: 1 * rem),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  ValueListenableBuilder<bool>(
                    valueListenable: _mc.playing,
                    builder: (_, on, __) => Text(on ? 'NOW PLAYING' : 'PAUSED', style: TextStyle(fontSize: 0.72 * rem, letterSpacing: 1.2, fontWeight: FontWeight.w700, color: t.accent)),
                  ),
                  SizedBox(height: 0.25 * rem),
                  Text(cur.title.isEmpty ? 'Unknown song' : cur.title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700, height: 1.15)),
                  if (cur.artist.isNotEmpty) Text(cur.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.95 * rem)),
                  if (cur.album.isNotEmpty) Text(cur.album, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted.withAlpha(190), fontSize: 0.82 * rem)),
                ]),
              ),
            ]),
            SizedBox(height: 0.9 * rem),
            ValueListenableBuilder<double>(
              valueListenable: _mc.position,
              builder: (_, pos, __) => ValueListenableBuilder<double>(
                valueListenable: _mc.duration,
                builder: (_, dur, __) => Row(children: [
                  Text(formatTime(pos), style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
                  SizedBox(width: 0.6 * rem),
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(4),
                      child: LinearProgressIndicator(value: dur > 0 ? (pos / dur).clamp(0.0, 1.0) : 0, minHeight: 4, color: t.accent, backgroundColor: t.textMuted.withAlpha(50)),
                    ),
                  ),
                  SizedBox(width: 0.6 * rem),
                  Text(dur > 0 ? formatTime(dur) : '--:--', style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
                ]),
              ),
            ),
            SizedBox(height: 0.3 * rem),
            // FittedBox: five round buttons always fit, even on a narrow phone, instead of overflowing.
            Align(
              alignment: Alignment.center,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Row(mainAxisSize: MainAxisSize.min, children: [
                  ValueListenableBuilder<bool>(valueListenable: _mc.shuffle, builder: (_, on, __) => _ctl(Icons.shuffle, 'Shuffle', _mc.toggleShuffle, active: on, size: 22)),
                  _ctl(Icons.skip_previous, 'Previous', () => _mc.prev(), size: 32),
                  ValueListenableBuilder<bool>(valueListenable: _mc.playing, builder: (_, on, __) => _ctl(on ? Icons.pause_circle_filled : Icons.play_circle_fill, on ? 'Pause' : 'Play', _mc.toggle, size: 52)),
                  _ctl(Icons.skip_next, 'Next', () => _mc.next(), size: 32),
                  ValueListenableBuilder<bool>(valueListenable: _mc.repeat, builder: (_, on, __) => _ctl(Icons.repeat, 'Repeat', _mc.toggleRepeat, active: on, size: 22)),
                ]),
              ),
            ),
          ]),
        );
      },
    );
  }
}

// ====================================================================== Forecast

/// A scrollable forecast: the next 24 hours, or the next 7 days (the person's choice, remembered). Same city and unit as the
/// Weather tile; tap a card = Weather settings.
class ForecastCard extends StatefulWidget {
  const ForecastCard({super.key, this.onLongPress});
  final VoidCallback? onLongPress;
  @override
  State<ForecastCard> createState() => _ForecastCardState();
}

class _ForecastCardState extends State<ForecastCard> {
  static const _kMode = 'pek_forecast_daily';
  WeatherForecast? _f;
  bool _loading = false;
  bool _failed = false;
  Timer? _timer;
  int _seq = 0;

  bool get _daily => Store.strGet(_kMode, scoped: false) == '1';

  @override
  void initState() {
    super.initState();
    Weather.changes.addListener(_refresh);
    _refresh();
    _timer = Timer.periodic(const Duration(minutes: 30), (_) => _refresh());
  }

  @override
  void dispose() {
    Weather.changes.removeListener(_refresh);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final c = Weather.city;
    final seq = ++_seq;
    if (c == null) {
      if (mounted) setState(() => _f = null);
      return;
    }
    final cached = Weather.lastForecast(c.label);
    if (mounted) {
      setState(() {
        _f = cached;
        _loading = true;
        _failed = false;
      });
    }
    final fresh = await Weather.fetchForecast(c.lat, c.lon, c.label);
    if (!mounted || seq != _seq) return;
    setState(() {
      _loading = false;
      if (fresh != null) {
        _f = fresh;
      } else {
        _failed = cached == null;
      }
    });
  }

  void _open() => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const WeatherSettingsScreen()));

  Future<void> _setDaily(bool v) async {
    await Store.strSet(_kMode, v ? '1' : '0', scoped: false);
    if (mounted) setState(() {});
  }

  static const _days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  String _hourLabel(ForecastHour h, int index, bool h12) {
    if (index == 0) return 'Now';
    if (!h12) return '${h.hour.toString().padLeft(2, '0')}:00';
    final x = h.hour % 12 == 0 ? 12 : h.hour % 12;
    return '$x ${h.hour < 12 ? 'AM' : 'PM'}';
  }

  String _dayLabel(ForecastDay d, int index) {
    if (index == 0) return 'Today';
    final dt = DateTime.tryParse(d.date);
    return dt == null ? d.date : _days[dt.weekday - 1];
  }

  Widget _card(BuildContext context, {required String label, required IconData icon, required String top, String? bottom, required int rain, VoidCallback? onTap}) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return PekFocusable(
      onTap: onTap ?? _open,
      radius: 14,
      background: t.surfaceFocused.withAlpha(90),
      padding: EdgeInsets.symmetric(horizontal: 0.4 * rem, vertical: 0.8 * rem),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text(label, maxLines: 1, style: TextStyle(fontSize: 0.82 * rem, color: t.textMuted, fontWeight: FontWeight.w600)),
        SizedBox(height: 0.5 * rem),
        Icon(icon, size: 1.9 * rem, color: t.accent),
        SizedBox(height: 0.5 * rem),
        Text(top, maxLines: 1, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w700)),
        Text(bottom ?? ' ', maxLines: 1, style: TextStyle(fontSize: 0.9 * rem, color: t.textMuted)),
        SizedBox(height: 0.3 * rem),
        // The chance of rain keeps its line even when it is low, so every card is the same height.
        Text(rain >= 10 ? '$rain%' : ' ', maxLines: 1, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
      ]),
    );
  }

  /// A day card: high and low spelled out ("H 65\u00b0" / "L 48\u00b0"); tap = the details of that day.
  Widget _dayCard(BuildContext context, ForecastDay d, int index, bool h12) => _card(
        context,
        label: _dayLabel(d, index),
        icon: Weather.iconFor(d.code),
        top: 'H ${Weather.degrees(d.hiC)}',
        bottom: 'L ${Weather.degrees(d.loC)}',
        rain: d.rain,
        onTap: () => _showDay(context, d, index, h12),
      );

  void _showDay(BuildContext context, ForecastDay d, int index, bool h12) {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      showDragHandle: true,
      backgroundColor: context.pek.tokens.glassStrong,
      builder: (c) => _DayDetails(day: d, title: _dayTitle(d, index), h12: h12),
    );
  }

  static const _longDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  static const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  String _dayTitle(ForecastDay d, int index) {
    final dt = DateTime.tryParse(d.date);
    if (dt == null) return d.date;
    final name = '${_longDays[dt.weekday - 1]}, ${_months[dt.month - 1]} ${dt.day}';
    return index == 0 ? 'Today \u00b7 $name' : name;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final city = Weather.city;
    if (city == null) {
      return DashTile(heading: 'Forecast', body: 'Tap to choose your city', onTap: _open, onLongPress: widget.onLongPress);
    }
    final daily = _daily;
    final h12 = Clock.hour12(context);
    final cardW = p.isTv ? 6.5 * rem : 5.4 * rem;
    final f = _f;
    final cards = <Widget>[];
    if (f != null) {
      if (daily) {
        final ds = f.upcomingDays();
        for (var i = 0; i < ds.length; i++) {
          cards.add(_dayCard(context, ds[i], i, h12));
        }
      } else {
        final hs = f.nextHours(24);
        for (var i = 0; i < hs.length; i++) {
          cards.add(_card(context, label: _hourLabel(hs[i], i, h12), icon: Weather.iconFor(hs[i].code, day: hs[i].day), top: Weather.degrees(hs[i].tempC), rain: hs[i].rain));
        }
      }
    }
    Widget body;
    if (cards.isEmpty) {
      body = Padding(
        padding: EdgeInsets.symmetric(vertical: 1.2 * rem),
        child: Text(_failed ? 'Could not load the forecast. Check your connection.' : (_loading ? 'Loading the forecast\u2026' : 'No forecast yet.'), style: TextStyle(color: t.textMuted)),
      );
    } else {
      // No fixed height: the row is as tall as its tallest card, so a bigger phone font can never overflow it.
      body = SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: IntrinsicHeight(
          child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            for (var i = 0; i < cards.length; i++) ...[
              if (i > 0) SizedBox(width: 0.6 * rem),
              SizedBox(width: cardW, child: cards[i]),
            ],
          ]),
        ),
      );
    }
    return GestureDetector(
      onLongPress: widget.onLongPress,
      behavior: HitTestBehavior.translucent,
      child: Container(
        padding: EdgeInsets.fromLTRB(1.1 * rem, 1 * rem, 1.1 * rem, 1 * rem),
        decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.radius)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text('Forecast \u00b7 ${city.label}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w700)),
            ),
            SizedBox(width: 0.5 * rem),
            PekButton(compact: true, primary: !daily, label: 'Hourly', onTap: () => _setDaily(false)),
            SizedBox(width: 0.4 * rem),
            PekButton(compact: true, primary: daily, label: 'Daily', onTap: () => _setDaily(true)),
          ]),
          SizedBox(height: 0.8 * rem),
          body,
        ]),
      ),
    );
  }
}

/// The details of one forecast day, in a bottom sheet: high / low, feels like, rain, wind, UV, sunrise and sunset.
class _DayDetails extends StatelessWidget {
  const _DayDetails({required this.day, required this.title, required this.h12});
  final ForecastDay day;
  final String title;
  final bool h12;

  /// "07:12" or "7:12 AM" from "2026-10-22T07:12".
  String _clock(String iso) {
    if (iso.length < 16) return iso;
    final h = int.tryParse(iso.substring(11, 13)) ?? 0;
    final m = iso.substring(14, 16);
    if (!h12) return '${h.toString().padLeft(2, '0')}:$m';
    return '${h % 12 == 0 ? 12 : h % 12}:$m ${h < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final d = day;
    final rows = <(IconData, String, String)>[
      (Icons.thermostat, 'Feels like', d.feelsHiC != null && d.feelsLoC != null ? '${Weather.degrees(d.feelsHiC!)} / ${Weather.degrees(d.feelsLoC!)}' : ''),
      (Icons.water_drop, 'Chance of rain', '${d.rain}%'),
      (Icons.umbrella, 'Precipitation', d.precipMm != null ? Weather.amount(d.precipMm!) : ''),
      (Icons.air, 'Wind', d.windKmh != null ? '${Weather.speed(d.windKmh!)}${d.windDir != null ? ' ${Weather.compass(d.windDir!)}' : ''}' : ''),
      (Icons.storm, 'Wind gusts', d.gustKmh != null ? Weather.speed(d.gustKmh!) : ''),
      (Icons.wb_sunny_outlined, 'UV index', d.uv != null ? '${d.uv!.round()} \u00b7 ${Weather.uvLabel(d.uv!)}' : ''),
      (Icons.wb_twilight, 'Sunrise', d.sunrise != null ? _clock(d.sunrise!) : ''),
      (Icons.nights_stay_outlined, 'Sunset', d.sunset != null ? _clock(d.sunset!) : ''),
    ].where((r) => r.$3.isNotEmpty).toList();
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(1.25 * rem, 0, 1.25 * rem, 1.5 * rem),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700)),
        SizedBox(height: 0.9 * rem),
        Row(children: [
          Icon(Weather.iconFor(d.code), size: 2.8 * rem, color: t.accent),
          SizedBox(width: 0.9 * rem),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('H ${Weather.degrees(d.hiC)}  \u00b7  L ${Weather.degrees(d.loC)}', style: TextStyle(fontSize: 1.5 * rem, fontWeight: FontWeight.w700)),
              Text(Weather.describe(d.code), style: TextStyle(fontSize: 0.95 * rem, color: t.textMuted)),
            ]),
          ),
        ]),
        SizedBox(height: 1 * rem),
        for (final r in rows)
          Padding(
            padding: EdgeInsets.symmetric(vertical: 0.5 * rem),
            child: Row(children: [
              Icon(r.$1, size: 1.3 * rem, color: t.textMuted),
              SizedBox(width: 0.75 * rem),
              Expanded(child: Text(r.$2, style: TextStyle(fontSize: 0.95 * rem, color: t.textMuted))),
              Text(r.$3, style: TextStyle(fontSize: 1 * rem, fontWeight: FontWeight.w600)),
            ]),
          ),
      ]),
    );
  }
}

// ====================================================================== Music rows

/// Albums from the music library (a row of covers, tap = the album, See all = the Music tab).
class AlbumsRow extends StatefulWidget {
  const AlbumsRow({super.key, this.onLongPress, this.onOpenMusic});
  final VoidCallback? onLongPress;
  final VoidCallback? onOpenMusic;
  @override
  State<AlbumsRow> createState() => _AlbumsRowState();
}

class _AlbumsRowState extends State<AlbumsRow> {
  late final Future<List<Album>> _albums = Api.musicLibrary().then((l) {
    // A different handful each day, the same all day: the row does not reshuffle on every redraw.
    final now = DateTime.now();
    final rnd = math.Random(now.year * 10000 + now.month * 100 + now.day);
    final a = List<Album>.of(l.albums)..shuffle(rnd);
    return a.take(15).toList();
  }).catchError((_) => <Album>[]);

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final w = _cell(p);
    return FutureBuilder<List<Album>>(
      future: _albums,
      builder: (context, snap) {
        final albums = snap.data ?? const <Album>[];
        if (albums.isEmpty) {
          return DashTile(
            heading: 'Albums',
            body: snap.connectionState == ConnectionState.done ? 'No music found yet. Add a music folder in Settings.' : 'Loading\u2026',
            onTap: widget.onOpenMusic,
            onLongPress: widget.onLongPress,
          );
        }
        return DashRow(
          title: 'Albums',
          more: widget.onOpenMusic,
          onLongPress: widget.onLongPress,
          cellW: w,
          cellH: w + 3.2 * p.rem,
          cells: [
            for (final a in albums)
              SquareCard(
                title: a.title,
                subtitle: a.artist,
                artUrl: a.art ? Api.albumArt(a.id) : '',
                size: w,
                onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AlbumScreen(albumId: a.id, title: a.title))),
              ),
          ],
        );
      },
    );
  }
}

/// The person's playlists (tap = the playlist).
class PlaylistsRow extends StatelessWidget {
  const PlaylistsRow({super.key, this.onLongPress, this.onOpenMusic});
  final VoidCallback? onLongPress;
  final VoidCallback? onOpenMusic;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final w = _cell(p);
    return ListenableBuilder(
      listenable: Playlists.instance,
      builder: (context, _) {
        final lists = Playlists.instance.all;
        if (lists.isEmpty) {
          return DashTile(heading: 'Playlists', body: 'Make a playlist in Music and it shows up here.', onTap: onOpenMusic, onLongPress: onLongPress);
        }
        return DashRow(
          title: 'Playlists',
          more: onOpenMusic,
          onLongPress: onLongPress,
          cellW: w,
          cellH: w + 3.2 * p.rem,
          cells: [
            for (final pl in lists)
              SquareCard(
                title: pl.name,
                subtitle: '${pl.tracks.length} song${pl.tracks.length == 1 ? '' : 's'}',
                artUrl: pl.cover == null ? '' : Api.trackArt(pl.cover!),
                size: w,
                onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => PlaylistScreen(id: pl.id))),
              ),
          ],
        );
      },
    );
  }
}

// ====================================================================== Plugins

/// The plugins pinned on the More page, as a row of icons. Tap = open the plugin.
class PinnedPluginsRow extends StatelessWidget {
  const PinnedPluginsRow({super.key, required this.plugins, this.onLongPress});
  final List<PluginInfo> plugins;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final w = p.isTv ? 7.5 * rem : 5.8 * rem;
    return DashRow(
      title: 'Pinned plugins',
      onLongPress: onLongPress,
      cellW: w,
      cellH: 6.6 * rem,
      cells: [
        for (final info in plugins)
          PekFocusable(
            onTap: () {
              if (!info.flutterScreen) {
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('This plugin has no screen for this app yet')));
                return;
              }
              openPluginScreen(context, pluginId: info.folder, title: info.name);
            },
            radius: 14,
            background: t.surface,
            padding: EdgeInsets.symmetric(horizontal: 0.4 * rem, vertical: 0.7 * rem),
            child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
              PluginPicture(url: info.icon, size: 2.8 * rem, letter: info.name.isEmpty ? '?' : info.name.substring(0, 1)),
              SizedBox(height: 0.5 * rem),
              Text(info.name, maxLines: 2, textAlign: TextAlign.center, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.8 * rem, fontWeight: FontWeight.w600, height: 1.15)),
            ]),
          ),
      ],
    );
  }
}

// ====================================================================== Tiles

/// How much is in the library: movies, shows and songs.
class LibraryStatsTile extends StatefulWidget {
  const LibraryStatsTile({super.key, this.onLongPress});
  final VoidCallback? onLongPress;
  @override
  State<LibraryStatsTile> createState() => _LibraryStatsTileState();
}

class _LibraryStatsTileState extends State<LibraryStatsTile> {
  late final Future<(int, int, int)> _n = _load();

  Future<(int, int, int)> _load() async {
    final m = await Api.movies().then((l) => l.length).catchError((_) => 0);
    final s = await Api.shows().then((l) => l.length).catchError((_) => 0);
    final k = await Api.musicStatus().then((v) => v.tracks).catchError((_) => 0);
    return (m, s, k);
  }

  static String _n1(int n, String one, String many) => '$n ${n == 1 ? one : many}';

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<(int, int, int)>(
      future: _n,
      builder: (context, snap) {
        final d = snap.data;
        if (d == null) return DashTile(heading: 'Library', body: 'Counting\u2026', onLongPress: widget.onLongPress);
        return DashTile(big: _n1(d.$1, 'movie', 'movies'), sub: '${_n1(d.$2, 'show', 'shows')} \u00b7 ${_n1(d.$3, 'song', 'songs')}', onLongPress: widget.onLongPress);
      },
    );
  }
}

/// "Surprise me": opens a random movie from the library.
class SurpriseTile extends StatelessWidget {
  const SurpriseTile({super.key, this.onLongPress});
  final VoidCallback? onLongPress;

  Future<void> _pick(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final nav = Navigator.of(context);
    final movies = await Api.movies().catchError((_) => <Movie>[]);
    if (movies.isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('No movies in your library yet')));
      return;
    }
    final m = movies[math.Random().nextInt(movies.length)];
    unawaited(nav.push(MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m))));
  }

  @override
  Widget build(BuildContext context) => DashTile(heading: 'Surprise me', body: 'Pick a random movie from your library', onTap: () => _pick(context), onLongPress: onLongPress);
}
