import 'dart:async';

import 'package:flutter/material.dart';

import 'cloud.dart';
import 'common.dart';
import 'plugin_backup.dart';
import 'plugin_store_ui.dart';
import 'settings_extra.dart' show ToggleRow;
import 'tokens.dart';
import 'widgets.dart';

String _size(int n) => n >= 1048576 ? '${(n / 1048576).toStringAsFixed(1)} MB' : '${n < 1024 ? 1 : (n / 1024).round()} KB';

String _ago(int ms) {
  if (ms <= 0) return 'not yet';
  final s = (DateTime.now().millisecondsSinceEpoch - ms) ~/ 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return '${s ~/ 60} min ago';
  if (s < 86400) return '${s ~/ 3600} h ago';
  return '${s ~/ 86400} d ago';
}

/// Plugins page: cloud copies of plugins that this device does not have, or has a different version of
/// (the same offers as the web UI's Plugins tab). Nothing installs until the person confirms on the permissions screen.
class PluginBackupOffers extends StatelessWidget {
  const PluginBackupOffers({super.key});

  Future<void> _restore(BuildContext context, BackupOffer o) async {
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: o.name,
          body: Builder(
            builder: (c) => PluginInstallPage(
              title: o.name,
              shelf: 'zip',
              source: 'zip',
              padding: c.pek.pagePad,
              load: (progress) => PluginBackup.fetchForRestore(o.id, onProgress: progress),
              notice: (prep, replaced) => [
                'This is the copy in your PEK Cloud backup.',
                if (replaced) 'It replaces the version of ${prep.name} that is on this device.',
              ],
            ),
          ),
        ),
      ),
    );
    unawaited(PluginBackup.run()); // the offer goes away once the plugin matches the cloud copy
  }

  Future<void> _keepMine(BuildContext context, BackupOffer o) async {
    final err = await PluginBackup.keepLocal(o.id);
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(err.isEmpty ? 'Your copy of ${o.name} is now the one in the cloud.' : PluginBackup.errorText(err))));
  }

  String _what(BackupOffer o) {
    switch (o.kind) {
      case 'update':
        return 'A newer copy is in your cloud backup';
      case 'conflict':
        return 'Different from your cloud backup (changed on both)';
      default:
        return 'In your cloud backup, not on this device';
    }
  }

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return ValueListenableBuilder<List<BackupOffer>>(
      valueListenable: PluginBackup.offers,
      builder: (context, list, _) {
        if (list.isEmpty || !PluginBackup.enabled || !Cloud.linked) return const SizedBox.shrink();
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Heading('From your cloud backup'),
          for (final o in list)
            ListRow(
              title: o.version.isEmpty ? o.name : '${o.name}  v${o.version}',
              subtitle: [_what(o), if (o.size > 0) _size(o.size)].join(' \u00b7 '),
              trailing: Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
                PekButton(compact: true, primary: true, label: o.kind == 'new' ? 'Install' : (o.kind == 'update' ? 'Update' : 'Use cloud copy'), onTap: () => _restore(context, o)),
                if (o.kind == 'conflict') PekButton(compact: true, label: 'Keep mine', onTap: () => _keepMine(context, o)),
                PekButton(compact: true, label: 'Not now', onTap: () => PluginBackup.dismiss(o.id)),
              ]),
            ),
          SizedBox(height: rem),
        ]);
      },
    );
  }
}

/// Settings > Account: the on / off switch and a "Back up now" button.
class PluginBackupSettings extends StatefulWidget {
  const PluginBackupSettings({super.key});
  @override
  State<PluginBackupSettings> createState() => _PluginBackupSettingsState();
}

class _PluginBackupSettingsState extends State<PluginBackupSettings> {
  bool _busy = false;
  String _note = '';

  Future<void> _flip() async {
    await PluginBackup.setEnabled(!PluginBackup.enabled);
    if (mounted) setState(() => _note = '');
  }

  Future<void> _now() async {
    setState(() {
      _busy = true;
      _note = 'Backing up\u2026';
    });
    final r = await PluginBackup.run(force: true);
    if (!mounted) return;
    setState(() {
      _busy = false;
      _note = !r.ok
          ? PluginBackup.errorText(r.error)
          : r.uploaded > 0
              ? 'Backed up ${r.uploaded} plugin${r.uploaded == 1 ? '' : 's'}.'
              : (r.offers.isNotEmpty ? 'Up to date. ${r.offers.length} cloud cop${r.offers.length == 1 ? 'y is' : 'ies are'} waiting on the Plugins page.' : 'Everything is backed up.');
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ValueListenableBuilder<int>(
      valueListenable: PluginBackup.lastRun,
      builder: (context, last, _) {
        final on = PluginBackup.enabled;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(height: 0.75 * rem),
          ToggleRow(title: 'Back up my plugins', subtitle: on ? 'On' : 'Off', on: on, onTap: _flip),
          Padding(
            padding: EdgeInsets.only(top: 0.3 * rem),
            child: Text(
              'Keeps a copy of the plugins you installed from a .zip or GitHub in your cloud account, so you can bring them back on another device. Only the plugin\u2019s own files are saved, never its data. Getting a plugin back always asks you first.',
              style: TextStyle(color: p.tokens.textMuted, fontSize: 0.85 * rem),
            ),
          ),
          if (on) ...[
            SizedBox(height: 0.5 * rem),
            Text('Last checked: ${_ago(last)}', style: TextStyle(color: p.tokens.textMuted)),
            if (_note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.3 * rem), child: Text(_note, style: TextStyle(color: p.tokens.textMuted))),
            SizedBox(height: 0.5 * rem),
            PekButton(label: _busy ? 'Backing up\u2026' : 'Back up now', onTap: _busy ? null : _now),
          ],
        ]);
      },
    );
  }
}
