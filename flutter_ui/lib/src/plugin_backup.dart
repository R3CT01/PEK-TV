import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'cloud.dart';
import 'plugin_store.dart';
import 'store.dart';

/// A cloud copy of a plugin that this device does not have, or has a different version of.
class BackupOffer {
  const BackupOffer({required this.id, required this.name, required this.version, required this.kind, required this.updated, required this.size});

  final String id, name, version;

  /// 'new' (not on this device), 'update' (the cloud copy is newer), 'conflict' (both changed).
  final String kind;
  final int updated, size;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'version': version, 'kind': kind, 'updated': updated, 'size': size};
  factory BackupOffer.fromJson(Map<String, dynamic> j) => BackupOffer(
        id: '${j['id'] ?? ''}',
        name: '${j['name'] ?? j['id'] ?? ''}',
        version: '${j['version'] ?? ''}',
        kind: '${j['kind'] ?? 'new'}',
        updated: (j['updated'] as num?)?.toInt() ?? 0,
        size: (j['size'] as num?)?.toInt() ?? 0,
      );
}

class BackupRun {
  const BackupRun({required this.ok, this.error = '', this.off = false, this.uploaded = 0, this.offers = const []});
  final bool ok, off;
  final String error;
  final int uploaded;
  final List<BackupOffer> offers;
}

class _Fail implements Exception {
  const _Fail(this.code);
  final String code;
}

class _Listing {
  const _Listing(this.files, this.sig);
  final List<({String path, int size, int mtime})> files;
  final String sig;
}

class _Packed {
  const _Packed(this.bundle, this.fp, this.raw, this.name, this.version);
  final String bundle, fp, name, version;
  final int raw;
}

/// Port of www/plugin_backup.js, on the same cloud routes (cloud/worker.js: /v1/plugins/*), so a backup made by the web UI
/// can be restored here and the other way round (same bundle format and fingerprint).
///
///  - Only third-party plugins are backed up, and only their own files (never their data/ folder).
///  - Backing up is automatic once you are signed in (Settings > Account > Back up my plugins).
///  - Getting plugins BACK is never automatic: the cloud copy is only offered ([offers]); installing it goes through the same
///    permissions screen and server checks as installing a .zip.
///  - Removing a plugin marks it removed in the cloud so other devices stop offering it. Nothing is ever deleted on a device
///    because of the cloud.
class PluginBackup {
  static const _kOn = 'pek_plugin_backup_on'; // '0' = off (default is on)
  static const _kSeen = 'pek_plugin_backup_seen_v1'; // {email, plugins: {id: {sig, fp, u}}}
  static const _kPending = 'pek_plugin_backup_pending_v1'; // {list: [offer]}
  static const _kSkip = 'pek_plugin_backup_skip_v1'; // {id: cloud "updated" the person said "not now" to}

  static const _chunk = 400000; // characters per upload piece (the worker expects this size or less)
  static const _maxRaw = 8 * 1024 * 1024;

  /// Shipped with PEK TV (kept in step with plugin_install.h and the worker); never backed up.
  static const builtin = ['weather', 'sample_scraper', 'sample_counter', 'tmdb-discover'];
  static final _validId = RegExp(r'^[a-z0-9][a-z0-9_-]{0,39}$');
  static bool validId(String id) => _validId.hasMatch(id);

  /// The cloud copies on offer. The Plugins page listens to this.
  static final ValueNotifier<List<BackupOffer>> offers = ValueNotifier(_loadOffers());
  static final ValueNotifier<int> lastRun = ValueNotifier(0);

  static bool get enabled => Store.strGet(_kOn, scoped: false) != '0';
  static Future<void> setEnabled(bool on) async {
    await Store.strSet(_kOn, on ? '1' : '0', scoped: false);
    if (!on) offers.value = const [];
    if (on) unawaited(run());
  }

  static List<BackupOffer> _loadOffers() {
    final l = Store.jsonMap(_kPending, scoped: false)['list'];
    if (l is! List) return const [];
    return [for (final e in l) if (e is Map) BackupOffer.fromJson(Map<String, dynamic>.from(e))];
  }

