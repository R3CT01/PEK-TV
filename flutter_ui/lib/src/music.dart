import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'music_controller.dart';
import 'music_filters.dart';
import 'music_fullscreen.dart';
import 'playlist_ui.dart';
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
        : widget.url.startsWith('/')
            ? Image.file(File(widget.url), key: ValueKey(widget.url), fit: BoxFit.cover, cacheWidth: 400, gaplessPlayback: true, errorBuilder: (_, __, ___) => fallback())
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
/// What a [MusicPage] shows: everything (the Music screen), or one half of it for music mode (Your Library / Search).
enum MusicView { all, library, search }

class MusicPage extends StatefulWidget {
  const MusicPage({super.key, required this.padding, this.title = 'Music', this.view = MusicView.all});
  final EdgeInsets padding;
  final String title;
  final MusicView view;
  @override
  State<MusicPage> createState() => _MusicPageState();
}

class _MusicPageState extends State<MusicPage> {
  int _tab = 0; // 0 albums, 1 artists, 2 songs, 3 playlists
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
  MusicFilters _filters = MusicFilters.none; // Genre / Year, sent with every list and search

  /// Words in the search box, or (in music mode's Search page, which has no tabs) only a filter: both show search results.
  bool get _searching => _q.isNotEmpty || (widget.view == MusicView.search && _filters.active);

  // songs, loaded 200 at a time (the next page is fetched by itself when the list gets near its end)
  final List<Track> _songs = [];
  int _songTotal = 0;
  bool _songsLoading = false;
  bool _songsFailed = false;
  bool _songsAsked = false; // the first page of the current filter has been answered (so "no matches" is true)
  int _songGen = 0; // bumped when the filter changes, so an answer that was asked before it is dropped

