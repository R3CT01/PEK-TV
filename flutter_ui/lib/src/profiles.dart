import 'dart:convert';
import 'dart:typed_data';
import 'dart:math' as math;

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'cloud.dart';
import 'store.dart';

/// One person of the household. Same fields as www/profiles.js so the profile list syncs with the web UI's.
class Profile {
  Profile({required this.id, required this.name, required this.color, this.updated = 0, this.avatar = '', this.pin = ''});
  String id;
  String name;
  String color; // "#RRGGBB"
  int updated;
  String avatar; // '' | 'b:<built-in>' | 'd:data:image/jpeg;base64,...'
  String pin; // '' | '<16 hex salt>:<64 hex hash>'

  bool get locked => pin.isNotEmpty;
  Color get colorValue => Profiles.parseColor(color);

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'color': color, 'updated': updated, 'avatar': avatar, 'pin': pin};
}

/// Netflix-style profiles: each person has their own favorites, watch history, resume points and skip settings (see [Store]).
/// Plugins, the library and the server are shared. Like the web UI, profiles are an account feature: the picker only
/// appears while a cloud account is signed in; signed out the app just runs as the active profile.
class Profiles {
  static const max = 5;
  static const nameMax = 20;
  static const colors = ['#E04A00', '#C2185B', '#7B1FA2', '#3949AB', '#0277BD', '#00897B', '#689F38', '#F9A825'];

  /// The built-in pictures (the web UI draws small SVGs; here they are emoji on the profile's colour).
  static const builtIn = <String, String>{
    'smile': '\u{1F600}',
    'cool': '\u{1F60E}',
    'cat': '\u{1F431}',
    'dog': '\u{1F436}',
    'bear': '\u{1F43B}',
    'panda': '\u{1F43C}',
    'robot': '\u{1F916}',
    'alien': '\u{1F47D}',
    'ghost': '\u{1F47B}',
    'owl': '\u{1F989}',
    'fox': '\u{1F98A}',
    'star': '\u{2B50}',
  };

  static const _kReg = 'pek_profiles_v1';
  static const _avMax = 12000;
  static const _pinRounds = 3000;

  static final ValueNotifier<int> changes = ValueNotifier(0);

  static List<Profile> _list = [];
  static Map<String, int> _tombs = {};
  static String _active = 'p1';
  static bool setupDone = false;

  /// A profile was picked in this run of the app (the picker is shown once per run).
  static bool pickedThisSession = false;

  // ---------------------------------------------------------------- loading / saving

  static Profile _first() => Profile(id: 'p1', name: 'Profile 1', color: colors[0]);

  static void load() {
    _list = [];
    _tombs = {};
    _active = 'p1';
    setupDone = false;
    try {
      final o = jsonDecode(Store.strGet(_kReg, scoped: false) ?? 'null');
      if (o is Map) {
        for (final e in (o['list'] as List? ?? const [])) {
          if (e is! Map) continue;
          final id = '${e['id'] ?? ''}';
          if (id.isEmpty) continue;
          _list.add(Profile(
            id: id,
            name: _cleanName('${e['name'] ?? ''}').isEmpty ? 'Profile' : _cleanName('${e['name']}'),
            color: _okColor('${e['color'] ?? ''}') ? '${e['color']}' : colors[0],
            updated: (e['updated'] as num?)?.toInt() ?? 0,
            avatar: okAvatar('${e['avatar'] ?? ''}') ? '${e['avatar'] ?? ''}' : '',
            pin: okPin('${e['pin'] ?? ''}') ? '${e['pin'] ?? ''}' : '',
          ));
        }
        final t = o['tombs'];
        if (t is Map) t.forEach((k, v) => _tombs['$k'] = (v as num?)?.toInt() ?? 0);
        _active = '${o['active'] ?? 'p1'}';
        setupDone = o['setupDone'] == true;
      }
    } catch (_) {}
    if (_list.isEmpty) {
      _list = [_first()];
      _active = 'p1';
    }
    if (!_list.any((p) => p.id == _active)) _active = _list.first.id;
    // Anyone who already has several profiles, a custom name, a picture or a passcode has effectively done the first-time setup.
    if (!setupDone && (_list.length > 1 || _list.any((p) => p.avatar.isNotEmpty || p.pin.isNotEmpty || p.name != 'Profile 1'))) setupDone = true;
    Store.setProfile(_active);
  }

  /// The signed-out / signed-in state changed: read everything again.
  static void reload() {
    pickedThisSession = false;
    load();
    changes.value++;
  }

  static void _save() {
    Store.strSet(
        _kReg,
        jsonEncode({
          'v': 3,
          'active': _active,
          'list': _list.map((p) => p.toJson()).toList(),
          'tombs': _tombs,
          'setupDone': setupDone,
        }),
        scoped: false);
    changes.value++;
  }

  // ---------------------------------------------------------------- reading

