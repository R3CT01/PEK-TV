import 'package:flutter/material.dart';

import 'theme.dart';

/// A tappable card with a TV-style focus look: it grows a little and gets an accent border when the D-pad lands on it.
/// Enter / Select / A (D-pad centre) activate it through Flutter's default "activate" shortcut.
class FocusCard extends StatefulWidget {
  const FocusCard({super.key, required this.onTap, required this.child, this.autofocus = false});

  final VoidCallback onTap;
  final Widget child;
  final bool autofocus;

  @override
  State<FocusCard> createState() => _FocusCardState();
}

class _FocusCardState extends State<FocusCard> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(Pek.radius);
    return AnimatedScale(
      scale: _focused ? 1.06 : 1.0,
      duration: const Duration(milliseconds: 120),
      child: DecoratedBox(
        decoration: BoxDecoration(
          borderRadius: r,
          border: Border.all(color: _focused ? Pek.accent : Colors.transparent, width: 3),
        ),
        child: ClipRRect(
          borderRadius: r,
          child: InkWell(
            autofocus: widget.autofocus,
            onTap: widget.onTap,
            onFocusChange: (f) => setState(() => _focused = f),
            focusColor: Colors.transparent,
            child: widget.child,
          ),
        ),
      ),
    );
  }
}
