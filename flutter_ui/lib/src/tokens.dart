import 'package:flutter/material.dart';

import 'activity.dart';
import 'tv_mode.dart';

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
  });

  final Color bg, bgElevated, surface, surfaceFocused, border, borderFocus;
  final Color text, textMuted, accent, accentGlow, overlay, shadow, glassStrong;
  final double radius;

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
    required this.tvDevice,
    required this.safePct,
    required this.rem,
    required this.size,
    required super.child,
  });

  final PekTokens tokens;
  /// The 10-foot look (html.pek-tv): bigger text, safe margins, bold focus ring. Follows Settings > TV mode.
  final bool isTv;

  /// The device itself is a TV box (no touch). Decides how you get around (sidebar, D-pad shortcuts), not how big things are.
  final bool tvDevice;

  /// Screen margin kept clear in TV mode, in percent (0, 2, 4 or 6).
  final int safePct;
  final double rem;
  final Size size;

  /// The sidebar layout: always on a TV box; on other devices only when the TV look is forced on and the screen is wide.
  bool get sidebar => tvDevice || (isTv && !narrow);

  /// @media (max-width: 720px): the shell uses the bottom tab bar instead of the sidebar.
  bool get narrow => size.width <= 720;

  /// @media (max-width: 700px), (max-height: 500px): the compact poster grid.
  bool get compact => size.width <= 700 || size.height <= 500;

  /// html.pek-tv --tv-safe-x / --tv-safe-y (safePct of the width / height; Settings > TV mode > Screen margins).
  double get safeX => isTv ? size.width * safePct / 100 : 0;
  double get safeY => isTv ? size.height * safePct / 100 : 0;

  static PekScope of(BuildContext c) => c.dependOnInheritedWidgetOfExactType<PekScope>()!;

  @override
  bool updateShouldNotify(PekScope o) => tokens != o.tokens || isTv != o.isTv || tvDevice != o.tvDevice || safePct != o.safePct || rem != o.rem || size != o.size;
}

extension PekContext on BuildContext {
  PekScope get pek => PekScope.of(this);
}

/// Wraps the whole app. html.pek-tv: font-size clamp(16px, 1.5625vw, 64px) on the root, so everything in rem scales
/// with the screen width (1920 wide = 30px). On a phone 1rem = 16px. The TV look follows Settings > TV mode (tv_mode.dart).
class PekRoot extends StatelessWidget {
  const PekRoot({super.key, required this.isPhone, required this.child, this.tokens = PekTokens.light});
  final bool isPhone;
  final PekTokens tokens;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(listenable: TvMode.changes, builder: (context, _) => _build(context));
  }

  Widget _build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final isTv = TvMode.isOn(!isPhone);
    final rem = isTv ? (size.width * 0.015625).clamp(16.0, 64.0).toDouble() : 16.0;
    return PekScope(
      tokens: tokens,
      isTv: isTv,
      tvDevice: !isPhone,
      safePct: TvMode.safe,
      rem: rem,
      size: size,
      child: PekBackdrop(
        tokens: tokens,
        child: PekIdlePointer(
          enabled: isTv,
          child: Theme(
            data: isTv ? _tvTheme(Theme.of(context), rem) : Theme.of(context),
            child: DefaultTextStyle(
              style: TextStyle(fontSize: rem, color: tokens.text, height: isTv ? 1.35 : null, fontWeight: FontWeight.w400, decoration: TextDecoration.none),
              child: child,
            ),
          ),
        ),
      ),
    );
  }

  /// What the CSS did to Material-drawn widgets (dialogs, text fields, the app bar title): text that follows rem,
  /// text inputs 3rem high with the bold 0.2rem focus ring, icons that match the text.
  ThemeData _tvTheme(ThemeData th, double rem) => th.copyWith(
        textTheme: th.textTheme.apply(fontSizeFactor: rem / 16),
        iconTheme: th.iconTheme.copyWith(size: 1.5 * rem),
        inputDecorationTheme: th.inputDecorationTheme.copyWith(
          contentPadding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.9 * rem),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: BorderSide(color: tokens.borderFocus, width: 0.2 * rem)),
        ),
      );
}

/// The page background: a flat colour (screens that open on top use it too, so they fully cover the page below).
class PekBackdrop extends StatelessWidget {
  const PekBackdrop({super.key, required this.tokens, required this.child});
  final PekTokens tokens;
  final Widget child;

  @override
  // While a video is open the picture is a native surface BEHIND Flutter, so this must not paint an opaque colour
  // over it (that is what made the video look blank while the controls still showed).
  Widget build(BuildContext context) => ValueListenableBuilder<bool>(
        valueListenable: Activity.playerOpen,
        child: child,
        builder: (_, open, c) => ColoredBox(color: open ? Colors.transparent : tokens.bg, child: c),
      );
}
