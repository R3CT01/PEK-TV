import 'dart:async';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

import 'common.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The "10-foot" look.
///
/// - [mode]: 'auto' (on for a TV box, off on a phone), 'on' or 'off'. Settings > TV mode.
/// - [safe]: percent of the screen kept clear at the edges (0, 2, 4 or 6) for TVs that crop the picture.
/// - The look itself (rem that follows the screen width, safe margins, bold focus ring, 3rem targets) lives in
///   `PekRoot` / `PekScope` (tokens.dart) and the widgets that read `context.pek.isTv`.
/// - The pointer hides after 3 idle seconds in TV mode ([PekIdlePointer]).
/// - Game controllers need no port: Android already turns them into D-pad keys, which Flutter's focus system handles.
///
/// Like the web UI (localStorage 'hesper-tv-mode' / 'hesper-tv-safe') this belongs to the device, not to a profile.
class TvMode {
  static const modeKey = 'pek_tv_mode';
  static const safeKey = 'pek_tv_safe';
  static const safeChoices = <int>[0, 2, 4, 6];

  /// Interface size on a TV, percent of the old size. 85 is the default: the old size (100) was a bit large.
  static const sizeKey = 'pek_tv_size';
  static const sizeChoices = <(int, String)>[(65, 'Smallest'), (75, 'Smaller'), (85, 'Small'), (100, 'Original')];
  static const defaultSize = 85;
  static const modes = <(String, String, String)>[
    ('auto', 'Auto', 'On for TV boxes, off on phones'),
    ('on', 'On', 'Always use the TV look'),
    ('off', 'Off', 'Never use the TV look'),
  ];

  /// Bumped on every change; `PekRoot` rebuilds the whole app look from it.
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static String get mode {
    final v = Store.strGet(modeKey, scoped: false);
    return v == 'on' || v == 'off' ? v! : 'auto';
  }

  static int get safe {
    final v = int.tryParse(Store.strGet(safeKey, scoped: false) ?? '');
    return v != null && safeChoices.contains(v) ? v : 2;
  }

  static int get size {
    final v = int.tryParse(Store.strGet(sizeKey, scoped: false) ?? '');
    return v != null && v >= 50 && v <= 130 ? v : defaultSize;
  }

  static Future<void> setSize(int pct) async {
    await Store.strSet(sizeKey, '${pct.clamp(50, 130)}', scoped: false);
    changes.value++;
  }

  /// [tvDevice] = the host says this is a TV box (not a phone or tablet).
  static bool isOn(bool tvDevice) => mode == 'on' || (mode == 'auto' && tvDevice);

  static Future<void> setMode(String m) async {
    await Store.strSet(modeKey, m == 'on' || m == 'off' ? m : 'auto', scoped: false);
    changes.value++;
  }

  static Future<void> setSafe(int pct) async {
    await Store.strSet(safeKey, '${safeChoices.contains(pct) ? pct : 2}', scoped: false);
    changes.value++;
  }
}

/// Settings > TV mode (the web UI's "TV mode" card under Advanced).
class TvModeSection extends StatelessWidget {
  const TvModeSection({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    return ListenableBuilder(
      listenable: TvMode.changes,
      builder: (context, _) => Section(
        title: 'TV mode',
        hint: 'Bigger text, safe margins and a bolder highlight for the couch.',
        children: [
          for (final m in TvMode.modes)
            ListRow(
              title: m.$2,
              subtitle: m.$3,
              onTap: () => TvMode.setMode(m.$1),
              trailing: Icon(m.$1 == TvMode.mode ? Icons.check_circle : Icons.circle_outlined, color: m.$1 == TvMode.mode ? t.accent : t.textMuted),
            ),
          SizedBox(height: 0.5 * p.rem),
          Text('Interface size on the TV', style: TextStyle(color: t.textMuted)),
          SizedBox(height: 0.4 * p.rem),
          Wrap(spacing: 0.5 * p.rem, runSpacing: 0.5 * p.rem, children: [
            for (final s in TvMode.sizeChoices)
              PekButton(label: s.$2, primary: TvMode.size == s.$1, onTap: () => TvMode.setSize(s.$1)),
          ]),
          SizedBox(height: 0.5 * p.rem),
          Text('Screen margins (raise if your TV cuts off the edges)', style: TextStyle(color: t.textMuted)),
          SizedBox(height: 0.4 * p.rem),
          Wrap(spacing: 0.5 * p.rem, runSpacing: 0.5 * p.rem, children: [
            for (final s in const [(0, 'None'), (2, 'Small'), (4, 'Medium'), (6, 'Large')])
              PekButton(label: s.$2, primary: TvMode.safe == s.$1, onTap: () => TvMode.setSafe(s.$1)),
          ]),
        ],
      ),
    );
  }
}

/// `html.pek-tv.pek-idle * { cursor: none }`: in TV mode the mouse pointer disappears after 3 idle seconds and comes back
/// the moment the mouse moves. Touch and remote input are never affected, so a phone with TV mode forced on keeps working.
class PekIdlePointer extends StatefulWidget {
  const PekIdlePointer({super.key, required this.enabled, required this.child});
  final bool enabled;
  final Widget child;

  @override
  State<PekIdlePointer> createState() => _PekIdlePointerState();
}

class _PekIdlePointerState extends State<PekIdlePointer> {
  Timer? _timer;
  bool _idle = false;
  bool _mouse = false; // the last pointer seen was a mouse

  @override
  void initState() {
    super.initState();
    _arm();
  }

  @override
  void didUpdateWidget(PekIdlePointer old) {
    super.didUpdateWidget(old);
    if (old.enabled != widget.enabled) _wake();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _arm() {
    _timer?.cancel();
    if (widget.enabled) _timer = Timer(const Duration(seconds: 3), () => _set(true));
  }

  void _set(bool idle) {
    if (!mounted || _idle == idle) return;
    setState(() => _idle = idle);
  }

  void _wake([PointerEvent? e]) {
    if (e != null) _mouse = e.kind == PointerDeviceKind.mouse;
    _set(false);
    _arm();
  }

  @override
  Widget build(BuildContext context) {
    final hide = widget.enabled && _idle && _mouse;
    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerHover: _wake,
      onPointerMove: _wake,
      onPointerDown: _wake,
      child: MouseRegion(
        // Children (buttons) ask for their own cursor, so while idle the pointer is ignored below this region and the
        // region's "none" wins. The first mouse move wakes it again.
        cursor: hide ? SystemMouseCursors.none : MouseCursor.defer,
        child: IgnorePointer(ignoring: hide, child: widget.child),
      ),
    );
  }
}
