import 'package:flutter/material.dart';

import 'api.dart';
import 'home.dart' show PosterImage;
import 'player.dart';
import 'theme.dart';

void _play(BuildContext context, String id, String title) {
  Navigator.push(
    context,
    MaterialPageRoute<void>(builder: (_) => PlayerScreen(url: Api.streamUrl(id), title: title)),
  );
}

class MovieScreen extends StatelessWidget {
  const MovieScreen({super.key, required this.movie});
  final Movie movie;

  @override
  Widget build(BuildContext context) {
    final details = Api.movieDetails(movie.id);
    final title = movie.year > 0 ? '${movie.title} (${movie.year})' : movie.title;
    return Scaffold(
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 200,
              child: AspectRatio(
                aspectRatio: 2 / 3,
                child: ClipRRect(borderRadius: BorderRadius.circular(Pek.radius), child: PosterImage(poster: details, title: movie.title, width: 480)),
              ),
            ),
            const SizedBox(width: 24),
            Expanded(
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 12),
                    FutureBuilder<Details>(
                      future: details,
                      builder: (_, snap) => Text(snap.data?.overview ?? '', style: const TextStyle(color: Pek.muted, height: 1.4)),
                    ),
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      autofocus: true,
                      onPressed: () => _play(context, movie.id, movie.title),
                      icon: const Icon(Icons.play_arrow),
                      label: const Text('Play'),
                    ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
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
    final show = widget.show;
    final details = Api.showDetails(show.title);
    final seasons = show.seasons;
    final episodes = seasons.isEmpty ? const <Episode>[] : seasons[_season].episodes;
    return Scaffold(
      appBar: AppBar(backgroundColor: Colors.transparent, elevation: 0, title: Text(show.title)),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            FutureBuilder<Details>(
              future: details,
              builder: (_, snap) => Text(
                snap.data?.overview ?? '',
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Pek.muted, height: 1.4),
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 44,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: seasons.length,
                separatorBuilder: (_, __) => const SizedBox(width: 8),
                itemBuilder: (_, i) => ChoiceChip(
                  autofocus: i == 0,
                  label: Text(seasons[i].number == 0 ? 'Specials' : 'Season ${seasons[i].number}'),
                  selected: i == _season,
                  onSelected: (_) => setState(() => _season = i),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: ListView.builder(
                itemCount: episodes.length,
                itemBuilder: (_, i) {
                  final e = episodes[i];
                  final label = 'S${e.season.toString().padLeft(2, '0')}E${e.episode.toString().padLeft(2, '0')}';
                  return ListTile(
                    leading: const Icon(Icons.play_circle_outline),
                    title: Text('$label  ${e.filename}', maxLines: 1, overflow: TextOverflow.ellipsis),
                    onTap: () => _play(context, e.id, '${show.title} $label'),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
