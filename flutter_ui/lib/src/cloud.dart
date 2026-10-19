import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'profiles.dart';
import 'store.dart';

/// The answer of one cloud call.
class CloudResult {
  const CloudResult({required this.ok, this.error = '', this.status = 0, this.body = const {}, this.needsVerify = false, this.pushed = 0, this.changed = false});
  final bool ok;
  final String error; // a short code, see [Cloud.errorText]
  final int status;
  final Map<String, dynamic> body;
  final bool needsVerify; // account made, the emailed code still has to be entered
  final int pushed;
  final bool changed;
}

/// Port of www/sync.js: the household account (email + password) of the PEK Cloud worker (cloud/worker.js) and the
/// two-way sync of watch history and resume points. Each profile syncs its own data under the account.
///
/// Library favorites are not synced: the cloud only keeps favorites with a TMDb id (`f|movie:603`), and the Flutter UI's
/// favorites are library items. They stay on the device (per profile).
class Cloud {
  static const api = 'https://pek-sync.aquariusibeats.workers.dev';

  static const _kToken = 'pek_account_token';
  static const _kEmail = 'pek_account_email';
  static const _kUser = 'pek_account_username';
  static const _kLastMail = 'pek_profiles_lastmail';

  static const _chunk = 800;
  static const _maxRounds = 20;
  static const _dataBudget = 1900;
  static const _torMaxSource = 900;

  static final http.Client _c = http.Client();

  /// Bumped whenever the signed-in state changes (the screens that show it repaint).
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static bool get linked => _token.isNotEmpty;
  static String get _token => Store.strGet(_kToken, scoped: false) ?? '';
  static String get email => Store.strGet(_kEmail, scoped: false) ?? '';
  static String get username => Store.strGet(_kUser, scoped: false) ?? '';
  static int get lastSync => int.tryParse(Store.strGet('pek_sync_last') ?? '') ?? 0;

  // ---------------------------------------------------------------- small helpers

  static int _int(dynamic v) {
    if (v is num) return v.toInt();
    return int.tryParse('${v ?? ''}') ?? 0;
  }

  static double _num(dynamic v) => v is num ? v.toDouble() : (double.tryParse('${v ?? ''}') ?? 0);
  static bool _truthy(dynamic v) => v == true || (v is num && v != 0);

