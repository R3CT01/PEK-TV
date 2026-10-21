import 'dart:async';

import 'package:flutter/material.dart';

import 'common.dart';
import 'settings_extra.dart' show ToggleRow;
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// One time zone offered in Clock settings (CLOCK_ZONES in www/app_config.js). [std] is the winter offset from UTC in
/// minutes; [rule] says when daylight saving applies ('' = never).
class ClockZone {
  const ClockZone(this.id, this.label, this.std, [this.rule = '']);
  final String id;
  final String label;
  final int std;
  final String rule;
}

/// The Clock dashboard widget's choices (24-hour time, show date, time zone), a port of the clock part of app_appearance.js.
/// They belong to the device (not to a profile) and are not synced, like the web UI.
///
/// Time zones are worked out here from each zone's own rule instead of a time-zone database, so no extra package is needed:
/// US / Canada (2nd Sunday of March to 1st Sunday of November), EU / UK (last Sunday of March to last Sunday of October),
/// Sydney, Auckland and Cairo. Zones that no longer change their clocks have a fixed offset.
class Clock {
  static const _k12 = 'pek_clock_12h';
  static const _kDate = 'pek_clock_show_date';
  static const _kTz = 'pek_clock_tz'; // '' = this device's own zone

  static const zones = <ClockZone>[
    ClockZone('UTC', 'UTC', 0),
    ClockZone('Pacific/Honolulu', 'Honolulu', -600),
    ClockZone('America/Anchorage', 'Anchorage', -540, 'us'),
    ClockZone('America/Los_Angeles', 'Los Angeles', -480, 'us'),
    ClockZone('America/Phoenix', 'Phoenix', -420),
    ClockZone('America/Denver', 'Denver', -420, 'us'),
    ClockZone('America/Chicago', 'Chicago', -360, 'us'),
    ClockZone('America/Mexico_City', 'Mexico City', -360),
    ClockZone('America/New_York', 'New York', -300, 'us'),
    ClockZone('America/Toronto', 'Toronto', -300, 'us'),
    ClockZone('America/Sao_Paulo', 'S\u00e3o Paulo', -180),
    ClockZone('America/Argentina/Buenos_Aires', 'Buenos Aires', -180),
    ClockZone('Atlantic/Reykjavik', 'Reykjav\u00edk', 0),
    ClockZone('Europe/London', 'London', 0, 'eu'),
    ClockZone('Europe/Paris', 'Paris', 60, 'eu'),
    ClockZone('Europe/Berlin', 'Berlin', 60, 'eu'),
    ClockZone('Europe/Madrid', 'Madrid', 60, 'eu'),
    ClockZone('Europe/Rome', 'Rome', 60, 'eu'),
    ClockZone('Europe/Athens', 'Athens', 120, 'eu'),
    ClockZone('Europe/Istanbul', 'Istanbul', 180),
    ClockZone('Europe/Moscow', 'Moscow', 180),
    ClockZone('Africa/Lagos', 'Lagos', 60),
    ClockZone('Africa/Cairo', 'Cairo', 120, 'egypt'),
    ClockZone('Africa/Nairobi', 'Nairobi', 180),
    ClockZone('Africa/Johannesburg', 'Johannesburg', 120),
    ClockZone('Asia/Dubai', 'Dubai', 240),
    ClockZone('Asia/Karachi', 'Karachi', 300),
    ClockZone('Asia/Kolkata', 'Mumbai / Delhi', 330),
    ClockZone('Asia/Dhaka', 'Dhaka', 360),
    ClockZone('Asia/Bangkok', 'Bangkok', 420),
    ClockZone('Asia/Singapore', 'Singapore', 480),
    ClockZone('Asia/Hong_Kong', 'Hong Kong', 480),
    ClockZone('Asia/Shanghai', 'Beijing / Shanghai', 480),
    ClockZone('Asia/Seoul', 'Seoul', 540),
    ClockZone('Asia/Tokyo', 'Tokyo', 540),
    ClockZone('Australia/Perth', 'Perth', 480),
    ClockZone('Australia/Sydney', 'Sydney', 600, 'au'),
    ClockZone('Pacific/Auckland', 'Auckland', 720, 'nz'),
  ];

