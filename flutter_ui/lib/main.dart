import 'package:flutter/material.dart';

import 'src/api.dart';
import 'src/mpv.dart';
import 'src/shell.dart';
import 'src/store.dart';
import 'src/theme.dart';
import 'src/tokens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Store.init();
  // The same phone / TV test the web UI used for html.pek-tv (bigger text, TV safe margins, bold focus ring).
  final phone = await PekPlayer.isPhone();
  runApp(PekApp(isPhone: phone));
}

class PekApp extends StatelessWidget {
  const PekApp({super.key, required this.isPhone});
  final bool isPhone;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PEK TV',
      debugShowCheckedModeBanner: false,
      theme: pekTheme(),
      // Tokens, TV mode and the rem size are available to every route (dialogs and the player included).
      builder: (context, child) => PekRoot(isPhone: isPhone, child: child ?? const SizedBox.shrink()),
      home: const _Boot(),
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
  late Future<bool> _ready = Api.waitForServer();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<bool>(
      future: _ready,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Scaffold(body: Center(child: CircularProgressIndicator()));
        }
        if (snap.data == true) return const AppShell();
        final rem = context.pek.rem;
        return Scaffold(
          body: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('The PEK server did not start.'),
              SizedBox(height: rem),
              PekButtonRetry(onTap: () => setState(() => _ready = Api.waitForServer())),
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
