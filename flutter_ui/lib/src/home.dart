import 'package:flutter/material.dart';

import 'api.dart';
import 'detail.dart';
import 'focus.dart';
import 'mpv.dart';
import 'theme.dart';
import 'art_cache.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0; // 0 movies, 1 shows
  late Future<List<Movie>> _movies = Api.movies();
  late Future<List<Show>> _shows = Api.shows();

  Future<void> _menu() async {
    final pick = await showDialog<String>(
      context: context,
      builder: (c) => SimpleDialog(
        title: const Text('PEK TV'),
        children: [
          SimpleDialogOption(onPressed: () => Navigator.pop(c, 'refresh'), child: const Text('Refresh library')),
          SimpleDialogOption(onPressed: () => Navigator.pop(c, 'exit'), child: const Text('Exit')),
        ],
      ),
    );
    if (!mounted) return;
    switch (pick) {
      case 'refresh':
        setState(() {
          _movies = Api.movies();
          _shows = Api.shows();
        });
        break;
      case 'exit':
        await PekPlayer.exitApp();
        break;
    }
  }

  Future<void> _askExit() async {
    final yes = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        title: const Text('Exit PEK TV?'),
        actions: [
          TextButton(autofocus: true, onPressed: () => Navigator.pop(c, false), child: const Text('Stay')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Exit')),
        ],
      ),
    );
    if (yes == true) await PekPlayer.exitApp();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _askExit();
      },
      child: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 12, 24, 8),
                child: Row(
                  children: [
                    const Text('PEK TV', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Pek.accent)),
                    const SizedBox(width: 24),
                    ChoiceChip(label: const Text('Movies'), selected: _tab == 0, onSelected: (_) => setState(() => _tab = 0)),
                    const SizedBox(width: 8),
                    ChoiceChip(label: const Text('Shows'), selected: _tab == 1, onSelected: (_) => setState(() => _tab = 1)),
                    const Spacer(),
                    IconButton(onPressed: _menu, icon: const Icon(Icons.more_vert)),
                  ],
                ),
              ),
              Expanded(child: _tab == 0 ? _moviesGrid() : _showsGrid()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _moviesGrid() {
    return FutureBuilder<List<Movie>>(
      future: _movies,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
        if (snap.hasError) return Center(child: Text('Could not load movies: ${snap.error}'));
        final items = snap.data ?? const [];
        if (items.isEmpty) return const Center(child: Text('No movies yet. Add a source folder in Settings, then refresh.'));
        return _grid(
          count: items.length,
          builder: (i) {
            final m = items[i];
            return _PosterCard(
              title: m.title,
              subtitle: m.year > 0 ? '${m.year}' : '',
              poster: Api.movieDetails(m.id),
              autofocus: i == 0,
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m))),
            );
          },
        );
      },
    );
  }

  Widget _showsGrid() {
    return FutureBuilder<List<Show>>(
      future: _shows,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
        if (snap.hasError) return Center(child: Text('Could not load shows: ${snap.error}'));
        final items = snap.data ?? const [];
        if (items.isEmpty) return const Center(child: Text('No shows yet.'));
        return _grid(
          count: items.length,
          builder: (i) {
            final s = items[i];
            return _PosterCard(
              title: s.title,
              subtitle: '${s.episodeCount} episodes',
              poster: Api.showDetails(s.title),
              autofocus: i == 0,
              onTap: () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s))),
            );
          },
        );
      },
    );
  }

  Widget _grid({required int count, required Widget Function(int) builder}) {
    return GridView.builder(
      padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 190,
        childAspectRatio: 0.56,
        crossAxisSpacing: 16,
        mainAxisSpacing: 16,
      ),
      itemCount: count,
      itemBuilder: (context, i) => builder(i),
    );
  }
}

class _PosterCard extends StatelessWidget {
  const _PosterCard({
    required this.title,
    required this.subtitle,
    required this.poster,
    required this.onTap,
    this.autofocus = false,
  });

  final String title;
  final String subtitle;
  final Future<Details> poster;
  final VoidCallback onTap;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    return FocusCard(
      autofocus: autofocus,
      onTap: onTap,
      child: Container(
        color: Pek.surface,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(child: PosterImage(poster: poster, title: title)),
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                  if (subtitle.isNotEmpty) Text(subtitle, style: const TextStyle(fontSize: 11, color: Pek.muted)),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Poster from the server's details lookup; the title is shown while it loads or when there is no picture.
class PosterImage extends StatelessWidget {
  const PosterImage({super.key, required this.poster, required this.title, this.width = 320});
  final Future<Details> poster;
  final String title;
  final int width;

  @override
  Widget build(BuildContext context) {
    Widget placeholder() => Center(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Text(title, textAlign: TextAlign.center, style: const TextStyle(color: Pek.muted)),
          ),
        );
    return FutureBuilder<Details>(
      future: poster,
      builder: (context, snap) {
        final url = snap.data?.poster ?? '';
        if (url.isEmpty) return placeholder();
        return ArtImage(
          url,
          fit: BoxFit.cover,
          cacheWidth: width, // decode small: weak TV boxes run out of memory on full-size posters
          errorBuilder: (_, __, ___) => placeholder(),
        );
      },
    );
  }
}
