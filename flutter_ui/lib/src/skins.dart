import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'store.dart';
import 'tokens.dart';

class Skin {
  const Skin(this.id, this.name, this.description, this.tokens, {this.custom = false, this.author = '', this.version = '', this.source});
  final String id;
  final String name;
  final String description;
  final PekTokens tokens;

  /// Made in the Skin maker, pasted from a skin.json, or installed from a .zip / GitHub: can be edited, copied and deleted.
  final bool custom;
  final String author, version;

  /// Where an installed skin came from: null (made here), {'type': 'zip'} or {'type': 'github', 'owner', 'repo', 'tag'}.
  /// A skin from GitHub is shown as "unverified", like the web UI (`PekSkinSources`).
  final Map<String, dynamic>? source;

  bool get fromGithub => source?['type'] == 'github';
  bool get installed => id.startsWith(Skins.installedPrefix);

  Skin copyWith({String? id, String? name, String? description, PekTokens? tokens, String? author, String? version, Map<String, dynamic>? source}) =>
      Skin(id ?? this.id, name ?? this.name, description ?? this.description, tokens ?? this.tokens,
          custom: custom, author: author ?? this.author, version: version ?? this.version, source: source ?? this.source);
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
    bg: Color(0xFF130A06), bgElevated: Color(0xFF1A0E08), surface: Color(0xFF24140C), surfaceFocused: Color(0x26FF8A3D),
    border: Color(0xFF3D2314), borderFocus: Color(0xFFFF8A3D), text: Color(0xFFFFF3EA), textMuted: Color(0xFFC9A590),
    accent: Color(0xFFFF8A3D), accentGlow: Color.fromRGBO(255, 138, 61, 0.40), overlay: Color.fromRGBO(10, 5, 3, 0.75),
    shadow: Color.fromRGBO(0, 0, 0, 0.55), glassStrong: Color.fromRGBO(27, 15, 10, 0.94), radius: 20,
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

  static const builtIn = <Skin>[
    Skin('ember', 'PEK Ember', 'The standard look: warm dark brown with an orange accent.', ember),
    Skin('minimal', 'Mono', 'Quiet, dark and monochrome. No outlines.', minimal),
    Skin('light', 'Cream', 'The original light theme.', PekTokens.light),
    Skin('netflix', 'Night red', 'Dark with a red accent and square corners.', PekTokens.netflix),
    Skin('green', 'Green', 'Soft, rounded and flat.', green),
    Skin('neon', 'Neon', 'Cyan and magenta on near-black.', neon),
  ];

  // ---------------------------------------------------------------- the skins people made

  static const _customKey = 'pek_custom_skins';

  /// Ids of skins installed from a .zip or GitHub start with this (made ones start with "custom-"). The id after it is
  /// the same slug the web UI uses (folder name, else skin name), so installing the same skin again updates it.
  static const installedPrefix = 'pkg-';
  static List<Skin>? _custom;

  /// The skins made in the Skin maker. Shared by every profile on the device; each profile still picks its own.
  static List<Skin> get customSkins => _custom ??= _loadCustom();

  /// The built-in skins, then the ones made here.
  static List<Skin> get all => [...builtIn, ...customSkins];

  static List<Skin> _loadCustom() {
    final out = <Skin>[];
    try {
      final raw = Store.strGet(_customKey, scoped: false);
      if (raw == null || raw.isEmpty) return out;
      for (final e in jsonDecode(raw) as List) {
        if (e is! Map) continue;
        final id = '${e['id'] ?? ''}';
        if (!id.startsWith('custom-') && !id.startsWith(installedPrefix)) continue;
        final tokens = SkinJson.tokensFrom((e['tokens'] as Map?)?.cast<String, dynamic>() ?? const {});
        if (tokens == null) continue;
        out.add(Skin(id, '${e['name'] ?? 'My skin'}', '${e['description'] ?? ''}', tokens,
            custom: true, author: '${e['author'] ?? ''}', version: '${e['version'] ?? ''}', source: (e['source'] as Map?)?.cast<String, dynamic>()));
      }
    } catch (_) {}
    return out;
  }

  static Future<void> _saveCustom() => Store.strSet(
        _customKey,
        jsonEncode([
          for (final s in customSkins)
            {
              'id': s.id,
              'name': s.name,
              'author': s.author,
              'version': s.version,
              'description': s.description,
              'tokens': SkinJson.tokensTo(s.tokens),
              if (s.source != null) 'source': s.source,
            },
        ]),
        scoped: false,
      );

  /// A free id for a new skin.
  static String newId() => 'custom-${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}';

  /// Adds a skin or replaces the one with the same id. When it is the skin in use, the app repaints at once.
  static Future<void> saveCustom(Skin skin) async {
    final list = [...customSkins];
    final i = list.indexWhere((s) => s.id == skin.id);
    if (i >= 0) {
      list[i] = skin;
    } else {
      list.add(skin);
    }
    _custom = list;
    await _saveCustom();
    changes.value++;
  }

