import 'package:flutter/material.dart';

import 'api.dart';
import 'art_cache.dart';
import 'player.dart';
import 'ratings.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart' show weatherActions;
import 'torrent.dart';
import 'watched.dart';
import 'widgets.dart';

/// Opens the player. [resume] makes the player record progress for Resume Watching.
///
/// For an episode the player also offers the next one near the end ("Up next"): [nextFor] says which, and when it is left out the
/// show is looked up here from the item's show title.
Future<void> playMedia(BuildContext context, Progress item, {double startSec = 0, Progress? Function(Progress current)? nextFor}) async {
  // A resume point that came from a torrent (here or on another device) starts the same release again.
  if (item.isTorrent) {
    await playTorrent(context, track: item, startSec: startSec);
    return;
  }
  var resolver = nextFor;
  if (resolver == null && item.kind == 'episode' && item.showTitle.isNotEmpty) {
    try {
      final shows = await Api.shows();
      final show = shows.where((s) => s.title == item.showTitle).firstOrNull;
      if (show != null) resolver = (cur) => nextEpisodeItem(show, cur.id);
    } catch (_) {}
  }
  if (!context.mounted) return;
  await Navigator.push(
    context,
    MaterialPageRoute<void>(builder: (_) => PlayerScreen(url: Api.streamUrl(item.id), title: item.title, startSec: startSec, resume: item, nextFor: resolver)),
  );
}

/// Pressing something you stopped partway: ask whether to carry on from where you were or start from the beginning.
/// (Under 15 seconds in there is nothing worth resuming, so it just plays.)
Future<void> playResumeOrStart(BuildContext context, Progress item) async {
  if (item.position < 15) {
    await playMedia(context, item);
    return;
  }
  final from = await showDialog<double>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(item.title, maxLines: 2, overflow: TextOverflow.ellipsis),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        PekButton(label: 'Resume from ${_fmt(item.position)}', primary: true, autofocus: true, onTap: () => Navigator.pop(c, item.position)),
        const SizedBox(height: 8),
        PekButton(label: 'Start over', onTap: () => Navigator.pop(c, 0.0)),
      ]),
    ),
  );
  if (from == null || !context.mounted) return;
  await playMedia(context, item, startSec: from);
}

/// The episode after [currentId] in [show]: the rest of the season, then the next season. Specials never come "next".
Progress? nextEpisodeItem(Show show, String currentId) {
  final flat = <Episode>[
    for (final s in show.seasons)
      if (s.number > 0) ...s.episodes,
  ]..sort((a, b) => a.season != b.season ? a.season - b.season : a.episode - b.episode);
  final i = flat.indexWhere((e) => e.id == currentId);
  if (i < 0 || i + 1 >= flat.length) return null;
  return episodeItem(show, flat[i + 1]);
}

Progress movieItem(Movie m) => Progress(id: m.id, title: m.title, kind: 'movie', position: 0, duration: 0, updated: 0, year: m.year);

Progress episodeItem(Show s, Episode e) {
  final label = 'S${e.season.toString().padLeft(2, '0')}E${e.episode.toString().padLeft(2, '0')}';
  return Progress(id: e.id, title: '${s.title} $label', kind: 'episode', position: 0, duration: 0, updated: 0, showTitle: s.title, season: e.season, episode: e.episode);
}

/// Is this episode in Watch History?
bool episodeWatched(Show s, Episode e) => Store.isWatched(kind: 'episode', showTitle: s.title, season: e.season, episode: e.episode);

bool movieWatched(Movie m) => Store.isWatched(kind: 'movie', title: m.title, year: m.year);

