import 'package:flutter/material.dart';

import 'api.dart';
import 'player.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Opens the player. [resume] makes the player record progress for Resume Watching.
Future<void> playMedia(BuildContext context, Progress item, {double startSec = 0}) {
  return Navigator.push(
    context,
    MaterialPageRoute<void>(builder: (_) => PlayerScreen(url: Api.streamUrl(item.id), title: item.title, startSec: startSec, resume: item)),
  );
}

Progress movieItem(Movie m) => Progress(id: m.id, title: m.title, kind: 'movie', position: 0, duration: 0, updated: 0, year: m.year);

Progress episodeItem(Show s, Episode e) {
  final label = 'S${e.season.toString().padLeft(2, '0')}E${e.episode.toString().padLeft(2, '0')}';
  return Progress(id: e.id, title: '${s.title} $label', kind: 'episode', position: 0, duration: 0, updated: 0, showTitle: s.title);
}

class MovieScreen extends StatelessWidget {
  const MovieScreen({super.key, required this.movie});
  final Movie movie;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final details = Api.movieDetails(movie.id);
    final title = movie.year > 0 ? '${movie.title} (${movie.year})' : movie.title;
    final poster = SizedBox(
      width: p.narrow ? p.size.width * 0.5 : 14 * rem,
      child: AspectRatio(aspectRatio: 2 / 3, child: ClipRRect(borderRadius: BorderRadius.circular(t.radius), child: PosterImage(poster: details, title: movie.title, width: 480))),
    );
    final info = ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final saved = Store.progressFor(movie.id);
        final fav = Store.isFavorite('m:${movie.id}');
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(fontSize: 1.7 * rem, fontWeight: FontWeight.w800)),
            SizedBox(height: 0.75 * rem),
            FutureBuilder<Details>(future: details, builder: (_, snap) => Text(snap.data?.overview ?? '', style: TextStyle(color: t.textMuted, height: 1.4))),
            SizedBox(height: 1.25 * rem),
            Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
              if (saved != null) ...[
                PekButton(label: 'Continue ${_fmt(saved.position)}', primary: true, autofocus: true, onTap: () => playMedia(context, movieItem(movie), startSec: saved.position)),
                PekButton(label: 'Start over', onTap: () => playMedia(context, movieItem(movie))),
              ] else
                PekButton(label: 'Play', primary: true, autofocus: true, onTap: () => playMedia(context, movieItem(movie))),
              PekButton(label: fav ? '\u2665 Favorited' : '\u2661 Favorite', onTap: () => Store.toggleFavorite(Favorite.movie(movie.id, movie.title, movie.year))),
            ]),
          ],
        );
      },
    );
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text),
      body: p.narrow
          ? SingleChildScrollView(padding: EdgeInsets.all(rem), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Center(child: poster), SizedBox(height: rem), info]))
          : Padding(
              padding: EdgeInsets.fromLTRB(2 * rem + p.safeX, rem, 2 * rem + p.safeX, rem),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [poster, SizedBox(width: 2 * rem), Expanded(child: SingleChildScrollView(child: info))]),
            ),
    );
  }
}

String _fmt(double s) {
  final t = s.floor();
  final h = t ~/ 3600, m = (t % 3600) ~/ 60, sec = t % 60;
  String two(int n) => n.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(sec)}' : '${two(m)}:${two(sec)}';
}

class ShowScreen extends StatefulWidget {
  const ShowScreen({super.key, required this.show});
  final Show show;
  @override
  State<ShowScreen> createState() => _ShowScreenState();
}

class _ShowScreenState extends State<ShowScreen> {
  int _season = 0;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final show = widget.show;
    final details = Api.showDetails(show.title);
    final seasons = show.seasons;
    final episodes = seasons.isEmpty ? const <Episode>[] : seasons[_season].episodes;
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text, title: Text(show.title)),
      body: ValueListenableBuilder<int>(
        valueListenable: Store.changed,
        builder: (context, _, __) {
          final fav = Store.isFavorite('s:${show.title}');
          return ListView(
            padding: EdgeInsets.fromLTRB(rem + p.safeX, 0, rem + p.safeX, rem),
            children: [
              FutureBuilder<Details>(future: details, builder: (_, snap) => Text(snap.data?.overview ?? '', maxLines: 4, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, height: 1.4))),
              SizedBox(height: 0.75 * rem),
              Align(
                alignment: Alignment.centerLeft,
                child: PekButton(compact: true, label: fav ? '\u2665 Favorited' : '\u2661 Favorite', onTap: () => Store.toggleFavorite(Favorite.show(show.title))),
              ),
              SizedBox(height: 0.75 * rem),
              SizedBox(
                height: 2.75 * rem,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: seasons.length,
                  separatorBuilder: (_, __) => SizedBox(width: 0.5 * rem),
                  itemBuilder: (_, i) => PekButton(
                    compact: true,
                    primary: i == _season,
                    autofocus: i == 0,
                    label: seasons[i].number == 0 ? 'Specials' : 'Season ${seasons[i].number}',
                    onTap: () => setState(() => _season = i),
                  ),
                ),
              ),
              SizedBox(height: 0.75 * rem),
              for (final e in episodes) _episodeRow(context, show, e),
            ],
          );
        },
      ),
    );
  }

  Widget _episodeRow(BuildContext context, Show show, Episode e) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final label = 'S${e.season.toString().padLeft(2, '0')}E${e.episode.toString().padLeft(2, '0')}';
    final saved = Store.progressFor(e.id);
    return Padding(
      padding: EdgeInsets.only(bottom: 0.5 * rem),
      child: PekFocusable(
        radius: 12,
        background: t.surface,
        borderColor: t.border,
        padding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.7 * rem),
        onTap: () => playMedia(context, episodeItem(show, e), startSec: saved?.position ?? 0),
        child: Row(children: [
          Icon(Icons.play_circle_outline, color: t.accent, size: 1.5 * rem),
          SizedBox(width: 0.75 * rem),
          Expanded(child: Text('$label  ${e.filename}', maxLines: 1, overflow: TextOverflow.ellipsis)),
          if (saved != null) Text(_fmt(saved.position), style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem)),
        ]),
      ),
    );
  }
}