  @override
  void initState() {
    super.initState();
    if (widget.view == MusicView.library) _tab = 3; // like Spotify, the library opens on the playlists
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
    final gen = _songGen;
    setState(() {
      _songsLoading = true;
      _songsFailed = false;
    });
    try {
      final r = await Api.musicSongs(offset: _songs.length, filters: _filters);
      if (gen == _songGen) {
        _songTotal = r.$1;
        _songs.addAll(r.$2);
        _songsAsked = true;
      }
    } catch (_) {
      if (gen == _songGen) _songsFailed = true; // the button below tries again; nothing retries by itself
    }
    if (mounted) setState(() => _songsLoading = false);
    if (mounted && gen != _songGen && _tab == 2) _moreSongs(); // the filter changed while this was loading: ask again with the new one
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
            _lib = Api.musicLibrary(_filters);
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
    final gen = _songGen;
    try {
      final r = await Api.musicSongs(offset: 0, limit: _songs.length.clamp(200, 500), filters: _filters);
      if (gen != _songGen) return; // the filter changed meanwhile: these songs are for the old one
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
        _results = _searching ? Api.musicSearch(q, _filters) : null;
      });
    });
  }

  /// A new Genre / Year choice: every list is read again with it (the server does the filtering, so Songs stays paged).
  void _onFilters(MusicFilters f) {
    setState(() {
      _filters = f;
      _lib = Api.musicLibrary(f);
      _songs.clear();
      _songTotal = 0;
      _songsFailed = false;
      _songsAsked = false;
      _songGen++;
      _results = _searching ? Api.musicSearch(_q, f) : null;
    });
    if (_tab == 2) _moreSongs();
  }

  void _openAlbum(Album a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AlbumScreen(albumId: a.id, title: a.title)));
  void _openArtist(Artist a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ArtistScreen(artistId: a.id, name: a.name)));

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final pad = widget.padding;
    final tabs = ['Albums', 'Artists', 'Songs', 'Playlists'];
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
              Heading(widget.title, weather: !Store.musicMode),
              if (widget.view != MusicView.library) TextField(
                controller: _search,
                onChanged: _onSearch,
                decoration: InputDecoration(
                  hintText: 'Search',
                  prefixIcon: const Icon(Icons.search, size: 20),
                  contentPadding: EdgeInsets.symmetric(vertical: 0.5 * rem),
                ),
              ),
              if (widget.view != MusicView.library) SizedBox(height: 0.75 * rem),
              if (widget.view != MusicView.library && (_tab != 3 || _searching)) MusicFilterBar(filters: _filters, onChanged: _onFilters),
              if (!_searching && widget.view != MusicView.search) ...[
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
              if (widget.view != MusicView.search)
                Padding(
                  padding: EdgeInsets.only(bottom: 0.5 * rem),
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: PekButton(compact: true, label: _scanning ? 'Scanning\u2026' : 'Rescan library', onTap: _scanning ? null : _rescanLibrary),
                  ),
                ),
              if (_scanning) ScanLine(label: _scanned > 0 ? 'Reading your music\u2026 $_scanned songs so far' : 'Reading your music\u2026'),
            ]),
          ),
        ),
        if (_searching)
          SliverPadding(
            padding: side,
            sliver: SliverToBoxAdapter(child: Async<MusicSearch>(future: _results!, builder: (c, r) => _searchResults(c, r))),
          )
        else if (widget.view == MusicView.search)
          SliverPadding(padding: side, sliver: const SliverToBoxAdapter(child: PekCard(title: 'Search your music', subtitle: 'Songs, albums and artists. Pick a genre or year to browse.')))
        else
          SliverPadding(padding: side, sliver: _librarySliver(context)),
        SliverToBoxAdapter(child: SizedBox(height: 4 * rem + pad.bottom)), // room for the mini player
      ],
    );
  }

  /// The Rescan button: walks every source folder again (nothing scans by itself at start-up). The status poll shows progress.
  Future<void> _rescanLibrary() async {
    setState(() => _scanning = true);
    try {
      final wait = await Api.rescan();
      if (wait != null && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Please wait $wait s before scanning again.')));
      }
    } catch (_) {}
    Api.forgetLibrary();
    _checkStatus();
  }

  /// The Albums / Artists / Songs body as a sliver, once the library answered.
  Widget _librarySliver(BuildContext context) {
    final p = context.pek;
    if (_tab == 3) return const SliverToBoxAdapter(child: PlaylistRows()); // playlists live on the device, not in the library
    return FutureBuilder<MusicLibrary>(
      future: _lib,
      builder: (context, snap) {
        if (!snap.hasData && !snap.hasError) {
          return SliverToBoxAdapter(child: Padding(padding: EdgeInsets.all(2 * p.rem), child: Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted))));
        }
        if (snap.hasError) {
          // Say what actually failed (a timeout, a bad answer, no connection) instead of always blaming the server.
          final why = '${snap.error}'.replaceFirst('Exception: ', '');
          return SliverToBoxAdapter(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PekCard(title: 'Could not load your music', subtitle: why.length > 160 ? '${why.substring(0, 160)}\u2026' : why),
              SizedBox(height: p.rem),
              FilledButton(autofocus: true, onPressed: () => setState(() => _lib = Api.musicLibrary(_filters)), child: const Text('Try again')),
            ]),
          );
        }
        final lib = snap.data!;
        if (_filters.active && lib.albums.isEmpty && lib.artists.isEmpty && _tab != 2) {
          return SliverToBoxAdapter(child: PekCard(title: 'No matches', subtitle: 'No albums or artists match ${_filters.label}.'));
        }
        if (lib.albums.isEmpty && lib.artists.isEmpty && _tab != 2) {
          return SliverToBoxAdapter(
            child: PekCard(
              title: _scanning ? 'Scanning your music\u2026' : 'No music yet',
              subtitle: _scanning ? 'Songs appear here as they are read.' : (Store.musicMode ? 'Add a folder with music in Settings \u2192 Library.' : 'Add a folder with music in More \u2192 Settings \u2192 Sources.'),
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
    if (_filters.active && _songsAsked && _songs.isEmpty && !_songsLoading && !_songsFailed) {
      return SliverToBoxAdapter(child: PekCard(title: 'No matches', subtitle: 'No songs match ${_filters.label}.'));
    }
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
    if (r.artists.isEmpty && r.albums.isEmpty && r.songs.isEmpty) {
      final what = [if (_q.isNotEmpty) '\u201c$_q\u201d', if (_filters.active) _filters.label].join(' in ');
      return PekCard(title: 'No results', subtitle: 'Nothing matches $what.');
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (r.artists.isNotEmpty) Section(title: 'Artists', children: [for (final a in r.artists) ListRow(title: a.name, subtitle: '${a.albums} albums', onTap: () => _openArtist(a))]),
      if (r.albums.isNotEmpty) Section(title: 'Albums', children: [for (final a in r.albums) ListRow(title: a.title, subtitle: a.artist, onTap: () => _openAlbum(a), trailing: Art(url: a.art ? Api.albumArt(a.id) : '', size: 2.5 * rem))]),
      if (r.songs.isNotEmpty) Section(title: 'Songs', children: [for (var i = 0; i < r.songs.length; i++) TrackRow(track: r.songs[i], onTap: () => _mc.playList(r.songs, i))]),
    ]);
  }
}

