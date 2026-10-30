import 'dart:math';

import 'package:flutter/material.dart';

import 'clock.dart';
import 'profiles.dart';
import 'tokens.dart';

/// Part of the day a greeting is written for.
enum DayPart { lateNight, earlyMorning, morning, afternoon, evening, night }

/// Random dashboard greetings. Each line is a template with three placeholders:
///   {user}     the active profile's name (dropped, with its comma, when the profile has no real name yet)
///   {greeting} "Good morning" / "Good afternoon" / "Good evening" / "Good night"
///   {tod}      "this morning" / "this afternoon" / "this evening" / "tonight"
class Greeting {
  /// The part of the day at [hour] (0-23).
  static DayPart partOf(int hour) {
    if (hour < 4) return DayPart.lateNight;
    if (hour < 7) return DayPart.earlyMorning;
    if (hour < 12) return DayPart.morning;
    if (hour < 17) return DayPart.afternoon;
    if (hour < 21) return DayPart.evening;
    return DayPart.night;
  }

  static String greetingWord(DayPart p) => switch (p) {
        DayPart.lateNight || DayPart.night => 'Good night',
        DayPart.earlyMorning || DayPart.morning => 'Good morning',
        DayPart.afternoon => 'Good afternoon',
        DayPart.evening => 'Good evening',
      };

  static String todWord(DayPart p) => switch (p) {
        DayPart.lateNight || DayPart.night => 'tonight',
        DayPart.earlyMorning || DayPart.morning => 'this morning',
        DayPart.afternoon => 'this afternoon',
        DayPart.evening => 'this evening',
      };

  static const _any = <String>[
    'Hello {user}, how are we feeling {tod}?',
    '{greeting}, {user}.',
    'Welcome back, {user}.',
    'Hey {user}, what are we watching {tod}?',
    'Hi {user}, ready when you are.',
    '{greeting}, {user}. What\'s the plan?',
  ];

  static const _byPart = <DayPart, List<String>>{
    DayPart.lateNight: [
      '{user}, it\'s the middle of the night. Is everything okay?',
      '{greeting}, {user}. Burning the midnight oil, are we?',
      'Still up, {user}? Let\'s make it a good one.',
    ],
    DayPart.earlyMorning: [
      '{greeting}, {user}. We are up early, aren\'t we?',
      '{greeting}, {user}. Early bird today!',
      'Rise and shine, {user}. Coffee first?',
    ],
    DayPart.morning: [
      '{greeting}, {user}. Hope the day is off to a good start.',
      '{greeting}, {user}! Fresh start, fresh watchlist.',
      'Morning, {user}. What are we in the mood for?',
    ],
    DayPart.afternoon: [
      '{greeting}, {user}. How is the day treating us?',
      'Taking a break, {user}? You\'ve earned it.',
      'Hello {user}, how are we feeling {tod}?',
    ],
    DayPart.evening: [
      'Hello {user}, how are we feeling {tod}?',
      '{greeting}, {user}. Time to wind down.',
      'Settle in, {user}. The evening is ours.',
    ],
    DayPart.night: [
      '{greeting}, {user}. One more episode?',
      'Hello {user}, how are we feeling {tod}?',
      'Cozy night in, {user}?',
    ],
  };

  static String? _last;
  static final _rnd = Random();

  /// A random template for [part], never the same one twice in a row.
  static String pick(DayPart part, {Random? rnd}) {
    final pool = [..._any, ...?_byPart[part]];
    final r = rnd ?? _rnd;
    var t = pool[r.nextInt(pool.length)];
    if (pool.length > 1 && t == _last) t = pool[(pool.indexOf(t) + 1 + r.nextInt(pool.length - 1)) % pool.length];
    _last = t;
    return t;
  }

  /// Fills in a template. An empty [name] (or the "Profile 1" default) leaves the name out.
  static String fill(String template, DayPart part, String name) {
    final n = name.trim();
    final named = n.isNotEmpty && !RegExp(r'^Profile \d+$').hasMatch(n);
    var s = template;
    if (!named) {
      s = s
          .replaceAll(RegExp(r',? \{user\}'), '') // "Hello {user}," / "{greeting}, {user}."
          .replaceAll('{user}, ', '')
          .replaceAll('{user}', '');
      s = s.replaceAll(RegExp(r'\s+([,.!?])'), r'$1').trim();
      if (s.isNotEmpty) s = s[0].toUpperCase() + s.substring(1);
    } else {
      s = s.replaceAll('{user}', n);
    }
    return s.replaceAll('{greeting}', greetingWord(part)).replaceAll('{tod}', todWord(part));
  }

  /// The part of the day right now, in the Clock widget's time zone (this device's own zone unless one is chosen).
  static DayPart now() => partOf(Clock.wall(DateTime.now().toUtc(), Clock.tz).hour);
}

/// The line at the top of the Dashboard. The line is picked once each time the Dashboard opens; the name follows the active profile.
class GreetingBanner extends StatefulWidget {
  const GreetingBanner({super.key});
  @override
  State<GreetingBanner> createState() => _GreetingBannerState();
}

class _GreetingBannerState extends State<GreetingBanner> {
  late final DayPart _part = Greeting.now();
  late final String _template = Greeting.pick(_part);

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return ValueListenableBuilder<int>(
      valueListenable: Profiles.changes,
      builder: (context, _, __) => Padding(
        padding: EdgeInsets.only(bottom: 0.6 * p.rem),
        child: Text(
          Greeting.fill(_template, _part, Profiles.current.name),
          style: TextStyle(fontSize: (p.narrow ? 1.05 : 1.2) * p.rem, color: p.tokens.textMuted, fontWeight: FontWeight.w500),
        ),
      ),
    );
  }
}
