import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'music.dart';
import 'playlist_ui.dart';
import 'playlists.dart';
import 'settings_extra.dart' show ToggleRow;
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Music mode (Settings > Mode): the app shows only music, laid out like a music streaming app.
/// The shell lives in shell.dart (four pages: Home, Search, Your Library, Settings); this file holds the Home page and the
/// switch. Colours, radii and text sizes all come from the active skin's tokens, so skins and themes still apply.

String _greeting() {
  final h = DateTime.now().hour;
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/// One quick-pick: a playlist or an album, shown as a small tile with its cover (Spotify's grid at the top of Home).
class _Pick {
  const _Pick({required this.title, required this.art, required this.onTap});
  final String title;
  final String art;
  final VoidCallback onTap;
}

class MusicHomePage extends StatefulWidget {
  const MusicHomePage({super.key, required this.padding, required this.onOpenLibrary});
  final EdgeInsets padding;
  final VoidCallback onOpenLibrary;
  @override
  State<MusicHomePage> createState() => _MusicHomePageState();
}

class _MusicHomePageState extends State<MusicHomePage> {
  late Future<MusicLibrary> _lib = Api.musicLibrary();

  void _openAlbum(Album a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => AlbumScreen(albumId: a.id, title: a.title)));
  void _openArtist(Artist a) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ArtistScreen(artistId: a.id, name: a.name)));

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ListenableBuilder(
      listenable: Playlists.instance,
      builder: (context, _) {
        final lists = Playlists.instance.all;
        return ListView(padding: widget.padding, cacheExtent: 900, children: [
          Heading(_greeting()),
          FutureBuilder<MusicLibrary>(
            future: _lib,
            builder: (context, snap) {
              if (snap.hasError) {
                return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  const PekCard(title: 'Could not load your music', subtitle: 'Check that PEK TV is running, then try again.'),
                  SizedBox(height: rem),
                  PekButton(label: 'Try again', primary: true, onTap: () => setState(() => _lib = Api.musicLibrary())),
                ]);
              }
              if (!snap.hasData) {
                return Padding(padding: EdgeInsets.all(2 * rem), child: Text('Loading\u2026', style: TextStyle(color: t.textMuted)));
              }
              final lib = snap.data!;
              if (lib.albums.isEmpty && lib.artists.isEmpty && lists.isEmpty) {
                return const PekCard(title: 'No music yet', subtitle: 'Add a folder with music in Settings \u2192 Library.');
              }
              // Playlists first, then albums, up to six tiles.
              final picks = <_Pick>[
                for (final pl in lists.take(6)) _Pick(title: pl.name, art: playlistArt(pl), onTap: () => openPlaylist(context, pl.id)),
                for (final a in lib.albums) _Pick(title: a.title, art: a.art ? Api.albumArt(a.id) : '', onTap: () => _openAlbum(a)),
              ].take(6).toList();
              return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                _quickGrid(picks, rem, t),
                if (lists.isNotEmpty)
                  _shelf('Your playlists', rem, [
                    for (final pl in lists) _card(pl.name, '${pl.tracks.length} songs', playlistArt(pl), rem, t, () => openPlaylist(context, pl.id)),
                  ]),
                if (lib.albums.isNotEmpty)
                  _shelf('Albums', rem, [
                    for (final a in lib.albums.take(30)) _card(a.title, a.artist, a.art ? Api.albumArt(a.id) : '', rem, t, () => _openAlbum(a)),
                  ], onMore: widget.onOpenLibrary),
                if (lib.artists.isNotEmpty)
                  _shelf('Artists', rem, [
                    for (final a in lib.artists.take(30)) _card(a.name, 'Artist', a.art ? Api.artistArt(a.id) : '', rem, t, () => _openArtist(a), round: true),
                  ], onMore: widget.onOpenLibrary),
                SizedBox(height: 4 * rem + widget.padding.bottom), // room for the mini player
              ]);
            },
          ),
        ]);
      },
    );
  }

  /// Two columns of wide, short tiles: cover on the left, title on the right.
  Widget _quickGrid(List<_Pick> picks, double rem, PekTokens t) {
    final gap = 0.6 * rem;
    final rows = (picks.length / 2).ceil();
    final h = 3.6 * rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 1.5 * rem),
      child: Column(children: [
        for (var r = 0; r < rows; r++)
          Padding(
            padding: EdgeInsets.only(bottom: r == rows - 1 ? 0 : gap),
            child: SizedBox(
              height: h,
              child: Row(children: [
                for (var c = 0; c < 2; c++) ...[
                  if (c > 0) SizedBox(width: gap),
                  Expanded(
                    child: r * 2 + c < picks.length
                        ? PekFocusable(
                            radius: 8,
                            background: t.surface,
                            onTap: picks[r * 2 + c].onTap,
                            child: Row(children: [
                              ClipRRect(
                                borderRadius: const BorderRadius.horizontal(left: Radius.circular(8)),
                                child: Art(url: picks[r * 2 + c].art, size: h, radius: 0),
                              ),
                              SizedBox(width: 0.6 * rem),
                              Expanded(child: Text(picks[r * 2 + c].title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.9 * rem))),
                              SizedBox(width: 0.4 * rem),
                            ]),
                          )
                        : const SizedBox.shrink(),
                  ),
                ],
              ]),
            ),
          ),
      ]),
    );
  }

  /// A titled row that scrolls sideways.
  Widget _shelf(String title, double rem, List<Widget> cards, {VoidCallback? onMore}) {
    final w = (context.pek.compact ? 9.5 : 11) * rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 1.5 * rem),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Expanded(child: Text(title, style: TextStyle(fontSize: 1.3 * rem, fontWeight: FontWeight.w700, letterSpacing: -0.3))),
          if (onMore != null) PekButton(compact: true, label: 'Show all', onTap: onMore),
        ]),
        SizedBox(height: 0.75 * rem),
        SizedBox(
          height: w + 3.2 * rem,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: cards.length,
            separatorBuilder: (_, __) => SizedBox(width: 0.75 * rem),
            itemBuilder: (_, i) => SizedBox(width: w, child: cards[i]),
          ),
        ),
      ]),
    );
  }

  Widget _card(String title, String sub, String art, double rem, PekTokens t, VoidCallback onTap, {bool round = false}) {
    return PekFocusable(
      radius: 12,
      focusScale: 1.04,
      onTap: onTap,
      child: Column(crossAxisAlignment: round ? CrossAxisAlignment.center : CrossAxisAlignment.start, children: [
        AspectRatio(aspectRatio: 1, child: Art(url: art, radius: 12, round: round)),
        SizedBox(height: 0.4 * rem),
        Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: round ? TextAlign.center : TextAlign.start, style: TextStyle(fontWeight: FontWeight.w600, fontSize: 0.9 * rem)),
        Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: round ? TextAlign.center : TextAlign.start, style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
      ]),
    );
  }
}

/// Settings > Mode: the switch between regular PEK TV and music mode. The setting is kept on this device.
class ModeSection extends StatelessWidget {
  const ModeSection({super.key});

  Future<void> _flip(BuildContext context) async {
    final nav = Navigator.of(context);
    final want = !Store.musicMode;
    // Close every screen pushed on top (this one included) first: main.dart swaps the shell underneath them.
    nav.popUntil((r) => r.isFirst);
    await Store.setMusicMode(want);
  }

  @override
  Widget build(BuildContext context) {
    final on = Store.musicMode;
    return Section(
      title: 'Mode',
      hint: on
          ? 'Music mode hides movies, shows, plugins and everything else that is not music. Turn it off to get all of PEK TV back; nothing is deleted.'
          : 'Music mode turns PEK TV into a music player and browser: your library, network folders and playlists, with every movie and TV screen hidden.',
      children: [ToggleRow(title: 'Music mode', subtitle: on ? 'On' : 'Off', on: on, onTap: () => _flip(context))],
    );
  }
}
