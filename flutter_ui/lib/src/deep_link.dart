import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'account_pages.dart';
import 'cloud.dart';

/// The website sends people back here after they create an account: pektv://account?email=...&username=...
/// The app opens its sign-in screen with the email filled in. The link carries no password and no session, only what is
/// needed to greet the person; anything else in it is ignored.
class DeepLink {
  static final navKey = GlobalKey<NavigatorState>();
  static const _channel = MethodChannel('pek/host');
  static bool _started = false;
  static final _name = RegExp(r'^[A-Za-z0-9][A-Za-z0-9._-]{2,19}$');

  /// Listens for links while the app runs and picks up the one that started it.
  static Future<void> start() async {
    if (_started) return;
    _started = true;
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'link' && call.arguments is String) handle(call.arguments as String);
      return null;
    });
    try {
      final first = await _channel.invokeMethod<String>('initialLink');
      if (first != null && first.isNotEmpty) handle(first);
    } catch (_) {}
  }

  static void handle(String url) {
    final u = Uri.tryParse(url);
    if (u == null || u.scheme != 'pektv' || u.host != 'account') return;
    final mail = (u.queryParameters['email'] ?? '').trim().toLowerCase();
    if (mail.length > 254 || !Cloud.validEmail(mail)) return;
    final name = (u.queryParameters['username'] ?? '').trim();
    Cloud.prefillEmail = mail;
    Cloud.prefillName = _name.hasMatch(name) ? name : '';
    if (Cloud.linked) return; // already signed in here: nothing to do
    navKey.currentState?.push(MaterialPageRoute<void>(builder: (_) => const AccountScreen(mode: AccountMode.signIn)));
  }
}
