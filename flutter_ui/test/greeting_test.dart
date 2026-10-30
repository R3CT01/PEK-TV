import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/greeting.dart';

void main() {
  test('parts of the day', () {
    expect(Greeting.partOf(2), DayPart.lateNight);
    expect(Greeting.partOf(5), DayPart.earlyMorning);
    expect(Greeting.partOf(9), DayPart.morning);
    expect(Greeting.partOf(14), DayPart.afternoon);
    expect(Greeting.partOf(19), DayPart.evening);
    expect(Greeting.partOf(23), DayPart.night);
  });

  test('fills the name and time of day', () {
    expect(Greeting.fill('Hello {user}, how are we feeling {tod}?', DayPart.evening, 'Sam'), 'Hello Sam, how are we feeling this evening?');
    expect(Greeting.fill('{greeting}, {user}. We are up early, aren\'t we?', DayPart.earlyMorning, 'Sam'), 'Good morning, Sam. We are up early, aren\'t we?');
  });

  test('leaves the name out for the default profile', () {
    expect(Greeting.fill('Hello {user}, how are we feeling {tod}?', DayPart.evening, 'Profile 1'), 'Hello, how are we feeling this evening?');
    expect(Greeting.fill('{greeting}, {user}.', DayPart.morning, ''), 'Good morning.');
    expect(Greeting.fill('Welcome back, {user}.', DayPart.morning, ''), 'Welcome back.');
  });

  test('never the same line twice in a row', () {
    final r = Random(1);
    var prev = Greeting.pick(DayPart.evening, rnd: r);
    for (var i = 0; i < 200; i++) {
      final t = Greeting.pick(DayPart.evening, rnd: r);
      expect(t, isNot(prev));
      prev = t;
    }
  });
}
