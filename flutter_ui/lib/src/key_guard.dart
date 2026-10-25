import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Tames a held remote button, for the whole app.
///
/// A held button sends a stream of repeat events. Flutter treats every repeat of OK as a fresh press, so whatever opened
/// under a held OK (a menu, a dialog, move mode) was pressed again and again ("spazzes out"). A held arrow moved the focus
/// 30 times a second, faster than the page could scroll, so it jumped around and ran out of the screen.
///
///  - A repeat of OK / Enter / A is swallowed: only the first press counts.
///  - A repeat of an arrow moves the focus at most about 6 times a second.
///
/// It sits above every screen, so a screen that handles a key itself (the player's seeking) is not affected. Text boxes keep
/// their normal caret movement.
class KeyGuard extends StatefulWidget {
  const KeyGuard({super.key, required this.child});
  final Widget child;

  @override
  State<KeyGuard> createState() => _KeyGuardState();
}

class _KeyGuardState extends State<KeyGuard> {
  DateTime _last = DateTime.fromMillisecondsSinceEpoch(0);

  static bool _select(LogicalKeyboardKey k) =>
      k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.gameButtonA;

  static bool _arrow(LogicalKeyboardKey k) =>
      k == LogicalKeyboardKey.arrowUp || k == LogicalKeyboardKey.arrowDown || k == LogicalKeyboardKey.arrowLeft || k == LogicalKeyboardKey.arrowRight;

  KeyEventResult _key(FocusNode node, KeyEvent e) {
    final k = e.logicalKey;
    final inText = FocusManager.instance.primaryFocus?.context?.findAncestorWidgetOfExactType<EditableText>() != null;
    if (inText) return KeyEventResult.ignored;
    if (e is KeyRepeatEvent) {
      if (_select(k)) return KeyEventResult.handled;
      if (_arrow(k)) {
        final now = DateTime.now();
        if (now.difference(_last) < const Duration(milliseconds: 170)) return KeyEventResult.handled;
        _last = now;
      }
    } else if (e is KeyDownEvent && _arrow(k)) {
      _last = DateTime.now();
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) => Focus(canRequestFocus: false, skipTraversal: true, onKeyEvent: _key, child: widget.child);
}
