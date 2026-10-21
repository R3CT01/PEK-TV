import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'plugin_store.dart';
import 'plugin_ui.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The PEK Store in the Flutter UI: browse the Official and Community shelves and install a plugin.
/// Same rules as the web UI (www/plugin_store.js): no web addresses to type, nothing installs by itself. The
/// server's safety checks run first (a dry run), then the author's warning (if the plugin has one), then the
/// permissions screen, then the person confirms. Uploading happens on the store's website, not in the app.
Future<void> openPluginStore(BuildContext context) {
  return Navigator.push<void>(
    context,
    MaterialPageRoute<void>(
      builder: (_) => SubScreen(title: 'PEK Store', body: Builder(builder: (c) => _StoreHome(padding: c.pek.pagePad))),
    ),
  );
}

class _StoreHome extends StatelessWidget {
  const _StoreHome({required this.padding});
  final EdgeInsets padding;

  Future<void> _shelf(BuildContext context, String shelf) {
    return Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: shelf == 'official' ? 'PEK Official' : 'Community plugins',
          body: Builder(builder: (c) => _ShelfPage(shelf: shelf, padding: c.pek.pagePad)),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return ListView(padding: padding, children: [
      const Heading('PEK Store'),
      Text('Plugins. Tap a shelf, tap a plugin, tap Install. No web addresses to type.', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.95 * p.rem)),
      SizedBox(height: p.rem),
      PekCard(title: 'PEK Official', subtitle: 'Published by the PEK owner', autofocus: true, onTap: () => _shelf(context, 'official')),
      SizedBox(height: 0.6 * p.rem),
      PekCard(title: 'Community plugins', subtitle: 'Made by other people, approved by the owner', onTap: () => _shelf(context, 'community')),
    ]);
  }
}

class _ShelfData {
  const _ShelfData(this.items, this.installed);
  final List<StoreItem> items;
  final Map<String, String> installed; // folder -> version
}

class _ShelfPage extends StatefulWidget {
  const _ShelfPage({required this.shelf, required this.padding});
  final String shelf;
  final EdgeInsets padding;

  @override
  State<_ShelfPage> createState() => _ShelfPageState();
}

class _ShelfPageState extends State<_ShelfPage> {
  late Future<_ShelfData> _data = _load();

  Future<_ShelfData> _load() async {
    final items = await PekStoreApi.list(widget.shelf);
    var installed = <String, String>{};
    try {
      installed = {for (final pl in await Api.plugins()) pl.folder: pl.version};
    } catch (_) {}
    return _ShelfData(items, installed);
  }

  Future<void> _open(StoreItem it) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: it.name,
          body: Builder(
            builder: (c) => PluginInstallPage(
              title: it.name,
              shelf: widget.shelf,
              load: (progress) => PekStoreApi.download(it, onProgress: progress),
              padding: c.pek.pagePad,
            ),
          ),
        ),
      ),
    );
    if (mounted) setState(() => _data = _load()); // an install or update changes the "installed" marks
  }

  String _kb(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${n < 1024 ? 1 : (n / 1024).round()} KB';

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final official = widget.shelf == 'official';
    return ListView(padding: widget.padding, children: [
      Heading(official ? 'PEK Official' : 'Community plugins'),
      Text(
        official ? 'Published by the PEK owner. Tap one to install it.' : 'Uploaded by other people and approved by the owner. Only install plugins from people you trust. Tap one to see what it asks for.',
        style: TextStyle(color: p.tokens.textMuted, fontSize: 0.95 * p.rem),
      ),
      SizedBox(height: p.rem),
      FutureBuilder<_ShelfData>(
        future: _data,
        builder: (context, snap) {
          if (snap.connectionState != ConnectionState.done) {
            return Padding(padding: EdgeInsets.all(2 * p.rem), child: Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted)));
          }
          if (snap.hasError) {
            final msg = snap.error is StoreException ? (snap.error as StoreException).message : 'The PEK Store gave an unexpected answer.';
            return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              PekCard(title: 'Could not load the store', subtitle: msg),
              SizedBox(height: 0.6 * p.rem),
              Wrap(children: [PekButton(label: 'Try again', primary: true, autofocus: true, onTap: () => setState(() => _data = _load()))]),
            ]);
          }
          final d = snap.data!;
          if (d.items.isEmpty) return PekCard(title: official ? 'Nothing on the Official shelf yet.' : 'No community plugins yet.');
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            for (var i = 0; i < d.items.length; i++)
              ListRow(
                autofocus: i == 0,
                title: d.items[i].name,
                subtitle: [
                  if (d.items[i].version.isNotEmpty) 'v${d.items[i].version}',
                  if (d.items[i].author.isNotEmpty) 'by ${d.items[i].author}',
                  _kb(d.items[i].size),
                  if (d.installed.containsKey(d.items[i].id)) (d.installed[d.items[i].id] == d.items[i].version ? 'installed' : 'update available'),
                  d.items[i].description,
                ].where((s) => s.isNotEmpty).join(' \u00b7 '),
                onTap: () => _open(d.items[i]),
              ),
          ]);
        },
      ),
    ]);
  }
}