  static String cleanEmail(String s) => s.trim().toLowerCase();
  static bool validEmail(String s) {
    final e = cleanEmail(s);
    return e.length >= 5 && e.length <= 254 && RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]{2,}$').hasMatch(e);
  }

  static bool validPassword(String s) => s.length >= 8 && s.length <= 200;

  /// What a failure code means in words.
  static String errorText(String code) {
    switch (code) {
      case 'offline':
        return 'Could not reach the PEK cloud. Check your connection.';
      case 'bad_email':
        return 'That email address does not look right.';
      case 'weak_password':
        return 'Use a password of at least 8 characters.';
      case 'bad_credentials':
        return 'Wrong email or password.';
      case 'bad_invite':
        return 'That invite code is not valid.';
      case 'bad_code':
        return 'That code is wrong or has expired.';
      case 'email_taken':
      case 'exists':
        return 'There is already an account with that email. Sign in instead.';
      case 'rate_limited':
        return 'Too many tries. Wait a little and try again.';
      case 'session_expired':
        return 'You were signed out. Please sign in again.';
      case 'too_large':
        return 'That was too much data for the cloud.';
      case 'cloud_outdated':
        return 'The cloud service needs updating before other profiles can sync.';
      case 'not_linked':
        return 'Sign in first.';
      case 'unknown_profile':
        return 'That profile was removed on another device.';
      default:
        return 'The cloud could not do that ($code).';
    }
  }

  static String _failure(int status, Map<String, dynamic> body) {
    final e = body['error'];
    if (status == 401 && (e == null || e == 'bad_session')) return 'session_expired';
    if (status == 413) return 'too_large';
    if (status == 429) return 'rate_limited';
    return e is String && e.isNotEmpty ? e : 'server';
  }

  static Future<({int status, Map<String, dynamic> body})> _request(String method, String path, {Object? body, bool withToken = false}) async {
    final headers = <String, String>{'Content-Type': 'application/json', if (withToken) 'Authorization': 'Bearer $_token'};
    final uri = Uri.parse('$api$path');
    http.Response r;
    if (method == 'GET') {
      r = await _c.get(uri, headers: headers).timeout(const Duration(seconds: 20));
    } else if (method == 'DELETE') {
      r = await _c.delete(uri, headers: headers).timeout(const Duration(seconds: 20));
    } else {
      r = await _c.post(uri, headers: headers, body: jsonEncode(body ?? <String, dynamic>{})).timeout(const Duration(seconds: 20));
    }
    var out = <String, dynamic>{};
    try {
      final o = jsonDecode(utf8.decode(r.bodyBytes));
      if (o is Map) out = Map<String, dynamic>.from(o);
    } catch (_) {}
    return (status: r.statusCode, body: out);
  }

  // ---------------------------------------------------------------- account

  static Future<void> _startSession(String token, String mail, String user) async {
    await Store.clearSyncState(Profiles.ids);
    await Store.strSet(_kToken, token, scoped: false);
    await Store.strSet(_kEmail, mail, scoped: false);
    if (user.isEmpty) {
      await Store.strDel(_kUser, scoped: false);
    } else {
      await Store.strSet(_kUser, user, scoped: false);
    }
    changes.value++;
  }

  static Future<void> _unlink() async {
    await Store.clearSyncState(Profiles.ids);
    await Store.strDel(_kToken, scoped: false);
    await Store.strDel(_kEmail, scoped: false);
    await Store.strDel(_kUser, scoped: false);
    changes.value++;
  }

  static Future<CloudResult> _auth(String path, Map<String, dynamic> body) async {
    try {
      final r = await _request('POST', path, body: body);
      if (r.status == 200 && r.body['ok'] == true) return CloudResult(ok: true, status: 200, body: r.body);
      return CloudResult(ok: false, status: r.status, error: _failure(r.status, r.body));
    } catch (_) {
      return const CloudResult(ok: false, error: 'offline');
    }
  }

  /// An auth call that ends with a session. [created] = this finished a brand-new account.
  static Future<CloudResult> _session(String path, Map<String, dynamic> body, {bool created = false}) async {
    final res = await _auth(path, body);
    if (!res.ok) return res;
    if (res.body['needsVerify'] == true) return const CloudResult(ok: true, needsVerify: true);
    final token = res.body['token'];
    if (token is! String || token.isEmpty) return const CloudResult(ok: false, error: 'server');
    final mail = '${res.body['email'] ?? body['email']}'.toLowerCase();
    await _startSession(token, mail, '${res.body['username'] ?? ''}');
    await Profiles.afterSignIn(mail, created: created);
    return CloudResult(ok: true, body: res.body);
  }

  static Future<CloudResult> signUp(String mail, String password, {String invite = '', String name = ''}) async {
    if (!validEmail(mail)) return const CloudResult(ok: false, error: 'bad_email');
    if (!validPassword(password)) return const CloudResult(ok: false, error: 'weak_password');
    final body = <String, dynamic>{'email': cleanEmail(mail), 'password': password};
    if (invite.trim().isNotEmpty) body['invite'] = invite.trim();
    if (name.trim().isNotEmpty) body['username'] = name.trim();
    return _session('/v1/auth/signup', body, created: true);
  }

  /// Finishes sign-up (or a sign-in that asks for it) with the 6-digit code from the email.
  static Future<CloudResult> verifyEmail(String mail, String code, {bool created = true}) {
    if (!validEmail(mail)) return Future.value(const CloudResult(ok: false, error: 'bad_email'));
    return _session('/v1/auth/verify', {'email': cleanEmail(mail), 'code': code.replaceAll(RegExp(r'\D'), '')}, created: created);
  }

  static Future<CloudResult> resendCode(String mail) async {
    if (!validEmail(mail)) return const CloudResult(ok: false, error: 'bad_email');
    final r = await _auth('/v1/auth/resend', {'email': cleanEmail(mail)});
    return r.ok ? const CloudResult(ok: true) : r;
  }

  static Future<CloudResult> signIn(String mail, String password) {
    if (!validEmail(mail) || password.isEmpty) return Future.value(const CloudResult(ok: false, error: 'bad_credentials'));
    return _session('/v1/auth/login', {'email': cleanEmail(mail), 'password': password});
  }

  static Future<CloudResult> forgotPassword(String mail) async {
    if (!validEmail(mail)) return const CloudResult(ok: false, error: 'bad_email');
    final r = await _auth('/v1/auth/forgot', {'email': cleanEmail(mail)});
    return r.ok ? const CloudResult(ok: true) : r;
  }

  static Future<CloudResult> resetPassword(String mail, String code, String password) {
    if (!validEmail(mail)) return Future.value(const CloudResult(ok: false, error: 'bad_email'));
    if (!validPassword(password)) return Future.value(const CloudResult(ok: false, error: 'weak_password'));
    return _session('/v1/auth/reset', {'email': cleanEmail(mail), 'code': code.replaceAll(RegExp(r'\D'), ''), 'password': password});
  }

  /// Checks the account password for this session (used to reset a forgotten profile passcode).
  static Future<CloudResult> confirmPassword(String password) async {
    if (!linked) return const CloudResult(ok: false, error: 'not_linked');
    if (password.isEmpty) return const CloudResult(ok: false, error: 'bad_credentials');
    try {
      final r = await _request('POST', '/v1/auth/confirm', body: {'password': password.length > 200 ? password.substring(0, 200) : password}, withToken: true);
      if (r.status == 200 && r.body['ok'] == true) return const CloudResult(ok: true);
      if (r.status == 401 && r.body['error'] == 'bad_credentials') return const CloudResult(ok: false, error: 'bad_credentials');
      return CloudResult(ok: false, error: _failure(r.status, r.body));
    } catch (_) {
      return const CloudResult(ok: false, error: 'offline');
    }
  }

  /// Signs out here (and ends the session on the server, best effort). Like the web UI, everything that came from the
  /// account (every profile's data, the profile list) leaves this device; the cloud keeps it.
  static Future<void> signOut() async {
    if (linked) {
      try {
        await _request('POST', '/v1/auth/logout', body: <String, dynamic>{}, withToken: true);
      } catch (_) {}
    }
    await _unlink();
    await Store.wipeAccountData();
    Profiles.reload();
    changes.value++;
  }

  /// Permanently deletes the cloud account and its data, then signs out here.
  static Future<CloudResult> deleteAccount() async {
    if (!linked) return const CloudResult(ok: false, error: 'not_linked');
    try {
      final r = await _request('DELETE', '/v1/account', withToken: true);
      if (r.status != 200) return CloudResult(ok: false, error: _failure(r.status, r.body));
    } catch (_) {
      return const CloudResult(ok: false, error: 'offline');
    }
    await _unlink();
    await Store.wipeAccountData();
    Profiles.reload();
    changes.value++;
    return const CloudResult(ok: true);
  }

  /// The account's profiles as the cloud has them (sends none of ours).
  static Future<List<Map<String, dynamic>>?> peekProfiles() async {
    if (!linked) return null;
    try {
      final r = await _request('POST', '/v1/profiles/sync', body: {'profiles': <dynamic>[]}, withToken: true);
      if (r.status == 200 && r.body['ok'] == true) {
        final l = r.body['profiles'];
        return l is List ? l.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : <Map<String, dynamic>>[];
      }
    } catch (_) {}
    return null;
  }

  static String get lastMail => Store.strGet(_kLastMail, scoped: false) ?? '';
  static Future<void> rememberMail(String mail) => Store.strSet(_kLastMail, mail, scoped: false);

  // ---------------------------------------------------------------- sync

  static Future<CloudResult>? _inflight;
  static List<Movie>? _movies;
  static List<Show>? _shows;

  /// Tells the cloud about this device's profiles and takes in the household's.
  static Future<CloudResult> _syncProfiles() async {
    final r = await _request('POST', '/v1/profiles/sync', body: {'profiles': Profiles.syncPayload()}, withToken: true);
    if (r.status == 200 && r.body['ok'] == true) {
      final l = r.body['profiles'];
      Profiles.mergeRemote(l is List ? l.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : const []);
      return const CloudResult(ok: true);
    }
    return CloudResult(ok: false, status: r.status, error: _failure(r.status, r.body));
  }

  /// True when this device has something the cloud has not seen yet (cheap, local only, no network).
  static bool hasLocalChanges() {
    if (!linked) return false;
    final a = _collectPush();
    return a.history.length + a.progress.length > 0;
  }

  /// [light] skips the profile round trip (a stop-of-playback sync only needs to push what changed).
  static Future<CloudResult> sync({bool light = false}) {
    final running = _inflight;
    if (running != null) return running;
    if (!linked) return Future.value(const CloudResult(ok: false, error: 'not_linked'));
    final f = _syncInner(light).catchError((Object _) => const CloudResult(ok: false, error: 'offline')).then((res) async {
      _inflight = null;
      if (res.error == 'session_expired') await _unlink(); // signed out elsewhere or expired: ask to sign in again
      return res;
    });
    _inflight = f;
    return f;
  }

  static Future<CloudResult> _syncInner(bool light) async {
    _movies = null;
    _shows = null;
    final pid = Profiles.currentId;
    var retried = false;
    for (;;) {
      if (!light) {
        final pr = await _syncProfiles();
        if (!pr.ok) {
          if (pr.error == 'session_expired' || pr.error == 'rate_limited') return pr;
          // No profile support in the cloud yet: the original profile still works, the others must wait.
          if (pid != 'p1') return CloudResult(ok: false, error: pr.status == 404 ? 'cloud_outdated' : pr.error);
        }
      }
      final all = _collectPush();
      final pushed = all.history.length + all.progress.length;
      var anyChange = false;
      CloudResult? fail;
      for (var n = 1; n <= _maxRounds; n++) {
        final chunk = all.take(_chunk);
        final cursor = int.tryParse(Store.strGet('pek_sync_cursor') ?? '') ?? 0;
        final r = await _request('POST', '/v1/sync', body: {'profile': pid, 'since': cursor, 'history': chunk.history, 'progress': chunk.progress, 'favorites': <dynamic>[]}, withToken: true);
        if (r.status == 404 && r.body['error'] == 'unknown_profile') {
          fail = const CloudResult(ok: false, error: 'unknown_profile');
          break;
        }
        if (r.status != 200 || r.body['ok'] != true) {
          fail = CloudResult(ok: false, error: _failure(r.status, r.body));
          break;
        }
        // An older cloud service ignores "profile" and would mix everybody's data into one: only the original profile may talk to it.
        if (pid != 'p1' && r.body['profile'] != pid) {
          fail = const CloudResult(ok: false, error: 'cloud_outdated');
          break;
        }
        _markPushed(chunk);
        if (await _applyRemote(r.body)) anyChange = true;
        await Store.strSet('pek_sync_cursor', '${r.body['cursor'] ?? cursor}');
        final more = r.body['more'] == true || all.isNotEmpty;
        if (more && n < _maxRounds) continue;
        await Store.strSet('pek_sync_last', '${DateTime.now().millisecondsSinceEpoch}');
        break;
      }
      if (fail == null) return CloudResult(ok: true, pushed: pushed, changed: anyChange);
      if (fail.error == 'unknown_profile' && !retried) {
        // Removed on another device, but in use here: keep it (the newer change wins) and try once more.
        retried = true;
        Profiles.touch(pid);
        continue;
      }
      return fail;
    }
  }

  // ---------------------------------------------------------------- what to push

  static Map<String, dynamic> _seen() {
    final s = Store.jsonMap('pek_sync_seen');
    s['h'] = s['h'] is Map ? Map<String, dynamic>.from(s['h'] as Map) : <String, dynamic>{};
    s['p'] = s['p'] is Map ? Map<String, dynamic>.from(s['p'] as Map) : <String, dynamic>{};
    return s;
  }

  static Map<String, _P> _progressByKey(Map<String, dynamic> pmap) {
    final out = <String, _P>{};
    pmap.forEach((id, v) {
      if (v is! Map) return;
      final e = Progress.fromJson(Map<String, dynamic>.from(v));
      final k = Store.keyFor(kind: e.kind, title: e.title, showTitle: e.showTitle, year: e.year, season: e.season, episode: e.episode);
      if (k == null) return;
      final cur = out[k];
      if (cur == null || e.updated > cur.entry.updated) out[k] = _P(id, e);
    });
    return out;
  }

  static Map<String, dynamic> _historyData(Map v) {
    final kind = '${v['kind'] ?? 'movie'}';
    final t = '${v['title'] ?? ''}';
    return {
      'kind': kind,
      'title': kind == 'episode' ? '' : t,
      'year': _int(v['year']),
      'showTitle': kind == 'episode' ? t : '',
      'season': _int(v['season']),
      'episode': _int(v['episode']),
      'watchedAt': _int(v['at']),
      'count': math.max(1, _int(v['count'])),
      'lib': 1,
    };
  }

  static String _shrinkSource(String src) {
    src = src.trim();
    if (src.length > _torMaxSource && src.toLowerCase().startsWith('magnet:')) {
      final parts = src.split('&');
      src = [for (var i = 0; i < parts.length; i++) if (i == 0 || !parts[i].toLowerCase().startsWith('tr=')) parts[i]].join('&');
    }
    if (src.isEmpty || src.length > _torMaxSource) return '';
    final l = src.toLowerCase();
    return (l.startsWith('magnet:?') || l.startsWith('https://')) ? src : '';
  }

  static Map<String, dynamic>? _cleanTorrent(dynamic t) {
    if (t is! Map) return null;
    final source = _shrinkSource('${t['source'] ?? ''}');
    if (source.isEmpty) return null;
    final title = '${t['title'] ?? ''}';
    return {'source': source, 'title': title.length > 200 ? title.substring(0, 200) : title, 'season': _int(t['season']), 'episode': _int(t['episode'])};
  }

  static String _cleanUrl(String u) => RegExp(r'^https?://', caseSensitive: false).hasMatch(u) && u.length <= 400 ? u : '';

  static _All _collectPush() {
    final seen = _seen();
    final sh = seen['h'] as Map<String, dynamic>;
    final sp = seen['p'] as Map<String, dynamic>;
    final history = <Map<String, dynamic>>[];
    final progress = <Map<String, dynamic>>[];
    final now = DateTime.now().millisecondsSinceEpoch;

    Store.historyRaw().forEach((k, v) {
      if (v is! Map) return;
      final updated = _int(v['updated'] ?? v['at']);
      if (updated <= 0 || _int(sh[k]) == updated) return;
      if (v['deleted'] != null) {
        history.add({'key': k, 'data': <String, dynamic>{}, 'updated': updated, 'deleted': 1});
      } else {
        history.add({'key': k, 'data': _historyData(v), 'updated': updated, 'deleted': 0});
      }
    });

    final local = _progressByKey(Store.progressRaw());
    local.forEach((k, p) {
      final e = p.entry;
      final s = sp[k];
      if (s is Map && _int(s['d']) == 0 && _int(s['u']) == e.updated) return;
      final d = <String, dynamic>{
        'kind': e.kind,
        'title': e.kind == 'episode' ? '' : e.title,
        'year': e.year,
        'showTitle': e.showTitle,
        'season': e.season,
        'episode': e.episode,
        'position': e.position,
        'duration': e.duration,
      };
      final tor = _cleanTorrent(e.torrent);
      if (tor != null) {
        // A torrent stream: send what another device needs to start it again.
        d['torrent'] = tor;
        if (e.origin.isNotEmpty) d['origin'] = {'id': '', 'name': e.origin.length > 60 ? e.origin.substring(0, 60) : e.origin};
        final im = _cleanUrl(e.image);
        if (im.isNotEmpty) d['image'] = im;
        if (jsonEncode(d).length > _dataBudget) d.remove('image');
        if (jsonEncode(d).length > _dataBudget) (d['torrent'] as Map<String, dynamic>)['title'] = '';
        if (jsonEncode(d).length > _dataBudget) {
          d.remove('torrent');
          d.remove('origin');
        }
      }
      progress.add({'key': k, 'data': d, 'updated': e.updated > 0 ? e.updated : now, 'deleted': 0});
    });
    sp.forEach((k, v) {
      // finished or removed here: tell the cloud
      if (v is Map && _int(v['d']) == 0 && !local.containsKey(k)) progress.add({'key': k, 'data': <String, dynamic>{}, 'updated': now, 'deleted': 1});
    });
    return _All(history, progress);
  }

  static void _markPushed(_Chunk chunk) {
    final seen = _seen();
    final sh = seen['h'] as Map<String, dynamic>;
    final sp = seen['p'] as Map<String, dynamic>;
    for (final it in chunk.history) {
      sh['${it['key']}'] = it['updated'];
    }
    for (final it in chunk.progress) {
      sp['${it['key']}'] = {'u': it['updated'], 'd': it['deleted'] == 1 ? 1 : 0};
    }
    Store.setJsonMap('pek_sync_seen', seen);
  }

  // ---------------------------------------------------------------- what to take in

  static String _label(String kind, String title, String showTitle, int season, int episode, int year) {
    if (kind == 'episode') {
      String two(int n) => n.toString().padLeft(2, '0');
      return '$showTitle S${two(season)}E${two(episode)}';
    }
    return title;
  }

  /// A library file for a title that came from the cloud (titles match across devices, file ids do not).
  static Future<Progress?> _resolve(Map<String, dynamic> d) async {
    final kind = '${d['kind'] ?? 'movie'}';
    try {
      if (kind == 'movie') {
        _movies ??= await Api.movies();
        final t = Store.normalize('${d['title'] ?? ''}');
        final y = _int(d['year']);
        final m = _movies!.where((m) => Store.normalize(m.title) == t && (y == 0 || m.year == 0 || m.year == y)).firstOrNull;
        if (m == null) return null;
        return Progress(id: m.id, title: m.title, kind: 'movie', position: 0, duration: 0, updated: 0, year: m.year);
      }
      if (kind == 'episode') {
        _shows ??= await Api.shows();
        final t = Store.normalize('${d['showTitle'] ?? ''}');
        final s = _int(d['season']), e = _int(d['episode']);
        for (final show in _shows!) {
          if (Store.normalize(show.title) != t) continue;
          for (final season in show.seasons) {
            for (final ep in season.episodes) {
              if (ep.season == s && ep.episode == e) {
                return Progress(id: ep.id, title: _label('episode', '', show.title, s, e, 0), kind: 'episode', position: 0, duration: 0, updated: 0, showTitle: show.title, season: s, episode: e);
              }
            }
          }
        }
      }
    } catch (_) {}
    return null;
  }

  static Future<bool> _applyRemote(Map<String, dynamic> resp) async {
    final pending = Store.jsonMap('pek_sync_pending');
    List<Map<String, dynamic>> listOf(dynamic v) => v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : <Map<String, dynamic>>[];
    final remoteH = listOf(resp['history']);
    final remoteP = listOf(resp['progress']);
    pending.forEach((k, v) {
      if (v is Map && !remoteP.any((r) => r['key'] == k)) remoteP.add(Map<String, dynamic>.from(v));
    });

    // 1) look up local files (async) for live resume points we do not have yet
    final have = _progressByKey(Store.progressRaw());
    final resolved = <String, Progress>{};
    for (final r in remoteP) {
      if (_truthy(r['deleted'])) continue;
      final key = '${r['key']}';
      if (have.containsKey(key)) continue;
      final data = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
      final p = await _resolve(data);
      if (p != null) resolved[key] = p;
    }

    // 2) apply everything in one synchronous step (the player may have written progress meanwhile)
    var changed = false;
    final seen = _seen();
    final sh = seen['h'] as Map<String, dynamic>;
    final sp = seen['p'] as Map<String, dynamic>;
    final hmap = Store.historyRaw();

    for (final r in remoteH) {
      final key = '${r['key']}';
      final ru = _int(r['updated']);
      final local = hmap[key];
      final lu = local is Map ? _int(local['updated'] ?? local['at']) : 0;
      if (local != null && lu > ru) continue; // ours is newer; it gets pushed
      if (local == null || lu < ru) {
        if (_truthy(r['deleted'])) {
          hmap[key] = {'deleted': 1, 'updated': ru};
        } else {
          final d = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
          final kind = '${d['kind'] ?? (key.startsWith('e|') ? 'episode' : 'movie')}';
          final watched = _int(d['watchedAt']);
          hmap[key] = {
            'key': key,
            'kind': kind,
            'title': kind == 'episode' ? '${d['showTitle'] ?? ''}' : '${d['title'] ?? ''}',
            'year': _int(d['year']),
            'season': _int(d['season']),
            'episode': _int(d['episode']),
            'at': watched > 0 ? watched : ru,
            'count': math.max(1, _int(d['count'])),
            'updated': ru,
          };
        }
        changed = true;
      }
      sh[key] = ru;
    }

    final pmap = Store.progressRaw();
    final local = _progressByKey(pmap);
    final newPending = <String, dynamic>{};
    for (final r in remoteP) {
      final key = '${r['key']}';
      final ru = _int(r['updated']);
      final mine = local[key];
      if (_truthy(r['deleted'])) {
        if (mine != null && mine.entry.updated >= ru) continue; // we resumed it later
        if (mine != null) {
          pmap.remove(mine.id);
          changed = true;
        }
        sp[key] = {'u': ru, 'd': 1};
        continue;
      }
      final h = hmap[key];
      if (h is Map && h['deleted'] == null && _int(h['at']) >= ru) continue; // finished since that position
      final data = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
      final pos = _num(data['position']), dur = _num(data['duration']);
      if (mine != null) {
        if (ru > mine.entry.updated) {
          pmap[mine.id] = {...mine.entry.toJson(), 'position': pos, 'duration': dur, 'updated': ru};
          sp[key] = {'u': ru, 'd': 0};
          changed = true;
        } else if (ru == mine.entry.updated) {
          sp[key] = {'u': ru, 'd': 0};
        }
        continue;
      }
      final res = resolved[key];
      if (res != null) {
        pmap[res.id] = {...res.toJson(), 'position': pos, 'duration': dur, 'updated': ru};
        sp[key] = {'u': ru, 'd': 0};
        changed = true;
        continue;
      }
      final tor = _cleanTorrent(data['torrent']);
      if (tor != null) {
        // Not in this device's library, but it was a torrent stream: keep it as a resume point that starts the release again.
        final kind = '${data['kind'] ?? 'movie'}';
        final showTitle = '${data['showTitle'] ?? ''}';
        final season = _int(data['season']), episode = _int(data['episode']);
        final og = data['origin'];
        final id = 'tor:$key';
        pmap[id] = Progress(
          id: id,
          title: _label(kind, '${data['title'] ?? ''}', showTitle, season, episode, _int(data['year'])),
          kind: kind,
          position: pos,
          duration: dur,
          updated: ru,
          showTitle: showTitle,
          year: _int(data['year']),
          season: season,
          episode: episode,
          torrent: tor,
          image: _cleanUrl('${data['image'] ?? ''}'),
          origin: og is Map ? '${og['name'] ?? ''}' : '',
        ).toJson();
        sp[key] = {'u': ru, 'd': 0};
        changed = true;
        continue;
      }
      newPending[key] = r;
    }
    await Store.writeHistoryRaw(hmap);
    await Store.writeProgressRaw(pmap);
    await Store.setJsonMap('pek_sync_seen', seen);
    await Store.setJsonMap('pek_sync_pending', newPending);
    if (changed) Store.notifyChanged();
    return changed;
  }
}

class _P {
  _P(this.id, this.entry);
  final String id;
  final Progress entry;
}

class _Chunk {
  _Chunk(this.history, this.progress);
  final List<Map<String, dynamic>> history;
  final List<Map<String, dynamic>> progress;
}

class _All {
  _All(this.history, this.progress);
  final List<Map<String, dynamic>> history;
  final List<Map<String, dynamic>> progress;

  bool get isNotEmpty => history.isNotEmpty || progress.isNotEmpty;

  /// Up to [max] items (history first), removed from this list.
  _Chunk take(int max) {
    final h = history.take(max).toList();
    history.removeRange(0, h.length);
    final p = progress.take(max - h.length).toList();
    progress.removeRange(0, p.length);
    return _Chunk(h, p);
  }
}
