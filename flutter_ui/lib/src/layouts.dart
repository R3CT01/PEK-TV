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

  static Future<void> setLayout(String v) async {
    await Store.strSet('pek_layout', v);
    changes.value++;
  }

  static Future<void> setPoster(String v) async {
    await Store.strSet('pek_poster', v);
    changes.value++;
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
        hint: p.isTv ? 'Where the menu sits and how big the posters are. Each profile keeps its own.' : 'How big the posters are.',
        children: [
          if (p.isTv)
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