  static Future<void> _saveOffers(List<BackupOffer> l) async {
    await Store.setJsonMap(_kPending, {'list': [for (final o in l) o.toJson()]}, scoped: false);
    offers.value = l;
  }

  static bool _truthy(dynamic v) => v == true || (v is num && v != 0);
  static int _int(dynamic v) => v is num ? v.toInt() : (int.tryParse('${v ?? ''}') ?? 0);

  // ---------------------------------------------------------------- reading what is installed on this device

  static Future<List<String>?> _localIds() async {
    final all = await Api.pluginFolders();
    if (all == null) return null; // then nothing is backed up this time, so a hiccup never looks like "everything was removed"
    return [for (final id in all) if (validId(id) && !builtin.contains(id)) id];
  }

  // A quick signature from the file list, sizes and modified times (no file contents read).
  static Future<_Listing?> _listLocal(String id) async {
    final files = await Api.pluginFiles(id);
    if (files == null || files.isEmpty) return null;
    final total = files.fold<int>(0, (a, f) => a + f.size);
    if (total > _maxRaw) return null;
    return _Listing(files, files.map((f) => '${f.path}:${f.size}:${f.mtime}').join('|'));
  }

  // Reads every file and builds one text bundle. The order is fixed so the fingerprint is stable.
  static Future<_Packed> _pack(String id, _Listing listing) async {
    final files = <Map<String, String>>[];
    var raw = 0;
    var name = id, version = '';
    for (final f in listing.files) {
      final bytes = await Api.pluginFile(id, f.path);
      raw += bytes.length;
      files.add({'p': f.path, 'd': base64Encode(bytes)});
      if (f.path == 'plugin.json') {
        try {
          final m = jsonDecode(utf8.decode(bytes).replaceFirst('\uFEFF', ''));
          if (m is Map) {
            if (m['name'] is String) name = (m['name'] as String).substring(0, math.min(80, (m['name'] as String).length));
            if (m['version'] is String) version = (m['version'] as String).substring(0, math.min(40, (m['version'] as String).length));
          }
        } catch (_) {/* keep the id as the name */}
      }
    }
    final bundle = jsonEncode({'v': 1, 'files': files});
    return _Packed(bundle, PekStoreApi.fingerprint(bundle), raw, name, version);
  }

  // ---------------------------------------------------------------- talking to the cloud

  static Future<int> _upload(String id, _Packed p) async {
    final total = math.max(1, (p.bundle.length / _chunk).ceil());
    for (var i = 0; i < total; i++) {
      final r = await Cloud.call('POST', '/v1/plugins/chunk', {
        'id': id,
        'fp': p.fp,
        'index': i,
        'total': total,
        'data': p.bundle.substring(i * _chunk, math.min(p.bundle.length, (i + 1) * _chunk)),
      });
      if (!r.ok) throw _Fail(r.error);
    }
    final updated = DateTime.now().millisecondsSinceEpoch;
    final r = await Cloud.call('POST', '/v1/plugins/commit', {'id': id, 'fp': p.fp, 'total': total, 'name': p.name, 'version': p.version, 'size': p.raw, 'updated': updated});
    if (!r.ok) throw _Fail(r.error);
    return updated;
  }

  /// Downloads one cloud copy and turns it into what the install screen needs. [onProgress] gets (chunk, of chunks).
  /// Throws [StoreException] with a sentence to show.
  static Future<PreparedPlugin> fetchForRestore(String id, {void Function(int, int)? onProgress}) async {
    final list = await Cloud.call('GET', '/v1/plugins');
    if (!list.ok) throw StoreException(errorText(list.error));
    Map<String, dynamic>? entry;
    for (final e in ((list.body['plugins'] as List?) ?? const [])) {
      if (e is Map && e['id'] == id && !_truthy(e['deleted'])) entry = Map<String, dynamic>.from(e);
    }
    if (entry == null) throw const StoreException('That backup is no longer in your cloud account.');
    final fp = '${entry['fp']}';
    final chunks = _int(entry['chunks']);
    final parts = StringBuffer();
    for (var i = 0; i < chunks; i++) {
      onProgress?.call(i, chunks);
      final r = await Cloud.call('GET', '/v1/plugins/chunk?id=${Uri.encodeQueryComponent(id)}&fp=${Uri.encodeQueryComponent(fp)}&i=$i');
      if (!r.ok) throw StoreException(errorText(r.error));
      parts.write('${r.body['data'] ?? ''}');
    }
    onProgress?.call(chunks, chunks);
    final bundle = parts.toString();
    const damaged = StoreException('The backup was damaged. Try again.'); // never install a damaged download
    if (PekStoreApi.fingerprint(bundle) != fp) throw damaged;
    final files = <PluginFile>[];
    try {
      final o = jsonDecode(bundle) as Map;
      if (o['v'] != 1) throw damaged;
      for (final f in (o['files'] as List)) {
        final m = f as Map;
        files.add(PluginFile('${m['p']}', base64Decode('${m['d']}')));
      }
    } catch (_) {
      throw damaged;
    }
    return PreparedPlugin.fromFiles(id, files);
  }

