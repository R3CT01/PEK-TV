import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';

import 'plugin_store.dart' show PluginFile;
import 'plugin_zip.dart';
import 'skin_install.dart';
import 'skins.dart';
import 'tokens.dart';

/// Makes skins from code. The Dart twin of `tools/make_skin.py`: the same four-colours-in, everything-else-derived rule
/// (`SkinJson.derive`), and the same skin.json / .zip layout the web build and the installer read.
///
///     // four colours, the rest follows
///     final skin = SkinBuilder('Sunset')
///         .colors(bg: '#1a0f14', surface: '#2a1820', text: '#fff1e8', accent: '#ffb347')
///         .corners(14)
///         .by('Me')
///         .build();
///
///     // one accent is enough; a hue works too
///     final ocean = SkinBuilder.fromAccent('Ocean', const Color(0xFF38BDF8)).build();
///     final moss  = SkinBuilder.fromHue('Moss', 140, dark: false).build();
///
///     await skin.save();                       // adds it to Settings > Appearance
///     final zip = skin.zip();                  // an installable .zip (skin-id/skin.json), same as the web build installs
///     final text = skin.skinJson();            // the skin.json text
///     await SkinBuilder.installAll([a, b]);    // many at once
///
/// A made skin is checked like an installed one: unreadable text and anything the installer would refuse throw a
/// [SkinBuildException] with a plain message.
class SkinBuildException implements Exception {
  const SkinBuildException(this.message);
  final String message;
  @override
  String toString() => message;
}

class SkinBuilder {
  SkinBuilder(this.name);

  /// One accent colour; the background, cards and text are worked out from its hue (dark skin unless [dark] is false).
  factory SkinBuilder.fromAccent(String name, Color accent, {bool dark = true}) {
    final b = SkinBuilder(name).._accent = accent;
    b._hue = HSLColor.fromColor(accent).hue;
    b._dark = dark;
    return b;
  }

  /// Only a hue (0-360).
  factory SkinBuilder.fromHue(String name, double hue, {bool dark = true}) {
    final b = SkinBuilder(name).._hue = hue % 360;
    b._dark = dark;
    b._accent = HSLColor.fromAHSL(1, hue % 360, 0.85, dark ? 0.60 : 0.42).toColor();
    return b;
  }

  /// A copy of an existing skin to change a few things on.
  factory SkinBuilder.from(Skin s) {
    final t = s.tokens;
    return SkinBuilder(s.name)
      ..id = s.id
      .._author = s.author
      .._version = s.version
      .._description = s.description
      .._bg = t.bg
      .._surface = t.surface
      .._text = t.text
      .._accent = t.accent
      .._radius = t.radius
      .._dark = t.bg.computeLuminance() < 0.5;
  }

  final String name;

  /// The skin's id when it is stored. Leave null to get one from the name (`pkg-<slug>`).
  String? id;
  String _author = '', _version = '', _description = '';
  Color? _bg, _surface, _text, _accent;
  double? _hue;
  double _radius = 16;
  bool _dark = true;
  bool _force = false, _glowOn = false;
  String? _css;
  final Map<String, String> _tokenOverrides = {};
  final Map<String, List<int>> _extraFiles = {};

  // ------------------------------------------------------------------ setters (each returns the builder)

  /// Colours as '#rgb', '#rrggbb', '#rrggbbaa' or 'rgba(r, g, b, a)' text, or [Color]s. Leave one out and it is worked out.
  SkinBuilder colors({Object? bg, Object? surface, Object? text, Object? accent}) {
    Color? c(Object? v, String what) {
      if (v == null) return null;
      if (v is Color) return v;
      final p = SkinJson.parseColor('$v');
      if (p == null) throw SkinBuildException('$what is not a colour: $v (use #rrggbb)');
      return p;
    }

    _bg = c(bg, 'bg') ?? _bg;
    _surface = c(surface, 'surface') ?? _surface;
    _text = c(text, 'text') ?? _text;
    _accent = c(accent, 'accent') ?? _accent;
    return this;
  }

  /// Corner size in px, 0-40.
  SkinBuilder corners(double px) {
    if (px < 0 || px > 40) throw const SkinBuildException('the corner size is 0 to 40');
    _radius = px;
    return this;
  }

  SkinBuilder by(String author) {
    _author = author;
    return this;
  }

  SkinBuilder describe(String description) {
    _description = description;
    return this;
  }

  SkinBuilder version(String v) {
    _version = v;
    return this;
  }

  /// Dark or light, for colours that are worked out.
  SkinBuilder light([bool on = true]) {
    _dark = !on;
    return this;
  }

  /// Set one token by hand (any key of a skin.json "tokens" object, e.g. 'textMuted', 'border', 'bgImage'). It goes into
  /// the skin.json; the Flutter UI uses the colour and radius tokens, and ignores 'bgImage' and the glass tokens.
  SkinBuilder token(String key, String value) {
    if (key != 'bgImage' && key != 'radius' && SkinJson.parseColor(value) == null) {
      throw SkinBuildException('tokens.$key is not a colour: $value (use #rrggbb)');
    }
    _tokenOverrides[key] = value;
    return this;
  }