/// Every episode of [seasons] is watched (and there is at least one): the web UI's `allSeen`.
bool seasonsWatched(Show s, Iterable<Season> seasons) {
  var any = false;
  for (final se in seasons) {
    for (final e in se.episodes) {
      any = true;
      if (!episodeWatched(s, e)) return false;
    }
  }
  return any;
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
        final seen = movieWatched(movie);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: TextStyle(fontSize: 1.7 * rem, fontWeight: FontWeight.w800)),
            if (Ratings.of(movie.title, movie.year) > 0) ...[
              SizedBox(height: 0.35 * rem),
              StarDisplay(value: Ratings.of(movie.title, movie.year)),
            ],
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
              PekButton(label: seen ? '\u2713 Watched \u00b7 mark as unwatched' : 'Mark as watched', onTap: () => Watched.set([movieItem(movie)], !seen)),
            ]),
            SizedBox(height: 1.25 * rem),
            RatingPanel(title: movie.title, year: movie.year),
          ],
        );
      },
    );
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text, actions: weatherActions(context)),
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
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text, title: Text(show.title), actions: weatherActions(context)),
      body: ValueListenableBuilder<int>(
        valueListenable: Store.changed,
        builder: (context, _, __) {
          final fav = Store.isFavorite('s:${show.title}');
          final allSeen = seasonsWatched(show, seasons);
          final seasonSeen = seasons.isNotEmpty && seasonsWatched(show, [seasons[_season]]);
          return ListView(
            padding: EdgeInsets.fromLTRB(rem + p.safeX, 0, rem + p.safeX, rem),
            children: [
              FutureBuilder<Details>(future: details, builder: (_, snap) => ExpandableText(snap.data?.overview ?? '', maxLines: 4)),
              SizedBox(height: 0.75 * rem),
              Wrap(spacing: 0.75 * rem, runSpacing: 0.5 * rem, children: [
                PekButton(compact: true, label: fav ? '\u2665 Favorited' : '\u2661 Favorite', onTap: () => Store.toggleFavorite(Favorite.show(show.title))),
                PekButton(
                  compact: true,
                  label: allSeen ? 'Mark show as unwatched' : 'Mark show as watched',
                  onTap: () => Watched.set([for (final se in seasons) for (final e in se.episodes) episodeItem(show, e)], !allSeen),
                ),
                if (seasons.isNotEmpty)
                  PekButton(
                    compact: true,
                    label: seasonSeen ? 'Mark season as unwatched' : 'Mark season as watched',
                    onTap: () => Watched.set([for (final e in episodes) episodeItem(show, e)], !seasonSeen),
                  ),
              ]),
              SizedBox(height: 0.75 * rem),
              RatingPanel(title: show.title, kind: 'show'),
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
                    label: (seasons[i].number == 0 ? 'Specials' : 'Season ${seasons[i].number}') + (seasonsWatched(show, [seasons[i]]) ? ' \u2713' : ''),
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
    final seen = episodeWatched(show, e);
    return Padding(
      padding: EdgeInsets.only(bottom: 0.5 * rem),
      child: PekFocusable(
        radius: 12,
        background: t.surface,
        borderColor: t.border,
        padding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.7 * rem),
        // Opens the episode page (picture, full synopsis, Play / Continue); Play is on that page.
        onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => EpisodeScreen(show: show, episode: e))),
        // Press and hold: mark this one episode watched / unwatched (the season and show buttons above do many at once).
        onLongPress: () => Watched.set([episodeItem(show, e)], !seen),
        child: Row(children: [
          Icon(Icons.play_circle_outline, color: t.accent, size: 1.5 * rem),
          SizedBox(width: 0.75 * rem),
          Expanded(child: Text('$label  ${e.filename}', maxLines: 1, overflow: TextOverflow.ellipsis)),
          if (saved != null) Text(_fmt(saved.position), style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem)),
          if (seen) Padding(padding: EdgeInsets.only(left: 0.5 * rem), child: Icon(Icons.check_circle, color: t.accent, size: 1.25 * rem)),
        ]),
      ),
    );
  }
}

/// A synopsis cut to [maxLines] with a "Show more" / "Show less" switch (shown only when the text really is cut).
class ExpandableText extends StatefulWidget {
  const ExpandableText(this.text, {super.key, this.maxLines = 4});
  final String text;
  final int maxLines;

  @override
  State<ExpandableText> createState() => _ExpandableTextState();
}

