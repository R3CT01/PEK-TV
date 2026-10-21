import 'dart:async';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'api.dart';
import 'cloud.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart';

/// Port of www/net.js: a small dot in the top right corner (green = online, red = offline) and the online / offline state.
///
/// "Online" means the internet is really reachable, not just that Wi-Fi is connected: a tiny page is fetched every 30 seconds
/// (every 8 seconds while offline, to notice the recovery quickly) and right away when the app comes back to the front.
/// Offline mode: the local library keeps working; the things that need the internet wait. When the connection comes back the
/// poster art that failed is looked up again, the profile syncs and the weather refreshes.
class Net {
  // The first is the page Android itself uses; the second is a fallback.
  static const _probes = ['https://www.gstatic.com/generate_204', 'https://cloudflare.com/cdn-cgi/trace'];
  static const _timeout = Duration(seconds: 5);
  static const _pollOnline = Duration(seconds: 30);
  static const _pollOffline = Duration(seconds: 8);

  static final http.Client _c = http.Client();

  /// null until the first check has finished (the dot stays hidden), then true / false.
  static final ValueNotifier<bool?> status = ValueNotifier(null);

  /// True until a check says otherwise (like PekNet.isOnline).
  static bool get isOnline => status.value != false;

  /// Lets the "Back online" / "Offline mode" notice appear on whatever screen is open (MaterialApp.scaffoldMessengerKey).
  static final GlobalKey<ScaffoldMessengerState> messenger = GlobalKey<ScaffoldMessengerState>();

  static Timer? _timer;
  static bool _checking = false;
  static bool _started = false;

  static void start() {
    if (_started) return;
    _started = true;
    WidgetsBinding.instance.addObserver(_Lifecycle());
    unawaited(check());
  }

  static Future<bool> _probe(String url) async {
    try {
      await _c.get(Uri.parse('$url?_=${DateTime.now().millisecondsSinceEpoch}')).timeout(_timeout); // any reply means it is reachable
      return true;
    } catch (_) {
      return false;
    }
  }

  static Future<void> check() async {
    if (_checking) return;
    _checking = true;
    try {
      var ok = false;
      for (var i = 0; i < _probes.length && !ok; i++) {
        ok = await _probe(_probes[i]);
      }
      _set(ok);
    } finally {
      _checking = false;
      _timer?.cancel();
      _timer = Timer(isOnline ? _pollOnline : _pollOffline, () => unawaited(check()));
    }
  }

  static void _set(bool v) {
    final known = status.value != null;
    final changed = known && v != isOnline;
    status.value = v;
    if (!changed) return;
    messenger.currentState
      ?..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(v ? 'Back online' : 'Offline mode: your local library only')));
    if (v) _backOnline();
  }

  /// What was waiting for the network (the web UI's _watchNetwork).
  static void _backOnline() {
    if (Cloud.linked) unawaited(Cloud.sync()); // _autoSync
    Api.forgetFailedDetails(); // poster art that was skipped while offline
    Store.notifyChanged(); // the screens showing posters ask again
    Weather.changes.value++; // the tile and the badge read the weather again
  }
}

class _Lifecycle with WidgetsBindingObserver {
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(Net.check());
  }
}

/// `.hn-dot`: 10px, 6px from the top right corner (inside the TV safe margins), never takes a tap or a key.
class NetDot extends StatelessWidget {
  const NetDot({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return Positioned(
      top: 6 + p.safeY,
      right: 6 + p.safeX,
      child: IgnorePointer(
        child: ValueListenableBuilder<bool?>(
          valueListenable: Net.status,
          builder: (context, v, _) {
            if (v == null) return const SizedBox.shrink();
            final c = v ? const Color(0xFF3FB950) : const Color(0xFFF85149);
            return Semantics(
              label: v ? 'Online' : 'Offline mode: local library only',
              child: AnimatedContainer(
                duration: const Duration(milliseconds: 300),
                width: 10,
                height: 10,
                decoration: BoxDecoration(color: c, shape: BoxShape.circle, boxShadow: [BoxShadow(color: c.withOpacity(v ? 0.85 : 0.9), blurRadius: 6)]),
              ),
            );
          },
        ),
      ),
    );
  }
}