  /// A soft accent glow behind the app (the web UI only; the Flutter UI has no background image).
  SkinBuilder glow([bool on = true]) {
    _glowOn = on;
    return this;
  }

  /// Styling for the web build (skin.css). The Flutter UI does not use it. Checked with the installer's CSS rules.
  SkinBuilder css(String css) {
    _css = css;
    return this;
  }

  /// An extra file for the zip (an image or font that skin.css refers to), by its path inside the skin.
  SkinBuilder file(String path, List<int> bytes) {
    _extraFiles[path] = bytes;
    return this;
  }

  /// Allow text that is hard to read on the background.
  SkinBuilder force([bool on = true]) {
    _force = on;
    return this;
  }

  // ------------------------------------------------------------------ results

  static String _glow(PekTokens t) {
    String rgb(Color c) => '${c.red}, ${c.green}, ${c.blue}';
    final a = rgb(t.accent), b = rgb(t.bg);
    return 'radial-gradient(ellipse at 50% -10%, rgba($a, 0.30) 0%, rgba($a, 0.12) 38%, rgba($b, 0) 72%), '
        'radial-gradient(ellipse at 50% 115%, rgba($a, 0.18) 0%, rgba($b, 0) 60%)';
  }

  PekTokens _tokens() {
    final haveAll = _bg != null && _surface != null && _text != null && _accent != null;
    if (!haveAll && _accent == null && _hue == null) {
      throw const SkinBuildException('give an accent colour (or a hue), or all of bg, surface, text and accent');
    }
    final hue = _hue ?? HSLColor.fromColor(_accent!).hue;
    Color hsl(double s, double l) => HSLColor.fromAHSL(1, hue, s, l).toColor();
    final accent = _accent ?? hsl(0.85, _dark ? 0.60 : 0.42);
    final bg = _bg ?? (_dark ? hsl(0.40, 0.06) : hsl(0.25, 0.90));
    final surface = _surface ?? (_dark ? hsl(0.32, 0.12) : hsl(0.30, 0.96));
    final text = _text ?? (_dark ? hsl(0.60, 0.95) : hsl(0.30, 0.14));
    return SkinJson.derive(bg: bg, surface: surface, text: text, accent: accent, radius: _radius);
  }

  static const _flutterKeys = {
    'bg', 'bgElevated', 'surface', 'surfaceFocused', 'border', 'borderFocus', 'text', 'textMuted', 'accent', 'accentGlow', 'radius', 'overlay', 'shadow', 'glassStrong',
  };

  /// The skin id this builder stores under.
  String get skinId => id ?? '${Skins.installedPrefix}${PluginZip.slug(name).isEmpty ? 'skin' : PluginZip.slug(name)}';

  /// The finished skin. Throws a [SkinBuildException] when it would not be readable or would be refused on install.
  Skin build() {
    if (name.trim().isEmpty) throw const SkinBuildException('a skin needs a name');
    final slug = PluginZip.slug(id == null ? name : id!.replaceFirst(Skins.installedPrefix, ''));
    if (slug.isEmpty) throw const SkinBuildException('could not make an id from the name; set builder.id');
    if (SkinInstaller.reservedIds.contains(slug)) {
      throw SkinBuildException('\u201c$slug\u201d is the id of a skin that ships with PEK TV; pick another name');
    }
    var tokens = _tokens();
    if (_tokenOverrides.keys.any((k) => k != 'bgImage')) tokens = _mergeOverrides(tokens);
    if (!_force && SkinJson.unreadable(tokens)) {
      throw const SkinBuildException('the text would be hard to read on the background, the cards or the bars. Use a lighter text or a darker background, or call force().');
    }
    return Skin(skinId, name.trim(), _description, tokens, custom: true, author: _author, version: _version, source: const {'type': 'zip'});
  }

  /// Applies hand-set colour tokens on top of the derived ones.
  PekTokens _mergeOverrides(PekTokens t) {
    Color pick(String k, Color d) => SkinJson.parseColor(_tokenOverrides[k] ?? '') ?? d;
    final r = double.tryParse((_tokenOverrides['radius'] ?? '').replaceAll('px', '').trim());
    return PekTokens(
      bg: pick('bg', t.bg),
      bgElevated: pick('bgElevated', t.bgElevated),
      surface: pick('surface', t.surface),
      surfaceFocused: pick('surfaceFocused', t.surfaceFocused),
      border: pick('border', t.border),
      borderFocus: pick('borderFocus', t.borderFocus),
      text: pick('text', t.text),
      textMuted: pick('textMuted', t.textMuted),
      accent: pick('accent', t.accent),
      accentGlow: pick('accentGlow', t.accentGlow),
      overlay: pick('overlay', t.overlay),
      shadow: pick('shadow', t.shadow),
      glassStrong: pick('glassStrong', t.glassStrong),
      radius: (r ?? t.radius).clamp(0.0, 40.0).toDouble(),
    );
  }

