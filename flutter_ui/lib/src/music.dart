import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'lyrics.dart';
import 'music_controller.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

final _mc = MusicController.instance;

/// Cover art with a note icon when there is none (or it fails to load).
/// The server answers 503 while it is still fetching an online picture in the background; that case is asked again a
/// few seconds later (up to [_maxTries] times). 404 means there is no picture and is not retried.
class Art extends StatefulWidget {
  const Art({super.key, required this.url, this.size, this.radius = 8, this.round = false});
  final String url;
  final double? size;
  final double radius;
  final bool round;

  @override
  State<Art> createState() => _ArtState();
}

class _ArtState extends State<Art> {
  static const _maxTries = 8;
  int _tries = 0;
  Timer? _retry;

  @override
  void didUpdateWidget(Art old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _retry?.cancel();
      _tries = 0;
    }
  }

  @override
  void dispose() {
    _retry?.cancel();
    super.dispose();
  }

  void _askAgainLater() {
    if (_tries >= _maxTries || (_retry?.isActive ?? false)) return;
    _retry = Timer(Duration(seconds: 3 + 3 * _tries), () {
      if (mounted) setState(() => _tries++);
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    Widget fallback() => ColoredBox(color: t.surfaceFocused, child: Center(child: Icon(Icons.music_note, color: t.textMuted)));
    final img = widget.url.isEmpty
        ? fallback()
        : Image.network(
            widget.url,
            key: ValueKey('${widget.url}#$_tries'),
            fit: BoxFit.cover,
            cacheWidth: 400,
            gaplessPlayback: true,
            errorBuilder: (_, error, __) {
              if (error is NetworkImageLoadException && error.statusCode == 503) _askAgainLater();
              return fallback();
            },
          );
    final clipped = widget.round ? ClipOval(child: img) : ClipRRect(borderRadius: BorderRadius.circular(widget.radius), child: img);
    return widget.size == null ? clipped : SizedBox(width: widget.size, height: widget.size, child: clipped);
  }
}

/// The Music tab (app_music.js): Albums / Artists / Songs and a search box. Playback is in [MusicController].
class MusicPage extends StatefulWidget {
  const MusicPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<MusicPage> createState() => _MusicPageState();
}

class _MusicPageState extends State<MusicPage> {
  int _tab = 0; // 0 albums, 1 artists, 2 songs
  late Future<MusicLibrary> _lib = Api.musicLibrary();
  final _search = TextEditingController();
  Timer? _debounce;
  Timer? _scanPoll;
  bool _scanning = false; // the music scan, or the video scan that starts it
  int _scanned = 0;
  String? _libKey; // tracks/albums/artists of the last status: a change means the lists on screen are stale
  bool _polling = false;
  String _q = '';
  Future<MusicSearch>? _results;

  // songs, loaded 200 at a time (the next page is fetched by itself when the list gets near its end)
  final List<Track> _songs = [];
  int _songTotal = 0;
  bool _songsLoading = false;
  bool _songsFailed = false;

  @override
  void initState() {
    super.initState();
    _scanPoll = Timer.periodic(const Duration(seconds: 3), (_) => _checkStatus());
    _checkStatus();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scanPoll?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _moreSongs() async {
    if (_songsLoading) return;
    setState(() {
      _songsLoading = true;
      _songsFailed = false;
    });
    try {
      final r = await Api.musicSongs(offset: _songs.length);
      _songTotal = r.$1;
      _songs.addAll(r.$2);
    } catch (_) {
      _songsFailed = true; // the button below tries again; nothing retries by itself
    }
    if (mounted) setState(() => _songsLoading = false);
  }

  /// Every 2 s: is the server scanning, and did the number of songs / albums / artists change? Then the lists are read
  /// again (without blanking them), so albums and artists show up while the scan runs and also when a scan began after
  /// this page had already loaded an empty list.
  Future<void> _checkStatus() async {
    if (_polling) return;
    _polling = true;
    try {
      final st = await Api.musicStatus();
      final video = await Api.scanning(); // the video scan hands over to the music scan when it ends
      if (!mounted) return;
      final scanning = st.scanning || video;
      final changed = _libKey != null && (st.key != _libKey || (_scanning && !scanning));
      final shown = scanning != _scanning || (scanning && st.scanned != _scanned);
      _libKey = st.key;
      if (changed || shown) {
        setState(() {
          _scanning = scanning;
          _scanned = st.scanned;
          if (changed) {
            _lib = Api.musicLibrary();
            _refreshSongs();
          }
        });
      }
    } catch (_) {
    } finally {
      _polling = false;
    }
  }

  /// Reads the songs already shown again, in place.
  Future<void> _refreshSongs() async {
    if (_songs.isEmpty || _songsLoading) return;
    try {
      final r = await Api.musicSongs(offset: 0, limit: _songs.length.clamp(200, 500));
      _songTotal = r.$1;
      _songs
        ..clear()
        ..addAll(r.$2);
    } catch (_) {}
    if (mounted) setState(() {});
  }

  void _onSearch(String v) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () {
      final q = v.trim();
      setState(() {
        _q = q;
        _results = q.isEmpty ? null : Api.musicSearch(q);
      });
    });
  }

  void _openAlbum(Album a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AlbumScreen(albumId: a.id, title: a.title)));
  void _openArtist(Artist a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ArtistScreen(artistId: a.id, name: a.name)));

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final pad = widget.padding;
    final tabs = ['Albums', 'Artists', 'Songs'];
    final side = EdgeInsets.only(left: pad.left, right: pad.right);
    // A CustomScrollView with builder slivers: only the rows on screen (plus a little beyond, so the remote's arrow keys
    // find the next row) are built. The old single ListView built every album and song at once.
    return CustomScrollView(
      cacheExtent: 900,
      slivers: [
        // The header is a SliverList (not a SliverToBoxAdapter) so the search box keeps its focus while it has it.
        SliverPadding(
          padding: EdgeInsets.only(left: pad.left, right: pad.right, top: pad.top),
          sliver: SliverList(
            delegate: SliverChildListDelegate([
              const Heading('Music'),
              TextField(
                controller: _search,
                onChanged: _onSearch,
                decoration: InputDecoration(
                  hintText: 'Search',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  contentPadding: EdgeInsets.symmetric(vertical: 0.5 * rem),
                ),
              ),
              SizedBox(height: rem),
              if (_q.isEmpty) ...[
                PekTabs(
                  labels: tabs,
                  selected: _tab,
                  onChanged: (i) {
                    setState(() => _tab = i);
                    if (i == 2 && _songs.isEmpty) _moreSongs();
                  },
                ),
                SizedBox(height: rem),
              ],
              if (_scanning) ScanLine(label: _scanned > 0 ? 'Reading your music\u2026 $_scanned songs so far' : 'Reading your music\u2026'),
            ]),
          ),
        ),
        if (_q.isNotEmpty)
          SliverPadding(
            padding: side,
            sliver: SliverToBoxAdapter(child: Async<MusicSearch>(future: _results!, builder: (c, r) => _searchResults(c, r))),
          )
        else
          SliverPadding(padding: side, sliver: _librarySliver(context)),
        SliverToBoxAdapter(child: SizedBox(height: 4 * rem + pad.bottom)), // room for the mini player
      ],
    );
  }

  /// The Albums / Artists / Songs body as a sliver, once the library answered.
  Widget _librarySliver(BuildContext context) {
    final p = context.pek;
    return FutureBuilder<MusicLibrary>(
      future: _lib,
      builder: (context, snap) {
        if (!snap.hasData && !snap.hasError) {
          return SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(2 * p.rem), child: Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted))));
        }
        if (snap.hasError) {
          return SliverToBoxAdapter(child: PekCard(title: 'Could not load', subtitle: 'The backend did not respond. Is the server running?'));
        }
        final lib = snap.data!;
        if (lib.albums.isEmpty && lib.artists.isEmpty && _tab != 2) {
          return SliverToBoxAdapter(
            child: PekCard(
              title: _scanning ? 'Scanning your music\u2026' : 'No music yet',
              subtitle: _scanning ? 'Songs appear here as they are read.' : 'Add a folder with music in More \u2192 Settings \u2192 Sources.',
            ),
          );
        }
        if (_tab == 0) return _albumSliver(context, lib.albums);
        if (_tab == 1) return _artistSliver(context, lib.artists);
        return _songSliver(context);
      },
    );
  }

  Widget _artistSliver(BuildContext context, List<Artist> artists) {
    final rem = context.pek.rem;
    return SliverList.builder(
      itemCount: artists.length,
      itemBuilder: (context, i) {
        final a = artists[i];
        return ListRow(
          title: a.name,
          subtitle: '${a.albums} albums \u00b7 ${a.tracks} songs',
          onTap: () => _openArtist(a),
          trailing: Art(url: a.art ? Api.artistArt(a.id) : '', size: 2.5 * rem, round: true),
        );
      },
    );
  }

  /// The same rows of tiles as before, built one row at a time as they scroll into view.
  Widget _albumSliver(BuildContext context, List<Album> albums) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final cols = (p.size.width / (p.compact ? 150 : 200)).floor().clamp(2, 12);
    final gap = 0.75 * rem;
    final rows = (albums.length / cols).ceil();
    return SliverList.builder(
      itemCount: rows,
      itemBuilder: (context, r) => Padding(
        padding: EdgeInsets.only(bottom: gap),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (var c = 0; c < cols; c++) ...[
            if (c > 0) SizedBox(width: gap),
            Expanded(
              child: r * cols + c < albums.length ? _albumTile(context, albums[r * cols + c], t, rem) : const SizedBox.shrink(),
            ),
          ],
        ]),
      ),
    );
  }

  Widget _albumTile(BuildContext context, Album a, PekTokens t, double rem) {
    return PekFocusable(
      radius: 12,
      focusScale: 1.04,
      onTap: () => _openAlbum(a),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        AspectRatio(aspectRatio: 1, child: Art(url: a.art ? Api.albumArt(a.id) : '', radius: 12)),
        SizedBox(height: 0.4 * rem),
        Text(a.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 0.9 * rem)),
        Text(a.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
      ]),
    );
  }

  Widget _songSliver(BuildContext context) {
    final rem = context.pek.rem;
    final more = _songs.length < _songTotal || _songs.isEmpty;
    return SliverList.builder(
      itemCount: _songs.length + (more ? 1 : 0),
      itemBuilder: (context, i) {
        if (i < _songs.length) {
          // Near the end of what is loaded: fetch the next page (once; a failed page waits for the button).
          if (i >= _songs.length - 25 && _songs.length < _songTotal && !_songsLoading && !_songsFailed) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (mounted) _moreSongs();
            });
          }
          return TrackRow(track: _songs[i], onTap: () => _mc.playList(_songs, i));
        }
        return Padding(
          padding: EdgeInsets.symmetric(vertical: rem),
          child: PekButton(compact: true, label: _songsLoading ? 'Loading\u2026' : (_songsFailed ? 'Try again' : 'Load more'), onTap: _songsLoading ? null : _moreSongs),
        );
      },
    );
  }

  Widget _searchResults(BuildContext context, MusicSearch r) {
    final rem = context.pek.rem;
    if (r.artists.isEmpty && r.albums.isEmpty && r.songs.isEmpty) return PekCard(title: 'No results', subtitle: 'Nothing matches \u201c$_q\u201d.');
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (r.artists.isNotEmpty) Section(title: 'Artists', children: [for (final a in r.artists) ListRow(title: a.name, subtitle: '${a.albums} albums', onTap: () => _openArtist(a))]),
      if (r.albums.isNotEmpty) Section(title: 'Albums', children: [for (final a in r.albums) ListRow(title: a.title, subtitle: a.artist, onTap: () => _openAlbum(a), trailing: Art(url: a.art ? Api.albumArt(a.id) : '', size: 2.5 * rem))]),
      if (r.songs.isNotEmpty) Section(title: 'Songs', children: [for (var i = 0; i < r.songs.length; i++) TrackRow(track: r.songs[i], onTap: () => _mc.playList(r.songs, i))]),
    ]);
  }
}