  /// Bumped whenever one of the three choices changes.
  static final ValueNotifier<int> changes = ValueNotifier(0);

  /// 12-hour time. Until a choice is saved it follows the device's own setting.
  static bool hour12(BuildContext context) {
    final v = Store.strGet(_k12, scoped: false);
    return v == null ? !MediaQuery.alwaysUse24HourFormatOf(context) : v == '1';
  }

  static bool get showDate => Store.strGet(_kDate, scoped: false) != '0';

  static String get tz {
    final z = Store.strGet(_kTz, scoped: false) ?? '';
    return zones.any((e) => e.id == z) ? z : '';
  }

  /// Saves a change like _saveClock: all three choices are written together.
  static Future<void> save(BuildContext context, {bool? hour12v, bool? showDateV, String? tzV}) async {
    final h = hour12v ?? hour12(context);
    final d = showDateV ?? showDate;
    final z = tzV ?? tz;
    await Store.strSet(_k12, h ? '1' : '0', scoped: false);
    await Store.strSet(_kDate, d ? '1' : '0', scoped: false);
    await Store.strSet(_kTz, z, scoped: false);
    changes.value++;
  }

  static String zoneLabel(String id) {
    for (final z in zones) {
      if (z.id == id) return z.label;
    }
    return id;
  }

  // ---- time zone arithmetic ----

  static DateTime _lastWeekday(int y, int m, int weekday) {
    final last = DateTime.utc(y, m + 1, 0);
    return last.subtract(Duration(days: (last.weekday - weekday + 7) % 7));
  }

  static DateTime _nthSunday(int y, int m, int n) {
    final first = DateTime.utc(y, m, 1);
    return DateTime.utc(y, m, 1 + (DateTime.sunday - first.weekday + 7) % 7 + 7 * (n - 1));
  }

  /// The moment (UTC) when a wall clock showing [hour] on [day] is read in a zone [off] minutes from UTC.
  static DateTime _at(DateTime day, int hour, int off) => day.add(Duration(hours: hour)).subtract(Duration(minutes: off));

  static bool _dst(ClockZone z, DateTime u) {
    final y = u.year;
    switch (z.rule) {
      case 'us':
        return !u.isBefore(_at(_nthSunday(y, 3, 2), 2, z.std)) && u.isBefore(_at(_nthSunday(y, 11, 1), 2, z.std + 60));
      case 'eu':
        return !u.isBefore(_lastWeekday(y, 3, DateTime.sunday).add(const Duration(hours: 1))) && u.isBefore(_lastWeekday(y, 10, DateTime.sunday).add(const Duration(hours: 1)));
      case 'au': // southern summer: from the 1st Sunday of October to the 1st Sunday of April
        return !u.isBefore(_at(_nthSunday(y, 10, 1), 2, z.std)) || u.isBefore(_at(_nthSunday(y, 4, 1), 3, z.std + 60));
      case 'nz': // last Sunday of September to the 1st Sunday of April
        return !u.isBefore(_at(_lastWeekday(y, 9, DateTime.sunday), 2, z.std)) || u.isBefore(_at(_nthSunday(y, 4, 1), 3, z.std + 60));
      case 'egypt': // last Friday of April to the last Thursday of October
        return !u.isBefore(_at(_lastWeekday(y, 4, DateTime.friday), 0, z.std)) && u.isBefore(_at(_lastWeekday(y, 10, DateTime.thursday).add(const Duration(days: 1)), 0, z.std + 60));
    }
    return false;
  }

  /// What a wall clock reads at [nowUtc] in [zoneId] ('' = this device), as a UTC-flagged DateTime whose fields are the wall time.
  static DateTime wall(DateTime nowUtc, String zoneId) {
    if (zoneId.isEmpty) {
      final l = nowUtc.toLocal();
      return DateTime.utc(l.year, l.month, l.day, l.hour, l.minute, l.second);
    }
    final z = zones.firstWhere((e) => e.id == zoneId, orElse: () => zones.first);
    return nowUtc.add(Duration(minutes: z.std + (_dst(z, nowUtc) ? 60 : 0)));
  }