  static List<Profile> get list => List.unmodifiable(_list);
  static Iterable<String> get ids => _list.map((p) => p.id).toList();
  static String get currentId => _active;
  static Profile get current => _list.firstWhere((p) => p.id == _active, orElse: () => _list.first);
  static bool get canAdd => _list.length < max;

  /// The first-time screen (name + picture) comes before anything else for an account whose main profile was never set up.
  static bool get needsSetup => Cloud.linked && !setupDone;

  /// With an account every run of the app starts on "Who's watching?" until a profile is picked.
  static bool get gateNeeded => Cloud.linked && (needsSetup || !pickedThisSession);

  // ---------------------------------------------------------------- helpers

  static String _cleanName(String s) {
    final t = s.replaceAll(RegExp(r'\s+'), ' ').trim();
    return t.length > nameMax ? t.substring(0, nameMax) : t;
  }

  static String cleanName(String s) => _cleanName(s);

  static bool nameTaken(String name, {String? exceptId}) {
    final n = name.toLowerCase();
    return _list.any((p) => p.id != exceptId && p.name.toLowerCase() == n);
  }

  static bool _okColor(String c) => RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(c);

  static Color parseColor(String c) {
    if (!_okColor(c)) return const Color(0xFFE04A00);
    return Color(0xFF000000 | int.parse(c.substring(1), radix: 16));
  }

  static String nextColor() {
    for (final c in colors) {
      if (!_list.any((p) => p.color == c)) return c;
    }
    return colors[_list.length % colors.length];
  }

  static bool okAvatar(String a) {
    if (a.isEmpty) return true;
    if (a.length > _avMax + 4) return false;
    if (a.startsWith('b:')) return builtIn.containsKey(a.substring(2));
    return RegExp(r'^d:data:image/jpeg;base64,[A-Za-z0-9+/=]+$').hasMatch(a);
  }