enum _Stage { downloading, error, warning, confirm, installing, done }

/// The install screen shared by every way of getting a plugin: the PEK Store, a .zip file and a GitHub repository.
/// [load] fetches and unpacks it (calling `progress(done, of)` when it knows how far along it is). Then PEK TV's server does a
/// dry run (is it allowed, does it replace one?), the author's warning (if any) and the permissions screen come up, and
/// only the person's tap installs it.
///   shelf    'official' / 'community' (store), 'zip' or 'github': sets the first line of the permissions screen
///   source   what to remember about where it came from (defaults to [shelf])
///   notice   extra lines for the top of the permissions screen
class PluginInstallPage extends StatefulWidget {
  const PluginInstallPage({super.key, required this.title, required this.shelf, required this.load, required this.padding, this.source, this.notice});
  final String title, shelf;
  final Future<PreparedPlugin> Function(void Function(int, int) progress) load;
  final EdgeInsets padding;
  final Object? source;
  final List<String> Function(PreparedPlugin prep, bool replaced)? notice;

  @override
  State<PluginInstallPage> createState() => _InstallPageState();
}

class _InstallPageState extends State<PluginInstallPage> {
  _Stage _stage = _Stage.downloading;
  String _error = '';
  PreparedPlugin? _prep;
  bool _replaced = false;
  int _chunk = 0, _chunks = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_prepare());
  }

  /// Download, then a dry run on PEK TV's server: it says whether the plugin is allowed and whether it replaces one.
  Future<void> _prepare() async {
    setState(() {
      _stage = _Stage.downloading;
      _error = '';
      _chunk = 0;
      _chunks = 0;
    });
    try {
      final prep = await widget.load((i, n) {
        if (mounted) setState(() {
          _chunk = i;
          _chunks = n;
        });
      });
      final verdict = await PluginInstaller.send(prep, dry: true);
      if (!mounted) return;
      if (!verdict.ok) {
        setState(() {
          _stage = _Stage.error;
          _error = verdict.error.isEmpty ? 'The server refused the plugin.' : verdict.error;
        });
        return;
      }
      setState(() {
        _prep = prep;
        _replaced = verdict.replaced;
        _stage = prep.warning != null ? _Stage.warning : _Stage.confirm;
      });
    } on StoreException catch (e) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = e.message;
      });
    } catch (e) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = 'Something went wrong: $e';
      });
    }
  }

  Future<void> _install() async {
    final prep = _prep;
    if (prep == null) return;
    setState(() => _stage = _Stage.installing);
    try {
      final res = await PluginInstaller.send(prep, dry: false);
      if (!mounted) return;
      if (!res.ok) {
        setState(() {
          _stage = _Stage.error;
          _error = res.error.isEmpty ? 'The server refused the plugin.' : res.error;
        });
        return;
      }
      await PluginInstaller.rememberSource(prep.id, widget.source ?? widget.shelf);
      await PluginInstaller.changed(prep.id);
      if (mounted) setState(() => _stage = _Stage.done);
    } on StoreException catch (e) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = e.message;
      });
    }
  }

  Widget _para(BuildContext context, String t) {
    final p = context.pek;
    return Padding(padding: EdgeInsets.only(bottom: 0.5 * p.rem), child: Text(t, style: TextStyle(fontSize: 0.95 * p.rem, height: 1.4, color: p.tokens.text)));
  }

  Widget _panel(BuildContext context, List<String> lines) {
    final p = context.pek;
    return DecoratedBox(
      decoration: BoxDecoration(color: p.tokens.surface, borderRadius: BorderRadius.circular(14)),
      child: Padding(
        padding: EdgeInsets.fromLTRB(p.rem, p.rem, p.rem, 0.5 * p.rem),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [for (final l in lines) _para(context, l)]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final prep = _prep;
    final children = <Widget>[];
    switch (_stage) {
      case _Stage.downloading:
        children.addAll([
          Heading('Downloading ${widget.title}\u2026'),
          Text(_chunks > 1 ? 'Part ${math.min(_chunk + 1, _chunks)} of $_chunks' : 'Please wait\u2026', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.95 * p.rem)),
          SizedBox(height: p.rem),
          LinearProgressIndicator(value: _chunks > 0 ? _chunk / _chunks : null, color: p.tokens.accent, backgroundColor: p.tokens.surface),
        ]);
      case _Stage.error:
        children.addAll([
          const Heading("Can't install this plugin"),
          _panel(context, [_error]),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: 'Try again', primary: true, autofocus: true, onTap: _prepare),
            PekButton(label: 'Back', onTap: () => Navigator.maybePop(context)),
          ]),
        ]);
      case _Stage.warning:
        final w = prep!.warning!;
        children.addAll([
          Heading(w.title),
          _panel(context, w.text),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: w.button, primary: true, autofocus: true, onTap: () => setState(() => _stage = _Stage.confirm)),
            PekButton(label: 'Cancel', onTap: () => Navigator.maybePop(context)),
          ]),
        ]);
      case _Stage.confirm:
        children.addAll([
          Heading('${_replaced ? 'Update' : 'Install'} \u201c${prep!.name}\u201d?'),
          _panel(context, prep.describe(replaced: _replaced, shelf: widget.shelf, notice: widget.notice?.call(prep, _replaced) ?? const [])),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: _replaced ? 'Update plugin' : 'Install plugin', primary: true, autofocus: true, onTap: _install),
            PekButton(label: 'Cancel', onTap: () => Navigator.maybePop(context)),
          ]),
        ]);
      case _Stage.installing:
        children.addAll([
          Heading('${_replaced ? 'Updating' : 'Installing'} ${prep!.name}\u2026'),
          SizedBox(height: p.rem),
          Row(children: [SizedBox(width: 1.4 * p.rem, height: 1.4 * p.rem, child: CircularProgressIndicator(strokeWidth: 2.5, color: p.tokens.accent))]),
        ]);
      case _Stage.done:
        final pr = prep!;
        children.addAll([
          Heading('${_replaced ? 'Updated' : 'Installed'} ${pr.name}'),
          _panel(context, [
            if (pr.hasFlutterScreen) 'It is ready: open it below${pr.navTab.isNotEmpty ? ', or from \u201c${pr.navTab}\u201d in the menu' : ''}.',
            if (pr.hasBackend) 'Close and reopen PEK TV once so the plugin\u2019s Python part starts.',
          ]),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            if (pr.hasFlutterScreen)
              PekButton(label: 'Open ${pr.name}', primary: true, autofocus: true, onTap: () => openPluginScreen(context, pluginId: pr.id, title: pr.navTab.isEmpty ? pr.name : pr.navTab)),
            PekButton(label: 'Done', autofocus: !pr.hasFlutterScreen, primary: !pr.hasFlutterScreen, onTap: () => Navigator.maybePop(context)),
          ]),
        ]);
    }
    return PopScope(
      canPop: _stage != _Stage.installing, // never walk away in the middle of writing files
      child: ListView(padding: widget.padding, children: children),
    );
  }
}
