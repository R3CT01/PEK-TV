import 'package:flutter/material.dart';

import 'src/activity.dart';
import 'src/app_update.dart';
import 'src/api.dart';
import 'src/cloud.dart';
import 'src/profile_pages.dart';
import 'src/profiles.dart';
import 'src/skins.dart';
import 'src/mpv.dart';
import 'src/music_controller.dart';
import 'src/net.dart';
import 'src/shell.dart';
import 'src/store.dart';
import 'src/theme.dart';
import 'src/tokens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // The same phone / TV test the web UI used for html.pek-tv; Settings > TV mode (tv_mode.dart) can force the look on or off.
  // Asked right away so it runs alongside the storage load instead of after it.
  final phoneAsk = PekPlayer.isPhone();
  await Store.init();
  Profiles.load();
  MusicController.instance.restore(); // the song the active profile was playing when the app closed
  Net.start(); // the green / red dot and offline mode (net.js)
  final phone = await phoneAsk;
  runApp(PekApp(isPhone: phone));
}

class PekApp extends StatelessWidget {
  const PekApp({super.key, required this.isPhone});
  final bool isPhone;

  @override
  Widget build(BuildContext context) {
    // The skin belongs to the profile: it changes with the picker and with Settings > Appearance.
    return ListenableBuilder(
      listenable: Listenable.merge([Skins.changes, Store.profile]),
      builder: (context, _) {
        final tokens = Skins.tokens;
        return MaterialApp(
          title: 'PEK TV',
          debugShowCheckedModeBanner: false,
          scaffoldMessengerKey: Net.messenger,
          theme: pekTheme(tokens),
          // Tokens, TV mode and the rem size are available to every route (dialogs and the player included).
          builder: (context, child) => PekRoot(isPhone: isPhone, tokens: tokens, child: Stack(fit: StackFit.expand, children: [child ?? const SizedBox.shrink(), const NetDot(), const ActivityOverlay(), const BusyRing()])),
          home: const _Boot(),
        );
      },
    );
  }
}

/// Waits for the C++ server (MainActivity has started it already, this only covers a slow start) then opens the shell.
class _Boot extends StatefulWidget {
  const _Boot();
  @override
  State<_Boot> createState() => _BootState();
}

class _BootState extends State<_Boot> {
  late Future<bool> _ready = _start();

  // A newer PEK TV on GitHub (app_update.dart). Looked for while the server starts, so it adds no waiting when up to date;
  // "Not now" hides the screen for this run only, it is back at the next start.
  AppRelease? _update;
  bool _later = false;

  Future<bool> _start() async {
    final check = AppUpdate.check(); // gives up after a few seconds; any problem = no update screen
    final ok = await Api.waitForServer();
    _update = await check;
    return ok;
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<bool>(
      future: _ready,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          // Same colour as the native splash (pek_splash_bg), so the hand-over from the launch screen does not flash.
          return const Scaffold(
            backgroundColor: Color(0xFFE04A00),
            body: Center(child: CircularProgressIndicator(color: Colors.white)),
          );
        }
        if (snap.data == true) {
          if (_update != null && !_later) {
            return AppUpdateScreen(release: _update!, onLater: () => setState(() => _later = true));
          }
          // With an account, "Who's watching?" comes first; the app below is rebuilt for each profile.
          return ListenableBuilder(
            listenable: Listenable.merge([Profiles.changes, Cloud.changes, Store.musicModeN]),
            builder: (context, _) => Profiles.gateNeeded ? const ProfileGate() : AppShell(key: ValueKey('shell-${Profiles.currentId}-${Store.musicMode}')),
          );
        }
        final rem = context.pek.rem;
        return Scaffold(
          body: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('The PEK server did not start.'),
              SizedBox(height: rem),
              PekButtonRetry(onTap: () => setState(() => _ready = _start())),
            ]),
          ),
        );
      },
    );
  }
}

class PekButtonRetry extends StatelessWidget {
  const PekButtonRetry({super.key, required this.onTap});
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => FilledButton(autofocus: true, onPressed: onTap, child: const Text('Try again'));
}
