import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Genre / Year buttons under the Music search box (and a Clear button while a filter is on).
/// They only choose; [MusicPage] sends the choice to the server (/api/music/* with genre= / year= / decade=).
/// Everything is a PekButton / ListRow, so the TV remote's arrow keys and OK work like everywhere else.
class MusicFilterBar extends StatelessWidget {
  const MusicFilterBar({super.key, required this.filters, required this.onChanged});
  final MusicFilters filters;
  final ValueChanged<MusicFilters> onChanged;

  String _yearLabel() => filters.year > 0 ? '${filters.year}' : (filters.decade > 0 ? '${filters.decade}s' : 'Year');

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 0.75 * rem),
      child: Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
        PekButton(
          compact: true,
          shrink: true,
          primary: filters.genre.isNotEmpty,
          label: filters.genre.isNotEmpty ? filters.genre : 'Genre',
          leading: const Icon(Icons.category_outlined, size: 18),
          onTap: () async {
            final g = await pickMusicGenre(context, filters.genre);
            if (g != null) onChanged(filters.withGenre(g));
          },
        ),
        PekButton(
          compact: true,
          shrink: true,
          primary: filters.year > 0 || filters.decade > 0,
          label: _yearLabel(),
          leading: const Icon(Icons.event_outlined, size: 18),
          onTap: () async {
            final y = await pickMusicYear(context, filters);
            if (y != null) onChanged(filters.withYear(year: y.year, decade: y.decade));
          },
        ),
        if (filters.active) PekButton(compact: true, shrink: true, label: 'Clear', leading: const Icon(Icons.close, size: 18), onTap: () => onChanged(MusicFilters.none)),
      ]),
    );
  }
}

/// A list in a dialog. Returns the chosen value, or null when it was closed without a choice.
Future<T?> _pickFromList<T>(BuildContext context, String title, List<({String title, String subtitle, T value, bool selected})> rows, {String empty = ''}) {
  return showDialog<T>(
    context: context,
    builder: (c) {
      final p = c.pek;
      final rem = p.rem;
      return Dialog(
        backgroundColor: p.tokens.glassStrong,
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: 28 * rem, maxHeight: p.size.height * 0.8),
          child: Padding(
            padding: EdgeInsets.all(rem),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: TextStyle(fontSize: 1.2 * rem, fontWeight: FontWeight.w700)),
              SizedBox(height: 0.5 * rem),
              if (rows.isEmpty)
                Padding(padding: EdgeInsets.symmetric(vertical: rem), child: Text(empty, style: TextStyle(color: p.tokens.textMuted)))
              else
                Flexible(
                  child: ListView.builder(
                    shrinkWrap: true,
                    itemCount: rows.length,
                    itemBuilder: (_, i) => ListRow(
                      title: rows[i].title,
                      subtitle: rows[i].subtitle,
                      autofocus: rows[i].selected,
                      highlight: rows[i].selected,
                      onTap: () => Navigator.pop(c, rows[i].value),
                    ),
                  ),
                ),
            ]),
          ),
        ),
      );
    },
  );
}

/// Asks the server which genres exist and lets the person pick one. Returns '' for "Any genre", null when closed.
Future<String?> pickMusicGenre(BuildContext context, String current) async {
  MusicFacets facets;
  try {
    facets = await Api.musicFacets();
  } catch (_) {
    facets = const MusicFacets(genres: [], years: []);
  }
  if (!context.mounted) return null;
  final rows = <({String title, String subtitle, String value, bool selected})>[
    (title: 'Any genre', subtitle: '', value: '', selected: current.isEmpty),
    for (final g in facets.genres)
      (title: g.name, subtitle: g.count == 1 ? '1 song' : '${g.count} songs', value: g.name, selected: g.name.toLowerCase() == current.toLowerCase()),
  ];
  return _pickFromList<String>(context, 'Genre', facets.genres.isEmpty ? rows.take(1).toList() : rows,
      empty: 'No genres found. Genres come from the songs\u2019 tags.');
}

/// Picks a decade ("1990s") or a single year. Decades come first, then the years that exist in the library, newest first.
/// Returns (year: 0, decade: 0) for "Any year", null when closed.
Future<({int year, int decade})?> pickMusicYear(BuildContext context, MusicFilters current) async {
  MusicFacets facets;
  try {
    facets = await Api.musicFacets();
  } catch (_) {
    facets = const MusicFacets(genres: [], years: []);
  }
  if (!context.mounted) return null;
  final decades = <int, int>{};
  for (final y in facets.years) {
    final d = (y.year ~/ 10) * 10;
    decades[d] = (decades[d] ?? 0) + y.count;
  }
  final ds = decades.keys.toList()..sort((a, b) => b.compareTo(a));
  String songs(int n) => n == 1 ? '1 song' : '$n songs';
  final rows = <({String title, String subtitle, ({int year, int decade}) value, bool selected})>[
    (title: 'Any year', subtitle: '', value: (year: 0, decade: 0), selected: current.year == 0 && current.decade == 0),
    for (final d in ds) (title: '${d}s', subtitle: songs(decades[d]!), value: (year: 0, decade: d), selected: current.year == 0 && current.decade == d),
    for (final y in facets.years) (title: '${y.year}', subtitle: songs(y.count), value: (year: y.year, decade: 0), selected: current.year == y.year),
  ];
  return _pickFromList<({int year, int decade})>(context, 'Year', facets.years.isEmpty ? rows.take(1).toList() : rows,
      empty: 'No years found. Years come from the songs\u2019 tags.');
}
