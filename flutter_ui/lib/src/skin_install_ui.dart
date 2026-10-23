import 'dart:async';

import 'package:flutter/material.dart';

import 'common.dart';
import 'plugin_store.dart' show StoreException;
import 'skin_install.dart';
import 'skins.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The confirm screen for a skin from a .zip or GitHub : what the skin is,
/// where it came from, a colour preview, then Install / Update. Nothing is stored until the person taps the button.
///
/// [load] opens and checks the skin (a picked .zip: `SkinInstaller.prepare`; GitHub: `SkinInstaller.fromGithub`).
/// [popCount] is how many screens to close when the person is done: this one plus the picker or the GitHub flow under it.
class SkinInstallPage extends StatefulWidget {
  const SkinInstallPage({super.key, required this.load, required this.padding, this.notice, this.popCount = 2});
  final Future<PreparedSkin> Function() load;
  final EdgeInsets padding;
  final List<String> Function(PreparedSkin prep, Skin? existing)? notice;
  final int popCount;

  @override
  State<SkinInstallPage> createState() => _SkinInstallPageState();
}

enum _Stage { loading, confirm, installing, done, error }

class _SkinInstallPageState extends State<SkinInstallPage> {
  _Stage _stage = _Stage.loading;
  String _error = '';
  PreparedSkin? _prep;
  Skin? _existing, _stored;

  @override
  void initState() {
    super.initState();
    unawaited(_open());
  }

  Future<void> _open() async {
    setState(() {
      _stage = _Stage.loading;
      _error = '';
    });
    try {
      final prep = await widget.load();
      if (!mounted) return;
      setState(() {
        _prep = prep;
        _existing = SkinInstaller.existing(prep);
        _stage = _Stage.confirm;
      });
    } on StoreException catch (e) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = e.message;
      });
    } catch (_) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = 'Something went wrong while opening the skin.';
      });
    }
  }

  Future<void> _install() async {
    final prep = _prep;
    if (prep == null || _stage != _Stage.confirm) return;
    setState(() => _stage = _Stage.installing);
    try {
      final skin = await SkinInstaller.install(prep);
      if (mounted) setState(() {
        _stored = skin;
        _stage = _Stage.done;
      });
    } catch (_) {
      if (mounted) setState(() {
        _stage = _Stage.error;
        _error = 'The skin could not be saved on this device.';
      });
    }
  }

  void _close() {
    final nav = Navigator.of(context);
    var n = widget.popCount;
    nav.popUntil((_) => n-- <= 0);
  }

  Widget _panel(BuildContext context, List<String> lines) {
    final p = context.pek;
    return DecoratedBox(
      decoration: BoxDecoration(color: p.tokens.surface, borderRadius: BorderRadius.circular(14)),
      child: Padding(
        padding: EdgeInsets.fromLTRB(p.rem, p.rem, p.rem, 0.5 * p.rem),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          for (final l in lines) Padding(padding: EdgeInsets.only(bottom: 0.5 * p.rem), child: Text(l, style: TextStyle(fontSize: 0.95 * p.rem, height: 1.4, color: p.tokens.text))),
        ]),
      ),
    );
  }

  /// The skin's own colours, drawn small, so the person sees the look before choosing it.
  Widget _preview(BuildContext context, PekTokens t) {
    final p = context.pek;
    Widget dot(Color c) => Container(
          width: 2 * p.rem,
          height: 2 * p.rem,
          margin: EdgeInsets.only(right: 0.5 * p.rem),
          decoration: BoxDecoration(color: c, shape: BoxShape.circle, border: Border.all(color: p.tokens.border)),
        );
    return Container(
      padding: EdgeInsets.all(p.rem),
      decoration: BoxDecoration(color: t.bg, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: t.border)),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('Preview', style: TextStyle(color: t.textMuted, fontSize: 0.8 * p.rem)),
        SizedBox(height: 0.4 * p.rem),
        Container(
          padding: EdgeInsets.all(0.8 * p.rem),
          decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(t.radius), border: Border.all(color: t.borderFocus)),
          child: Text('Movie night', style: TextStyle(color: t.text, fontSize: p.rem, fontWeight: FontWeight.w600)),
        ),
        SizedBox(height: 0.6 * p.rem),
        Row(children: [dot(t.bg), dot(t.surface), dot(t.text), dot(t.accent)]),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final children = <Widget>[];
    final prep = _prep;
    switch (_stage) {
      case _Stage.loading:
        children.add(Padding(padding: EdgeInsets.all(p.rem), child: Text('Checking the skin\u2026', style: TextStyle(color: p.tokens.textMuted))));
      case _Stage.error:
        children.addAll([
          const Heading('Can\u2019t install this skin'),
          _panel(context, [_error]),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: 'Close', primary: true, autofocus: true, onTap: _close),
          ]),
        ]);
      case _Stage.confirm || _Stage.installing:
        final pr = prep!;
        final replaced = _existing != null;
        final installing = _stage == _Stage.installing;
        final lines = <String>[
          ...?widget.notice?.call(pr, _existing),
          [if (pr.version.isNotEmpty) 'Version ${pr.version}', if (pr.author.isNotEmpty) 'by ${pr.author}'].join(' \u00b7 '),
          pr.description,
          'Sets ${pr.tokenCount} colours and sizes. This app uses the colours and the corner size.',
          if (replaced) 'This replaces the version you already have.',
          'A skin only changes how PEK TV looks. It can\u2019t run code or reach the network.',
        ]..removeWhere((l) => l.isEmpty);
        children.addAll([
          Heading('${replaced ? 'Update' : 'Install'} \u201c${pr.name}\u201d?'),
          _panel(context, lines),
          SizedBox(height: p.rem),
          _preview(context, pr.tokens),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: installing ? 'Installing\u2026' : (replaced ? 'Update skin' : 'Install skin'), primary: true, autofocus: true, onTap: installing ? null : _install),
            PekButton(label: 'Cancel', onTap: installing ? null : _close),
          ]),
        ]);
      case _Stage.done:
        children.addAll([
          Heading('${_existing != null ? 'Updated' : 'Installed'} ${_stored?.name ?? ''}'),
          _panel(context, const ['The skin is in Settings > Appearance.']),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: 'Use it now', primary: true, autofocus: true, onTap: () {
              final id = _stored?.id;
              if (id != null) unawaited(Skins.set(id));
              _close();
            }),
            PekButton(label: 'Done', onTap: _close),
          ]),
        ]);
    }
    return ListView(padding: widget.padding, children: children);
  }
}

/// The extra lines for a skin that came from GitHub (`_githubNotice` in the web UI): unverified, and a warning when it
/// would replace a skin that was installed some other way.
List<String> skinGithubNotice(String owner, String repo, String tag, int size, PreparedSkin prep, Skin? existing, {required bool source}) {
  String kb(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${n < 1024 ? 1 : (n / 1024).round()} KB';
  return [
    'Unverified skin from GitHub: $owner/$repo${tag.isNotEmpty ? ' \u00b7 $tag' : ''}${size > 0 ? ' \u00b7 ${kb(size)}' : ''}',
    'PEK TV did not make, review or approve it. It is published by its developer, who is responsible for it.',
    if (source) 'This is the repository\u2019s source code, not a packaged release.',
    if (existing != null && !(existing.fromGithub && '${existing.source?['owner']}/${existing.source?['repo']}'.toLowerCase() == '$owner/$repo'.toLowerCase()))
      'Careful: this replaces a skin with the same name that you installed from somewhere else.',
  ];
}
