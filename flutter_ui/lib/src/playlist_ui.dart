import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'music.dart' show Art;
import 'music_controller.dart';
import 'playlists.dart';
import 'tokens.dart';
import 'widgets.dart';

final _mc = MusicController.instance;
final _pl = Playlists.instance;

String _songs(int n) => '$n ${n == 1 ? 'song' : 'songs'}';

/// The picture shown for a playlist ('' = the note icon).
String playlistArt(Playlist p) {
  final t = p.cover;
  return t == null ? '' : Api.trackArt(t);
}

void _say(ScaffoldMessengerState? m, String text) => m?.showSnackBar(SnackBar(content: Text(text), duration: const Duration(seconds: 2)));

// ============================================================================================ dialogs

/// A one-line name box. null = cancelled; may be empty (the caller decides what an empty name becomes).
Future<String?> promptName(BuildContext context, {required String title, String initial = '', String action = 'Save'}) =>
    showDialog<String>(context: context, builder: (_) => _NameDialog(title: title, initial: initial, action: action));

class _NameDialog extends StatefulWidget {
  const _NameDialog({required this.title, required this.initial, required this.action});
  final String title, initial, action;

  @override
  State<_NameDialog> createState() => _NameDialogState();
}

class _NameDialogState extends State<_NameDialog> {
  late final TextEditingController _c = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text(widget.title),
        content: TextField(
          controller: _c,
          autofocus: true,
          maxLength: 80,
          textInputAction: TextInputAction.done,
          onSubmitted: (v) => Navigator.pop(context, v.trim()),
          decoration: const InputDecoration(hintText: 'Playlist name'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(context, _c.text.trim()), child: Text(widget.action)),
        ],
      );
}

Future<bool> _confirm(BuildContext context, String title, String text, String action) async =>
    await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(title),
        content: Text(text),
        actions: [
          TextButton(autofocus: true, onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(d, true), child: Text(action)),
        ],
      ),
    ) ??
    false;

// ============================================================================================ sheets

class SheetAction {
  const SheetAction(this.label, this.icon, this.run);
  final String label;
  final IconData icon;
  final VoidCallback run;
}

Future<void> _sheet(BuildContext context, {required String title, String subtitle = '', required List<SheetAction> actions}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.8),
        child: ListView(shrinkWrap: true, children: [
          ListTile(title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontWeight: FontWeight.w700)), subtitle: subtitle.isEmpty ? null : Text(subtitle, maxLines: 1, overflow: TextOverflow.ellipsis)),
          for (var i = 0; i < actions.length; i++)
            ListTile(
              autofocus: i == 0,
              leading: Icon(actions[i].icon),
              title: Text(actions[i].label),
              onTap: () {
                Navigator.pop(sheet);
                actions[i].run();
              },
            ),
        ]),
      ),
    ),
  );
}

/// Long-press on a song: play next, add to the queue, add to a playlist (+ [extra], e.g. "Remove from playlist").
Future<void> showTrackMenu(BuildContext context, Track t, {List<SheetAction> extra = const []}) {
  return _sheet(context, title: t.title.isEmpty ? 'Unknown song' : t.title, subtitle: t.artist, actions: [
    SheetAction('Play next', Icons.playlist_play, () => _mc.enqueue([t], next: true)),
    SheetAction('Add to queue', Icons.queue_music, () => _mc.enqueue([t])),
    SheetAction('Add to playlist\u2026', Icons.playlist_add, () => addToPlaylistSheet(context, [t])),
    ...extra,
  ]);
}

/// Pick a playlist (or make a new one) for [tracks]; songs already in it are skipped.
Future<void> addToPlaylistSheet(BuildContext context, List<Track> tracks) async {
  if (tracks.isEmpty) return;
  final messenger = ScaffoldMessenger.maybeOf(context);
  Future<void> newOne() async {
    final name = await promptName(context, title: 'New playlist', action: 'Create');
    if (name == null) return;
    final p = _pl.create(name, tracks);
    _say(messenger, 'Created \u201c${p.name}\u201d with ${_songs(p.tracks.length)}');
  }

  final lists = _pl.all;
  await _sheet(
    context,
    title: 'Add to playlist',
    subtitle: tracks.length == 1 ? tracks.first.title : _songs(tracks.length),
    actions: [
      SheetAction('New playlist\u2026', Icons.add, newOne),
      for (final p in lists)
        SheetAction('${p.name}  \u00b7  ${_songs(p.tracks.length)}', Icons.library_music_outlined, () {
          final n = _pl.add(p.id, tracks);
          _say(messenger, n == 0 ? 'Already in \u201c${p.name}\u201d' : 'Added ${_songs(n)} to \u201c${p.name}\u201d');
        }),
    ],
  );
}

/// A new playlist the user names (an empty name becomes "New playlist"); returns it, or null when cancelled.
Future<Playlist?> newPlaylist(BuildContext context, [List<Track> tracks = const []]) async {
  final name = await promptName(context, title: 'New playlist', action: 'Create');
  return name == null ? null : _pl.create(name, tracks);
}

Future<void> renamePlaylist(BuildContext context, Playlist p) async {
  final name = await promptName(context, title: 'Rename playlist', initial: p.name);
  if (name != null && name.isNotEmpty) _pl.rename(p.id, name);
}

Future<bool> deletePlaylist(BuildContext context, Playlist p) async {
  final ok = await _confirm(context, 'Delete playlist?', '\u201c${p.name}\u201d will be deleted. Your songs are not touched.', 'Delete');
  if (ok) _pl.delete(p.id);
  return ok;
}

