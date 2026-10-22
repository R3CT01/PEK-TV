import 'dart:convert';
import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/foundation.dart' show ValueNotifier;
import 'package:flutter/services.dart';

import 'api.dart';
import 'skins.dart';
import 'store.dart';

/// The Dart end of the plugin bridge (see FLUTTER_PLUGINS.md).
///
/// A plugin's screen is Python (plugins/<id>/screen.py). It runs inside the app through Chaquopy, under the same
/// guard as backend.py, and answers with a small JSON tree of widgets. This class only moves JSON:
///
///   Dart --'pek/plugins' channel--> FlutterHostActivity.kt --> python/pek_flutter.py --> screen.py
///
/// Nothing a plugin sends is code: the tree is data that plugin_ui.dart draws with the app's own widgets, and the
/// "effects" it can ask for are a short fixed list (open an https link, save a favorite, show a message).
class PluginHost {
  static const _channel = MethodChannel('pek/plugins');

  /// Bumped after a plugin is installed, updated or removed: the menu and the Plugins page reload their lists from it.
  static final ValueNotifier<int> changed = ValueNotifier(0);

  /// Installed plugins that have a Python screen and can play a title ("provides": {"stream": true}); null until loaded.
  static List<Map<String, String>>? streamers;

  static Future<void> refreshStreamers() async {
    try {
      final all = await Api.plugins();
      streamers = [for (final p in all) if (p.flutterScreen && p.streamer) {'id': p.folder, 'name': p.name}];
    } catch (_) {
      streamers ??= const [];
    }
  }

  /// What the plugin is told on every call (pek_ui.ctx() in Python): the device language and region, whether this
  /// is a TV, the keys of the favorites plugins have saved ("movie:603"), the plugins it may hand a title to and the
  /// Watch History keys (Python only sees them through is_watched() / streamers(), which check its permissions).
  static Map<String, dynamic> context({required bool isTv}) {
    final loc = PlatformDispatcher.instance.locale;
    final cc = (loc.countryCode ?? '').toUpperCase();
    return {
      'lang': cc.isEmpty ? loc.languageCode : '${loc.languageCode}-$cc',
      'region': cc.isEmpty ? 'US' : cc,
      'tv': isTv,
      'favorites': Store.pluginFavoriteKeys(),
      'streamers': streamers ?? const <Map<String, String>>[],
      'watched': Store.history().take(4000).map((e) => e.key).toList(),
      // The skins on this device. Python only hands them out through pek_ui.skins(), which needs the official "skins" permission.
      'skins': [
        for (final s in Skins.all)
          {'id': s.id, 'name': s.name, 'description': s.description, 'author': s.author, 'custom': s.custom && !s.installed, 'current': s.id == Skins.currentId, 'tokens': SkinJson.tokensToHex(s.tokens)},
      ],
    };
  }

  static Future<Map<String, dynamic>> _call(Map<String, dynamic> req) async {
    try {
      final s = await _channel.invokeMethod<String>('call', jsonEncode(req));
      final j = jsonDecode(s ?? '{}');
      return j is Map ? Map<String, dynamic>.from(j) : {'ok': false, 'error': 'The plugin gave a wrong answer.'};
    } on PlatformException catch (e) {
      return {'ok': false, 'error': e.message ?? 'The plugin could not be reached.'};
    } on MissingPluginException {
      return {'ok': false, 'error': 'Plugin screens run inside the Android app.'};
    } catch (e) {
      return {'ok': false, 'error': '$e'};
    }
  }

  /// Opens (or re-opens) the plugin's screen and returns its first tree. [launch] is a title to open it on
  /// ({type, id, title, year}), like the web UI's pek.onLaunch.
  static Future<Map<String, dynamic>> open(String id, {required Map<String, dynamic> ctx, Map<String, dynamic>? launch, bool fresh = false}) =>
      _call({'op': 'open', 'id': id, 'ctx': ctx, if (launch != null) 'launch': launch, if (fresh) 'fresh': true});

  /// A tap. [inputs] is the text of every text box on the screen, so the plugin sees what was typed first.
  static Future<Map<String, dynamic>> event(String id, String handler, {required Map<String, dynamic> ctx, Object? value, Map<String, String> inputs = const {}}) =>
      _call({'op': 'event', 'id': id, 'handler': handler, 'ctx': ctx, if (value != null) 'value': value, 'inputs': inputs});

  /// Asks whether background work (a fetch) changed the screen since version [since].
  static Future<Map<String, dynamic>> poll(String id, int since, {required Map<String, dynamic> ctx}) =>
      _call({'op': 'poll', 'id': id, 'since': since, 'ctx': ctx});

  static Future<void> close(String id) => _call({'op': 'close', 'id': id});

  /// A streaming app (the first installed of [packages], a comma list), on the title's page when it supports the link,
  /// else the app, else [url] in the browser. The activity only opens packages from its allow-list.
  static Future<bool> openApp(String packages, String url) async {
    if (!url.startsWith('https://')) return false;
    try {
      return (await _channel.invokeMethod<bool>('openApp', {'packages': packages, 'url': url})) ?? false;
    } catch (_) {
      return false;
    }
  }

  /// An https link in the YouTube app or the browser. Returns false when nothing could open it.
  static Future<bool> openUrl(String url) async {
    if (!url.startsWith('https://')) return false;
    try {
      return (await _channel.invokeMethod<bool>('openUrl', url)) ?? false;
    } catch (_) {
      return false;
    }
  }
}

/// plugin.json's `permissions.network` decides which hosts a plugin's pictures may load from (the same rule as
/// ui.posterCard in the web UI). `*.example.com` matches subdomains.
class PluginHosts {
  static bool allows(List<String> patterns, String url) {
    final u = Uri.tryParse(url);
    if (u == null || u.scheme != 'https' || u.host.isEmpty) return false;
    final host = u.host.toLowerCase();
    for (final raw in patterns) {
      final p = raw.toLowerCase();
      if (p.startsWith('*.')) {
        if (host.endsWith(p.substring(1)) && host != p.substring(2)) return true;
      } else if (host == p) {
        return true;
      }
    }
    return false;
  }
}

/// Back for a plugin screen that is shown inside the TV shell (not on its own route). The shell asks this first;
/// a plugin that is inside one of its own screens (a detail page, a list) takes the press, and a plugin at its top
/// level lets the shell go back to the dashboard.
class PluginBack {
  static bool Function()? current;
  static bool handle() => current?.call() ?? false;
}
