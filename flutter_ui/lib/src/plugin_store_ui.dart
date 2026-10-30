import 'dart:async';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'art_cache.dart';
import 'common.dart';
import 'plugin_store.dart';
import 'plugin_pek.dart' show PluginPek;
import 'plugin_ui.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The install screens of the PEK Store (the browsing screen is in store_browser.dart).

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
    final bad = t.startsWith(PluginPek.rejected); // a file that is not a correct .PEK plugin: red
    return Padding(
      padding: EdgeInsets.only(bottom: 0.5 * p.rem),
      child: Text(t, style: TextStyle(fontSize: 0.95 * p.rem, height: 1.4, color: bad ? const Color(0xFFE53935) : p.tokens.text, fontWeight: bad ? FontWeight.w700 : null)),
    );
  }

  Widget _panel(BuildContext context, List<String> lines) {
    final p = context.pek;
    return DecoratedBox(
      decoration: BoxDecoration(
        color: p.tokens.surface,
        borderRadius: BorderRadius.circular(14),
        border: lines.isNotEmpty && lines.first.startsWith(PluginPek.rejected) ? Border.all(color: const Color(0xFFE53935), width: 2) : null,
      ),
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
          if (prep!.iconBytes != null) Padding(padding: EdgeInsets.only(bottom: 0.6 * p.rem), child: PluginPicture(bytes: prep.iconBytes, size: 5 * p.rem)),
          Heading('${_replaced ? 'Update' : 'Install'} \u201c${prep.name}\u201d?'),
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


/// A plugin's picture (its plugin.json "icon"): from bytes (the store list, the install screen) or from an address (an
/// installed plugin, served by PEK TV's own server). Without one, the plugin's first letter on a plain tile, so every row
/// lines up.
class PluginPicture extends StatelessWidget {
  const PluginPicture({super.key, this.bytes, this.url = '', this.size, this.letter = '', this.expand = false});
  final Uint8List? bytes;
  final String url;
  final double? size;
  final String letter;
  final bool expand; // true: fill whatever space the parent gives (square corners; the parent clips), at a sharper decode size

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    if (expand) {
      return SizedBox.expand(
        child: url.isEmpty
            ? ColoredBox(color: p.tokens.surface, child: Center(child: Icon(Icons.extension_outlined, size: 3 * p.rem, color: p.tokens.textMuted)))
            : ArtImage(url, fit: BoxFit.cover, width: double.infinity, height: double.infinity, cacheWidth: 480,
                errorBuilder: (_, __, ___) => ColoredBox(color: p.tokens.surface, child: Center(child: Icon(Icons.extension_outlined, size: 3 * p.rem, color: p.tokens.textMuted)))),
      );
    }
    final w = size ?? 2.8 * p.rem;
    Widget fallback() => ColoredBox(
          color: p.tokens.surface,
          child: Center(child: Icon(Icons.extension_outlined, size: w * 0.5, color: p.tokens.textMuted)),
        );
    Widget child;
    if (bytes != null) {
      child = Image.memory(bytes!, fit: BoxFit.cover, width: w, height: w, gaplessPlayback: true, errorBuilder: (_, __, ___) => fallback());
    } else if (url.isNotEmpty) {
      child = ArtImage(url, fit: BoxFit.cover, width: w, height: w, cacheWidth: 160, errorBuilder: (_, __, ___) => fallback());
    } else {
      child = fallback();
    }
    return ClipRRect(borderRadius: BorderRadius.circular(w * 0.2), child: SizedBox(width: w, height: w, child: child));
  }
}
