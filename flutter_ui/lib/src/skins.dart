import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'store.dart';
import 'tokens.dart';

class Skin {
  const Skin(this.id, this.name, this.description, this.tokens);
  final String id;
  final String name;
  final String description;
  final PekTokens tokens;
}

/// The built-in skins (the colours of skins/*/skin.json and style.css). Each profile remembers its own.
class Skins {
  /// Quiet and monochrome: near-black, no outlines, one off-white accent.
  static const minimal = PekTokens(
    bg: Color(0xFF0B0B0C), bgElevated: Color(0xFF0B0B0C), surface: Color(0xFF151517), surfaceFocused: Color(0x1FFFFFFF),
    border: Color(0x14FFFFFF), borderFocus: Color(0xFFF2F2F3), text: Color(0xFFF2F2F3), textMuted: Color(0xFF8B8B92),
    accent: Color(0xFFF2F2F3), accentGlow: Color(0x00000000), overlay: Color.fromRGBO(0, 0, 0, 0.7),
    shadow: Color.fromRGBO(0, 0, 0, 0.5), glassStrong: Color.fromRGBO(21, 21, 23, 0.96), radius: 20,
  );
  static const ember = PekTokens(
    bg: Color(0xFF140B07), bgElevated: Color(0xFF1B0F0A), surface: Color(0xFF26150D), surfaceFocused: Color(0x26FF8A3D),
    border: Color(0xFF3D2314), borderFocus: Color(0xFFFF8A3D), text: Color(0xFFFFF3EA), textMuted: Color(0xFFC9A590),
    accent: Color(0xFFFF8A3D), accentGlow: Color.fromRGBO(255, 138, 61, 0.40), overlay: Color.fromRGBO(10, 5, 3, 0.75),
    shadow: Color.fromRGBO(0, 0, 0, 0.55), glassStrong: Color.fromRGBO(27, 15, 10, 0.94), radius: 20,
    // skins/default/skin.json bgImage: an orange glow from the top and a fainter one from the bottom
    glow: [
      RadialGradient(center: Alignment(0, -1.15), radius: 1.15, colors: [Color(0x4DFF7A2A), Color(0x1FFF7A2A), Color(0x00140B07)], stops: [0, 0.38, 0.72]),
      RadialGradient(center: Alignment(0, 1.2), radius: 0.95, colors: [Color(0x2EFF5A14), Color(0x00140B07)], stops: [0, 0.6]),
    ],
  );
  static const green = PekTokens(
    bg: Color(0xFF07120B), bgElevated: Color(0xFF0B1A10), surface: Color(0xFF112218), surfaceFocused: Color(0x333DDC84),
    border: Color(0xFF1F4A31), borderFocus: Color(0xFF3DDC84), text: Color(0xFFE9FFF1), textMuted: Color(0xFF8FB9A0),
    accent: Color(0xFF3DDC84), accentGlow: Color.fromRGBO(61, 220, 132, 0.35), overlay: Color.fromRGBO(5, 8, 15, 0.75),
    shadow: Color.fromRGBO(0, 0, 0, 0.5), glassStrong: Color.fromRGBO(13, 18, 30, 0.92), radius: 24,
  );
  static const neon = PekTokens(
    bg: Color(0xFF05010D), bgElevated: Color(0xFF0B0318), surface: Color(0xFF120626), surfaceFocused: Color(0x33FF2BD6),
    border: Color(0xFF3A1A5C), borderFocus: Color(0xFFFF2BD6), text: Color(0xFFF6EAFF), textMuted: Color(0xFFA98CC9),
    accent: Color(0xFF00F0FF), accentGlow: Color.fromRGBO(0, 240, 255, 0.45), overlay: Color.fromRGBO(5, 8, 15, 0.75),
    shadow: Color.fromRGBO(0, 0, 0, 0.5), glassStrong: Color.fromRGBO(13, 18, 30, 0.92), radius: 4,
  );

  static const all = <Skin>[
    Skin('ember', 'PEK Ember', 'The standard look: a dim, radiant orange glow.', ember),
    Skin('minimal', 'Mono', 'Quiet, dark and monochrome. No outlines.', minimal),
    Skin('light', 'Cream', 'The original light theme.', PekTokens.light),
    Skin('netflix', 'Night red', 'Dark with a red accent and square corners.', PekTokens.netflix),
    Skin('green', 'Green', 'Soft, rounded and flat.', green),
    Skin('neon', 'Neon', 'Cyan and magenta on near-black.', neon),
  ];

  /// Bumped when the skin changes (the whole app repaints with the new tokens).
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static String get currentId => Store.strGet('pek_skin') ?? 'ember';
  static Skin get current => all.firstWhere((s) => s.id == currentId, orElse: () => all.first);
  static PekTokens get tokens => current.tokens;

  static Future<void> set(String id) async {
    await Store.strSet('pek_skin', id);
    changes.value++;
  }
}