  /// The picture bytes of a custom photo avatar, or null.
  static Uint8List? photoBytes(String a) {
    if (!a.startsWith('d:data:image/jpeg;base64,') || !okAvatar(a)) return null;
    try {
      return base64Decode(a.substring('d:data:image/jpeg;base64,'.length));
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------- passcode (the same hash as profiles.js, so it syncs)

  static String _sha(String s) => sha256.convert(utf8.encode(s)).toString();

  static String _digest(String pin, String salt) {
    var h = _sha('$salt:$pin');
    for (var i = 0; i < _pinRounds; i++) {
      h = _sha('$h$salt$pin');
    }
    return h;
  }

  static bool okPin(String v) => v.isEmpty || RegExp(r'^[0-9a-f]{16}:[0-9a-f]{64}$').hasMatch(v);

  static String makePin(String pin) {
    final r = math.Random.secure();
    final salt = List.generate(8, (_) => r.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
    return '$salt:${_digest(pin, salt)}';
  }

  static bool checkPin(String stored, String pin) {
    final i = stored.indexOf(':');
    if (i < 0) return false;
    return _digest(pin, stored.substring(0, i)) == stored.substring(i + 1);
  }

  // ---------------------------------------------------------------- operations

  static String _newId() => 'p${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${math.Random().nextInt(1296).toRadixString(36)}';

  static Profile? add(String name, {String? color, String avatar = '', String pin = ''}) {
    if (!canAdd) return null;
    final p = Profile(
      id: _newId(),
      name: _cleanName(name),
      color: color ?? nextColor(),
      updated: DateTime.now().millisecondsSinceEpoch,
      avatar: okAvatar(avatar) ? avatar : '',
      pin: okPin(pin) ? pin : '',
    );
    _list.add(p);
    _save();
    return p;
  }

  static void update(String id, {required String name, String? color, String? avatar, String? pin}) {
    for (final p in _list) {
      if (p.id != id) continue;
      p.name = _cleanName(name);
      if (color != null && _okColor(color)) p.color = color;
      p.updated = DateTime.now().millisecondsSinceEpoch;
      if (avatar != null && okAvatar(avatar)) p.avatar = avatar;
      if (pin != null && okPin(pin)) p.pin = pin;
    }
    _save();
  }

  /// The first-time setup: turns the existing local profile into the main one.
  static void finishSetup(String name, String color, String avatar) {
    update('p1', name: name, color: color, avatar: avatar);
    setupDone = true;
    _save();
  }

  static Future<bool> remove(String id) async {
    if (_list.length < 2) return false;
    await Store.removeProfileData(id, keepFavorites: false);
    _list.removeWhere((p) => p.id == id);
    _tombs[id] = DateTime.now().millisecondsSinceEpoch; // so the removal reaches the cloud and the other devices
    if (_active == id) {
      _active = _list.first.id;
      Store.setProfile(_active);
    }
    _save();
    return true;
  }

  static void enter(String id) {
    if (!_list.any((p) => p.id == id)) return;
    _active = id;
    pickedThisSession = true;
    Store.setProfile(id);
    _save();
  }

  /// Back to "Who's watching?".
  static void openPicker() {
    pickedThisSession = false;
    changes.value++;
  }

  // ---------------------------------------------------------------- for the cloud

  /// The list as the cloud wants it: live profiles plus removal markers.
  static List<Map<String, dynamic>> syncPayload() => [
        for (final p in _list) {'id': p.id, 'name': p.name, 'color': p.color, 'updated': p.updated, 'deleted': 0, 'avatar': p.avatar, 'pin': p.pin},
        for (final e in _tombs.entries) {'id': e.key, 'name': '', 'color': '', 'updated': e.value, 'deleted': 1},
      ];

  /// The cloud's list (live and removed). The newest change wins per profile. A profile in use is never deleted under the running app.
  static bool mergeRemote(List<Map<String, dynamic>> remote) {
    var changed = false;
    for (final r in remote) {
      final id = r['id'];
      if (id is! String) continue;
      final ru = (r['updated'] as num?)?.toInt() ?? 0;
      final local = _list.where((p) => p.id == id).firstOrNull;
      final tomb = _tombs[id];
      final deleted = r['deleted'] == true || (r['deleted'] is num && r['deleted'] != 0);
      if (deleted) {
        if (tomb != null && ru >= tomb) {
          _tombs.remove(id); // the cloud has our removal
          changed = true;
        }
        if (local != null && local.updated <= ru && id != _active && _list.length > 1) {
          _list.removeWhere((p) => p.id == id);
          Store.removeProfileData(id, keepFavorites: false);
          changed = true;
        }
        continue;
      }
      if (tomb != null && tomb >= ru) continue; // we removed it after that: our removal gets pushed
      final name = _cleanName('${r['name'] ?? ''}');
      final color = '${r['color'] ?? ''}';
      final avatar = '${r['avatar'] ?? ''}';
      final pin = '${r['pin'] ?? ''}';
      if (local == null) {
        if (_list.length < max) {
          _list.add(Profile(id: id, name: name.isEmpty ? 'Profile' : name, color: _okColor(color) ? color : nextColor(), updated: ru, avatar: okAvatar(avatar) ? avatar : '', pin: okPin(pin) ? pin : ''));
          changed = true;
        }
      } else if (local.updated < ru) {
        if (name.isNotEmpty) local.name = name;
        if (_okColor(color)) local.color = color;
        local.updated = ru;
        // An older cloud service sends no avatar / passcode: then keep ours. An empty string means "none".
        if (r['avatar'] is String && okAvatar(avatar)) local.avatar = avatar;
        if (r['pin'] is String && okPin(pin)) local.pin = pin;
        changed = true;
      }
    }
    if (changed) _save();
    return changed;
  }

  /// The active profile was removed elsewhere but is still in use here: keep it (a newer "updated" wins in the cloud).
  static void touch(String id) {
    for (final p in _list) {
      if (p.id == id) p.updated = DateTime.now().millisecondsSinceEpoch;
    }
    _tombs.remove(id);
    _save();
  }

  /// A sign-in finished. A brand-new account keeps what is on the device (it becomes the main profile); signing back in to
  /// the same account merges; any other account replaces the device's profiles with its own (they download right after).
  static Future<void> afterSignIn(String mail, {required bool created}) async {
    final same = mail.isNotEmpty && Cloud.lastMail == mail;
    if (mail.isNotEmpty) await Cloud.rememberMail(mail);
    pickedThisSession = false;
    if (created || same) {
      changes.value++;
      return;
    }
    final remote = await Cloud.peekProfiles() ?? <Map<String, dynamic>>[];
    final live = remote.where((r) => r['id'] is String && !(r['deleted'] == true || (r['deleted'] is num && r['deleted'] != 0)) && _cleanName('${r['name'] ?? ''}').isNotEmpty).take(max).toList();
    for (final id in ids.toList()) {
      await Store.removeProfileData(id, keepFavorites: true);
    }
    await Store.removeProfileData('p1', keepFavorites: true);
    if (live.isNotEmpty) {
      _list = [
        for (final r in live)
          Profile(
            id: '${r['id']}',
            name: _cleanName('${r['name']}'),
            color: _okColor('${r['color'] ?? ''}') ? '${r['color']}' : nextColor(),
            updated: (r['updated'] as num?)?.toInt() ?? 0,
            avatar: okAvatar('${r['avatar'] ?? ''}') ? '${r['avatar'] ?? ''}' : '',
            pin: okPin('${r['pin'] ?? ''}') ? '${r['pin'] ?? ''}' : '',
          ),
      ];
      setupDone = true;
    } else {
      _list = [_first()]; // an account with nothing named yet
      setupDone = false;
    }
    _tombs = {};
    _active = _list.first.id;
    Store.setProfile(_active);
    _save();
  }
}
