import 'dart:async';

import 'package:flutter/material.dart';

import 'account_pages.dart';
import 'layouts.dart';
import 'api.dart';
import 'common.dart';
import 'detail.dart';
import 'mpv.dart';
import 'net_folders.dart';
import 'plugin_backup.dart';
import 'plugin_backup_ui.dart';
import 'plugin_host.dart' show PluginHost;
import 'plugin_install_ui.dart';
import 'plugin_store.dart' show PluginInstaller;
import 'plugin_store_ui.dart';
import 'plugin_updates.dart';
import 'plugin_ui.dart';
import 'settings_extra.dart';
import 'store.dart';
import 'tv_mode.dart';
import 'tokens.dart';
import 'widgets.dart';
import 'art_cache.dart';

// ====================================================================== Resume Watching

class ResumePage extends StatelessWidget {
  const ResumePage({super.key, required this.padding});
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final items = Store.resumeItems();
        return ListView(padding: padding, children: [
          const Heading('Resume Watching', weather: true),
          if (items.isEmpty) const PekCard(title: 'Nothing to resume', subtitle: 'Anything you stop partway through shows up here.'),
          for (final it in items)
            ListRow(
              leading: it.image.startsWith('https://') ? _ResumeThumb(url: it.image) : null,
              title: it.title,
              subtitle: it.duration > 0 ? '${formatTime(it.position)} of ${formatTime(it.duration)}' : 'Stopped at ${formatTime(it.position)}',
              onTap: () => playMedia(context, it, startSec: it.position),
              trailing: IconButton(tooltip: 'Remove', onPressed: () => Store.removeProgress(it.id), icon: Icon(Icons.close, color: p.tokens.textMuted)),
            ),
          const PluginFavoritesSection(),
        ]);
      },
    );
  }
}

// ====================================================================== Favorites

class FavoritesPage extends StatefulWidget {
  const FavoritesPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<FavoritesPage> createState() => _FavoritesPageState();
}

class _FavoritesPageState extends State<FavoritesPage> {
  late final Future<(List<Movie>, List<Show>)> _lib = _load();

  Future<(List<Movie>, List<Show>)> _load() async {
    final m = await Api.movies().catchError((_) => <Movie>[]);
    final s = await Api.shows().catchError((_) => <Show>[]);
    return (m, s);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) {
        final favs = Store.favorites();
        return ListView(padding: widget.padding, children: [
          const Heading('Favorites', weather: true),
          if (favs.isEmpty && Store.pluginFavorites().isEmpty)
            const PekCard(title: 'No favorites yet', subtitle: 'Open a movie or show and tap \u2661 Favorite. It will show up here.')
          else if (favs.isNotEmpty)
            FutureBuilder<(List<Movie>, List<Show>)>(
              future: _lib,
              builder: (context, snap) {
                if (!snap.hasData) return Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted));
                final (movies, shows) = snap.data!;
                final cells = <Widget>[];
                for (final f in favs) {
                  if (f.kind == 'movie') {
                    final m = movies.where((e) => e.id == f.ref).firstOrNull;
                    cells.add(PosterCard(
                      title: f.title,
                      subtitle: f.year > 0 ? '${f.year}' : '',
                      poster: m == null ? Future.value(const Details(overview: '', poster: '')) : Api.movieDetails(m.id),
                      onTap: m == null ? () => _gone(context) : () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => MovieScreen(movie: m))),
                      onLongPress: () => Store.toggleFavorite(f),
                    ));
                  } else {
                    final s = shows.where((e) => e.title == f.ref).firstOrNull;
                    cells.add(PosterCard(
                      title: f.title,
                      subtitle: s == null ? '' : '${s.episodeCount} episodes',
                      poster: s == null ? Future.value(const Details(overview: '', poster: '')) : Api.showDetails(s.title),
                      onTap: s == null ? () => _gone(context) : () => Navigator.push(context, MaterialPageRoute<void>(builder: (_) => ShowScreen(show: s))),
                      onLongPress: () => Store.toggleFavorite(f),
                    ));
                  }
                }
                return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  CustomScrollView(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    slivers: [PekGridSliver(count: cells.length, minWidth: p.compact ? 110 : 200, gap: p.compact ? 0.6 * rem : rem, builder: (_, i) => cells[i])],
                  ),
                  SizedBox(height: 0.5 * rem),
                  Text('Long-press a poster to remove it.', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.8 * rem)),
                ]);
              },
            ),
        ]);
      },
    );
  }

  void _gone(BuildContext c) => ScaffoldMessenger.maybeOf(c)?.showSnackBar(const SnackBar(content: Text('That title is no longer in your library.')));
}

