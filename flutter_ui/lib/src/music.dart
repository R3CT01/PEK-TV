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
class Art extends StatelessWidget {
  const Art({super.key, required this.url, this.size, this.radius = 8, this.round = false});
  final String url;
  final double? size;
  final double radius;
  final bool round;

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    Widget fallback() => ColoredBox(color: t.surfaceFocused, child: Center(child: Icon(Icons.music_note, color: t.textMuted)));
    final img = url.isEmpty
        ? fallback()
        : Image.network(url, fit: BoxFit.cover, cacheWidth: 400, gaplessPlayback: true, errorBuilder: (_, __, ___) => fallback());
    final clipped = round ? ClipOval(child: img) : ClipRRect(borderRadius: BorderRadius.circular(radius), child: img);
    return size == null ? clipped : SizedBox(width: size, height: size, child: clipped);
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
  String _q = '';
  Future<MusicSearch>? _results;

  // songs, loaded 200 at a time
  final List<Track> _songs = [];
  int _songTotal = 0;
  bool _songsLoading = false;

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _moreSongs() async {
    if (_songsLoading) return;
    setState(() => _songsLoading = true);
    try {
      final r = await Api.musicSongs(offset: _songs.length);
      _songTotal = r.$1;
      _songs.addAll(r.$2);
    } catch (_) {}
    if (mounted) setState(() => _songsLoading = false);
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
    return ListView(
      padding: pad,
      children: [
        const Heading('Music'),
        TextField(
          controller: _search,
          onChanged: _onSearch,
          decoration: InputDecoration(
            hintText: 'Search songs, albums, artists',
            prefixIcon: const Icon(Icons.search),
            filled: true,
            fillColor: t.surface,
            contentPadding: EdgeInsets.symmetric(vertical: 0.5 * rem),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.border)),
            enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide(color: t.border)),
          ),
        ),
        SizedBox(height: rem),
        if (_q.isNotEmpty)
          Async<MusicSearch>(future: _results!, builder: (c, r) => _searchResults(c, r))
        else ...[
          Wrap(spacing: 0.5 * rem, children: [
            for (var i = 0; i < tabs.length; i++)
              PekButton(
                compact: true,
                primary: i == _tab,
                label: tabs[i],
                onTap: () {
                  setState(() => _tab = i);
                  if (i == 2 && _songs.isEmpty) _moreSongs();
                },
              ),
          ]),
          SizedBox(height: rem),
          Async<MusicLibrary>(future: _lib, builder: (c, lib) => _tabBody(c, lib)),
        ],
        SizedBox(height: 4 * rem), // room for the mini player
      ],
    );
  }

  Widget _tabBody(BuildContext context, MusicLibrary lib) {
    final p = context.pek;
    final rem = p.rem;
    if (lib.albums.isEmpty && lib.artists.isEmpty && _tab != 2) {
      return PekCard(title: lib.scanning ? 'Scanning your music\u2026' : 'No music yet', subtitle: lib.scanning ? 'Pull back in a moment.' : 'Add a folder with music in More \u2192 Settings \u2192 Sources.');
    }
    if (_tab == 0) return _albumGrid(context, lib.albums);
    if (_tab == 1) {
      return Column(children: [
        for (final a in lib.artists)
          ListRow(
            title: a.name,
            subtitle: '${a.albums} albums \u00b7 ${a.tracks} songs',
            onTap: () => _openArtist(a),
            trailing: Art(url: a.art ? Api.artistArt(a.id) : '', size: 2.5 * rem, round: true),
          ),
      ]);
    }
    return _songList(context);
  }

  Widget _albumGrid(BuildContext context, List<Album> albums) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final cols = (p.size.width / (p.compact ? 150 : 200)).floor().clamp(2, 12);
    final gap = 0.75 * rem;
    final rows = (albums.length / cols).ceil();
    return Column(children: [
      for (var r = 0; r < rows; r++)
        Padding(
          padding: EdgeInsets.only(bottom: gap),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var c = 0; c < cols; c++) ...[
              if (c > 0) SizedBox(width: gap),
              Expanded(
                child: r * cols + c < albums.length
                    ? _albumTile(context, albums[r * cols + c], t, rem)
                    : const SizedBox.shrink(),
              ),
            ],
          ]),
        ),
    ]);
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

  Widget _songList(BuildContext context) {
    final rem = context.pek.rem;
    return Column(children: [
      for (var i = 0; i < _songs.length; i++) TrackRow(track: _songs[i], onTap: () => _mc.playList(_songs, i)),
      if (_songs.length < _songTotal || _songs.isEmpty)
        Padding(
          padding: EdgeInsets.symmetric(vertical: rem),
          child: PekButton(compact: true, label: _songsLoading ? 'Loading\u2026' : 'Load more', onTap: _songsLoading ? null : _moreSongs),
        ),
    ]);
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
          title: '${on ? '\u25b6 ' : ''}${number != null ? '$number. ' : ''}${track.title}',
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
            padding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.5 * rem),
            decoration: BoxDecoration(color: t.bgElevated, border: Border(top: BorderSide(color: t.border))),
            child: Row(children: [
              Art(url: Api.trackArt(cur), size: 2.5 * rem),
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
