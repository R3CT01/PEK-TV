import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'fields.dart' show PekDropdown;
import 'plugin_store.dart';
import 'plugin_store_ui.dart' show PluginInstallPage, PluginPicture;
import 'plugin_zip.dart';
import 'skin_install.dart';
import 'skin_install_ui.dart';
import 'skins.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The PEK Store as a full page, for plugins and for skins (the same worker keeps both, so the screen is the same):
///
///   - a header with a search box that suggests as you type (names, then authors; tap a name to open it, tap an author to
///     show only that author)
///   - the Official / Community shelves, a sort (best match, newest, oldest, name, author) and an author filter
///   - a grid of cards: picture (or the skin's colours), version, author, size, when it was uploaded and whether it is
///     installed or has an update
///
/// Nothing installs from here: a tap opens the same install screens as before (permissions first for a plugin, the colour
/// preview for a skin), and the person confirms there.
enum StoreKind {
  plugin('plugin', 'PEK Store', 'plugin', 'plugins'),
  skin('skin', 'Skin Store', 'skin', 'skins');

  const StoreKind(this.api, this.title, this.noun, this.plural);

  /// The `kind` the store worker knows it by.
  final String api;
  final String title, noun, plural;
}

enum StoreSort {
  best('Best match'),
  newest('Newest first'),
  oldest('Oldest first'),
  name('Name A to Z'),
  author('Author A to Z');

  const StoreSort(this.label);
  final String label;
}

Future<void> openPluginStore(BuildContext context) => _openStore(context, StoreKind.plugin);

Future<void> openSkinStore(BuildContext context) => _openStore(context, StoreKind.skin);

Future<void> _openStore(BuildContext context, StoreKind kind) {
  return Navigator.push<void>(
    context,
    MaterialPageRoute<void>(
      builder: (_) => SubScreen(title: kind.title, body: Builder(builder: (c) => StoreBrowser(kind: kind, padding: c.pek.pagePad))),
    ),
  );
}

// ------------------------------------------------------------------------------------------------ searching

List<String> _words(String q) => [
      for (final t in q.toLowerCase().split(RegExp(r'\s+'))) if (t.isNotEmpty) t,
    ];

String _authorKey(String a) => a.trim().toLowerCase();

bool _wordStart(String text, String t) => text.startsWith(t) || text.contains(' $t') || text.contains('-$t') || text.contains('_$t') || text.contains('.$t');

/// How well an item matches one word: 0 = not at all. A name beats an author, an author beats the description.
int _scoreWord(StoreItem it, String t) {
  final name = it.name.toLowerCase();
  final author = it.author.toLowerCase();
  var s = 0;
  if (name == t) {
    s = 100;
  } else if (name.startsWith(t)) {
    s = 80;
  } else if (_wordStart(name, t)) {
    s = 60;
  } else if (name.contains(t)) {
    s = 40;
  }
  if (_wordStart(author, t)) {
    s = math.max(s, 30);
  } else if (author.contains(t)) {
    s = math.max(s, 20);
  }
  if (it.id.toLowerCase().contains(t)) s = math.max(s, 15);
  if (it.description.toLowerCase().contains(t)) s = math.max(s, 10);
  return s;
}

/// Every word must match something (so two words narrow it down); the score is the sum.
int _score(StoreItem it, List<String> words) {
  var total = 0;
  for (final t in words) {
    final s = _scoreWord(it, t);
    if (s == 0) return 0;
    total += s;
  }
  return total;
}

class _Sug {
  const _Sug.item(this.item)
      : author = null,
        count = 0;
  const _Sug.author(this.author, this.count) : item = null;
  final StoreItem? item;
  final String? author;
  final int count;
}