// ====================================================================== Duplicates / Unknown

class DuplicatesPage extends StatelessWidget {
  const DuplicatesPage({super.key, required this.padding});
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    const kind = {'movie': 'Same movie', 'episode': 'Same episode', 'size': 'Same size, different names'};
    String plural(int n, String w) => '$n $w${n == 1 ? '' : 's'}';
    return ListView(padding: padding, children: [
      const Heading('Duplicates', weather: true),
      Async<DuplicatesResult>(
        future: Api.duplicates(),
        builder: (context, d) {
          if (d.groups.isEmpty) return const PekCard(title: 'No duplicates found', subtitle: 'Every movie and episode in your library appears only once.');
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            PekCard(title: '${plural(d.groups.length, 'duplicate group')} found', subtitle: 'Keeping one copy of each would free up to ${formatBytes(d.wastedTotal)}. PEK TV only lists duplicates; delete files from your file manager.'),
            SizedBox(height: 1.25 * rem),
            for (final g in d.groups)
              Section(
                title: g.kind == 'size' && g.files.isNotEmpty ? '${g.label}: ${formatBytes(g.files.first.size)}' : g.label,
                hint: '${kind[g.kind] ?? 'Duplicate'} \u00b7 ${plural(g.files.length, 'copy')} \u00b7 up to ${formatBytes(g.wasted)} to free',
                children: [for (final f in g.files) ListRow(title: f.filename, subtitle: '${formatBytes(f.size)} \u00b7 ${f.path}')],
              ),
          ]);
        },
      ),
    ]);
  }
}

class UnknownPage extends StatelessWidget {
  const UnknownPage({super.key, required this.padding});
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return ListView(padding: padding, children: [
      const Heading('Unknown', weather: true),
      Async<List<FileRow>>(
        future: Api.unknown(),
        builder: (context, files) {
          if (files.isEmpty) return const PekCard(title: 'Nothing here', subtitle: 'Every scanned file was classified as a movie or TV episode.');
          return Column(children: [for (final f in files) ListRow(title: f.filename, subtitle: f.path)]);
        },
      ),
    ]);
  }
}

// ====================================================================== Plugins

/// Lists the installed plugins, opens the ones that have a Python screen for this UI (plugin.json "flutter") and
/// removes them.
class PluginsPage extends StatefulWidget {
  const PluginsPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<PluginsPage> createState() => _PluginsPageState();
}

class _PluginsPageState extends State<PluginsPage> {
  late Future<List<PluginInfo>> _list = Api.plugins();

  @override
  void initState() {
    super.initState();
    PluginHost.changed.addListener(_reload); // the store installed, updated or removed something
    PluginUpdates.github.addListener(_rebuild);
    unawaited(PluginUpdates.check()); // also whenever this page opens, not only at start
  }