class TrackRow extends StatelessWidget {
  const TrackRow({super.key, required this.track, required this.onTap, this.number, this.onLongPress});
  final Track track;
  final VoidCallback onTap;
  final int? number;

  /// Press and hold; default = the song menu (play next, add to queue, add to playlist).
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return ValueListenableBuilder<Set<String>>(
      valueListenable: _mc.unplayable,
      builder: (context, bad, _) => ValueListenableBuilder<Track?>(
        valueListenable: _mc.current,
        builder: (context, cur, _) {
          final on = cur?.id == track.id;
          final broken = bad.contains(track.id);
          return Opacity(
            opacity: broken ? 0.5 : 1,
            child: ListRow(
              title: '${number != null ? '$number. ' : ''}${track.title}',
              highlight: on,
              subtitle: broken
                  ? 'Can\u2019t be played \u00b7 the file may be damaged'
                  : [track.artist, if (track.album.isNotEmpty && number == null) track.album].where((e) => e.isNotEmpty).join(' \u00b7 '),
              onTap: onTap,
              onLongPress: onLongPress ?? () => showTrackMenu(context, track),
              trailing: Text(track.duration > 0 ? formatTime(track.duration) : '', style: TextStyle(fontSize: 0.85 * rem, color: context.pek.tokens.textMuted)),
            ),
          );
        },
      ),
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
                    PekButton(compact: true, label: 'Add to playlist', onTap: tracks.isEmpty ? null : () => addToPlaylistSheet(context, tracks)),
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

/// A slim bar above the bottom tabs while something plays (like Spotify's): the song, previous / play-pause / next and a thin
/// progress line. Tapping the bar (or swiping it up) opens the full-screen player, as does the expand button.
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
        return Container(
          margin: EdgeInsets.fromLTRB(0.75 * rem, 0, 0.75 * rem, 0.5 * rem),
          decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(18)),
          clipBehavior: Clip.antiAlias,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            InkWell(
              onTap: () => openNowPlaying(context),
              onLongPress: null,
              child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onVerticalDragEnd: (d) {
                if ((d.primaryVelocity ?? 0) < -200) openNowPlaying(context);
              },
              child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 0.6 * rem, vertical: 0.4 * rem),
              child: Row(children: [
                Art(url: Api.trackArt(cur), size: 2.5 * rem, radius: 10),
                SizedBox(width: 0.75 * rem),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                    Text(cur.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text(cur.artist, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem)),
                  ]),
                ),
                IconButton(tooltip: 'Previous', visualDensity: VisualDensity.compact, onPressed: () => _mc.prev(), icon: const Icon(Icons.skip_previous)),
                ValueListenableBuilder<bool>(
                  valueListenable: _mc.playing,
                  builder: (_, on, __) => IconButton(tooltip: on ? 'Pause' : 'Play', visualDensity: VisualDensity.compact, onPressed: _mc.toggle, icon: Icon(on ? Icons.pause : Icons.play_arrow)),
                ),
                IconButton(tooltip: 'Next', visualDensity: VisualDensity.compact, onPressed: () => _mc.next(), icon: const Icon(Icons.skip_next)),
                IconButton(tooltip: 'Full screen', visualDensity: VisualDensity.compact, onPressed: () => openNowPlaying(context), icon: const Icon(Icons.open_in_full, size: 20)),
              ]),
            ))),
            ValueListenableBuilder<double>(
              valueListenable: _mc.position,
              builder: (_, pos, __) => ValueListenableBuilder<double>(
                valueListenable: _mc.duration,
                builder: (_, dur, __) => LinearProgressIndicator(
                  value: dur > 0 ? (pos / dur).clamp(0.0, 1.0) : 0,
                  minHeight: 2,
                  color: t.accent,
                  backgroundColor: t.textMuted.withAlpha(50),
                ),
              ),
            ),
          ]),
        );
      },
    );
  }
}
