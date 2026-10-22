import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/plugin_store.dart' show PluginFile, StoreException;
import 'package:pek_tv_ui/src/skin_builder.dart';
import 'package:pek_tv_ui/src/skin_install.dart';

PluginFile f(String path, String text) => PluginFile(path, Uint8List.fromList(utf8.encode(text)));
Uint8List zipOf(List<PluginFile> files, {String folder = 'x'}) => SkinZipWriter.write(folder, files);

void expectRefused(Uint8List zip, Pattern message) {
  expect(
    () => SkinInstaller.prepare(zip, fileName: 'x.zip'),
    throwsA(isA<StoreException>().having((e) => e.message, 'message', contains(message))),
  );
}

void main() {
  const ok = '{"name":"X","tokens":{"bg":"#101010","text":"#f0f0f0","accent":"#ff8800"}}';

  group('SkinBuilder', () {
    test('four colours -> skin -> zip -> prepare gives the same skin back', () {
      final b = SkinBuilder('Sunset').colors(bg: '#1a0f14', surface: '#2a1820', text: '#fff1e8', accent: '#ffb347').corners(14).by('Me');
      final prep = SkinInstaller.prepare(b.zip(), fileName: 'sunset.zip');
      expect(prep.id, 'sunset');
      expect(prep.skinId, 'pkg-sunset');
      expect(prep.name, 'Sunset');
      expect(prep.author, 'Me');
      expect(prep.tokens.accent, const Color(0xFFFFB347));
      expect(prep.tokens.radius, 14);
      expect(prep.hasCss, false);
    });

    test('one accent is enough, light or dark', () {
      final dark = SkinBuilder.fromAccent('Ocean', const Color(0xFF38BDF8)).build();
      final light = SkinBuilder.fromAccent('Paper', const Color(0xFF38BDF8), dark: false).build();
      expect(dark.tokens.bg.computeLuminance(), lessThan(0.5));
      expect(light.tokens.bg.computeLuminance(), greaterThan(0.5));
    });

    test('a hue alone makes a skin', () {
      expect(() => SkinBuilder.fromHue('Moss', 140).build(), returnsNormally);
    });

    test('unreadable text is refused unless forced', () {
      SkinBuilder bad() => SkinBuilder('Bad').colors(bg: '#222222', surface: '#222222', text: '#2a2a2a', accent: '#ffffff');
      expect(() => bad().build(), throwsA(isA<SkinBuildException>()));
      expect(() => bad().force().build(), returnsNormally);
    });

    test('a built-in id is refused', () {
      expect(() => SkinBuilder('Neon').colors(accent: '#00ffff').build(), throwsA(isA<SkinBuildException>()));
    });

    test('css and extra files go in the zip and are checked', () {
      final b = SkinBuilder.fromAccent('Styled', const Color(0xFFFF0066)).css('.card{border-radius:8px}');
      final prep = SkinInstaller.prepare(b.zip(), fileName: 's.zip');
      expect(prep.hasCss, true);
      expect(() => SkinBuilder.fromAccent('Evil', const Color(0xFFFF0066)).css('@import "a.css";').zip(), throwsA(isA<SkinBuildException>()));
    });

    test('skin.json keeps hand-set tokens (bgImage, glass) and the glow', () {
      final j = jsonDecode(SkinBuilder.fromAccent('Glow', const Color(0xFFFF0066)).glow().token('glass', 'rgba(1, 2, 3, 0.4)').skinJson()) as Map;
      final tokens = j['tokens'] as Map;
      expect(tokens['glass'], 'rgba(1, 2, 3, 0.4)');
      expect(tokens['bgImage'], startsWith('radial-gradient('));
    });
  });

  group('SkinInstaller.prepare', () {
    test('skin.json at the top of the zip or inside one folder', () {
      expect(SkinInstaller.prepare(zipOf([f('skin.json', ok)], folder: ''), fileName: 'a.zip').id, 'x');
      expect(SkinInstaller.prepare(zipOf([f('skin.json', ok)], folder: 'my-skin'), fileName: 'a.zip').id, 'my-skin');
    });

    test('refuses code, network css, @import and path tricks', () {
      expectRefused(zipOf([f('skin.json', ok), f('evil.js', '1')]), "can't contain code");
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', 'a{background:url(https://evil/x.png)}')]), 'outside the skin');
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', '@import "a.css";')]), '@import');
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', 'a{content:"\\41"}')]), 'backslash');
      expectRefused(zipOf([f('skin.json', ok), f('icon.svg', '<svg/>')]), 'file type not allowed');
    });

    test('a plugin is not a skin, and a zip with both is refused', () {
      expectRefused(zipOf([f('plugin.json', '{}')]), 'plugin, not a skin');
      expectRefused(zipOf([f('plugin.json', '{}'), f('skin.json', ok)]), 'both plugin.json and skin.json');
    });

    test('needs a name and some colours the app can use', () {
      expectRefused(zipOf([f('skin.json', '{"tokens":{"bg":"#000000"}}')]), 'needs a');
      expectRefused(zipOf([f('skin.json', '{"name":"Css only"}')]), 'colours or corner size');
    });

    test('text that cannot be read is refused', () {
      expectRefused(zipOf([f('skin.json', '{"name":"Dim","tokens":{"bg":"#222222","surface":"#222222","bgElevated":"#222222","text":"#2a2a2a"}}')]), 'hard to read');
    });

    test('a built-in id is refused', () {
      expectRefused(zipOf([f('skin.json', ok)], folder: 'neon'), 'ships with PEK TV');
    });
  });

  group('SkinInstaller.checkPath', () {
    test('plain relative paths only', () {
      expect(SkinInstaller.checkPath('img/a.png'), '');
      expect(SkinInstaller.checkPath('../a.css'), isNotEmpty);
      expect(SkinInstaller.checkPath('/etc/a.css'), isNotEmpty);
      expect(SkinInstaller.checkPath('.hidden.css'), isNotEmpty);
      expect(SkinInstaller.checkPath('a\\b.css'), isNotEmpty);
    });
  });
}