  void _rebuild() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    PluginHost.changed.removeListener(_reload);
    PluginUpdates.github.removeListener(_rebuild);
    super.dispose();
  }

  void _reload() {
    if (mounted) setState(() => _list = Api.plugins());
  }

  Future<void> _remove(PluginInfo pl) async {
    if (pl.builtin || PluginInstaller.stockIds.contains(pl.folder)) return; // built-in plugins cannot be removed
    final p = context.pek;
    final yes = await showDialog<bool>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => AlertDialog(
        backgroundColor: p.tokens.glassStrong,
        title: Text('Remove \u201c${pl.name}\u201d?'),
        content: const Text('Its files are deleted from this device. You can install it again later.'),
        actions: [
          TextButton(autofocus: true, onPressed: () => Navigator.pop(c, false), child: const Text('Keep')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Remove')),
        ],
      ),
    );
    if (yes != true) return;
    final ok = await Api.uninstallPlugin(pl.folder).catchError((_) => false);
    if (ok) {
      await PluginInstaller.forgetSource(pl.folder);
      unawaited(PluginBackup.forget(pl.folder)); // other devices stop offering it; nothing is deleted from them
      await PluginInstaller.changed(pl.folder); // closes its open screen and reloads the menu
    }
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(ok ? 'Removed ${pl.name}' : 'Could not remove ${pl.name}')));
    setState(() => _list = Api.plugins());
  }

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return ListView(padding: widget.padding, children: [
      const Heading('Plugins', weather: true),
      Wrap(spacing: 0.6 * rem, runSpacing: 0.6 * rem, children: [
        PekButton(label: 'Browse the plugin store', primary: true, onTap: () => openPluginStore(context)),
        PekButton(label: 'Install from .zip', onTap: () => openZipInstall(context)),
        PekButton(label: 'Install from GitHub', onTap: () => openGithubInstall(context)),
      ]),
      SizedBox(height: rem),
      const PluginBackupOffers(),
      Async<List<PluginInfo>>(
        future: _list,
        builder: (context, list) {
          if (list.isEmpty) return const PekCard(title: 'No plugins installed', subtitle: 'Open the plugin store, or install one from a .zip file or GitHub.');
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (final pl in list)
              ListRow(
                leading: PluginPicture(url: pl.icon),
                title: pl.version.isEmpty ? pl.name : '${pl.name}  v${pl.version}',
                subtitle: [
                  PluginInstaller.sourceLabel(pl.folder) ?? (pl.builtin ? 'built in' : ''),
                  if (PluginUpdates.github.value.containsKey(pl.folder)) 'update available: ${PluginUpdates.github.value[pl.folder]!.release.tag}',
                  pl.description,
                ].where((s) => s.isNotEmpty).join(' \u00b7 '),
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  if (pl.flutterScreen) ...[
                    PekButton(compact: true, primary: true, label: 'Open', onTap: () => openPluginScreen(context, pluginId: pl.folder, title: pl.navTab.isEmpty ? pl.name : pl.navTab)),
                    SizedBox(width: 0.5 * rem),
                  ],
                  if (PluginUpdates.github.value.containsKey(pl.folder)) ...[
                    PekButton(compact: true, primary: true, label: 'Update', onTap: () => PluginUpdates.openGithubUpdate(context, PluginUpdates.github.value[pl.folder]!)),
                    SizedBox(width: 0.5 * rem),
                  ],
                  if (!(pl.builtin || PluginInstaller.stockIds.contains(pl.folder))) PekButton(compact: true, label: 'Remove', onTap: () => _remove(pl)),
                ]),
              ),
          ]);
        },
      ),
    ]);
  }
}

// ====================================================================== Settings

class SettingsPage extends StatefulWidget {
  const SettingsPage({super.key, required this.padding});
  final EdgeInsets padding;
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late Future<List<String>> _sources = Api.sources();