  /// Deletes a made skin. A profile that was using it goes back to PEK Ember.
  static Future<void> deleteCustom(String id) async {
    _custom = customSkins.where((s) => s.id != id).toList();
    await _saveCustom();
    if (Store.strGet('pek_skin') == id) await Store.strSet('pek_skin', 'ember');
    changes.value++;
  }

  /// Bumped when the skin changes (the whole app repaints with the new tokens).
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static String get currentId => Store.strGet('pek_skin') ?? 'ember';
  static Skin get current {
    final id = currentId;
    for (final s in all) {
      if (s.id == id) return s;
    }
    return builtIn.first;
  }

  static PekTokens get tokens => current.tokens;

  static Future<void> set(String id) async {
    await Store.strSet('pek_skin', id);
    changes.value++;
  }
}

/// skin.json <-> tokens, in the same shape the web UI's skins use (colours as #rrggbb / #rrggbbaa / rgba(), radius as "14px"),
/// so a skin made here can be installed in the web build and the other way round.
class SkinJson {
  static const _colorKeys = ['bg', 'bgElevated', 'surface', 'surfaceFocused', 'border', 'borderFocus', 'text', 'textMuted', 'accent', 'accentGlow', 'overlay', 'shadow', 'glassStrong'];

  static String hex(Color c, {bool alpha = false}) {
    String two(int v) => v.toRadixString(16).padLeft(2, '0');
    final base = '#${two(c.red)}${two(c.green)}${two(c.blue)}';
    return alpha || c.alpha != 255 ? '$base${two(c.alpha)}' : base;
  }

  /// #rgb, #rrggbb, #rrggbbaa (CSS order), rgb(r, g, b) and rgba(r, g, b, a). null = not a colour.
  static Color? parseColor(String text) {
    final t = text.trim().toLowerCase();
    if (t.startsWith('#')) {
      var h = t.substring(1);
      if (h.length == 3) h = h.split('').map((c) => c + c).join();
      if (!RegExp(r'^[0-9a-f]+$').hasMatch(h)) return null;
      if (h.length == 6) return Color(0xFF000000 | int.parse(h, radix: 16));
      if (h.length == 8) {
        final v = int.parse(h, radix: 16);
        return Color(((v & 0xFF) << 24) | (v >> 8));
      }
      return null;
    }
    final m = RegExp(r'^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$').firstMatch(t);
    if (m == null) return null;
    int ch(int i) => int.parse(m.group(i)!).clamp(0, 255).toInt();
    final a = m.group(4) == null ? 1.0 : (double.tryParse(m.group(4)!) ?? 1.0).clamp(0.0, 1.0).toDouble();
    return Color.fromARGB((a * 255).round(), ch(1), ch(2), ch(3));
  }

  /// Tokens from a skin.json "tokens" object. Anything missing comes from a base that matches the background (dark or
  /// light); null when there is nothing usable in it.
  static PekTokens? tokensFrom(Map<String, dynamic> j) {
    final bg = j['bg'] is String ? parseColor(j['bg'] as String) : null;
    final base = (bg ?? Skins.ember.bg).computeLuminance() < 0.5 ? Skins.ember : PekTokens.light;
    Color pick(String k, Color d) => j[k] is String ? (parseColor(j[k] as String) ?? d) : d;
    var any = false;
    for (final k in _colorKeys) {
      if (j[k] is String && parseColor(j[k] as String) != null) any = true;
    }
    if (!any && j['radius'] == null) return null;
    final r = j['radius'] is String ? double.tryParse((j['radius'] as String).replaceAll('px', '').trim()) : (j['radius'] is num ? (j['radius'] as num).toDouble() : null);
    final dark = (bg ?? base.bg).computeLuminance() < 0.5;
    return PekTokens(
      bg: pick('bg', base.bg),
      bgElevated: pick('bgElevated', base.bgElevated),
      surface: pick('surface', base.surface),
      surfaceFocused: pick('surfaceFocused', base.surfaceFocused),
      border: pick('border', base.border),
      borderFocus: pick('borderFocus', base.borderFocus),
      text: pick('text', base.text),
      textMuted: pick('textMuted', base.textMuted),
      accent: pick('accent', base.accent),
      accentGlow: pick('accentGlow', base.accentGlow),
      overlay: pick('overlay', dark ? Skins.ember.overlay : PekTokens.light.overlay),
      shadow: pick('shadow', dark ? Skins.ember.shadow : PekTokens.light.shadow),
      glassStrong: pick('glassStrong', dark ? Skins.neon.glassStrong : PekTokens.light.glassStrong),
      radius: (r ?? base.radius).clamp(0.0, 40.0).toDouble(),
    );
  }