class TrackRow extends StatelessWidget {
  const TrackRow({super.key, required this.track, required this.onTap, this.number});
  final Track track;
  final VoidCallback onTap;
  final int? number;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return ValueListenableBuilder<Track?>(
      valueListenable: _mc.current,
      builder: (context, cur, _) {
        final on = cur?.id == track.id;
        return ListRow(
          title: '${number != null ? '$number. ' : ''}${track.title}',
          highlight: on,
          subtitle: [track.artist, if (track.album.isNotEmpty && number == null) track.album].where((e) => e.isNotEmpty).join(' \u00b7 '),
          onTap: onTap,
          trailing: Text(track.duration > 0 ? formatTime(track.duration) : '', style: TextStyle(fontSize: 0.85 * rem, color: context.pek.tokens.textMuted)),
        );
      },
    );
  }
}

class AlbumScreen extends StatelessWidget {
  const AlbumScreen({super.key, required this.albumId, required this.title});
  final String albumId;
  final String title;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return SubScreen(
      title: title,
      body: Async<(Album, List<Track>)>(
        future: Api.musicAlbum(albumId),
        builder: (context, r) {
          final (album, tracks) = r;
          return ListView(padding: p.pagePad, children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Art(url: album.art ? Api.albumArt(album.id) : '', size: (p.narrow ? 8 : 12) * rem, radius: 12),
              SizedBox(width: rem),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(album.title, style: TextStyle(fontSize: 1.4 * rem, fontWeight: FontWeight.w800)),
                  Text('${album.artist}${album.year > 0 ? ' \u00b7 ${album.year}' : ''}', style: TextStyle(color: p.tokens.textMuted)),
                  SizedBox(height: 0.75 * rem),
                  Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
                    PekButton(compact: true, primary: true, autofocus: true, label: 'Play', onTap: tracks.isEmpty ? null : () => _mc.playList(tracks, 0)),
                    PekButton(
                      compact: true,
                      label: 'Shuffle',
                      onTap: tracks.isEmpty
                          ? null
                          : () {
                              if (!_mc.shuffle.value) _mc.toggleShuffle();
                              _mc.playList(tracks, (DateTime.now().millisecondsSinceEpoch % tracks.length));
                            },
                    ),
                  ]),
                ]),
              ),
            ]),
            SizedBox(height: 1.25 * rem),
            for (var i = 0; i < tracks.length; i++) TrackRow(track: tracks[i], number: i + 1, onTap: () => _mc.playList(tracks, i)),
            SizedBox(height: 4 * rem),
          ]);
        },
      ),
    );
  }
}

