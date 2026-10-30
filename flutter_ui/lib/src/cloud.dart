import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'activity.dart';
import 'device_info.dart';

import 'api.dart';
import 'profiles.dart';
import 'store.dart';
import 'layouts.dart' show Layouts;
import 'recs.dart' show Recs;
import 'ratings.dart' show RatingEntry;
import 'skins.dart' show Skins;
import 'weather.dart' show Weather;

/// The answer of one cloud call.
class CloudResult {
  const CloudResult({required this.ok, this.error = '', this.status = 0, this.body = const {}, this.needsVerify = false, this.pending = false, this.pushed = 0, this.changed = false});
  final bool ok;
  final String error; // a short code, see [Cloud.errorText]
  final int status;
  final Map<String, dynamic> body;
  final bool needsVerify; // account made, the emailed code still has to be entered
  final bool pending; // TV link login: not approved on the website yet
  final int pushed;
  final bool changed;
}

/// The household account (email + password) of the PEK Cloud worker (cloud/worker.js) and the
/// two-way sync of watch history and resume points. Each profile syncs its own data under the account.
///
/// Library favorites sync too. The cloud keys favorites by TMDb id (`f|movie:603`), so each favorite is looked up once through
/// the same TMDb worker the backend uses and the id is kept with it. A favorite that comes from another device (or from a plugin
/// in the web UI) shows up here when the same title is in this device's library; otherwise it becomes a plugin favorite
/// (Favorites > Saved from plugins). Favorites a plugin screen saves here already have their TMDb id and sync as they are.
class Cloud {
  static const api = 'https://pek-sync.aquariusibeats.workers.dev';

  static const _kToken = 'pek_account_token';
  static const _kEmail = 'pek_account_email';
  static const _kUser = 'pek_account_username';
  static const _kLastMail = 'pek_profiles_lastmail';
  static const _kPlan = 'pek_plan';
  static const _kPlanOk = 'pek_plan_ok';
  static const _kPlanUntil = 'pek_plan_until';

  /// The website where PEK Cloud is bought (never inside the app).
  static const siteUrl = 'https://pekindustries.com/pektv';
  static const accountPage = '$siteUrl/account';

  /// Where the 6-digit TV code is entered. The QR code on the TV opens it with the code filled in (`?code=123456`).
  static const verifyPage = '$siteUrl/verify';

  /// Accounts are made on the website (an invite code is needed while the cloud is invite-only). "from=app" makes the page
  /// open this app again when the account exists (pektv://account?email=...&username=..., see deep_link.dart).
  static const signUpPage = '$siteUrl/account?signup=1&from=app';

  /// Filled in by that link: shown on the sign-in screen once.
  static String prefillEmail = '';
  static String prefillName = '';

  static const _chunk = 800;
  static const _maxRounds = 20;
  static const _dataBudget = 1900;
  static const _torMaxSource = 900;

  static final http.Client _c = http.Client();

  /// Bumped whenever the signed-in state changes (the screens that show it repaint).
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static bool get linked => _token.isNotEmpty;

  // ---------------------------------------------------------------- plan (PEK Cloud subscription)
  // Free accounts: 1 profile and no cloud backup. PEK Cloud (monthly, yearly or lifetime, bought on the website) unlocks
  // cloud backup and up to 5 profiles. Accounts made before plans existed are 'grandfathered' and have everything.
  static int _planCheckedAt = 0;

  /// 'free', 'grandfathered', 'monthly', 'yearly' or 'lifetime'; empty until the cloud has been asked.
  static String get plan => Store.strGet(_kPlan, scoped: false) ?? '';
  static bool get entitled => linked && Store.strGet(_kPlanOk, scoped: false) == '1';
  /// When a monthly / yearly plan runs out unless it renews (ms since 1970), 0 for the other plans.
  static int get planUntil => int.tryParse(Store.strGet(_kPlanUntil, scoped: false) ?? '') ?? 0;
  static bool get renews => plan == 'monthly' || plan == 'yearly';

  static String get planLabel {
    switch (plan) {
      case 'monthly':
        return 'PEK Cloud (monthly)';
      case 'yearly':
        return 'PEK Cloud (yearly)';
      case 'lifetime':
        return 'PEK Cloud (lifetime)';
      case 'grandfathered':
        return 'PEK Cloud (included with your account)';
      default:
        return 'Free';
    }
  }

  static Future<void> _savePlan(Map<String, dynamic> b) async {
    final p = b['plan'];
    if (p is! String || p.isEmpty) return; // an older cloud service that has no plans yet
    final ok = b['entitled'] == true ? '1' : '0';
    final until = '${(b['until'] as num?)?.toInt() ?? 0}';
    final changed = plan != p || Store.strGet(_kPlanOk, scoped: false) != ok || Store.strGet(_kPlanUntil, scoped: false) != until;
    await Store.strSet(_kPlan, p, scoped: false);
    await Store.strSet(_kPlanOk, ok, scoped: false);
    await Store.strSet(_kPlanUntil, until, scoped: false);
    if (changed) changes.value++;
  }