  /// The colours as #rrggbb / #rrggbbaa (CSS order) and the radius as "14px": what the Skin maker plugin reads and writes.
  static Map<String, String> tokensToHex(PekTokens t) => {
        'bg': hex(t.bg),
        'bgElevated': hex(t.bgElevated),
        'surface': hex(t.surface),
        'surfaceFocused': hex(t.surfaceFocused),
        'border': hex(t.border),
        'borderFocus': hex(t.borderFocus),
        'text': hex(t.text),
        'textMuted': hex(t.textMuted),
        'accent': hex(t.accent),
        'accentGlow': hex(t.accentGlow),
        'overlay': hex(t.overlay),
        'shadow': hex(t.shadow),
        'glassStrong': hex(t.glassStrong),
        'radius': '${t.radius.round()}px',
      };

  static Map<String, String> tokensTo(PekTokens t) {
    final dark = t.bg.computeLuminance() < 0.5;
    String rgba(Color c) => 'rgba(${c.red}, ${c.green}, ${c.blue}, ${(c.alpha / 255).toStringAsFixed(2)})';
    return {
      'bg': hex(t.bg),
      'bgElevated': hex(t.bgElevated),
      'surface': hex(t.surface),
      'surfaceFocused': hex(t.surfaceFocused),
      'border': hex(t.border),
      'borderFocus': hex(t.borderFocus),
      'text': hex(t.text),
      'textMuted': hex(t.textMuted),
      'accent': hex(t.accent),
      'accentGlow': rgba(t.accentGlow),
      'radius': '${t.radius.round()}px',
      'overlay': rgba(t.overlay),
      'shadow': rgba(t.shadow),
      // The web skins also carry the glass colours; the Flutter app only needs glassStrong.
      'glass': dark ? 'rgba(10, 14, 24, 0.45)' : 'rgba(255, 255, 255, 0.50)',
      'glassStrong': rgba(t.glassStrong),
      'glassFill': dark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.55)',
      'glassEdge': dark ? 'rgba(255, 255, 255, 0.10)' : 'rgba(60, 48, 38, 0.14)',
    };
  }

  /// The text of a skin.json for [skin] (what the web build installs from a .zip).
  static String toText(Skin skin) => const JsonEncoder.withIndent('  ').convert({
        'name': skin.name,
        'author': skin.author.isEmpty ? 'PEK TV' : skin.author,
        'version': skin.version.isEmpty ? '1.0.0' : skin.version,
        'description': skin.description,
        'pek_api': 1,
        'tokens': tokensTo(skin.tokens),
      });

  /// A skin from pasted skin.json text, or null when it is not one.
  static Skin? fromText(String text) {
    try {
      final j = jsonDecode(text);
      if (j is! Map) return null;
      final tokens = tokensFrom((j['tokens'] as Map?)?.cast<String, dynamic>() ?? const {});
      if (tokens == null) return null;
      final name = '${j['name'] ?? ''}'.trim();
      return Skin(Skins.newId(), name.isEmpty ? 'Imported skin' : name, '${j['description'] ?? ''}', tokens, custom: true, author: '${j['author'] ?? ''}');
    } catch (_) {
      return null;
    }
  }

  /// WCAG contrast ratio of two colours.
  static double contrast(Color a, Color b) {
    final la = a.computeLuminance(), lb = b.computeLuminance();
    return (math.max(la, lb) + 0.05) / (math.min(la, lb) + 0.05);
  }

  /// The web theme's guard (pekThemeUnreadable): text must keep a contrast of 2 on the background, cards and bars.
  static bool unreadable(PekTokens t) => contrast(t.text, t.bg) < 2 || contrast(t.text, t.surface) < 2 || contrast(t.text, t.bgElevated) < 2;

  /// The colours a skin needs besides its four main ones, worked out from them.
  static PekTokens derive({required Color bg, required Color surface, required Color text, required Color accent, required double radius}) {
    final dark = bg.computeLuminance() < 0.5;
    return PekTokens(
      bg: bg,
      bgElevated: Color.lerp(bg, surface, 0.5)!,
      surface: surface,
      surfaceFocused: accent.withAlpha(0x2A),
      border: Color.lerp(bg, text, 0.14)!,
      borderFocus: accent,
      text: text,
      textMuted: Color.lerp(text, bg, 0.42)!,
      accent: accent,
      accentGlow: accent.withAlpha(0x66),
      overlay: dark ? Skins.ember.overlay : PekTokens.light.overlay,
      shadow: dark ? Skins.ember.shadow : PekTokens.light.shadow,
      glassStrong: Color.lerp(bg, surface, 0.6)!.withAlpha(0xF0),
      radius: radius,
    );
  }
}