// ------------------------------------------------------------------------------------------------ dates and pictures

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "3 days ago", "yesterday", "Oct 12" ... for when an item was uploaded. '' when unknown.
String _ago(int ms) {
  if (ms <= 0) return '';
  final then = DateTime.fromMillisecondsSinceEpoch(ms);
  final d = DateTime.now().difference(then);
  String n(int v, String unit) => '$v $unit${v == 1 ? '' : 's'} ago';
  if (d.inMinutes < 1) return 'just now';
  if (d.inHours < 1) return n(d.inMinutes, 'minute');
  if (d.inDays < 1) return n(d.inHours, 'hour');
  if (d.inDays < 2) return 'yesterday';
  if (d.inDays < 14) return n(d.inDays, 'day');
  if (d.inDays < 60) return n(d.inDays ~/ 7, 'week');
  final base = '${_months[then.month - 1]} ${then.day}';
  return then.year == DateTime.now().year ? base : '$base, ${then.year}';
}

bool _isNew(int ms) => ms > 0 && DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms)).inDays < 7;

String _kb(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${n < 1024 ? 1 : (n / 1024).round()} KB';

/// The plugin pictures, decoded once (the grid rebuilds its cards often).
final Map<String, Uint8List?> _icons = {};
Uint8List? _iconOf(StoreItem it) => _icons.putIfAbsent('${it.id}:${it.fp}', () => it.iconBytes);

// ------------------------------------------------------------------------------------------------ skin previews

/// A skin bundle from the store, opened with the same checks as a .zip install. If every file sits inside one folder
/// (a zipped folder was uploaded), that folder is taken off first so skin.json is at the top.
PreparedSkin _openSkinBundle(StoreItem it, List<PluginFile> files) {
  var list = files;
  if (!list.any((f) => f.path == 'skin.json') && list.isNotEmpty) {
    final top = list.first.path.split('/').first;
    if (list.every((f) => f.path.startsWith('$top/')) && list.any((f) => f.path == '$top/skin.json')) {
      list = [for (final f in list) PluginFile(f.path.substring(top.length + 1), f.data)];
    }
  }
  return SkinInstaller.fromFiles(list, folder: it.id, fileName: it.id);
}


/// A skin's colours for its card. The store's list has no colours, so the (tiny) skin is downloaded once, opened with the
/// same checks as an install, and kept for the session. Three at a time, so the grid never floods the network.
class SkinPreviews {
  static final Map<String, Future<PekTokens?>> _cache = {};
  static final List<Completer<void>> _waiting = [];
  static int _active = 0;
  static const _parallel = 3;

  static Future<PekTokens?> tokens(StoreItem it) => _cache.putIfAbsent('${it.id}:${it.fp}', () => _run(it));

  static Future<void> _acquire() async {
    if (_active < _parallel) {
      _active++;
      return;
    }
    final c = Completer<void>();
    _waiting.add(c);
    await c.future; // the slot is handed over by _release, which keeps _active as it is
  }

  static void _release() {
    if (_waiting.isNotEmpty) {
      _waiting.removeAt(0).complete();
    } else {
      _active--;
    }
  }

  static Future<PekTokens?> _run(StoreItem it) async {
    if (it.chunks > 3) return null; // a skin is a few KB; anything this big is not worth downloading for a preview
    await _acquire();
    try {
      final files = await PekStoreApi.fetchFiles(it);
      return _openSkinBundle(it, files).tokens;
    } catch (_) {
      return null;
    } finally {
      _release();
    }
  }
}

// ------------------------------------------------------------------------------------------------ the screen

class StoreBrowser extends StatefulWidget {
  const StoreBrowser({super.key, required this.kind, required this.padding});
  final StoreKind kind;
  final EdgeInsets padding;

  @override
  State<StoreBrowser> createState() => _StoreBrowserState();
}

class _StoreBrowserState extends State<StoreBrowser> {
  /// The last list of each kind, so the page opens with something to show while the fresh list loads.
  static final Map<StoreKind, List<StoreItem>> _cache = {};

  final TextEditingController _q = TextEditingController();
  final FocusNode _qFocus = FocusNode(debugLabel: 'store search');

  List<StoreItem>? _items;
  String _error = '';
  bool _refreshing = true;
  Map<String, String> _plugins = {}; // installed plugin folder -> version

  String _shelf = 'all'; // all | official | community
  StoreSort _sort = StoreSort.newest;
  String _author = ''; // _authorKey of the chosen author, '' = everyone
  bool _sugOpen = false;

  StoreKind get kind => widget.kind;

  @override
  void initState() {
    super.initState();
    _items = _cache[kind];
    Skins.changes.addListener(_changed);
    unawaited(_load());
    unawaited(_reloadInstalled());
  }

  @override
  void dispose() {
    Skins.changes.removeListener(_changed);
    _q.dispose();
    _qFocus.dispose();
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    try {
      final items = await PekStoreApi.listAll(kind: kind.api);
      _cache[kind] = items;
      if (!mounted) return;
      setState(() {
        _items = items;
        _error = '';
        _refreshing = false;
      });
    } on StoreException catch (e) {
      _failed(e.message);
    } catch (_) {
      _failed('The PEK Store gave an unexpected answer.');
    }
  }

  void _failed(String message) {
    if (!mounted) return;
    setState(() {
      _refreshing = false;
      if (_items == null) _error = message; // with an old list on screen, a failed refresh stays quiet
    });
  }

  Future<void> _refresh() {
    setState(() {
      _refreshing = true;
      _error = '';
    });
    unawaited(_reloadInstalled());
    return _load();
  }

  Future<void> _reloadInstalled() async {
    if (kind != StoreKind.plugin) return;
    try {
      final list = await Api.plugins();
      if (mounted) setState(() => _plugins = {for (final pl in list) pl.folder: pl.version});
    } catch (_) {}
  }

  /// The installed version of an item, or null when it is not installed.
  String? _installedVersion(StoreItem it) {
    if (kind == StoreKind.plugin) return _plugins[it.id];
    final id = '${Skins.installedPrefix}${PluginZip.slug(it.id)}';
    for (final s in Skins.customSkins) {
      if (s.id == id) return s.version;
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------- filtering and sorting

  List<StoreItem> _visible() {
    final all = _items ?? const <StoreItem>[];
    final words = _words(_q.text);
    final scores = <String, int>{};
    final out = <StoreItem>[];
    for (final it in all) {
      if (_shelf != 'all' && it.shelf != _shelf) continue;
      if (_author.isNotEmpty && _authorKey(it.author) != _author) continue;
      if (words.isNotEmpty) {
        final s = _score(it, words);
        if (s == 0) continue;
        scores[it.id] = s;
      }
      out.add(it);
    }
    int byName(StoreItem a, StoreItem b) => a.name.toLowerCase().compareTo(b.name.toLowerCase());
    int byNewest(StoreItem a, StoreItem b) {
      final c = b.updated.compareTo(a.updated);
      return c != 0 ? c : byName(a, b);
    }

    // An item with no author goes last when sorting by author.
    String authorOf(StoreItem a) => a.author.trim().isEmpty ? '\uffff' : a.author.trim().toLowerCase();
    switch (_sort) {
      case StoreSort.best:
        if (words.isEmpty) {
          out.sort(byNewest);
        } else {
          out.sort((a, b) {
            final c = (scores[b.id] ?? 0).compareTo(scores[a.id] ?? 0);
            return c != 0 ? c : byNewest(a, b);
          });
        }
      case StoreSort.newest:
        out.sort(byNewest);
      case StoreSort.oldest:
        out.sort((a, b) {
          final c = a.updated.compareTo(b.updated);
          return c != 0 ? c : byName(a, b);
        });
      case StoreSort.name:
        out.sort(byName);
      case StoreSort.author:
        out.sort((a, b) {
          final c = authorOf(a).compareTo(authorOf(b));
          return c != 0 ? c : byName(a, b);
        });
    }
    return out;
  }

  /// What the search box offers while typing: up to five items (best first), then up to two authors.
  List<_Sug> _suggestions() {
    final items = _items;
    final words = _words(_q.text);
    if (items == null || words.isEmpty) return const [];
    final scored = <(StoreItem, int)>[];
    for (final it in items) {
      final s = _score(it, words);
      if (s >= 15) scored.add((it, s)); // a match in the name, author or id; a word in the description alone is not offered
    }
    scored.sort((a, b) => a.$2 != b.$2 ? b.$2.compareTo(a.$2) : b.$1.updated.compareTo(a.$1.updated));
    final out = <_Sug>[for (final e in scored.take(5)) _Sug.item(e.$1)];

    final q = _q.text.trim().toLowerCase();
    final counts = <String, int>{};
    final names = <String, String>{};
    for (final it in items) {
      final k = _authorKey(it.author);
      if (k.isEmpty || !k.contains(q)) continue;
      counts[k] = (counts[k] ?? 0) + 1;
      names.putIfAbsent(k, () => it.author.trim());
    }
    final keys = counts.keys.toList()
      ..sort((a, b) {
        final sa = a.startsWith(q), sb = b.startsWith(q);
        return sa == sb ? a.compareTo(b) : (sa ? -1 : 1);
      });
    for (final k in keys.take(2)) {
      out.add(_Sug.author(names[k]!, counts[k]!));
    }
    return out;
  }

  /// Authors for the filter: (key, "Name (n)") in A to Z order.
  List<(String, String)> _authors() {
    final counts = <String, int>{};
    final names = <String, String>{};
    for (final it in _items ?? const <StoreItem>[]) {
      final k = _authorKey(it.author);
      if (k.isEmpty) continue;
      counts[k] = (counts[k] ?? 0) + 1;
      names.putIfAbsent(k, () => it.author.trim());
    }
    final keys = counts.keys.toList()..sort();
    return [for (final k in keys) (k, '${names[k]} (${counts[k]})')];
  }

  bool get _filtered => _q.text.trim().isNotEmpty || _shelf != 'all' || _author.isNotEmpty;

  void _clearFilters() {
    setState(() {
      _q.clear();
      _shelf = 'all';
      _author = '';
      _sugOpen = false;
    });
  }

  // -------------------------------------------------------------------------------------------- opening an item

  Future<void> _openItem(StoreItem it) async {
    _qFocus.unfocus();
    setState(() => _sugOpen = false);
    final shelf = it.shelf == 'official' ? 'official' : 'community';
    if (kind == StoreKind.plugin) {
      await Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => SubScreen(
            title: it.name,
            body: Builder(
              builder: (c) => PluginInstallPage(
                title: it.name,
                shelf: shelf,
                load: (progress) => PekStoreApi.download(it, onProgress: progress, official: shelf == 'official'),
                padding: c.pek.pagePad,
              ),
            ),
          ),
        ),
      );
    } else {
      await Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => SubScreen(
            title: it.name,
            body: Builder(
              builder: (c) => SkinInstallPage(
                load: () async {
                  final files = await PekStoreApi.fetchFiles(it);
                  final prep = _openSkinBundle(it, files);
                  return prep.withSource({'type': 'store', 'shelf': shelf});
                },
                padding: c.pek.pagePad,
                popCount: 1, // just this screen: the store stays open underneath
                notice: (prep, existing) => [
                  shelf == 'official' ? 'From the PEK Store, Official shelf (published by the PEK owner).' : 'From the PEK Store, Community shelf: made by another person and approved by the owner.',
                ],
              ),
            ),
          ),
        ),
      );
    }
    if (mounted) unawaited(_reloadInstalled()); // an install or an update changes the marks on the cards
  }

  void _pickSuggestion(_Sug s) {
    final it = s.item;
    if (it != null) {
      unawaited(_openItem(it));
      return;
    }
    _qFocus.unfocus();
    setState(() {
      _author = _authorKey(s.author ?? '');
      _q.clear();
      _sugOpen = false;
    });
  }

  // -------------------------------------------------------------------------------------------- building

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final pad = widget.padding;
    final items = _visible();
    final loading = _items == null && _error.isEmpty;

    final slivers = <Widget>[
      // The header is a SliverList so the search box keeps its focus while it is typed in.
      SliverPadding(
        padding: EdgeInsets.fromLTRB(pad.left, pad.top, pad.right, 0),
        sliver: SliverList(delegate: SliverChildListDelegate([_header(context, items.length)])),
      ),
    ];

    if (loading) {
      slivers.add(SliverFillRemaining(
        hasScrollBody: false,
        child: Padding(
          padding: EdgeInsets.all(3 * p.rem),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            SizedBox(width: 1.6 * p.rem, height: 1.6 * p.rem, child: CircularProgressIndicator(strokeWidth: 2.5, color: p.tokens.accent)),
            SizedBox(height: p.rem),
            Text('Opening the ${kind.noun} store\u2026', style: TextStyle(color: p.tokens.textMuted)),
          ]),
        ),
      ));
    } else if (_error.isNotEmpty) {
      slivers.add(SliverPadding(
        padding: EdgeInsets.fromLTRB(pad.left, p.rem, pad.right, pad.bottom),
        sliver: SliverList(
          delegate: SliverChildListDelegate([
            PekCard(title: 'Could not load the store', subtitle: _error),
            SizedBox(height: 0.6 * p.rem),
            Wrap(children: [PekButton(label: 'Try again', primary: true, autofocus: true, shrink: true, onTap: _refresh)]),
          ]),
        ),
      ));
    } else if (items.isEmpty) {
      final none = (_items ?? const <StoreItem>[]).isEmpty;
      slivers.add(SliverPadding(
        padding: EdgeInsets.fromLTRB(pad.left, p.rem, pad.right, pad.bottom),
        sliver: SliverList(
          delegate: SliverChildListDelegate([
            PekCard(
              title: none ? 'Nothing in the ${kind.noun} store yet.' : 'No ${kind.plural} match.',
              subtitle: none ? 'Check back soon, or install one from a .zip file or GitHub.' : 'Try fewer words, another shelf or another author.',
            ),
            if (!none) ...[
              SizedBox(height: 0.6 * p.rem),
              Wrap(children: [PekButton(label: 'Clear search and filters', primary: true, shrink: true, onTap: _clearFilters)]),
            ],
          ]),
        ),
      ));
    } else {
      final skins = kind == StoreKind.skin;
      slivers.add(SliverPadding(
        padding: EdgeInsets.fromLTRB(pad.left, 0, pad.right, pad.bottom + 2 * p.rem),
        sliver: SliverGrid(
          gridDelegate: SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 26 * p.rem,
            mainAxisExtent: 9.8 * p.rem,
            crossAxisSpacing: 0.8 * p.rem,
            mainAxisSpacing: 0.8 * p.rem,
          ),
          delegate: SliverChildBuilderDelegate(
            (context, i) {
              final it = items[i];
              return _StoreCard(
                key: ValueKey('${it.id}:${it.fp}'),
                item: it,
                skin: skins,
                installed: _installedVersion(it),
                autofocus: i == 0 && p.tvDevice,
                onTap: () => _openItem(it),
              );
            },
            childCount: items.length,
          ),
        ),
      ));
    }

    return RefreshIndicator(
      onRefresh: _refresh,
      color: p.tokens.accent,
      backgroundColor: p.tokens.surface,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        cacheExtent: 700,
        slivers: slivers,
      ),
    );
  }

  Widget _header(BuildContext context, int shown) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final total = _items?.length ?? 0;
    final official = _items?.where((e) => e.shelf == 'official').length ?? 0;
    final community = total - official;
    final skins = kind == StoreKind.skin;
    final authors = _authors();
    final sorts = [for (final s in StoreSort.values) (s, s.label)];

    Widget caption(String text, Widget field) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: EdgeInsets.only(left: 0.3 * rem, bottom: 0.25 * rem), child: Text(text, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted))),
          field,
        ]);

    final sortField = caption('Sort by', PekDropdown<StoreSort>(value: _sort, items: sorts, label: 'Sort by', onChanged: (v) => setState(() => _sort = v)));
    final authorField = caption(
      'Author',
      PekDropdown<String>(
        value: authors.any((a) => a.$1 == _author) ? _author : '',
        items: [('', 'All authors'), ...authors],
        label: 'Author',
        onChanged: (v) => setState(() => _author = v),
      ),
    );

    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      // The banner: what this store is, the search box and its suggestions.
      Container(
        padding: EdgeInsets.all(p.narrow ? 1.0 * rem : 1.4 * rem),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(math.min(t.radius + 4, 28.0)),
          border: Border.all(color: t.border),
          gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [t.accent.withAlpha(70), t.surface, t.surface]),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(skins ? 'Find a new look' : 'Find a plugin', style: TextStyle(fontSize: (p.narrow ? 1.5 : 2.0) * rem, fontWeight: FontWeight.w800, letterSpacing: -0.6, height: 1.15)),
                SizedBox(height: 0.3 * rem),
                Text(
                  skins ? 'Colours and corner sizes for the whole app. A skin can\u2019t run code or reach the network.' : 'Add live TV, trailers, weather and more. Tap one to see what it asks for before it installs.',
                  style: TextStyle(color: t.textMuted, fontSize: 0.92 * rem, height: 1.35),
                ),
              ]),
            ),
            SizedBox(width: 0.75 * rem),
            PekButton(label: _refreshing ? 'Updating\u2026' : 'Refresh', compact: true, shrink: true, onTap: _refreshing ? null : _refresh),
          ]),
          SizedBox(height: rem),
          _searchBox(context),
        ]),
      ),
      SizedBox(height: rem),
      PekTabs(
        labels: ['All $total', 'Official $official', 'Community $community'],
        selected: const ['all', 'official', 'community'].indexOf(_shelf),
        onChanged: (i) => setState(() => _shelf = const ['all', 'official', 'community'][i]),
      ),
      SizedBox(height: 0.75 * rem),
      if (p.narrow) ...[sortField, SizedBox(height: 0.6 * rem), authorField] else Row(crossAxisAlignment: CrossAxisAlignment.end, children: [Expanded(child: sortField), SizedBox(width: rem), Expanded(child: authorField)]),
      SizedBox(height: 0.9 * rem),
      Row(children: [
        Expanded(
          child: Text(
            _items == null ? '' : '$shown ${shown == 1 ? kind.noun : kind.plural}${_q.text.trim().isEmpty ? '' : ' for \u201c${_q.text.trim()}\u201d'}',
            style: TextStyle(color: t.textMuted, fontSize: 0.88 * rem),
          ),
        ),
        if (_filtered) PekButton(label: 'Clear', compact: true, shrink: true, onTap: _clearFilters),
      ]),
      SizedBox(height: 0.6 * rem),
    ]);
  }

  Widget _searchBox(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final sugs = _sugOpen ? _suggestions() : const <_Sug>[];
    OutlineInputBorder border(Color c, [double w = 1]) => OutlineInputBorder(borderRadius: BorderRadius.circular(999), borderSide: BorderSide(color: c, width: w));

    // Focus() with canRequestFocus: false only watches: it is "focused" while the text box OR a suggestion has the focus, so
    // the list stays up when the D-pad moves down into it and closes when the focus goes anywhere else.
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: (has) {
        final open = has && _q.text.trim().isNotEmpty;
        if (open != _sugOpen) setState(() => _sugOpen = open);
      },
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(
          controller: _q,
          focusNode: _qFocus,
          autocorrect: false,
          enableSuggestions: false,
          textInputAction: TextInputAction.search,
          style: TextStyle(color: t.text, fontSize: rem),
          onTapOutside: (_) {}, // a tap on a suggestion must not close the list before it is handled
          onChanged: (v) => setState(() => _sugOpen = v.trim().isNotEmpty),
          onSubmitted: (_) {
            _qFocus.unfocus();
            setState(() => _sugOpen = false);
          },
          decoration: InputDecoration(
            hintText: kind == StoreKind.skin ? 'Search skins, authors\u2026' : 'Search plugins, authors\u2026',
            hintStyle: TextStyle(color: t.textMuted.withAlpha(200)),
            filled: true,
            fillColor: t.bg.withAlpha(150),
            prefixIcon: Icon(Icons.search, color: t.textMuted),
            suffixIcon: _q.text.isEmpty
                ? null
                : IconButton(
                    tooltip: 'Clear',
                    icon: Icon(Icons.close, color: t.textMuted),
                    onPressed: () => setState(() {
                      _q.clear();
                      _sugOpen = false;
                    }),
                  ),
            contentPadding: EdgeInsets.symmetric(horizontal: 1.1 * rem, vertical: 0.85 * rem),
            enabledBorder: border(t.border),
            focusedBorder: border(t.borderFocus, p.isTv ? 0.2 * rem : 1.5),
            border: border(t.border),
          ),
        ),
        if (sugs.isNotEmpty)
          Container(
            margin: EdgeInsets.only(top: 0.5 * rem),
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: t.glassStrong,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: t.border),
              boxShadow: [BoxShadow(color: t.shadow, blurRadius: 18, offset: const Offset(0, 6))],
            ),
            child: Column(children: [
              for (var i = 0; i < sugs.length; i++) ...[
                if (i > 0 && sugs[i].item == null && sugs[i - 1].item != null) Container(height: 1, color: t.border), // items, then authors
                _suggestionRow(context, sugs[i]),
              ],
            ]),
          ),
      ]),
    );
  }

  /// [text] with the part the person typed in bold.
  Widget _marked(BuildContext context, String text, {double size = 1.0}) {
    final p = context.pek;
    final q = _q.text.trim().toLowerCase();
    final base = TextStyle(fontSize: size * p.rem, color: p.tokens.text, fontWeight: FontWeight.w500);
    var at = q.isEmpty ? -1 : text.toLowerCase().indexOf(q);
    if (at + q.length > text.length) at = -1; // lower-casing changed the length (rare letters): skip the bold part
    if (at < 0) return Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: base);
    return Text.rich(
      TextSpan(style: base, children: [
        TextSpan(text: text.substring(0, at)),
        TextSpan(text: text.substring(at, at + q.length), style: TextStyle(fontWeight: FontWeight.w800, color: p.tokens.accent)),
        TextSpan(text: text.substring(at + q.length)),
      ]),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }

  Widget _suggestionRow(BuildContext context, _Sug s) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final it = s.item;
    final Widget leading;
    final Widget label;
    final String trailing;
    if (it != null) {
      leading = kind == StoreKind.plugin ? PluginPicture(bytes: _iconOf(it), size: 2 * rem) : Icon(Icons.palette_outlined, size: 1.4 * rem, color: t.textMuted);
      label = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        _marked(context, it.name),
        if (it.author.isNotEmpty) Text('by ${it.author}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
      ]);
      trailing = 'Open';
    } else {
      leading = Icon(Icons.person_outline, size: 1.4 * rem, color: t.textMuted);
      label = _marked(context, s.author ?? '');
      trailing = '${s.count} ${s.count == 1 ? kind.noun : kind.plural}';
    }
    return PekFocusable(
      onTap: () => _pickSuggestion(s),
      padding: EdgeInsets.symmetric(horizontal: 0.9 * rem, vertical: 0.5 * rem),
      minHeight: p.isTv ? 3 * rem : 2.8 * rem,
      alignment: Alignment.centerLeft,
      child: Row(children: [
        SizedBox(width: 2 * rem, child: Center(child: leading)),
        SizedBox(width: 0.8 * rem),
        Expanded(child: label),
        SizedBox(width: 0.5 * rem),
        Text(trailing, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
      ]),
    );
  }
}

