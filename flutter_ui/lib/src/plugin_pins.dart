import 'dart:convert';

import 'package:flutter/foundation.dart';

import 'store.dart';

/// The plugin screens a person pinned to the front: the More page on phones and the side menu on a TV.
/// Every other plugin is reached through the Plugins page. Kept per profile, at most [max] at a time.
class PluginPins {
  static const max = 10;
  static const _key = 'pek_pinned_plugins_v1';

  /// Bumped whenever a pin is added or removed.
  static final ValueNotifier<int> changed = ValueNotifier(0);

  /// Plugin folders in the order they were pinned.
  static List<String> get all {
    try {
      final o = jsonDecode(Store.strGet(_key) ?? '[]');
      if (o is! List) return const [];
      final seen = <String>{};
      return [for (final e in o) if (e is String && e.isNotEmpty && seen.add(e)) e].take(max).toList();
    } catch (_) {
      return const [];
    }
  }

  static bool isPinned(String folder) => all.contains(folder);

  static bool get full => all.length >= max;

  /// Pins or unpins [folder]. Returns false (and changes nothing) when pinning would go over [max].
  static Future<bool> toggle(String folder) async {
    final l = List<String>.of(all);
    if (l.contains(folder)) {
      l.remove(folder);
    } else {
      if (l.length >= max) return false;
      l.add(folder);
    }
    await Store.strSet(_key, jsonEncode(l));
    changed.value++;
    return true;
  }

  /// The plugin was removed: its pin goes too.
  static Future<void> forget(String folder) async {
    final l = List<String>.of(all);
    if (!l.remove(folder)) return;
    await Store.strSet(_key, jsonEncode(l));
    changed.value++;
  }
}
