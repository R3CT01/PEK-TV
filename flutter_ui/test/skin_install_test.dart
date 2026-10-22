import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/plugin_store.dart' show PluginFile, StoreException;
import 'package:pek_tv_ui/src/skin_install.dart';

import 'skin_zip_writer.dart';

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

  group('SkinInstaller.prepare', () {
    test('skin.json at the top of the zip or inside one folder', () {
      expect(SkinInstaller.prepare(zipOf([f('skin.json', ok)], folder: ''), fileName: 'a.zip').id, 'x');
      expect(SkinInstaller.prepare(zipOf([f('skin.json', ok)], folder: 'my-skin'), fileName: 'a.zip').id, 'my-skin');
    });

    test('refuses code, network css, @import and path tricks', () {
      expectRefused(zipOf([f('skin.json', ok), f('evil.js', '1')]), "can't contain code");
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', 'a{background:url(https://evil/x.png)}')]), 'CSS');
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', '@import "a.css";')]), 'CSS');
      expectRefused(zipOf([f('skin.json', ok), f('skin.css', 'a{content:"\\41"}')]), 'CSS');
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