// ------------------------------------------------------------------------------------------------ a card

class _StoreCard extends StatelessWidget {
  const _StoreCard({super.key, required this.item, required this.skin, required this.installed, required this.autofocus, required this.onTap});
  final StoreItem item;
  final bool skin;

  /// The installed version, or null when it is not installed.
  final String? installed;
  final bool autofocus;
  final VoidCallback onTap;

  Widget _badge(BuildContext context, String text, {required bool solid, IconData? icon}) {
    final p = context.pek;
    final t = p.tokens;
    final fg = solid ? t.bg : t.accent;
    return Container(
      padding: EdgeInsets.symmetric(horizontal: 0.55 * p.rem, vertical: 0.12 * p.rem),
      decoration: BoxDecoration(color: solid ? t.accent : t.accent.withAlpha(36), borderRadius: BorderRadius.circular(999)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Icon(icon, size: 0.8 * p.rem, color: fg), SizedBox(width: 0.2 * p.rem)],
        Text(text, maxLines: 1, style: TextStyle(fontSize: 0.7 * p.rem, fontWeight: FontWeight.w700, color: fg, height: 1.2)),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final it = item;

    // One badge: an update beats "installed", which beats "new".
    Widget? badge;
    if (installed != null && it.version.isNotEmpty && installed != it.version) {
      badge = _badge(context, 'Update', solid: true, icon: Icons.arrow_upward);
    } else if (installed != null) {
      badge = _badge(context, 'Installed', solid: false, icon: Icons.check);
    } else if (_isNew(it.updated)) {
      badge = _badge(context, 'New', solid: false);
    }

    final meta = [
      if (it.author.isNotEmpty) 'by ${it.author}',
      if (it.version.isNotEmpty) 'v${it.version}',
      _kb(it.size),
    ].join(' \u00b7 ');
    final ago = _ago(it.updated);
    final footer = [
      if (ago.isNotEmpty) 'Updated $ago',
      it.shelf == 'official' ? 'Official' : 'Community',
    ].join(' \u00b7 ');

    return PekFocusable(
      autofocus: autofocus,
      onTap: onTap,
      radius: 18,
      focusScale: 1.02,
      background: t.surface,
      borderColor: t.border,
      padding: EdgeInsets.all(0.9 * rem),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (skin) _SkinSwatch(item: it, width: 6 * rem, height: 4.8 * rem) else PluginPicture(bytes: _iconOf(it), size: 4.6 * rem),
        SizedBox(width: 0.9 * rem),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(it.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.02 * rem, fontWeight: FontWeight.w700, letterSpacing: -0.2))),
              if (badge != null) ...[SizedBox(width: 0.4 * rem), badge],
            ]),
            SizedBox(height: 0.1 * rem),
            Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted)),
            SizedBox(height: 0.25 * rem),
            Expanded(
              child: Text(it.description.isEmpty ? 'No description.' : it.description, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.85 * rem, height: 1.3, color: t.text.withAlpha(215))),
            ),
            Text(footer, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.74 * rem, color: t.textMuted)),
          ]),
        ),
      ]),
    );
  }
}