  Future<void> _addFolder() async {
    final path = await Navigator.push<String>(context, MaterialPageRoute<String>(builder: (_) => const FolderPicker()));
    if (path == null) return;
    final ok = await Api.addSource(path).catchError((_) => false);
    if (!mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(ok ? 'Added. Scanning in the background\u2026' : 'Could not add that folder.')));
    setState(() => _sources = Api.sources());
  }

  Future<void> _addNetFolder() async {
    final added = await Navigator.push<bool>(context, MaterialPageRoute<bool>(builder: (_) => const NetFolderPage()));
    if (added != true || !mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Added. The first scan of a network folder takes a little longer\u2026')));
    setState(() => _sources = Api.sources());
  }

  Future<void> _removeSource(String path) async {
    await Api.removeSource(path).catchError((_) {});
    if (mounted) setState(() => _sources = Api.sources());
  }

  Future<void> _exit() async {
    final p = context.pek;
    final yes = await showDialog<bool>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => AlertDialog(
        backgroundColor: p.tokens.glassStrong,
        title: const Text('Are you sure you want to exit?'),
        content: const Text('PEK TV will stop running and its temporary cache will be cleared.'),
        actions: [
          TextButton(autofocus: true, onPressed: () => Navigator.pop(c, false), child: const Text('Close')),
          TextButton(onPressed: () => Navigator.pop(c, true), child: const Text('Yes, exit')),
        ],
      ),
    );
    if (yes == true) await PekPlayer.exitApp();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ListView(padding: widget.padding, children: [
      const Heading('Settings', weather: true),
      SettingsGroup(title: 'Library', children: [Section(
        title: 'Media sources',
        hint: 'Folders PEK TV scans for movies, shows and music. Removing one only forgets it; no files are deleted.',
        children: [
          Async<List<String>>(
            future: _sources,
            builder: (context, list) => Column(children: [
              if (list.isEmpty) const PekCard(title: 'No sources yet', subtitle: 'Add a folder to get started.'),
              for (final s in list) ListRow(title: s, trailing: IconButton(onPressed: () => _removeSource(s), icon: Icon(Icons.close, color: t.textMuted))),
            ]),
          ),
          SizedBox(height: 0.5 * rem),
          Wrap(spacing: 8, runSpacing: 8, children: [
            PekButton(label: 'Add source folder', primary: true, onTap: _addFolder),
            PekButton(label: 'Add network folder', onTap: _addNetFolder),
          ]),
        ],
      )]),
      const SettingsGroup(title: 'Account', children: [AccountSection()]),
      const SettingsGroup(title: 'Appearance', children: [AppearanceSection(), LayoutSection(), ActivitySection()]),
      const SettingsGroup(title: 'Playback', children: [SubtitleSection(), SkipSection(), MusicOnlineSection()]),
      const SettingsGroup(title: 'Plugins', children: [GithubInstallSection(), PluginPostersSection()]),
      SettingsGroup(title: 'Advanced', hint: 'Most people never need these.', children: [
        const TvModeSection(),
        const VideoOutputSection(),
        const AudioOutputSection(),
        const StorageSection(),
      ]),
      SettingsGroup(title: 'App', children: [
        Section(title: 'Exit', children: [Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Exit PEK TV', onTap: _exit))]),
      ]),
    ]);
  }
}

/// The in-app folder picker (`openPicker` in app_sources.js) on top of GET /api/browse.
class FolderPicker extends StatefulWidget {
  const FolderPicker({super.key});
  @override
  State<FolderPicker> createState() => _FolderPickerState();
}

class _FolderPickerState extends State<FolderPicker> {
  String _path = '';
  String _parent = '';
  List<Map<String, dynamic>> _dirs = const [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _go('');
  }

  Future<void> _go(String path) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final d = await Api.browse(path);
      _path = '${d['path'] ?? path}';
      _parent = '${d['parent'] ?? ''}';
      _dirs = ((d['directories'] as List?) ?? const []).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList();
    } catch (_) {
      _error = 'Could not reach the server.';
    }
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return SubScreen(
      title: 'Choose a folder',
      body: ListView(padding: p.pagePad, children: [
        Text(_path, style: TextStyle(color: p.tokens.textMuted)),
        SizedBox(height: 0.75 * rem),
        Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
          PekButton(compact: true, label: 'Up', onTap: _path.isEmpty || _parent == _path ? null : () => _go(_parent)),
          PekButton(compact: true, primary: true, label: 'Use this folder', onTap: _path.isEmpty ? null : () => Navigator.pop(context, _path)),
        ]),
        SizedBox(height: rem),
        if (_error != null) Text(_error!),
        if (_loading) Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted)),
        if (!_loading && _dirs.isEmpty && _error == null) Text('No folders here.', style: TextStyle(color: p.tokens.textMuted)),
        for (final d in _dirs) ListRow(title: '${d['name']}', onTap: () => _go('${d['path']}')),
      ]),
    );
  }
}


/// The small picture at the left of a Resume Watching row (a stream started from a plugin brings its own artwork).
class _ResumeThumb extends StatelessWidget {
  const _ResumeThumb({required this.url});
  final String url;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final w = 3.2 * p.rem;
    return ClipRRect(
      borderRadius: BorderRadius.circular(8),
      child: SizedBox(
        width: w,
        height: w * 1.5,
        child: ArtImage(url, fit: BoxFit.cover, cacheWidth: 200, errorBuilder: (_, __, ___) => ColoredBox(color: p.tokens.surface)),
      ),
    );
  }
}