  static String time(DateTime w, bool h12) {
    final mm = w.minute.toString().padLeft(2, '0');
    if (!h12) return '${w.hour.toString().padLeft(2, '0')}:$mm';
    final h = w.hour % 12 == 0 ? 12 : w.hour % 12;
    return '$h:$mm ${w.hour < 12 ? 'AM' : 'PM'}';
  }

  static String day(DateTime w) {
    const d = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return '${d[w.weekday - 1]}, ${m[w.month - 1]} ${w.day}';
  }

  /// The two lines of the clock tile (_clockLines): the time, and "day \u00b7 zone" (just the zone when the date is hidden).
  static ({String time, String dateLine}) lines(BuildContext context, DateTime nowUtc) {
    final z = tz;
    final w = wall(nowUtc, z);
    final zl = z.isEmpty ? '' : zoneLabel(z);
    final d = day(w);
    return (time: time(w, hour12(context)), dateLine: showDate ? (zl.isNotEmpty ? '$d \u00b7 $zl' : d) : zl);
  }
}

/// The Clock tile of the dashboard. Repaints itself when the minute changes (never the whole dashboard).
/// Tap = Clock settings; press and hold = [onLongPress] (customize the dashboard).
class ClockTile extends StatefulWidget {
  const ClockTile({super.key, this.onLongPress});
  final VoidCallback? onLongPress;
  @override
  State<ClockTile> createState() => _ClockTileState();
}

class _ClockTileState extends State<ClockTile> {
  Timer? _timer;
  String _shown = '';

  @override
  void initState() {
    super.initState();
    Clock.changes.addListener(_again);
    _timer = Timer.periodic(const Duration(seconds: 1), (_) => _again());
  }

  @override
  void dispose() {
    Clock.changes.removeListener(_again);
    _timer?.cancel();
    super.dispose();
  }

  void _again() {
    if (!mounted) return;
    final l = Clock.lines(context, DateTime.now().toUtc());
    final key = '${l.time}|${l.dateLine}';
    if (key != _shown) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final l = Clock.lines(context, DateTime.now().toUtc());
    _shown = '${l.time}|${l.dateLine}';
    return DashTile(
      big: l.time,
      sub: l.dateLine,
      onTap: () => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const ClockSettingsScreen())),
      onLongPress: widget.onLongPress,
    );
  }
}

/// Clock settings (_renderClockSettings): 24-hour time, show date and the time zone list, each zone with the time it shows now.
class ClockSettingsScreen extends StatelessWidget {
  const ClockSettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return SubScreen(
      title: 'Clock',
      body: ListenableBuilder(
        listenable: Clock.changes,
        builder: (context, _) {
          final h12 = Clock.hour12(context);
          final selected = Clock.tz;
          final now = DateTime.now().toUtc();
          return ListView(padding: p.pagePad, children: [
            Section(
              title: 'Display',
              children: [
                ToggleRow(title: '24-hour time', on: !h12, onTap: () => Clock.save(context, hour12v: !h12)),
                ToggleRow(title: 'Show date', on: Clock.showDate, onTap: () => Clock.save(context, showDateV: !Clock.showDate)),
              ],
            ),
            Section(
              title: 'Time zone',
              children: [
                for (final z in [const ClockZone('', 'This device', 0), ...Clock.zones])
                  ListRow(
                    title: '${selected == z.id ? '\u2713  ' : ''}${z.label}',
                    subtitle: () {
                      final w = Clock.wall(now, z.id);
                      return '${Clock.time(w, h12)} \u00b7 ${Clock.day(w)}';
                    }(),
                    onTap: () => Clock.save(context, tzV: z.id),
                  ),
              ],
            ),
          ]);
        },
      ),
    );
  }
}
