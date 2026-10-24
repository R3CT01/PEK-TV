import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'fields.dart';
import 'plugin_github.dart';
import 'plugin_store.dart';
import 'plugin_store_ui.dart';
import 'plugin_zip.dart';
import 'settings_extra.dart' show ToggleRow;
import 'skin_install.dart';
import 'skin_install_ui.dart';
import 'tokens.dart';
import 'widgets.dart';

String _kb(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${n < 1024 ? 1 : (n / 1024).round()} KB';

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

Widget _muted(BuildContext context, String t) {
  final p = context.pek;
  return Padding(padding: EdgeInsets.only(bottom: 0.75 * p.rem), child: Text(t, style: TextStyle(color: p.tokens.textMuted, fontSize: 0.95 * p.rem, height: 1.4)));
}

// ============================================================================ Install from a .zip file

/// Plugins > Install from .zip: pick a plugin .zip on this device or on a network folder, then the usual install screens.
/// Nothing is installed until the person confirms on the permissions screen.
///
/// [skin] true: the same picker, but the file is opened as a skin (Settings > Appearance > Install skin from .zip).
Future<void> openZipInstall(BuildContext context, {bool skin = false}) {
  return Navigator.push<void>(
    context,
    MaterialPageRoute<void>(builder: (_) => SubScreen(title: 'Install from .zip', body: Builder(builder: (c) => _ZipPicker(padding: c.pek.pagePad, skin: skin)))),
  );
}

class _ZipPicker extends StatefulWidget {
  const _ZipPicker({required this.padding, this.skin = false});
  final EdgeInsets padding;
  final bool skin;
  @override
  State<_ZipPicker> createState() => _ZipPickerState();
}

class _ZipPickerState extends State<_ZipPicker> {
  List<String> _sources = const [];
  ZipListing? _listing; // null = the home list
  bool _loading = false;
  String _error = '';

  @override
  void initState() {
    super.initState();
    unawaited(_loadSources());
  }

  Future<void> _loadSources() async {
    try {
      final s = await Api.sources();
      if (mounted) setState(() => _sources = s);
    } catch (_) {} // the list just starts without library folders
  }

  Future<void> _go(String path) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final l = await ZipPicker.browse(path);
      if (mounted) setState(() => _listing = l);
    } on StoreException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  /// Android's own file picker: works without "All files access". On a device that has none, the in-app browser is used.
  Future<void> _pick() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final f = await ZipPicker.pickNative();
      if (f != null) await _open(f.name, f.bytes);
    } on NoSystemPicker {
      if (mounted) setState(() => _error = 'This device has no file picker. Use This device below to browse for the file.');
    } on StoreException catch (err) {
      if (mounted) setState(() => _error = err.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _choose(ZipEntry e) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final bytes = await ZipPicker.fetch(e.path);
      if (!mounted) return;
      await _open(e.name, bytes);
    } on StoreException catch (err) {
      if (mounted) setState(() => _error = err.message);
    }
    if (mounted) setState(() => _loading = false);
  }

  /// The install screens for a .zip that was read (picked with the system picker or from the in-app browser).
  Future<void> _open(String name, Uint8List bytes) async {
    if (!mounted) return;
    setState(() => _loading = false);
    if (widget.skin) {
      await Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => SubScreen(
            title: name,
            body: Builder(builder: (c) => SkinInstallPage(load: () async => SkinInstaller.prepare(bytes, fileName: name), padding: c.pek.pagePad)),
          ),
        ),
      );
      return;
    }
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: name,
          body: Builder(
            builder: (c) => PluginInstallPage(
              title: name,
              shelf: 'zip',
              source: 'zip',
              load: (_) async => PluginZip.prepare(bytes, fileName: name),
              padding: c.pek.pagePad,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final l = _listing;
    final children = <Widget>[];
    if (l == null) {
      children.addAll([
        const Heading('Install from .zip'),
        _muted(context, widget.skin
            ? 'Choose the skin\u2019s .zip file. You will see what it is before anything is installed.'
            : 'Choose the plugin\u2019s .zip file. You will see what it asks for before anything is installed.'),
        ListRow(autofocus: true, title: 'Choose a file', subtitle: 'Pick the .zip with Android\u2019s file picker (Downloads, Drive, a USB stick). No extra permission needed.', onTap: _pick),
        ListRow(title: 'Browse this device', subtitle: 'Folders on this device. Android only shows .zip files here after you allow All files access', onTap: () => _go('@local')),
        for (final s in _sources) ListRow(title: s, subtitle: 'Media source', onTap: () => _go(s)),
      ]);
    } else {
      children.addAll([
        Heading(l.path),
        Wrap(spacing: 0.5 * p.rem, runSpacing: 0.5 * p.rem, children: [
          PekButton(compact: true, label: 'Up', autofocus: true, onTap: l.parent.isEmpty || l.parent == l.path ? () => setState(() => _listing = null) : () => _go(l.parent)),
          PekButton(compact: true, label: 'Start', onTap: () => setState(() => _listing = null)),
        ]),
        SizedBox(height: p.rem),
        if (l.entries.isEmpty && !_loading) _muted(context, 'No folders or .zip files here.'),
        for (final e in l.entries)
          ListRow(
            title: e.dir ? '${e.name}/' : e.name,
            subtitle: e.dir ? '' : _kb(e.size),
            onTap: () => e.dir ? _go(e.path) : _choose(e),
          ),
      ]);
    }
    return ListView(padding: widget.padding, children: [
      if (_error.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: p.rem), child: _panel(context, [_error])),
      if (_loading) Padding(padding: EdgeInsets.only(bottom: p.rem), child: Text('Please wait\u2026', style: TextStyle(color: p.tokens.textMuted))),
      ...children,
    ]);
  }
}

