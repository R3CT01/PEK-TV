import 'package:flutter/material.dart';

/// The design tokens from style.css. Default = :root (the light "sx" theme). [netflix] = html.nf-on.
/// Skins will later swap these at runtime, exactly like the CSS variables.
class PekTokens {
  const PekTokens({
    required this.bg,
    required this.bgElevated,
    required this.surface,
    required this.surfaceFocused,
    required this.border,
    required this.borderFocus,
    required this.text,
    required this.textMuted,
    required this.accent,
    required this.accentGlow,
    required this.overlay,
    required this.shadow,
    required this.glassStrong,
    required this.radius,
    this.glow = const [],
  });

  final Color bg, bgElevated, surface, surfaceFocused, border, borderFocus;
  final Color text, textMuted, accent, accentGlow, overlay, shadow, glassStrong;
  final double radius;
  final List<Gradient> glow; // drawn over bg, behind the app (the skin's bgImage)

  // :root in style.css
  static const light = PekTokens(
    bg: Color(0xFFE9E2DA),
    bgElevated: Color(0xFFF3EEE7),
    surface: Color(0xFFF8F4EE),
    surfaceFocused: Color(0x182B2622), // #2b262218
    border: Color(0xFFD5CABD),
    borderFocus: Color(0xFF2B2622),
    text: Color(0xFF2B2622),
    textMuted: Color(0xFF7A6F66),
    accent: Color(0xFF2B2622),
    accentGlow: Color.fromRGBO(43, 38, 34, 0.22),
    overlay: Color.fromRGBO(60, 48, 38, 0.35),
    shadow: Color.fromRGBO(70, 52, 36, 0.22),
    glassStrong: Color.fromRGBO(250, 246, 240, 0.96),
    radius: 16,
  );

  // html.nf-on in style.css
  static const netflix = PekTokens(
    bg: Color(0xFF141414),
    bgElevated: Color(0xFF141414),
    surface: Color(0xFF1F1F1F),
    surfaceFocused: Color.fromRGBO(255, 255, 255, 0.14),
    border: Color(0xFF333333),
    borderFocus: Color(0xFFFFFFFF),
    text: Color(0xFFFFFFFF),
    textMuted: Color(0xFFB3B3B3),
    accent: Color(0xFFE50914),
    accentGlow: Color(0x00000000),
    overlay: Color.fromRGBO(0, 0, 0, 0.75),
    shadow: Color.fromRGBO(0, 0, 0, 0.6),
    glassStrong: Color(0xFF181818),
    radius: 4,
  );
}

/// What the CSS knows from the page: tokens, TV mode (html.pek-tv), the rem size and the screen size.
class PekScope extends InheritedWidget {
  const PekScope({
    super.key,
    required this.tokens,
    required this.isTv,
    required this.rem,
    required this.size,
    required super.child,
  });

  final PekTokens tokens;
  final bool isTv;
  final double rem;
  final Size size;

  /// @media (max-width: 720px): the shell uses the bottom tab bar instead of the sidebar.
  bool get narrow => size.width <= 720;

  /// @media (max-width: 700px), (max-height: 500px): the compact poster grid.
  bool get compact => size.width <= 700 || size.height <= 500;

  /// html.pek-tv --tv-safe-x / --tv-safe-y (2vw / 2vh, the default 2 % margin).
  double get safeX => isTv ? size.width * 0.02 : 0;
  double get safeY => isTv ? size.height * 0.02 : 0;

  static PekScope of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<PekScope>()!;

  @override
  bool updateShouldNotify(PekScope o) => tokens != o.tokens || isTv != o.isTv || rem != o.rem || size != o.size;
}

extension PekContext on BuildContext {
  PekScope get pek => PekScope.of(this);
}

/// Wraps the whole app. html.pek-tv: font-size clamp(16px, 1.5625vw, 64px) on the root, so everything in rem scales
/// with the screen width (1920 wide = 30px). On a phone 1rem = 16px.
class PekRoot extends StatelessWidget {
  const PekRoot({super.key, required this.isPhone, required this.child, this.tokens = PekTokens.light});
  final bool isPhone;
  final PekTokens tokens;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final isTv = !isPhone;
    final rem = isTv ? (size.width * 0.015625).clamp(16.0, 64.0).toDouble() : 16.0;
    return PekScope(
      tokens: tokens,
      isTv: isTv,
      rem: rem,
      size: size,
      child: PekBackdrop(
        tokens: tokens,
        child: DefaultTextStyle(
          style: TextStyle(fontSize: rem, color: tokens.text, height: isTv ? 1.35 : null, fontWeight: FontWeight.w400, decoration: TextDecoration.none),
          child: child,
        ),
      ),
    );
  }
}

/// The page background: the solid colour with the skin's glow gradients on top.
class PekBackdrop extends StatelessWidget {
  const PekBackdrop({super.key, required this.tokens, required this.child});
  final PekTokens tokens;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: tokens.bg,
      child: Stack(
        fit: StackFit.expand,
        children: [
          for (final g in tokens.glow) DecoratedBox(decoration: BoxDecoration(gradient: g)),
          child,
        ],
      ),
    );
  }
}
