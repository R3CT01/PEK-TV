import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'plugin_github.dart';
import 'plugin_install_ui.dart';
import 'plugin_store.dart';
import 'plugin_store_ui.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Keeps installed plugins up to date. Checked once when the app starts (a few seconds in, so the start is not slowed down) and
/// again when the Plugins page asks.
///
///  * Built-in plugins (Weather, TMDb Discover, Skin maker) come from the PEK Store's Official shelf. A newer version there is installed by
///    itself: it is PEK's own plugin, published by the owner.
///  * A plugin installed from GitHub is looked up on GitHub again (its latest release). A newer one is only OFFERED on the Plugins
///    page: it is third-party code from an unverified developer, so the person sees the permissions screen again and taps Update.
///  * Plugins from the Community shelf or a .zip file are not checked here.
class PluginUpdates {
  /// GitHub plugins with a newer release, by plugin id.
  static final ValueNotifier<Map<String, GithubUpdate>> github = ValueNotifier(const {});

  /// Built-in plugins that were updated from the store during this run (for a one-time message on the Plugins page).
  static final ValueNotifier<List<String>> updatedStock = ValueNotifier(const []);

  static bool _started = false;
  static bool _checking = false;

  static void checkOnStartup() {
    if (_started) return;
    _started = true;
    Timer(const Duration(seconds: 6), () => unawaited(check()));
  }

  /// 1.10.0 is newer than 1.9.2; a missing number counts as 0. Letters after a number are ignored (1.2.0-beta = 1.2.0).
  static bool newer(String a, String b) {
    List<int> parts(String v) => v.trim().replaceFirst(RegExp(r'^[vV]'), '').split(RegExp(r'[.\-+]')).map((e) => int.tryParse(RegExp(r'^\d+').stringMatch(e) ?? '') ?? 0).toList();
    final x = parts(a), y = parts(b);
    for (var i = 0; i < (x.length > y.length ? x.length : y.length); i++) {
      final d = (i < x.length ? x[i] : 0) - (i < y.length ? y[i] : 0);
      if (d != 0) return d > 0;
    }
    return false;
  }

  static Future<void> check() async {
    if (_checking) return;
    _checking = true;
    try {
      final List<PluginInfo> installed;
      try {
        installed = await Api.plugins();
      } catch (_) {
        return; // the server is not answering: try again next time
      }
      await _stock(installed);
      await _github(installed);
    } finally {
      _checking = false;
    }
  }

  static Future<void> _stock(List<PluginInfo> installed) async {
    final mine = {for (final p in installed) if (PluginInstaller.stockIds.contains(p.folder)) p.folder: p.version};
    if (mine.isEmpty) return;
    List<StoreItem> items;
    try {
      items = await PekStoreApi.list('official');
    } catch (_) {
      return; // offline: nothing to do
    }
    for (final it in items) {
      final have = mine[it.id];
      if (have == null || it.version.isEmpty) continue;
      if (!newer(it.version, have)) continue;
      try {
        final prep = await PekStoreApi.download(it, official: true);
        final verdict = await PluginInstaller.send(prep, dry: true);
        if (!verdict.ok) continue;
        final res = await PluginInstaller.send(prep, dry: false);
        if (!res.ok) continue;
        await PluginInstaller.rememberSource(prep.id, 'official');
        await PluginInstaller.changed(prep.id);
        updatedStock.value = [...updatedStock.value, '${prep.name} ${prep.version}'];
      } catch (_) {
        // Try again at the next start.
      }
    }
  }

  static Future<void> _github(List<PluginInfo> installed) async {
    if (!PekGithub.enabled) return;
    final found = <String, GithubUpdate>{};
    for (final p in installed) {
      final src = PluginInstaller.sourceOf(p.folder);
      if (src is! Map || src['type'] != 'github') continue;
      final owner = '${src['owner']}', repo = '${src['repo']}', tag = '${src['tag'] ?? ''}';
      if (owner.isEmpty || repo.isEmpty) continue;
      try {
        final rel = await PekGithub.findRelease(owner, repo, pek: true);
        if (rel.options.isEmpty) continue; // no .PEK file in the release: nothing PEK TV could install
        if (rel.tag.isEmpty || rel.tag == tag) continue; // no release, or the one that is installed
        if (tag.isNotEmpty && !newer(rel.tag, tag) && RegExp(r'\d').hasMatch(rel.tag) && RegExp(r'\d').hasMatch(tag)) continue; // an older / same number
        found[p.folder] = GithubUpdate(plugin: p, release: rel, kind: '${src['kind'] ?? 'source'}');
      } catch (_) {}
    }
    github.value = found;
  }

  /// Opens the install screen for a GitHub update: the same permissions screen as a first install.
  static Future<void> openGithubUpdate(BuildContext context, GithubUpdate u) async {
    final rel = u.release;
    final opt = rel.options.where((o) => o.kind == u.kind).firstOrNull ?? rel.options.firstOrNull;
    if (opt == null) return;
    await Navigator.push<void>(
      context,
      MaterialPageRoute<void>(
        builder: (_) => SubScreen(
          title: 'Update ${u.plugin.name}',
          body: Builder(
            builder: (c) => PluginInstallPage(
              title: '${rel.owner}/${rel.repo}',
              shelf: 'github',
              source: {'type': 'github', 'owner': rel.owner, 'repo': rel.repo, 'tag': rel.tag, 'kind': opt.kind},
              load: (_) => PekGithub.download(rel, opt),
              notice: (prep, replaced) => [
                'Update from GitHub: ${rel.owner}/${rel.repo} \u00b7 ${rel.tag}',
                'PEK TV did not make, review or approve it. Check what it asks for before you update.',
              ],
              padding: c.pek.pagePad,
            ),
          ),
        ),
      ),
    );
    unawaited(check());
  }
}

class GithubUpdate {
  const GithubUpdate({required this.plugin, required this.release, required this.kind});
  final PluginInfo plugin;
  final GithubRelease release;
  final String kind;
}