  /// Asks the cloud which plan this account has (at most once a minute unless [force]). Returns whether cloud backup is unlocked.
  static Future<bool> refreshPlan({bool force = false}) async {
    if (!linked) return false;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!force && now - _planCheckedAt < 60 * 1000) return entitled;
    _planCheckedAt = now;
    try {
      final r = await _request('GET', '/v1/me', withToken: true);
      if (r.status == 200 && r.body['ok'] == true) {
        final u = r.body['username'];
        if (u is String && u.isNotEmpty && u != username) {
          await Store.strSet(_kUser, u, scoped: false); // chosen on the website (older accounts had none)
          changes.value++;
        }
        await _savePlan(r.body);
      } else if (r.status == 404) {
        await _savePlan({'plan': 'grandfathered', 'entitled': true, 'until': 0}); // a cloud service from before plans: nothing is locked
      }
    } catch (_) {}
    return entitled;
  }
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
      case 'expired':
        return 'That code ran out. Here is a new one.';
      case 'already_linked':
        return 'That code was already used.';
      case 'server_busy':
        return 'The PEK cloud is busy. Try again in a minute.';
      case 'unknown_profile':
        return 'That profile was removed on another device.';
      case 'subscription_required':
        return 'Cloud backup is part of PEK Cloud. Subscribe on $siteUrl to turn it on.';
      case 'email_not_verified':
        return 'This account was never confirmed. Create it again on $siteUrl/account to finish.';
      case 'cancel_subscription_first':
        return 'Cancel your subscription on $accountPage first, then delete the account.';
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

  /// A signed-in call to the worker for other modules (plugin backup). Errors come back as a short code in [CloudResult.error]
  /// (the worker's own code when it sent one, e.g. `plugin_quota`; otherwise `session_expired`, `rate_limited`, `offline`, ...).
  static Future<CloudResult> call(String method, String path, [Map<String, dynamic>? body]) async {
    if (!linked) return const CloudResult(ok: false, error: 'not_linked');
    try {
      final r = await _request(method, path, body: body, withToken: true);
      if (r.status == 200 && r.body['ok'] == true) return CloudResult(ok: true, status: 200, body: r.body);
      final e = r.body['error'];
      final code = (e is String && e.isNotEmpty && r.status != 401) ? e : _failure(r.status, r.body);
      if (code == 'session_expired') await _unlink(); // signed out elsewhere or expired: ask to sign in again
      return CloudResult(ok: false, status: r.status, error: code, body: r.body);
    } catch (_) {
      return const CloudResult(ok: false, error: 'offline');
    }
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
    await Store.strDel(_kPlan, scoped: false);
    await Store.strDel(_kPlanOk, scoped: false);
    await Store.strDel(_kPlanUntil, scoped: false);
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
    await _savePlan(res.body);
    await Profiles.afterSignIn(mail, created: created);
    return CloudResult(ok: true, body: res.body);
  }

  /// Finishes a sign-in with the 6-digit code from the email. (Accounts are created on the website, never in the app.)
  static Future<CloudResult> verifyEmail(String mail, String code, {bool created = true}) {
    if (!validEmail(mail)) return Future.value(const CloudResult(ok: false, error: 'bad_email'));
    return _session('/v1/auth/verify', {'email': cleanEmail(mail), 'code': code.replaceAll(RegExp(r'\D'), '')}, created: created);
  }

  static Future<CloudResult> resendCode(String mail) async {
    if (!validEmail(mail)) return const CloudResult(ok: false, error: 'bad_email');
    final r = await _auth('/v1/auth/resend', {'email': cleanEmail(mail), 'device': await DeviceInfo.read()});
    return r.ok ? const CloudResult(ok: true) : r;
  }

  static Future<CloudResult> signIn(String mail, String password) async {
    if (!validEmail(mail) || password.isEmpty) return const CloudResult(ok: false, error: 'bad_credentials');
    // The device goes along so the sign-in email can say which device is signing in, what it is called and when.
    return _session('/v1/auth/login', {'email': cleanEmail(mail), 'password': password, 'device': await DeviceInfo.read()});
  }

  /// TV link login, step 1: asks for a 6-digit code to show on screen. The body has `code`, `poll` (the secret this device
  /// keeps and sends back in [devicePoll]), `expiresIn` and `interval` in seconds.
  static Future<CloudResult> deviceStart() async => _auth('/v1/device/start', {'device': await DeviceInfo.read()});

  /// TV link login, step 2 (repeat every few seconds): ok + [CloudResult.pending] while nobody has approved the code on the
  /// website yet; ok without it once approved, and this device is then signed in. An `expired` error means: ask for a new code.
  static Future<CloudResult> devicePoll(String poll) async {
    final res = await _auth('/v1/device/poll', {'poll': poll});
    if (!res.ok) return res;
    final token = res.body['token'];
    if (res.body['status'] != 'approved' || token is! String || token.isEmpty) return const CloudResult(ok: true, pending: true);
    final mail = '${res.body['email'] ?? ''}'.toLowerCase();
    await _startSession(token, mail, '${res.body['username'] ?? ''}');
    await _savePlan(res.body);
    await Profiles.afterSignIn(mail, created: false);
    return CloudResult(ok: true, body: res.body);
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
    return a.history.length + a.progress.length + a.favorites.length + a.settings.length + a.skins.length + a.ratings.length > 0 || _hasUnresolvedFavorites;
  }

  /// [light] skips the profile round trip (a stop-of-playback sync only needs to push what changed).
  static Future<CloudResult> sync({bool light = false}) {
    final running = _inflight;
    if (running != null) return running;
    if (!linked) return Future.value(const CloudResult(ok: false, error: 'not_linked'));
    Activity.begin('sync', 'Syncing watch history\u2026');
    final f = _syncGuarded(light).catchError((Object _) => const CloudResult(ok: false, error: 'offline')).then((res) async {
      _inflight = null;
      Activity.end('sync', res.ok ? 'Sync complete' : (res.error == 'subscription_required' ? 'Cloud backup is off' : 'Sync failed'));
      if (res.error == 'session_expired') await _unlink(); // signed out elsewhere or expired: ask to sign in again
      return res;
    });
    _inflight = f;
    return f;
  }

  /// Cloud backup is part of PEK Cloud: a free account does not talk to the sync service at all.
  static Future<CloudResult> _syncGuarded(bool light) async {
    if (!entitled && !await refreshPlan()) return const CloudResult(ok: false, error: 'subscription_required');
    final r = await _syncInner(light);
    if (r.error == 'subscription_required') await _savePlan({'plan': 'free', 'entitled': false, 'until': 0}); // it ran out
    return r;
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
      await _resolveFavorites();
      final all = _collectPush();
      final pushed = all.history.length + all.progress.length + all.favorites.length + all.settings.length + all.skins.length + all.ratings.length;
      var anyChange = false;
      CloudResult? fail;
      for (var n = 1; n <= _maxRounds; n++) {
        final chunk = all.take(_chunk);
        final cursor = int.tryParse(Store.strGet('pek_sync_cursor') ?? '') ?? 0;
        final r = await _request('POST', '/v1/sync', body: {'profile': pid, 'since': cursor, 'history': chunk.history, 'progress': chunk.progress, 'favorites': chunk.favorites, 'settings': chunk.settings, 'skins': chunk.skins, 'ratings': chunk.ratings}, withToken: true);
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
        _markPushed(chunk, settingsStored: r.body['settings'] is List, skinsStored: r.body['skins'] is List, ratingsStored: r.body['ratings'] is List); // an older cloud ignores settings, skins and ratings: keep them for later
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

  // ---------------------------------------------------------------- favorites (TMDb ids from the existing TMDb proxy)

  /// The same Cloudflare TMDb worker the C++ backend uses (backend/server.cpp tmdbProxyUrl()). It holds the key.
  static const _tmdb = 'https://hesper-tmdb.aquariusibeats.workers.dev';

  /// null = could not ask (offline); id 0 = TMDb has no match.
  static Future<({int id, String poster})?> _tmdbLookup(bool tv, String title, int year) async {
    try {
      final q = Uri.encodeQueryComponent(title);
      final url = tv ? '$_tmdb/search/tv?query=$q' : '$_tmdb/search/movie?query=$q${year > 0 ? '&year=$year' : ''}';
      final r = await _c.get(Uri.parse(url)).timeout(const Duration(seconds: 12));
      if (r.statusCode != 200) return null;
      final o = jsonDecode(utf8.decode(r.bodyBytes));
      final res = o is Map && o['results'] is List ? (o['results'] as List).whereType<Map>().toList() : <Map>[];
      if (res.isEmpty) return (id: 0, poster: '');
      Map pick = res.first;
      if (!tv && year > 0) {
        for (final m in res) {
          if ('${m['release_date'] ?? ''}'.startsWith('$year')) {
            pick = m;
            break;
          }
        }
      }
      return (id: _int(pick['id']), poster: '${pick['poster_path'] ?? ''}');
    } catch (_) {
      return null;
    }
  }

  static bool get _hasUnresolvedFavorites => Store.favRaw().any((f) => _int(f['tmdb']) == 0);

  /// Gives every favorite a TMDb id (the cloud keys favorites by it) and a change stamp. Runs before a sync.
  static Future<void> _resolveFavorites() async {
    final favs = Store.favRaw();
    final tombs = Store.favTombs();
    final now = DateTime.now().millisecondsSinceEpoch;
    var changed = false;
    var tombsChanged = false;
    for (final f in favs) {
      if (_int(f['updated']) <= 0) {
        f['updated'] = _int(f['added']) > 0 ? _int(f['added']) : now;
        changed = true;
      }
      if (_int(f['tmdb']) != 0) continue;
      final tv = f['kind'] == 'show';
      final hit = await _tmdbLookup(tv, '${f['title'] ?? ''}', _int(f['year']));
      if (hit == null) continue; // try again next time
      f['type'] = tv ? 'tv' : 'movie';
      f['tmdb'] = hit.id > 0 ? hit.id : -1;
      if (hit.poster.isNotEmpty) f['poster'] = hit.poster;
      changed = true;
      // Favorited again after having been removed: the new favorite wins over the old removal.
      final tk = '${f['type']}:${hit.id}';
      if (hit.id > 0 && tombs.containsKey(tk) && _int(tombs[tk]) <= _int(f['updated'])) {
        tombs.remove(tk);
        tombsChanged = true;
      }
    }
    if (changed) await Store.writeFavRaw(favs);
    if (tombsChanged) await Store.writeFavTombs(tombs);
  }

  static String _cleanPoster(String p) => RegExp(r'^/[A-Za-z0-9_-]{5,80}\.(jpg|jpeg|png|webp)$').hasMatch(p) ? p : '';

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
    final favorites = <Map<String, dynamic>>[];
    final sf = seen['f'] is Map ? Map<String, dynamic>.from(seen['f'] as Map) : <String, dynamic>{};
    for (final f in Store.favRaw()) {
      final id = _int(f['tmdb']);
      if (id <= 0) continue;
      final type = '${f['type'] ?? ''}' == 'tv' ? 'tv' : 'movie';
      final key = 'f|$type:$id';
      final updated = _int(f['updated']);
      if (updated <= 0 || _int(sf[key]) == updated) continue;
      final added = _int(f['added']) > 0 ? _int(f['added']) : updated;
      favorites.add({
        'key': key,
        'data': {'key': '$type:$id', 'type': type, 'id': id, 'title': '${f['title'] ?? ''}', 'year': _int(f['year']), 'posterPath': _cleanPoster('${f['poster'] ?? ''}'), 'from': <String>[], 'added': added, 'updated': updated},
        'updated': updated,
        'deleted': 0,
      });
    }
    // Favorites saved by plugin screens: same keys and format as the web UI's plugin favorites (`from` = the plugin).
    final libIds = {for (final f in Store.favRaw()) '${f['type']}:${_int(f['tmdb'])}'};
    for (final f in Store.pluginFavRaw()) {
      final id = _int(f['id']);
      final type = '${f['type'] ?? ''}' == 'tv' ? 'tv' : 'movie';
      if (id <= 0 || libIds.contains('$type:$id')) continue; // a library favorite of the same title already carries it
      final key = 'f|$type:$id';
      final updated = _int(f['updated']) > 0 ? _int(f['updated']) : _int(f['added']);
      if (updated <= 0 || _int(sf[key]) == updated) continue;
      final added = _int(f['added']) > 0 ? _int(f['added']) : updated;
      favorites.add({
        'key': key,
        'data': {'key': '$type:$id', 'type': type, 'id': id, 'title': '${f['title'] ?? ''}', 'year': _int(f['year']), 'posterPath': _cleanPoster('${f['posterPath'] ?? ''}'), 'from': <String>['${f['plugin'] ?? ''}'], 'added': added, 'updated': updated},
        'updated': updated,
        'deleted': 0,
      });
    }
    Store.favTombs().forEach((k, v) {
      final key = 'f|$k';
      final u = _int(v);
      if (u > 0 && _int(sf[key]) != u) favorites.add({'key': key, 'data': <String, dynamic>{}, 'updated': u, 'deleted': 1});
    });
    // Settings that follow the profile (dashboard layout, look = layout + poster size, weather city and unit): items `s|dashboard`,
    // `s|look` and `s|weather`, last writer wins.
    final settings = <Map<String, dynamic>>[];
    final ss = seen['s'] is Map ? Map<String, dynamic>.from(seen['s'] as Map) : <String, dynamic>{};
    final smeta = _trackSettings();
    for (final n in _skeys) {
      final m = smeta[n];
      if (m is! Map || _int(ss[n]) == _int(m['u'])) continue;
      final o = _settingRead(n);
      if (o != null) settings.add({'key': 's|$n', 'data': o, 'updated': _int(m['u']), 'deleted': 0});
    }
    // Skins (made in the Skin maker, or installed from a .zip / GitHub): one item `k|<id>` each, a deleted skin is a removal marker.
    // They follow the profile, so signing in on a new device brings them back.
    final skins = <Map<String, dynamic>>[];
    final sk = seen['k'] is Map ? Map<String, dynamic>.from(seen['k'] as Map) : <String, dynamic>{};
    for (final k in Skins.customSkins) {
      if (!Skins.validId(k.id) || k.updated <= 0) continue;
      final key = 'k|${k.id}';
      if (_int(sk[key]) == k.updated) continue;
      var d = Skins.syncValue(k);
      if (jsonEncode(d).length > _skinBudget) d = {...d, 'desc': '', 'src': null}..removeWhere((_, v) => v == null);
      if (jsonEncode(d).length > _skinBudget) continue;
      skins.add({'key': key, 'data': d, 'updated': k.updated, 'deleted': 0});
    }
    Skins.tombs().forEach((id, u) {
      final key = 'k|$id';
      if (Skins.validId(id) && u > 0 && _int(sk[key]) != u) skins.add({'key': key, 'data': <String, dynamic>{}, 'updated': u, 'deleted': 1});
    });
    // ratings (movies, 1..10; a removal goes up as a deleted marker)
    final ratings = <Map<String, dynamic>>[];
    final sr = seen['r'] is Map ? Map<String, dynamic>.from(seen['r'] as Map) : <String, dynamic>{};
    Store.ratingsRaw().forEach((k, v) {
      if (v is! Map) return;
      final updated = _int(v['updated'] ?? v['at']);
      if (updated <= 0 || _int(sr[k]) == updated) return;
      if (v['deleted'] != null) {
        ratings.add({'key': 'r|$k', 'data': <String, dynamic>{}, 'updated': updated, 'deleted': 1});
      } else {
        final r = _int(v['rating']);
        if (r < 1 || r > 10 || !RegExp(r'^[mes]\|').hasMatch(k)) return;
        ratings.add({
          'key': 'r|$k',
          'data': {'title': '${v['title'] ?? ''}', 'year': _int(v['year']), 'season': _int(v['season']), 'episode': _int(v['episode']), 'rating': r, 'at': _int(v['at'])},
          'updated': updated,
          'deleted': 0,
        });
      }
    });
    return _All(history, progress, favorites, settings, skins, ratings);
  }

  static const _skinBudget = 1900; // the cloud keeps 2000 characters per item

  // ---------------------------------------------------------------- settings

  static const _baseTs = 1; // a value that was on the device before it ever synced: it loses to anything already in the cloud

  static const _skeys = ['dashboard', 'look', 'weather', 'skin'];
  static const _dashBudget = 1900; // same size limit as the web UI's DATA_BUDGET

  /// What this device has now for one setting (null when nothing was ever chosen).
  static Map<String, dynamic>? _settingRead(String n) {
    switch (n) {
      case 'dashboard':
        return Store.dashboardChosen || Recs.touched ? _dashValue(Store.dashboardItems()) : null;
      case 'look':
        return Layouts.syncValue();
      case 'skin':
        final id = Store.strGet('pek_skin');
        return id == null || id.isEmpty ? null : {'id': id};
      default:
        return Weather.syncValue();
    }
  }

  /// The dashboard setting: the widget list, plus the Recommended widget's picks (`recs`: genres, "not interested", offered).
  /// [recs] is what came from the cloud; without it the picks on this device go up.
  static Map<String, dynamic> _dashValue(List<DashItem> items, {Map<String, dynamic>? recs, bool localRecs = true}) {
    final l = [for (final w in items) w.toJson()];
    final r = localRecs ? Recs.syncValue() : recs;
    Map<String, dynamic> value() => {'list': l, if (r != null) 'recs': r};
    while (l.isNotEmpty && jsonEncode(value()).length > _dashBudget) {
      l.removeLast();
    }
    return value();
  }

  /// Checks a value that came from the cloud. Null when nothing in it is usable.
  static Map<String, dynamic>? _settingClean(String n, dynamic o) {
    switch (n) {
      case 'dashboard':
        return o is Map && o['list'] is List ? _dashValue(Store.cleanDashboard(o['list']), recs: Recs.cleanSync(o['recs']), localRecs: false) : null;
      case 'look':
        return Layouts.cleanSync(o);
      case 'skin':
        // a built-in skin, or one of the profile's own skins (it arrives in the same sync; until then the app shows PEK Ember)
        final id = o is Map ? '${o['id'] ?? ''}' : '';
        return Skins.builtIn.any((s) => s.id == id) || Skins.validId(id) ? {'id': id} : null;
      default:
        return Weather.cleanSync(o);
    }
  }

  /// Puts a cleaned value from the cloud on this device.
  static void _settingWrite(String n, Map<String, dynamic> o) {
    switch (n) {
      case 'dashboard':
        unawaited(Store.applyDashboardFromCloud(Store.cleanDashboard(o['list'])));
        unawaited(Recs.applySynced(o['recs']));
      case 'look':
        Layouts.applySynced(o);
      case 'skin':
        unawaited(Skins.set('${o['id']}'));
      default:
        Weather.applySynced(o);
    }
  }

  /// Notices a change made on this device since the last look and stamps it with the time it was noticed.
  static Map<String, dynamic> _trackSettings() {
    final meta = Store.jsonMap('pek_sync_setmeta');
    var changed = false;
    final now = DateTime.now().millisecondsSinceEpoch;
    for (final n in _skeys) {
      final o = _settingRead(n);
      final cur = o == null ? '' : jsonEncode(o);
      if (cur.isEmpty) continue; // nothing chosen on this device: nothing to sync
      final m = meta[n];
      if (m is! Map || m['v'] is! String) {
        meta[n] = {'v': cur, 'u': _baseTs};
        changed = true;
      } else if (m['v'] != cur) {
        meta[n] = {'v': cur, 'u': now};
        changed = true;
      }
    }
    if (changed) unawaited(Store.setJsonMap('pek_sync_setmeta', meta));
    return meta;
  }

  static void _markPushed(_Chunk chunk, {bool settingsStored = false, bool skinsStored = false, bool ratingsStored = false}) {
    final seen = _seen();
    final sh = seen['h'] as Map<String, dynamic>;
    final sp = seen['p'] as Map<String, dynamic>;
    for (final it in chunk.history) {
      sh['${it['key']}'] = it['updated'];
    }
    for (final it in chunk.progress) {
      sp['${it['key']}'] = {'u': it['updated'], 'd': it['deleted'] == 1 ? 1 : 0};
    }
    final sf = seen['f'] is Map ? Map<String, dynamic>.from(seen['f'] as Map) : <String, dynamic>{};
    for (final it in chunk.favorites) {
      sf['${it['key']}'] = it['updated'];
    }
    seen['f'] = sf;
    if (ratingsStored) {
      final sr = seen['r'] is Map ? Map<String, dynamic>.from(seen['r'] as Map) : <String, dynamic>{};
      for (final it in chunk.ratings) {
        sr['${it['key']}'.substring(2)] = it['updated'];
      }
      seen['r'] = sr;
    }
    if (skinsStored) {
      final sk = seen['k'] is Map ? Map<String, dynamic>.from(seen['k'] as Map) : <String, dynamic>{};
      for (final it in chunk.skins) {
        sk['${it['key']}'] = it['updated'];
      }
      seen['k'] = sk;
    }
    if (settingsStored) {
      final ss = seen['s'] is Map ? Map<String, dynamic>.from(seen['s'] as Map) : <String, dynamic>{};
      for (final it in chunk.settings) {
        ss['${it['key']}'.substring(2)] = it['updated'];
      }
      seen['s'] = ss;
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

  /// A favorite entry for a title that is in this device's library, or null.
  static Future<Map<String, dynamic>?> _libraryFavorite(bool tv, String title, int year) async {
    final t = Store.normalize(title);
    if (t.isEmpty) return null;
    try {
      if (tv) {
        _shows ??= await Api.shows();
        final s = _shows!.where((s) => Store.normalize(s.title) == t).firstOrNull;
        return s == null ? null : {'kind': 'show', 'key': 's:${s.title}', 'title': s.title, 'year': 0};
      }
      _movies ??= await Api.movies();
      final m = _movies!.where((m) => Store.normalize(m.title) == t && (year == 0 || m.year == 0 || m.year == year)).firstOrNull;
      return m == null ? null : {'kind': 'movie', 'key': 'm:${m.id}', 'title': m.title, 'year': m.year};
    } catch (_) {
      return null;
    }
  }

  static Future<bool> _applyRemote(Map<String, dynamic> resp) async {
    final pending = Store.jsonMap('pek_sync_pending');
    List<Map<String, dynamic>> listOf(dynamic v) => v is List ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList() : <Map<String, dynamic>>[];
    final remoteH = listOf(resp['history']);
    final remoteP = listOf(resp['progress']);
    pending.forEach((k, v) {
      if (v is Map && !remoteP.any((r) => r['key'] == k)) remoteP.add(Map<String, dynamic>.from(v));
    });

    final remoteF = listOf(resp['favorites']);
    final pendingF = Store.jsonMap('pek_sync_pendingf');
    pendingF.forEach((k, v) {
      if (v is Map && !remoteF.any((r) => r['key'] == k)) remoteF.add(Map<String, dynamic>.from(v));
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

    // ... and for favorites that came from the cloud (TMDb id + title) but are not in this device's favorites yet
    final haveFavs = Store.favRaw();
    final resolvedF = <String, Map<String, dynamic>>{};
    for (final r in remoteF) {
      if (_truthy(r['deleted'])) continue;
      final key = '${r['key']}';
      final m = RegExp(r'^f\|(movie|tv):(\d+)$').firstMatch(key);
      if (m == null) continue;
      if (haveFavs.any((f) => _int(f['tmdb']) == int.parse(m.group(2)!) && '${f['type']}' == m.group(1))) continue;
      if (Store.pluginFavRaw().any((f) => _int(f['id']) == int.parse(m.group(2)!) && '${f['type']}' == m.group(1))) continue;
      final d = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
      final lib = await _libraryFavorite(m.group(1) == 'tv', '${d['title'] ?? ''}', _int(d['year']));
      if (lib != null) resolvedF[key] = lib;
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
    // favorites: the newest change per title wins; a title this library does not have stays pending
    final favs = Store.favRaw();
    final pfavs = Store.pluginFavRaw();
    var pluginFavChanged = false;
    final tombs = Store.favTombs();
    final sf = seen['f'] is Map ? Map<String, dynamic>.from(seen['f'] as Map) : <String, dynamic>{};
    final newPendingF = <String, dynamic>{};
    var favChanged = false;
    var tombChanged = false;
    for (final r in remoteF) {
      final key = '${r['key']}';
      final m = RegExp(r'^f\|(movie|tv):(\d+)$').firstMatch(key);
      if (m == null) continue;
      final type = m.group(1)!;
      final id = int.parse(m.group(2)!);
      final ru = _int(r['updated']);
      final tk = '$type:$id';
      final idx = favs.indexWhere((f) => _int(f['tmdb']) == id && '${f['type']}' == type);
      final pidx = pfavs.indexWhere((f) => _int(f['id']) == id && '${f['type']}' == type);
      if (_truthy(r['deleted'])) {
        if (pidx >= 0 && _int(pfavs[pidx]['updated']) <= ru) {
          pfavs.removeAt(pidx); // removed on another device after we saved it
          pluginFavChanged = true;
        }
        if (idx >= 0) {
          if (_int(favs[idx]['updated']) > ru) continue; // favorited again here: ours wins
          favs.removeAt(idx);
          favChanged = true;
        } else if (tombs[tk] != null && _int(tombs[tk]) <= ru) {
          tombs.remove(tk);
          tombChanged = true;
        }
        sf[key] = ru;
        continue;
      }
      if (idx >= 0) {
        final lu = _int(favs[idx]['updated']);
        if (ru > lu) {
          favs[idx]['updated'] = ru;
          sf[key] = ru;
          favChanged = true;
        } else if (ru == lu) {
          sf[key] = ru;
        }
        continue;
      }
      if (pidx >= 0) {
        final lu = _int(pfavs[pidx]['updated']);
        if (ru > lu) {
          pfavs[pidx]['updated'] = ru;
          sf[key] = ru;
          pluginFavChanged = true;
        } else if (ru == lu) {
          sf[key] = ru;
        }
        continue;
      }
      if (tombs[tk] != null && _int(tombs[tk]) >= ru) continue; // removed here after that
      final lib = resolvedF[key];
      if (lib != null) {
        final d = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
        final poster = _cleanPoster('${d['posterPath'] ?? ''}');
        favs.insert(0, {...lib, 'tmdb': id, 'type': type, if (poster.isNotEmpty) 'poster': poster, 'added': _int(d['added']) > 0 ? _int(d['added']) : ru, 'updated': ru});
        sf[key] = ru;
        favChanged = true;
      } else {
        // Not a title of this library: keep it as a plugin favorite (the web UI's plugin favorites arrive this way too).
        final d = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
        final title = '${d['title'] ?? ''}';
        if (title.isEmpty) {
          newPendingF[key] = r;
        } else {
          final from = d['from'] is List && (d['from'] as List).isNotEmpty ? '${(d['from'] as List).first}' : '';
          pfavs.insert(0, {
            'key': tk,
            'type': type,
            'id': id,
            'title': title,
            'year': _int(d['year']),
            'posterPath': _cleanPoster('${d['posterPath'] ?? ''}'),
            'plugin': from.isEmpty ? 'tmdb-discover' : from,
            'added': _int(d['added']) > 0 ? _int(d['added']) : ru,
            'updated': ru,
          });
          sf[key] = ru;
          pluginFavChanged = true;
        }
      }
    }
    seen['f'] = sf;
    if (favChanged) {
      await Store.writeFavRaw(favs);
      changed = true;
    }
    if (pluginFavChanged) {
      await Store.writePluginFavRaw(pfavs);
      changed = true;
    }
    if (tombChanged) await Store.writeFavTombs(tombs);
    await Store.setJsonMap('pek_sync_pendingf', newPendingF);

    // ratings: last writer wins per movie, by the rating's own "updated" time
    final remoteR = resp['ratings'];
    if (remoteR is List) {
      final rmap = Store.ratingsRaw();
      final sr = seen['r'] is Map ? Map<String, dynamic>.from(seen['r'] as Map) : <String, dynamic>{};
      var ratingsChanged = false;
      for (final r in listOf(remoteR)) {
        final rkey = '${r['key']}';
        if (!RegExp(r'^r\|[mes]\|').hasMatch(rkey)) continue;
        final key = rkey.substring(2);
        final ru = _int(r['updated']);
        final localR = rmap[key];
        final lu = localR is Map ? _int(localR['updated'] ?? localR['at']) : 0;
        if (localR != null && lu > ru) continue; // ours is newer; it gets pushed
        if (localR == null || lu < ru) {
          if (_truthy(r['deleted'])) {
            rmap[key] = {'deleted': 1, 'updated': ru};
          } else {
            final d = r['data'] is Map ? Map<String, dynamic>.from(r['data'] as Map) : <String, dynamic>{};
            final stars = _int(d['rating']);
            if (stars < 1 || stars > 10) continue;
            rmap[key] = {'key': key, 'kind': RatingEntry.kindOfKey(key), 'title': '${d['title'] ?? ''}', 'year': _int(d['year']), 'season': _int(d['season']), 'episode': _int(d['episode']), 'rating': stars, 'at': _int(d['at']) > 0 ? _int(d['at']) : ru, 'updated': ru};
          }
          ratingsChanged = true;
        }
        sr[key] = ru;
      }
      seen['r'] = sr;
      if (ratingsChanged) {
        await Store.writeRatingsRaw(rmap);
        changed = true;
      }
    }

    // skins: this profile's skins from the cloud (before the settings, so the chosen skin can be one of them)
    final remoteK = resp['skins'];
    if (remoteK is List) {
      final res = await Skins.applyCloud(listOf(remoteK));
      if (res.changed) changed = true;
      final sk = seen['k'] is Map ? Map<String, dynamic>.from(seen['k'] as Map) : <String, dynamic>{};
      res.inSync.forEach((k, u) => sk[k] = u);
      seen['k'] = sk;
    }

    // settings: the cloud's dashboard / look / weather / skin, unless this device changed it more recently
    final remoteS = resp['settings'];
    if (remoteS is List) {
      final ss = seen['s'] is Map ? Map<String, dynamic>.from(seen['s'] as Map) : <String, dynamic>{};
      final smeta = _trackSettings(); // a change made while the request was in flight counts as newer than the cloud's copy
      for (final r in listOf(remoteS)) {
        final key = '${r['key']}';
        if (!key.startsWith('s|') || _truthy(r['deleted'])) continue;
        final n = key.substring(2);
        if (!_skeys.contains(n)) continue;
        final sm = smeta[n];
        final mine = sm is Map ? _int(sm['u']) : 0;
        final ru = _int(r['updated']);
        if (ru < mine) continue; // ours is newer; it gets pushed
        if (ru == mine) {
          ss[n] = ru;
          continue;
        }
        final clean = _settingClean(n, r['data']);
        if (clean == null) continue;
        _settingWrite(n, clean);
        final now2 = _settingRead(n);
        if (now2 == null) continue;
        smeta[n] = {'v': jsonEncode(now2), 'u': ru};
        ss[n] = ru;
        changed = true;
      }
      seen['s'] = ss;
      await Store.setJsonMap('pek_sync_setmeta', smeta);
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
  _Chunk(this.history, this.progress, this.favorites, this.settings, this.skins, this.ratings);
  final List<Map<String, dynamic>> history;
  final List<Map<String, dynamic>> progress;
  final List<Map<String, dynamic>> favorites;
  final List<Map<String, dynamic>> settings;
  final List<Map<String, dynamic>> skins;
  final List<Map<String, dynamic>> ratings;
}

class _All {
  _All(this.history, this.progress, this.favorites, this.settings, this.skins, this.ratings);
  final List<Map<String, dynamic>> history;
  final List<Map<String, dynamic>> progress;
  final List<Map<String, dynamic>> favorites;
  final List<Map<String, dynamic>> settings;
  final List<Map<String, dynamic>> skins;
  final List<Map<String, dynamic>> ratings;

  bool get isNotEmpty => history.isNotEmpty || progress.isNotEmpty || favorites.isNotEmpty || settings.isNotEmpty || skins.isNotEmpty || ratings.isNotEmpty;

  /// Up to [max] items (history first), removed from this list.
  _Chunk take(int max) {
    final h = history.take(max).toList();
    history.removeRange(0, h.length);
    final p = progress.take(max - h.length).toList();
    progress.removeRange(0, p.length);
    final f = favorites.take(max - h.length - p.length).toList();
    favorites.removeRange(0, f.length);
    final s = settings.take(max - h.length - p.length - f.length).toList();
    settings.removeRange(0, s.length);
    final k = skins.take(max - h.length - p.length - f.length - s.length).toList();
    skins.removeRange(0, k.length);
    final r = ratings.take(max - h.length - p.length - f.length - s.length - k.length).toList();
    ratings.removeRange(0, r.length);
    return _Chunk(h, p, f, s, k, r);
  }
}