  /// The skin.json text (tokens in the web UI's shape, plus any hand-set tokens such as bgImage).
  String skinJson() {
    final skin = build();
    final tokens = SkinJson.tokensTo(skin.tokens);
    // The tokens the Flutter UI reads are already in [tokens] (overrides included); the rest (glass, bgImage, ...) go in as typed.
    for (final e in _tokenOverrides.entries) {
      if (!_flutterKeys.contains(e.key)) tokens[e.key] = e.value;
    }
    if (_glowOn && !_tokenOverrides.containsKey('bgImage')) tokens['bgImage'] = _glow(skin.tokens);
    return const JsonEncoder.withIndent('  ').convert({
      'name': skin.name,
      'author': skin.author.isEmpty ? 'PEK TV' : skin.author,
      'version': skin.version.isEmpty ? '1.0.0' : skin.version,
      'description': skin.description,
      'pek_api': 1,
      'tokens': tokens,
    });
  }

  /// The files of the skin (skin.json, skin.css when there is one, and the extra files), checked like an install.
  List<PluginFile> files() {
    build();
    final out = <PluginFile>[
      PluginFile('skin.json', Uint8List.fromList(utf8.encode('${skinJson()}\n'))),
      if (_css != null) PluginFile('skin.css', Uint8List.fromList(utf8.encode(_css!))),
      for (final e in _extraFiles.entries) PluginFile(e.key, Uint8List.fromList(e.value)),
    ];
    final why = SkinInstaller.checkFiles(out);
    if (why.isNotEmpty) throw SkinBuildException(why);
    return out;
  }

  /// An installable .zip: `<id>/skin.json` (+ skin.css and the extra files). The web build installs it, and so does
  /// Settings > Appearance > Install from .zip.
  Uint8List zip() {
    final folder = skinId.replaceFirst(Skins.installedPrefix, '');
    return SkinZipWriter.write(folder, files());
  }

  /// Adds the skin to this device (Settings > Appearance), replacing one with the same id.
  Future<Skin> save() async {
    final skin = build();
    await Skins.saveCustom(skin);
    return skin;
  }

  /// Makes and stores many skins; returns the ones stored. Stops at the first one that cannot be built.
  static Future<List<Skin>> installAll(Iterable<SkinBuilder> builders) async {
    final out = <Skin>[];
    for (final b in builders) {
      out.add(await b.save());
    }
    return out;
  }
}

/// Writes a .zip with the files stored (no compression; skins are a few KB). What `PluginZip.read` and the web
/// installer read.
class SkinZipWriter {
  static Uint8List write(String folder, List<PluginFile> files) {
    final out = BytesBuilder();
    final central = BytesBuilder();
    var count = 0;
    void u16(BytesBuilder b, int v) => b.add([v & 0xff, (v >> 8) & 0xff]);
    void u32(BytesBuilder b, int v) => b.add([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
    const dosDate = 0x0021; // 1980-01-01, so the same skin gives the same bytes every time
    for (final f in files) {
      final name = utf8.encode(folder.isEmpty ? f.path : '$folder/${f.path}');
      final crc = _crc32(f.data);
      final offset = out.length;
      u32(out, 0x04034b50);
      u16(out, 20);
      u16(out, 0x0800); // names are UTF-8
      u16(out, 0); // stored
      u16(out, 0);
      u16(out, dosDate);
      u32(out, crc);
      u32(out, f.data.length);
      u32(out, f.data.length);
      u16(out, name.length);
      u16(out, 0);
      out.add(name);
      out.add(f.data);

      u32(central, 0x02014b50);
      u16(central, 20);
      u16(central, 20);
      u16(central, 0x0800);
      u16(central, 0);
      u16(central, 0);
      u16(central, dosDate);
      u32(central, crc);
      u32(central, f.data.length);
      u32(central, f.data.length);
      u16(central, name.length);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u32(central, 0x81A40000); // -rw-r--r--
      u32(central, offset);
      central.add(name);
      count++;
    }
    final cdOffset = out.length;
    final cd = central.takeBytes();
    out.add(cd);
    u32(out, 0x06054b50);
    u16(out, 0);
    u16(out, 0);
    u16(out, count);
    u16(out, count);
    u32(out, cd.length);
    u32(out, cdOffset);
    u16(out, 0);
    return out.takeBytes();
  }

  static Uint32List? _table;
  static int _crc32(List<int> bytes) {
    var t = _table;
    if (t == null) {
      t = Uint32List(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1);
        }
        t[n] = c;
      }
      _table = t;
    }
    var crc = 0xFFFFFFFF;
    for (final b in bytes) {
      crc = t[(crc ^ b) & 0xff] ^ (crc >> 8);
    }
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF;
  }
}
