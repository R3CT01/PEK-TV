import 'package:flutter/material.dart';

import 'tokens.dart';

/// Static copies of the default tokens for the screens that have not moved to PekScope yet (detail, player).
class Pek {
  static const bg = Color(0xFFE9E2DA);
  static const surface = Color(0xFFF8F4EE);
  static const accent = Color(0xFF2B2622);
  static const text = Color(0xFF2B2622);
  static const muted = Color(0xFF7A6F66);
  static const radius = 16.0;
}

ThemeData pekTheme() {
  const t = PekTokens.light;
  final base = ThemeData.light(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: t.bg,
    canvasColor: t.bg,
    colorScheme: base.colorScheme.copyWith(
      primary: t.accent,
      onPrimary: t.bg,
      surface: t.surface,
      onSurface: t.text,
    ),
    textTheme: base.textTheme.apply(bodyColor: t.text, displayColor: t.text),
    focusColor: t.surfaceFocused,
  );
}