// ============================================================================ Install from GitHub

/// Plugins > Install from GitHub: type owner/repo, pick a release file, then the usual install screens.
/// PEK TV lists nothing: the person types the name.
///
/// [skin] true: the release file is opened as a skin (Settings > Appearance > Install skin from GitHub).
Future<void> openGithubInstall(BuildContext context, {bool skin = false}) {
  if (!PekGithub.enabled) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(const SnackBar(content: Text('Installing from GitHub is switched off in Settings.')));
    return Future<void>.value();
  }
  return Navigator.push<void>(
    context,
    MaterialPageRoute<void>(builder: (_) => SubScreen(title: 'Install from GitHub', body: Builder(builder: (c) => _GithubFlow(padding: c.pek.pagePad, skin: skin)))),
  );
}

enum _GhStage { warn, enter, pick }

class _GithubFlow extends StatefulWidget {
  const _GithubFlow({required this.padding, this.skin = false});
  final EdgeInsets padding;
  final bool skin;
  @override
  State<_GithubFlow> createState() => _GithubFlowState();
}

class _GithubFlowState extends State<_GithubFlow> {
  late _GhStage _stage = PekGithub.warned ? _GhStage.enter : _GhStage.warn;
  final _text = TextEditingController();
  bool _busy = false;
  String _error = '', _note = '';
  GithubRelease? _release;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  Future<void> _accept() async {
    await PekGithub.setWarned();
    if (mounted) setState(() => _stage = _GhStage.enter);
  }

  Future<void> _find() async {
    if (_busy) return;
    final parsed = PekGithub.parseRepo(_text.text);
    if (parsed == null) {
      setState(() => _error = 'Type it like owner/repo, for example someone/${widget.skin ? 'my-skin' : 'my-plugin'}.');
      return;
    }
    setState(() {
      _busy = true;
      _error = '';
      _note = 'Looking up ${parsed.owner}/${parsed.repo}\u2026';
    });
    try {
      final rel = await PekGithub.findRelease(parsed.owner, parsed.repo);
      if (!mounted) return;
      if (rel.options.isEmpty) {
        throw StoreException('There is nothing in ${parsed.owner}/${parsed.repo} that PEK TV can install (no .zip release file).');
      }
      setState(() {
        _busy = false;
        _note = '';
      });
      if (rel.options.length == 1) {
        await _install(rel, rel.options.first);
      } else {
        setState(() {
          _release = rel;
          _stage = _GhStage.pick;
        });
      }
    } on StoreException catch (e) {
      if (mounted) setState(() {
        _busy = false;
        _note = '';
        _error = e.message;
      });
    }
  }

  /// The extra lines at the top of the permissions screen for a plugin that came from GitHub (`_githubNotice` in the web UI).
  List<String> _notice(GithubRelease rel, GithubOption opt, PreparedPlugin prep, bool replaced) {
    final out = <String>[
      'Unverified plugin from GitHub: ${rel.owner}/${rel.repo}${rel.tag.isNotEmpty ? ' \u00b7 ${rel.tag}' : ''}${opt.size > 0 ? ' \u00b7 ${_kb(opt.size)}' : ''}',
      'PEK TV did not make, review or approve it. It is published by its developer, who is responsible for it.',
      if (opt.kind == 'source') 'This is the repository\u2019s source code, not a packaged release.',
    ];
    if (replaced) {
      final prev = PluginInstaller.sourceOf(prep.id);
      final same = prev is Map && prev['type'] == 'github' && '${prev['owner']}/${prev['repo']}'.toLowerCase() == '${rel.owner}/${rel.repo}'.toLowerCase();
      if (!same) out.add('Careful: this replaces a plugin with the same name that you installed from somewhere else.');
    }
    return out;
  }