/// Long-press on a playlist in a list.
Future<void> showPlaylistMenu(BuildContext context, Playlist p) {
  return _sheet(context, title: p.name, subtitle: _songs(p.tracks.length), actions: [
    if (p.tracks.isNotEmpty) SheetAction('Play', Icons.play_arrow, () => _mc.playAll(p.tracks)),
    if (p.tracks.isNotEmpty) SheetAction('Shuffle', Icons.shuffle, () => _mc.playAll(p.tracks, shuffle: true)),
    if (p.tracks.isNotEmpty) SheetAction('Add to queue', Icons.queue_music, () => _mc.enqueue(p.tracks)),
    SheetAction('Rename', Icons.edit_outlined, () => renamePlaylist(context, p)),
    SheetAction('Delete', Icons.delete_outline, () => deletePlaylist(context, p)),
  ]);
}

void openPlaylist(BuildContext context, String id) => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => PlaylistScreen(id: id)));

/// The Playlists list (Music tab): "+ New playlist" and one row per playlist.
class PlaylistRows extends StatelessWidget {
  const PlaylistRows({super.key});

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return ListenableBuilder(
      listenable: _pl,
      builder: (context, _) {
        final lists = _pl.all;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: EdgeInsets.only(bottom: 0.75 * rem),
            child: PekButton(
              compact: true,
              primary: true,
              label: '+ New playlist',
              onTap: () async {
                final p = await newPlaylist(context);
                if (p != null && context.mounted) openPlaylist(context, p.id);
              },
            ),
          ),
          if (lists.isEmpty) const PekCard(title: 'No playlists yet', subtitle: 'Make a playlist, then add songs with \u201cAdd to playlist\u201d or by pressing and holding a song.'),
          for (final p in lists)
            ListRow(
              title: p.name,
              subtitle: _songs(p.tracks.length),
              trailing: Art(url: playlistArt(p), size: 2.5 * rem),
              onTap: () => openPlaylist(context, p.id),
              onLongPress: () => showPlaylistMenu(context, p),
            ),
        ]);
      },
    );
  }
}

// ============================================================================================ the playlist page

/// One playlist: Play / Shuffle / Add to queue / Rename / Delete, and its songs. Touch: drag the handle to reorder.
/// Remote: press and hold (or the menu) for Move up / Move down / Remove.
class PlaylistScreen extends StatelessWidget {
  const PlaylistScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: _pl,
      builder: (context, _) {
        final pl = _pl.byId(id);
        return SubScreen(
          title: pl?.name ?? 'Playlist',
          body: pl == null ? const Center(child: Text('This playlist was deleted.')) : _body(context, pl),
        );
      },
    );
  }

  Widget _body(BuildContext context, Playlist pl) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final tracks = pl.tracks;

    final header = Padding(
      padding: EdgeInsets.only(bottom: rem),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Art(url: playlistArt(pl), size: (p.narrow ? 8 : 12) * rem, radius: 12),
        SizedBox(width: rem),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(pl.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.4 * rem, fontWeight: FontWeight.w800)),
            Text(_songs(tracks.length), style: TextStyle(color: t.textMuted)),
            SizedBox(height: 0.75 * rem),
            Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
              PekButton(compact: true, primary: true, autofocus: true, label: 'Play', onTap: tracks.isEmpty ? null : () => _mc.playAll(tracks)),
              PekButton(compact: true, label: 'Shuffle', onTap: tracks.isEmpty ? null : () => _mc.playAll(tracks, shuffle: true)),
              PekButton(compact: true, label: 'Add to queue', onTap: tracks.isEmpty ? null : () => _mc.enqueue(tracks)),
              PekButton(compact: true, label: 'Rename', onTap: () => renamePlaylist(context, pl)),
              PekButton(
                compact: true,
                label: 'Delete',
                onTap: () async {
                  if (await deletePlaylist(context, pl) && context.mounted) Navigator.of(context).maybePop();
                },
              ),
            ]),
          ]),
        ),
      ]),
    );

    if (tracks.isEmpty) {
      return ListView(padding: p.pagePad, children: [
        header,
        const PekCard(title: 'This playlist is empty', subtitle: 'Add songs from an album or the Songs list: press and hold a song, then \u201cAdd to playlist\u201d.'),
      ]);
    }

    return ReorderableListView.builder(
      padding: p.pagePad.copyWith(bottom: p.pagePad.bottom + 4 * rem),
      header: header,
      buildDefaultDragHandles: false,
      itemCount: tracks.length,
      onReorder: (from, to) => _pl.move(pl.id, from, to > from ? to - 1 : to),
      itemBuilder: (context, i) {
        final tr = tracks[i];
        return KeyedSubtree(
          key: ValueKey(tr.id),
          child: ValueListenableBuilder<Track?>(
            valueListenable: _mc.current,
            builder: (_, cur, __) => ListRow(
              title: '${i + 1}. ${tr.title}',
              subtitle: tr.artist,
              highlight: cur?.id == tr.id,
              onTap: () => _mc.playList(tracks, i),
              onLongPress: () => showTrackMenu(context, tr, extra: [
                if (i > 0) SheetAction('Move up', Icons.arrow_upward, () => _pl.move(pl.id, i, i - 1)),
                if (i < tracks.length - 1) SheetAction('Move down', Icons.arrow_downward, () => _pl.move(pl.id, i, i + 1)),
                SheetAction('Remove from playlist', Icons.remove_circle_outline, () => _pl.removeAt(pl.id, i)),
              ]),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                if (tr.duration > 0) Text(formatTime(tr.duration), style: TextStyle(fontSize: 0.85 * rem, color: t.textMuted)),
                if (!p.isTv) ReorderableDragStartListener(index: i, child: Padding(padding: EdgeInsets.only(left: 0.6 * rem), child: Icon(Icons.drag_handle, color: t.textMuted))),
              ]),
            ),
          ),
        );
      },
    );
  }
}