/// A skin's look drawn small: its background, a title bar, two cards (one with the focus border) and its accent colour.
class _SkinSwatch extends StatelessWidget {
  const _SkinSwatch({required this.item, required this.width, required this.height});
  final StoreItem item;
  final double width, height;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return SizedBox(
      width: width,
      height: height,
      child: FutureBuilder<PekTokens?>(
        future: SkinPreviews.tokens(item),
        builder: (context, snap) {
          final k = snap.data;
          if (k == null) {
            return DecoratedBox(
              decoration: BoxDecoration(color: p.tokens.bg.withAlpha(120), borderRadius: BorderRadius.circular(12), border: Border.all(color: p.tokens.border)),
              child: Center(
                child: snap.connectionState == ConnectionState.done
                    ? Icon(Icons.palette_outlined, color: p.tokens.textMuted, size: 1.6 * rem)
                    : SizedBox(width: 1.1 * rem, height: 1.1 * rem, child: CircularProgressIndicator(strokeWidth: 2, color: p.tokens.accent)),
              ),
            );
          }
          final r = (k.radius * 0.45).clamp(3.0, 12.0).toDouble();
          Widget card({required bool focused}) => Expanded(
                child: DecoratedBox(
                  decoration: BoxDecoration(color: k.surface, borderRadius: BorderRadius.circular(r), border: Border.all(color: focused ? k.borderFocus : k.border, width: focused ? 1.5 : 1)),
                ),
              );
          return Container(
            padding: EdgeInsets.all(0.5 * rem),
            decoration: BoxDecoration(color: k.bg, borderRadius: BorderRadius.circular(math.min(r + 4, 14.0)), border: Border.all(color: k.border)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Container(height: 0.42 * rem, width: width * 0.45, decoration: BoxDecoration(color: k.text, borderRadius: BorderRadius.circular(99))),
              SizedBox(height: 0.35 * rem),
              Expanded(child: Row(children: [card(focused: true), SizedBox(width: 0.3 * rem), card(focused: false)])),
              SizedBox(height: 0.35 * rem),
              Row(children: [
                Container(width: 0.9 * rem, height: 0.9 * rem, decoration: BoxDecoration(color: k.accent, shape: BoxShape.circle)),
                SizedBox(width: 0.3 * rem),
                Expanded(child: Container(height: 0.3 * rem, decoration: BoxDecoration(color: k.textMuted, borderRadius: BorderRadius.circular(99)))),
              ]),
            ]),
          );
        },
      ),
    );
  }
}