  Future<void> _install(GithubRelease rel, GithubOption opt) {
    if (widget.skin) {
      return Navigator.push<void>(
        context,
        MaterialPageRoute<void>(
          builder: (_) => SubScreen(
            title: '${rel.owner}/${rel.repo}',
            body: Builder(
              builder: (c) => SkinInstallPage(
                load: () => SkinInstaller.fromGithub(rel, opt),
                notice: (prep, existing) => skinGithubNotice(rel.owner, rel.repo, rel.tag, opt.size, prep, existing, source: opt.kind == 'source'),
                padding: c.pek.pagePad,
              ),
            ),
          ),
        ),
      );
    }
    return Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: '${rel.owner}/${rel.repo}',
          body: Builder(
            builder: (c) => PluginInstallPage(
              title: '${rel.owner}/${rel.repo}',
              shelf: 'github',
              source: {'type': 'github', 'owner': rel.owner, 'repo': rel.repo, 'tag': rel.tag, 'kind': opt.kind},
              load: (_) => PekGithub.download(rel, opt),
              notice: (prep, replaced) => _notice(rel, opt, prep, replaced),
              padding: c.pek.pagePad,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final children = <Widget>[];
    switch (_stage) {
      case _GhStage.warn:
        children.addAll([
          const Heading('Before you install from GitHub'),
          _panel(context, widget.skin
              ? const [
                  'This installs a skin straight from a GitHub repository that you name.',
                  'PEK TV did not make, review or approve these skins. Each one is published by its own developer, who is responsible for it.',
                  'A skin can only change how PEK TV looks: it can\u2019t run code or reach the network, and PEK TV shows you what it is before anything is installed.',
                ]
              : const [
                  'This installs a plugin straight from a GitHub repository that you name.',
                  'PEK TV did not make, review or approve these plugins, and they are not part of the PEK Store. Each one is published by its own developer, who is responsible for it.',
                  'PEK TV still runs it in a sandbox and shows you what it asks for before anything is installed, but it cannot check what the plugin really does. Only install plugins from developers you trust.',
                  'Make sure you have the right to use whatever the plugin gives you access to.',
                ]),
          SizedBox(height: p.rem),
          Wrap(spacing: 0.6 * p.rem, runSpacing: 0.6 * p.rem, children: [
            PekButton(label: 'I understand, continue', primary: true, autofocus: true, onTap: _accept),
            PekButton(label: 'Cancel', onTap: () => Navigator.maybePop(context)),
          ]),
        ]);
      case _GhStage.enter:
        children.addAll([
          const Heading('Install from GitHub'),
          _muted(context, widget.skin
              ? 'Type the developer\u2019s GitHub name, a slash, and the skin\u2019s repository name, like someone/my-skin. Pasting a github.com link works too.'
              : 'Type the developer\u2019s GitHub name, a slash, and the plugin\u2019s repository name, like someone/my-plugin. Pasting a github.com link works too.'),
          PekField(label: 'GitHub repository', controller: _text, hint: 'owner/repo', autofocus: true, onSubmitted: _find),
          _muted(context, widget.skin ? 'These skins are unverified: PEK TV does not review them.' : 'These plugins are unverified: PEK TV does not review them.'),
          if (_error.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: p.rem), child: _panel(context, [_error])),
          if (_note.isNotEmpty) _muted(context, _note),
          Wrap(children: [PekButton(label: _busy ? 'Working\u2026' : (widget.skin ? 'Find skin' : 'Find plugin'), primary: true, onTap: _busy ? null : _find)]),
        ]);
      case _GhStage.pick:
        final rel = _release!;
        children.addAll([
          const Heading('Choose what to install'),
          _muted(context, '${rel.owner}/${rel.repo}${rel.tag.isNotEmpty ? ' \u00b7 ${rel.tag}' : ''}. Tap one to download it. You will see what it asks for before anything is installed.'),
          ListRow(title: '.. (back)', onTap: () => setState(() {
                _stage = _GhStage.enter;
                _error = '';
              })),
          for (var i = 0; i < rel.options.length; i++)
            ListRow(
              autofocus: i == 0,
              title: rel.options[i].label,
              subtitle: [if (rel.tag.isNotEmpty) rel.tag, if (rel.options[i].size > 0) _kb(rel.options[i].size)].join(' \u00b7 '),
              onTap: () => _install(rel, rel.options[i]),
            ),
        ]);
    }
    return ListView(padding: widget.padding, children: children);
  }
}

// ============================================================================ Settings > Install from GitHub

/// The on / off switch for installing plugins from GitHub (`_setGithubEnabled` in the web UI). The server can also refuse it
/// for a whole build with PEK_ALLOW_GITHUB=0.
class GithubInstallSection extends StatefulWidget {
  const GithubInstallSection({super.key});
  @override
  State<GithubInstallSection> createState() => _GithubInstallSectionState();
}

class _GithubInstallSectionState extends State<GithubInstallSection> {
  Future<void> _flip() async {
    await PekGithub.setEnabled(!PekGithub.enabled);
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final on = PekGithub.enabled;
    return Section(
      title: 'Plugins and skins from GitHub',
      hint: 'Lets you install a plugin or a skin by typing its GitHub name (Plugins > Install from GitHub, Appearance > Install skin from GitHub). They are not reviewed by PEK TV.',
      children: [ToggleRow(title: 'Install from GitHub', subtitle: on ? 'On' : 'Off', on: on, onTap: _flip)],
    );
  }
}