  // ---------------------------------------------------------------- the backup pass

  static Future<BackupRun>? _running;

  /// Backs up what changed on this device and works out what the cloud has that this device has not. [force] re-reads every plugin
  /// even if its files look unchanged.
  static Future<BackupRun> run({bool force = false}) {
    if (!enabled) return Future.value(const BackupRun(ok: true, off: true));
    final r = _running ??= _run(force).whenComplete(() => _running = null);
    return r;
  }

  static bool _skipped(Map<String, dynamic> skip, String id, int updated) => _int(skip[id]) >= updated && skip[id] != null;

  static Future<BackupRun> _run(bool force) async {
    if (!Cloud.linked) return const BackupRun(ok: false, error: 'not_linked');
    final email = Cloud.email;
    var state = Store.jsonMap(_kSeen, scoped: false);
    if (state['email'] != email) state = {'email': email, 'plugins': <String, dynamic>{}}; // a different account: start fresh
    final seenMap = <String, dynamic>{...((state['plugins'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{})};
    final skip = Store.jsonMap(_kSkip, scoped: false);
    final pending = <BackupOffer>[];
    var uploaded = 0;
    String? failed;

    final List<String>? ids;
    final CloudResult list;
    try {
      ids = await _localIds();
      list = await Cloud.call('GET', '/v1/plugins');
    } catch (_) {
      return const BackupRun(ok: false, error: 'offline');
    }
    if (ids == null) return const BackupRun(ok: false, error: 'local');
    if (!list.ok) return BackupRun(ok: false, error: list.error);

    final cloud = <String, Map<String, dynamic>>{};
    for (final e in ((list.body['plugins'] as List?) ?? const [])) {
      if (e is Map && e['id'] is String) cloud['${e['id']}'] = Map<String, dynamic>.from(e);
    }
    final all = <String>{...ids, ...cloud.keys.where(validId)};

    BackupOffer offer(String id, Map<String, dynamic> c, String kind) =>
        BackupOffer(id: id, name: '${c['name'] ?? ''}'.isEmpty ? id : '${c['name']}', version: '${c['version'] ?? ''}', kind: kind, updated: _int(c['updated']), size: _int(c['size']));

    for (final id in all) {
      if (failed != null) break;
      final c = cloud[id];
      final live = c != null && !_truthy(c['deleted']);
      final seen = (seenMap[id] as Map?)?.cast<String, dynamic>();

      if (!ids.contains(id)) {
        // Only in the cloud: offer it (unless the person said "not now" to this version).
        if (live && !_skipped(skip, id, _int(c['updated']))) pending.add(offer(id, c, 'new'));
        continue;
      }
      try {
        final listing = await _listLocal(id);
        if (listing == null) continue; // nothing readable: leave it alone
        final sameSizes = seen != null && seen['sig'] == listing.sig && !force;

        if (!live) {
          if (c != null && sameSizes) continue; // removed elsewhere, unchanged here: stay local-only
          final p = await _pack(id, listing);
          final u = await _upload(id, p);
          uploaded++;
          seenMap[id] = {'sig': listing.sig, 'fp': p.fp, 'u': u};
          continue;
        }

        // Both have it. If the sizes are unchanged we already know this device's fingerprint.
        _Packed? p;
        var localFp = sameSizes ? '${seen['fp']}' : null;
        if (localFp == null) {
          p = await _pack(id, listing);
          localFp = p.fp;
        }
        if (localFp == '${c['fp']}') {
          seenMap[id] = {'sig': listing.sig, 'fp': localFp, 'u': _int(c['updated'])};
          continue;
        }
        final localChanged = seen == null || seen['fp'] != localFp;
        final cloudChanged = seen == null || seen['fp'] != c['fp'];
        if (localChanged && !cloudChanged) {
          p ??= await _pack(id, listing);
          final u = await _upload(id, p);
          uploaded++;
          seenMap[id] = {'sig': listing.sig, 'fp': p.fp, 'u': u};
          continue;
        }
        if (!_skipped(skip, id, _int(c['updated']))) pending.add(offer(id, c, localChanged ? 'conflict' : 'update'));
        seenMap[id] = {'sig': listing.sig, 'fp': localFp, 'u': seen?['u'] ?? 0};
      } on _Fail catch (e) {
        // One plugin failing must not stop the others. A signed-out session or no network stops everything.
        if (e.code == 'session_expired' || e.code == 'offline' || e.code == 'rate_limited') failed = e.code;
      } catch (_) {/* this plugin only */}
    }

    await Store.setJsonMap(_kSeen, {'email': email, 'plugins': seenMap}, scoped: false);
    await _saveOffers(pending);
    lastRun.value = DateTime.now().millisecondsSinceEpoch;
    if (failed != null) return BackupRun(ok: false, error: failed, uploaded: uploaded, offers: pending);
    return BackupRun(ok: true, uploaded: uploaded, offers: pending);
  }

  // ---------------------------------------------------------------- what the person can do with an offer

  static Future<void> _drop(String id) => _saveOffers([for (final o in offers.value) if (o.id != id) o]);

  /// "Not now": hide this cloud version until a newer one appears.
  static Future<void> dismiss(String id) async {
    final skip = Store.jsonMap(_kSkip, scoped: false);
    final o = offers.value.where((x) => x.id == id).firstOrNull;
    skip[id] = o?.updated ?? DateTime.now().millisecondsSinceEpoch;
    await Store.setJsonMap(_kSkip, skip, scoped: false);
    await _drop(id);
  }

  /// "Keep mine": replace the cloud copy with the one on this device. Returns an error code, or '' when it worked.
  static Future<String> keepLocal(String id) async {
    try {
      final listing = await _listLocal(id);
      if (listing == null) return 'local';
      final p = await _pack(id, listing);
      final u = await _upload(id, p);
      final state = Store.jsonMap(_kSeen, scoped: false);
      final plugins = <String, dynamic>{...((state['plugins'] as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{})};
      plugins[id] = {'sig': listing.sig, 'fp': p.fp, 'u': u};
      await Store.setJsonMap(_kSeen, {'email': Cloud.email, 'plugins': plugins}, scoped: false);
      await _drop(id);
      return '';
    } on _Fail catch (e) {
      return e.code;
    } catch (_) {
      return 'server';
    }
  }

  /// The person removed this plugin here: tell the cloud so their other devices stop offering it.
  static Future<void> forget(String id) async {
    if (!enabled || !Cloud.linked || !validId(id)) return;
    final r = await Cloud.call('POST', '/v1/plugins/delete', {'id': id, 'updated': DateTime.now().millisecondsSinceEpoch});
    if (!r.ok) return;
    final state = Store.jsonMap(_kSeen, scoped: false);
    final plugins = (state['plugins'] as Map?)?.cast<String, dynamic>();
    if (plugins != null && plugins.remove(id) != null) await Store.setJsonMap(_kSeen, {...state, 'plugins': plugins}, scoped: false);
    await _drop(id);
  }

  static String errorText(String code) {
    switch (code) {
      case 'plugin_quota':
        return 'Your cloud plugin storage is full (30 plugins or 60 MB). Remove a plugin to make room.';
      case 'local':
        return 'PEK TV could not read the plugins on this device.';
      case 'not_linked':
        return 'Sign in to back up your plugins.';
      case 'too_large':
        return 'That plugin is too large to back up.';
      default:
        return Cloud.errorText(code);
    }
  }
}
