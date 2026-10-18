import 'package:flutter/material.dart';

import 'src/api.dart';
import 'src/home.dart';
import 'src/theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const PekApp());
}

class PekApp extends StatelessWidget {
  const PekApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'PEK TV',
      debugShowCheckedModeBanner: false,
      theme: pekTheme(),
      // The default shortcuts already map the arrow keys / D-pad to focus moves and Enter / Select / A to "activate".
      home: const _Boot(),
    );
  }
}

/// Waits for the C++ server (MainActivity has started it already, this only covers a slow start) then opens Home.
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
        if (snap.data == true) return const HomeScreen();
        return Scaffold(
          body: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('The PEK server did not start.'),
              const SizedBox(height: 16),
              FilledButton(
                autofocus: true,
                onPressed: () => setState(() => _ready = Api.waitForServer()),
                child: const Text('Try again'),
              ),
            ]),
          ),
        );
      },
    );
  }
}