class _ExpandableTextState extends State<ExpandableText> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    if (widget.text.isEmpty) return const SizedBox.shrink();
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final style = TextStyle(color: t.textMuted, height: 1.4);
    return LayoutBuilder(builder: (context, c) {
      final painter = TextPainter(
        text: TextSpan(text: widget.text, style: DefaultTextStyle.of(context).style.merge(style)),
        textDirection: TextDirection.ltr,
        textScaler: MediaQuery.textScalerOf(context),
        maxLines: widget.maxLines,
      )..layout(maxWidth: c.maxWidth);
      final cut = painter.didExceedMaxLines;
      painter.dispose();
      if (!cut) return Text(widget.text, style: style);
      return PekFocusable(
        radius: 8,
        padding: EdgeInsets.symmetric(vertical: 0.25 * rem),
        onTap: () => setState(() => _open = !_open),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(widget.text, maxLines: _open ? null : widget.maxLines, overflow: _open ? TextOverflow.visible : TextOverflow.ellipsis, style: style),
          SizedBox(height: 0.25 * rem),
          Text(_open ? 'Show less' : 'Show more', style: TextStyle(color: t.accent, fontWeight: FontWeight.w600)),
        ]),
      );
    });
  }
}

/// One episode: its still picture, title, the whole synopsis, and Play / Continue / Mark as watched.
class EpisodeScreen extends StatelessWidget {
  const EpisodeScreen({super.key, required this.show, required this.episode});
  final Show show;
  final Episode episode;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final e = episode;
    final label = 'S${e.season.toString().padLeft(2, '0')}E${e.episode.toString().padLeft(2, '0')}';
    final info = Api.episodeDetails(show.title, e.season, e.episode);
    Widget noPicture() => Center(child: Icon(Icons.movie_outlined, color: t.textMuted, size: 2.5 * rem));
    final still = ClipRRect(
      borderRadius: BorderRadius.circular(t.radius),
      child: AspectRatio(
        aspectRatio: 16 / 9,
        child: ColoredBox(
          color: t.surface,
          child: FutureBuilder<EpisodeInfo>(
            future: info,
            builder: (_, snap) {
              final url = snap.data?.still ?? '';
              if (url.isEmpty) return noPicture();
              return ArtImage(url, fit: BoxFit.cover, cacheWidth: 800, errorBuilder: (_, __, ___) => noPicture());
            },
          ),
        ),
      ),
    );
    final body = ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final saved = Store.progressFor(e.id);
        final seen = episodeWatched(show, e);
        final item = episodeItem(show, e);
        void play(double start) => playMedia(context, item, startSec: start, nextFor: (cur) => nextEpisodeItem(show, cur.id));
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            FutureBuilder<EpisodeInfo>(
              future: info,
              builder: (_, snap) {
                final done = snap.connectionState == ConnectionState.done;
                final name = snap.data?.name ?? '';
                final overview = snap.data?.overview ?? '';
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(label, style: TextStyle(color: t.accent, fontWeight: FontWeight.w700)),
                    SizedBox(height: 0.25 * rem),
                    Text(name.isEmpty ? e.filename : name, style: TextStyle(fontSize: 1.5 * rem, fontWeight: FontWeight.w800)),
                    SizedBox(height: 0.75 * rem),
                    // The whole synopsis: no line limit here.
                    Text(overview.isNotEmpty ? overview : (done ? 'No description available.' : 'Loading...'), style: TextStyle(color: t.textMuted, height: 1.4)),
                  ],
                );
              },
            ),
            SizedBox(height: 1.25 * rem),
            Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
              if (saved != null) ...[
                PekButton(label: 'Continue ${_fmt(saved.position)}', primary: true, autofocus: true, onTap: () => play(saved.position)),
                PekButton(label: 'Start over', onTap: () => play(0)),
              ] else
                PekButton(label: 'Play', primary: true, autofocus: true, onTap: () => play(0)),
              PekButton(label: seen ? '\u2713 Watched \u00b7 mark as unwatched' : 'Mark as watched', onTap: () => Watched.set([item], !seen)),
            ]),
            SizedBox(height: 1.25 * rem),
            RatingPanel(title: show.title, kind: 'episode', season: e.season, episode: e.episode),
          ],
        );
      },
    );
    return Scaffold(
      backgroundColor: t.bg,
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: t.text, title: Text(show.title), actions: weatherActions(context)),
      body: p.narrow
          ? SingleChildScrollView(padding: EdgeInsets.all(rem), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [still, SizedBox(height: rem), body]))
          : Padding(
              padding: EdgeInsets.fromLTRB(2 * rem + p.safeX, rem, 2 * rem + p.safeX, rem),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [SizedBox(width: 26 * rem, child: still), SizedBox(width: 2 * rem), Expanded(child: SingleChildScrollView(child: body))]),
            ),
    );
  }
}