class ArtistScreen extends StatelessWidget {
  const ArtistScreen({super.key, required this.artistId, required this.name});
  final String artistId;
  final String name;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return SubScreen(
      title: name,
      body: Async<(Artist, List<Album>)>(
        future: Api.musicArtist(artistId),
        builder: (context, r) => ListView(padding: p.pagePad, children: [
          for (final a in r.$2)
            ListRow(
              title: a.title,
              subtitle: '${a.year > 0 ? '${a.year} \u00b7 ' : ''}${a.tracks} songs',
              trailing: Art(url: a.art ? Api.albumArt(a.id) : '', size: 3 * rem),
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AlbumScreen(albumId: a.id, title: a.title))),
            ),
          SizedBox(height: 4 * rem),
        ]),
      ),
    );
  }
}

/// A slim bar above the bottom tabs while something plays. Tap = Now Playing.
class MiniPlayer extends StatelessWidget {
  const MiniPlayer({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ValueListenableBuilder<Track?>(
      valueListenable: _mc.current,
      builder: (context, cur, _) {
        if (cur == null) return const SizedBox.shrink();
        return GestureDetector(
          onTap: () => Navigator.push(context, MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => const NowPlayingScreen())),
          child: Container(
            margin: EdgeInsets.fromLTRB(0.75 * rem, 0, 0.75 * rem, 0.5 * rem),
            padding: EdgeInsets.symmetric(horizontal: 0.6 * rem, vertical: 0.4 * rem),
            decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(18)),
            child: Row(children: [
              Art(url: Api.trackArt(cur), size: 2.5 * rem, radius: 10),
              SizedBox(width: 0.75 * rem),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Text(cur.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                  Text(cur.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem)),
                ]),
              ),
              ValueListenableBuilder<bool>(
                valueListenable: _mc.playing,
                builder: (_, on, __) => IconButton(onPressed: _mc.toggle, icon: Icon(on ? Icons.pause : Icons.play_arrow)),
              ),
              IconButton(onPressed: () => _mc.next(), icon: const Icon(Icons.skip_next)),
            ]),
          ),
        );
      },
    );
  }
}

