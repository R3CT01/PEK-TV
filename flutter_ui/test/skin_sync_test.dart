import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/skins.dart';

void main() {
  group('skins in the cloud', () {
    test('every built-in look survives the trip to the cloud and back', () {
      for (final b in Skins.builtIn) {
        final skin = Skin('custom-abc123', b.name, b.description, b.tokens, custom: true, author: 'me', version: '1.2.3');
        final wire = jsonDecode(jsonEncode(Skins.syncValue(skin)));
        expect(jsonEncode(wire).length, lessThan(1900));
        final back = Skins.cleanSync('custom-abc123', wire, 42)!;
        expect(back.updated, 42);
        expect(back.name, b.name);
        expect(back.author, 'me');
        expect(SkinJson.tokensTo(back.tokens), SkinJson.tokensTo(b.tokens));
      }
    });

    test('a GitHub skin keeps where it came from', () {
      final skin = Skin('pkg-sunset', 'Sunset', '', Skins.ember,
          custom: true, source: const {'type': 'github', 'owner': 'a', 'repo': 'b', 'tag': 'v1', 'kind': 'asset'});
      final back = Skins.cleanSync('pkg-sunset', jsonDecode(jsonEncode(Skins.syncValue(skin))), 1)!;
      expect(back.fromGithub, isTrue);
      expect(back.source!['repo'], 'b');
    });

    test('nothing odd from the cloud is taken in', () {
      final good = Map<String, dynamic>.from(Skins.syncValue(Skin('custom-a', 'A', '', Skins.ember, custom: true)));
      expect(Skins.cleanSync('custom-a', good, 1), isNotNull);
      expect(Skins.cleanSync('../evil', good, 1), isNull); // not a skin id
      expect(Skins.cleanSync('custom-a', {...good, 'c': 'zz'}, 1), isNull); // colours of the wrong size
      expect(Skins.cleanSync('custom-a', {...good, 'c': 'x' * 104}, 1), isNull); // not hex
      expect(Skins.cleanSync('custom-a', 'text', 1), isNull);
      expect(Skins.cleanSync('custom-a', {...good, 'r': 9999}, 1)!.tokens.radius, 40); // corner size is kept in range
    });

    test('ids', () {
      expect(Skins.validId('custom-lq3x9'), isTrue);
      expect(Skins.validId('pkg-my-skin_2'), isTrue);
      expect(Skins.validId('ember'), isFalse);
      expect(Skins.validId('pkg-'), isFalse);
    });
  });
}
