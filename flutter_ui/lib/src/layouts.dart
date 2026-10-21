import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'common.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

class PekLayout {
  const PekLayout(this.id, this.name, this.description, this.poster);
  final String id;
  final String name;
  final String description;
  final String poster; // the poster size this layout uses unless one is picked
}

/// Port of the web UI's layouts (app_config.js): where the menu sits and how big the posters are. Phones always use the bottom
/// tab bar, so there a layout only changes poster size. Each profile keeps its own.
class Layouts {
  static const all = <PekLayout>[
    PekLayout('classic', 'Classic', 'Menu on the left, medium posters.', 'm'),
    PekLayout('topbar', 'Top bar', 'Menu across the top, like Arctic. Phones keep the bottom bar.', 'm'),
    PekLayout('wall', 'Wall', 'Big posters and a slimmer menu.', 'l'),
    PekLayout('compact', 'Compact', 'Smaller posters and tighter spacing, so more fits on screen.', 's'),
  ];
  static const sizes = <(String, String)>[('auto', 'Auto'), ('s', 'Small'), ('m', 'Medium'), ('l', 'Large')];

  static final ValueNotifier<int> changes = ValueNotifier(0);

  static String get id {
    final v = Store.strGet('pek_layout');
    return all.any((l) => l.id == v) ? v! : 'classic';
  }

  static PekLayout get current => all.firstWhere((l) => l.id == id);

  static String get posterSetting {
    final v = Store.strGet('pek_poster');
    return sizes.any((s) => s.$1 == v) ? v! : 'auto';
  }

  static String get poster => posterSetting == 'auto' ? current.poster : posterSetting;

  /// Multiplier for the poster grid's minimum cell width.
  static double get posterScale => switch (poster) { 's' => 0.75, 'l' => 1.35, _ => 1.0 };

  /// TV look: `html.pek-tv[data-poster]` sets the grid minimum to 7rem / 9rem / 14rem for small / medium / large.
  static double get posterScaleTv => switch (poster) { 's' => 7 / 9, 'l' => 14 / 9, _ => 1.0 };

  /// Bumped only when the person changes the layout or poster size here (not when the cloud does): Cloud sync listens to it.
  static final ValueNotifier<int> edited = ValueNotifier(0);

  static Future<void> setLayout(String v) async {
    await Store.strSet('pek_layout', v);
    changes.value++;
    edited.value++;
  }

  static Future<void> setPoster(String v) async {
    await Store.strSet('pek_poster', v);
    changes.value++;
    edited.value++;
  }

  // ---- cloud sync (`s|look`, the same shape the web UI sends: {layout, poster, view}; this UI has no list/grid `view`) ----

  /// What this profile has chosen on this device, or null when nothing was ever chosen (a default that was never changed is not synced).
  static Map<String, dynamic>? syncValue() {
    final out = <String, dynamic>{};
    final l = Store.strGet('pek_layout');
    if (all.any((e) => e.id == l)) out['layout'] = l;
    final s = Store.strGet('pek_poster');
    if (sizes.any((e) => e.$1 == s)) out['poster'] = s;
    return out.isEmpty ? null : out;
  }

  /// Checks a value that came from the cloud (same limits as the web UI's cleanLook). Null when nothing in it is usable.
  static Map<String, dynamic>? cleanSync(dynamic o) {
    if (o is! Map) return null;
    final out = <String, dynamic>{};
    if (all.any((e) => e.id == o['layout'])) out['layout'] = o['layout'];
    if (sizes.any((e) => e.$1 == o['poster'])) out['poster'] = o['poster'];
    return out.isEmpty ? null : out;
  }

  /// Puts a cleaned value from the cloud on this device. Only what the value has is changed; `view` is left alone.
  static void applySynced(Map<String, dynamic> o) {
    if (o['layout'] is String) unawaited(Store.strSet('pek_layout', o['layout'] as String));
    if (o['poster'] is String) unawaited(Store.strSet('pek_poster', o['poster'] as String));
    changes.value++; // repaint, but not `edited`: this change came from the cloud
  }
}

/// Settings > Layout. The layout cards are hidden on phones (they only have one layout); poster size is shown everywhere.
class LayoutSection extends StatelessWidget {
  const LayoutSection({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    return ListenableBuilder(
      listenable: Listenable.merge([Layouts.changes, Store.profile]),
      builder: (context, _) => Section(
        title: 'Layout',
        hint: p.sidebar ? 'Where the menu sits and how big the posters are. Each profile keeps its own.' : 'How big the posters are.',
        children: [
          if (p.sidebar)
            for (final l in Layouts.all)
              ListRow(
                title: l.name,
                subtitle: l.description,
                onTap: () => Layouts.setLayout(l.id),
                trailing: Icon(l.id == Layouts.id ? Icons.check_circle : Icons.circle_outlined, color: l.id == Layouts.id ? t.accent : t.textMuted),
              ),
          SizedBox(height: 0.5 * p.rem),
          Text('Poster size', style: TextStyle(color: t.textMuted)),
          SizedBox(height: 0.4 * p.rem),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final s in Layouts.sizes) PekButton(label: s.$2, primary: Layouts.posterSetting == s.$1, onTap: () => Layouts.setPoster(s.$1)),
          ]),
        ],
      ),
    );
  }
}