class NowPlayingScreen extends StatefulWidget {
  const NowPlayingScreen({super.key});
  @override
  State<NowPlayingScreen> createState() => _NowPlayingState();
}

class _NowPlayingState extends State<NowPlayingScreen> {
  double? _drag;
  bool _lyrics = Store.musicLyrics;

  @override
  void initState() {
    super.initState();
    _mc.current.addListener(_closeWhenStopped);
  }

  @override
  void dispose() {
    _mc.current.removeListener(_closeWhenStopped);
    super.dispose();
  }

  void _closeWhenStopped() {
    if (_mc.current.value == null && mounted) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text, leading: IconButton(icon: const Icon(Icons.keyboard_arrow_down), onPressed: () => Navigator.pop(context)), title: const Text('Now playing')),
      body: ValueListenableBuilder<Track?>(
        valueListenable: _mc.current,
        builder: (context, cur, _) {
          if (cur == null) return const SizedBox.shrink();
          final side = (p.size.shortestSide - 4 * rem).clamp(120.0, 28 * rem).toDouble();
          return Center(
            child: SingleChildScrollView(
              padding: EdgeInsets.all(rem),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Art(url: Api.trackArt(cur), size: side, radius: 16),
                SizedBox(height: 1.25 * rem),
                Text(cur.title, textAlign: TextAlign.center, style: TextStyle(fontSize: 1.4 * rem, fontWeight: FontWeight.w800)),
                Text('${cur.artist}${cur.album.isNotEmpty ? ' \u00b7 ${cur.album}' : ''}', textAlign: TextAlign.center, style: TextStyle(color: t.textMuted)),
                SizedBox(height: rem),
                SizedBox(
                  width: side,
                  child: ValueListenableBuilder<double>(
                    valueListenable: _mc.duration,
                    builder: (_, dur, __) => ValueListenableBuilder<double>(
                      valueListenable: _mc.position,
                      builder: (_, pos, __) {
                        final max = dur > 0 ? dur : (cur.duration > 0 ? cur.duration : 1.0);
                        final v = (_drag ?? pos).clamp(0.0, max).toDouble();
                        return Column(children: [
                          Slider(value: v, max: max, onChanged: (x) => setState(() => _drag = x), onChangeEnd: (x) {
                            _mc.seek(x);
                            setState(() => _drag = null);
                          }),
                          Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(formatTime(v)), Text(formatTime(max))]),
                        ]);
                      },
                    ),
                  ),
                ),
                SizedBox(height: 0.5 * rem),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  ValueListenableBuilder<bool>(valueListenable: _mc.shuffle, builder: (_, on, __) => IconButton(onPressed: _mc.toggleShuffle, icon: Icon(Icons.shuffle, color: on ? t.accent : t.textMuted))),
                  IconButton(iconSize: 2.2 * rem, onPressed: _mc.prev, icon: const Icon(Icons.skip_previous)),
                  ValueListenableBuilder<bool>(
                    valueListenable: _mc.playing,
                    builder: (_, on, __) => IconButton(autofocus: true, iconSize: 3 * rem, onPressed: _mc.toggle, icon: Icon(on ? Icons.pause_circle_filled : Icons.play_circle_filled)),
                  ),
                  IconButton(iconSize: 2.2 * rem, onPressed: () => _mc.next(), icon: const Icon(Icons.skip_next)),
                  ValueListenableBuilder<bool>(valueListenable: _mc.repeat, builder: (_, on, __) => IconButton(onPressed: _mc.toggleRepeat, icon: Icon(Icons.repeat, color: on ? t.accent : t.textMuted))),
                ]),
                Row(mainAxisSize: MainAxisSize.min, children: [
                  TextButton(onPressed: _mc.stop, child: const Text('Stop')),
                  SizedBox(width: rem),
                  TextButton.icon(
                    onPressed: () {
                      setState(() => _lyrics = !_lyrics);
                      Store.setMusicLyrics(_lyrics);
                    },
                    icon: Icon(Icons.lyrics_outlined, color: _lyrics ? t.accent : t.textMuted),
                    label: Text('Lyrics', style: TextStyle(color: _lyrics ? t.accent : t.textMuted)),
                  ),
                ]),
                if (_lyrics) SizedBox(width: side, height: 13 * rem, child: LyricsPanel(trackId: cur.id, position: _mc.position, onSeek: _mc.seek)),
              ]),
            ),
          );
        },
      ),
    );
  }
}
