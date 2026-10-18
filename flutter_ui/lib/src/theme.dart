import 'package:flutter/material.dart';

/// PEK Ember (the app's default dark skin). Skins become a token file later; for now these are the defaults.
class Pek {
  static const bg = Color(0xFF14100D);
  static const surface = Color(0xFF1E1813);
  static const accent = Color(0xFFFF7A2F);
  static const text = Color(0xFFF3EBE3);
  static const muted = Color(0xFFA8998C);
  static const radius = 14.0;
}

ThemeData pekTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  return base.copyWith(
    scaffoldBackgroundColor: Pek.bg,
    colorScheme: base.colorScheme.copyWith(
      primary: Pek.accent,
      surface: Pek.surface,
      onSurface: Pek.text,
    ),
    textTheme: base.textTheme.apply(bodyColor: Pek.text, displayColor: Pek.text),
    focusColor: Pek.accent.withOpacity(0.25),
  );
}
