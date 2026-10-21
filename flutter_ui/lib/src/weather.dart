import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import 'common.dart';
import 'fields.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Weather tile of the dashboard. Same source as plugins/weather: Open-Meteo (no key), a city you pick, Fahrenheit or
/// Celsius. The city and unit are kept on the device and also sync to the signed-in profile as the `s|weather` setting
/// (same item as the web UI, see Cloud), so a profile's other devices get the same city.
class Weather {
  static const _kCoords = 'pek_weather_coords';
  static const _kUnit = 'pek_weather_unit';
  static const _kLast = 'pek_weather_last';
  static final http.Client _c = http.Client();

  static const _codes = <int, String>{
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
    55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
  };

  /// Bumped when the city, the unit or the reading changes.
  static final ValueNotifier<int> changes = ValueNotifier(0);

  static String get unit => Store.strGet(_kUnit, scoped: false) == 'C' ? 'C' : 'F';
  /// Bumped only when the person changes the city or unit here (not when the cloud does): Cloud sync listens to it.
  static final ValueNotifier<int> edited = ValueNotifier(0);

  static Future<void> setUnit(String u) async {
    await Store.strSet(_kUnit, u, scoped: false);
    changes.value++;
    edited.value++;
  }

  static ({double lat, double lon, String label})? get city {
    try {
      final o = jsonDecode(Store.strGet(_kCoords, scoped: false) ?? 'null');
      if (o is Map && o['lat'] is num && o['lon'] is num && '${o['label'] ?? ''}'.isNotEmpty) return (lat: (o['lat'] as num).toDouble(), lon: (o['lon'] as num).toDouble(), label: '${o['label']}');
    } catch (_) {}
    return null;
  }

  static Future<void> setCity(double lat, double lon, String label) async {
    await Store.strSet(_kCoords, jsonEncode({'lat': lat, 'lon': lon, 'label': label}), scoped: false);
    await Store.strDel(_kLast, scoped: false);
    changes.value++;
    edited.value++;
  }

  static Future<void> clearCity() async {
    await Store.strDel(_kCoords, scoped: false);
    await Store.strDel(_kLast, scoped: false);
    changes.value++;
    edited.value++;
  }

  // ---- cloud sync (`s|weather`, the same shape the web UI sends: {coords: {lat, lon, label}, city, unit}) ----

  /// What this device has chosen, or null when nothing was ever chosen (a unit that was never changed is not synced).
  static Map<String, dynamic>? syncValue() {
    final out = <String, dynamic>{};
    final c = city;
    if (c != null) {
      out['coords'] = {'lat': c.lat, 'lon': c.lon, 'label': c.label};
      out['city'] = c.label;
    }
    final u = Store.strGet(_kUnit, scoped: false);
    if (u == 'F' || u == 'C') out['unit'] = u;
    return out.isEmpty ? null : out;
  }

  /// Checks a value that came from the cloud (same limits as the web UI). Null when nothing in it is usable.
  static Map<String, dynamic>? cleanSync(dynamic o) {
    if (o is! Map) return null;
    final out = <String, dynamic>{};
    final c = o['coords'];
    if (c is Map && c['lat'] is num && c['lon'] is num && c['label'] is String) {
      final lat = (c['lat'] as num).toDouble(), lon = (c['lon'] as num).toDouble(), label = c['label'] as String;
      if (lat.isFinite && lon.isFinite && lat.abs() <= 90 && lon.abs() <= 180 && label.isNotEmpty && label.length <= 120) {
        out['coords'] = {'lat': lat, 'lon': lon, 'label': label};
      }
    }
    final city = o['city'];
    if (city is String && city.isNotEmpty && city.length <= 120) out['city'] = city;
    if (o['unit'] == 'F' || o['unit'] == 'C') out['unit'] = o['unit'];
    return out.isEmpty ? null : out;
  }

  /// Puts a cleaned value from the cloud on this device. Only what the value has is changed (like the web UI).
  static void applySynced(Map<String, dynamic> o) {
    final c = o['coords'];
    if (c is Map) {
      final label = '${c['label']}';
      final changedCity = city?.label != label;
      unawaited(Store.strSet(_kCoords, jsonEncode({'lat': c['lat'], 'lon': c['lon'], 'label': label}), scoped: false));
      if (changedCity) unawaited(Store.strDel(_kLast, scoped: false)); // the old city's reading must not show for the new one
    }
    final u = o['unit'];
    if (u == 'F' || u == 'C') unawaited(Store.strSet(_kUnit, u as String, scoped: false));
    changes.value++; // refresh the badge and tile, but not `edited`: this change came from the cloud
  }

  /// The last good reading for [label] (shown when offline), or null.
  static ({double tempC, String condition})? last(String label) {
    try {
      final o = jsonDecode(Store.strGet(_kLast, scoped: false) ?? 'null');
      if (o is Map && o['city'] == label && o['temp_c'] is num) return (tempC: (o['temp_c'] as num).toDouble(), condition: '${o['condition'] ?? ''}');
    } catch (_) {}
    return null;
  }

  /// A fresh reading, or null when offline (callers fall back to [last]).
  static Future<({double tempC, String condition})?> fetch(double lat, double lon, String label) async {
    try {
      final r = await _c.get(Uri.parse('https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon&current=temperature_2m,weather_code')).timeout(const Duration(seconds: 6));
      if (r.statusCode != 200) return null;
      final cur = (jsonDecode(utf8.decode(r.bodyBytes)) as Map)['current'] as Map;
      final t = (cur['temperature_2m'] as num).toDouble();
      final cond = _codes[(cur['weather_code'] as num?)?.toInt() ?? 0] ?? 'Clear';
      await Store.strSet(_kLast, jsonEncode({'city': label, 'temp_c': t, 'temp_f': (t * 9 / 5 + 32).round(), 'condition': cond}), scoped: false);
      return (tempC: t, condition: cond);
    } catch (_) {
      return null;
    }
  }

  // ---- header badge (top right of every main page, like .weather-badge in the web UI) ----
  /// Text the badge shows, e.g. "65\u00b0F". One value for every page, so only one request is made.
  static final ValueNotifier<String> badge = ValueNotifier('--\u00b0');
  static Timer? _badgeTimer;
  static DateTime? _badgeAt;
  static bool _badgeBusy = false;

  /// Starts the shared refresh (city / unit changes + every 15 minutes). Safe to call from every badge.
  static void startBadge() {
    if (_badgeTimer != null) return;
    changes.addListener(() => refreshBadge(force: true));
    _badgeTimer = Timer.periodic(const Duration(minutes: 15), (_) => refreshBadge(force: true));
    refreshBadge(force: true);
  }

  static Future<void> refreshBadge({bool force = false}) async {
    final c = city;
    if (c == null) {
      badge.value = '--\u00b0';
      return;
    }
    final cached = last(c.label);
    if (cached != null) badge.value = format(cached.tempC);
    if (_badgeBusy) return;
    if (!force && _badgeAt != null && DateTime.now().difference(_badgeAt!) < const Duration(minutes: 5)) return;
    _badgeBusy = true;
    try {
      final r = await fetch(c.lat, c.lon, c.label);
      _badgeAt = DateTime.now();
      if (r != null && city?.label == c.label) badge.value = format(r.tempC);
    } finally {
      _badgeBusy = false;
    }
  }

  static String format(double tempC) => unit == 'C' ? '${tempC.round()}\u00b0C' : '${(tempC * 9 / 5 + 32).round()}\u00b0F';

  /// City search through Open-Meteo's geocoder: (label, lat, lon).
  static Future<List<({String label, double lat, double lon})>> search(String q) async {
    final r = await _c.get(Uri.parse('https://geocoding-api.open-meteo.com/v1/search?name=${Uri.encodeQueryComponent(q)}&count=6&language=en&format=json')).timeout(const Duration(seconds: 8));
    final o = jsonDecode(utf8.decode(r.bodyBytes));
    final res = o is Map && o['results'] is List ? (o['results'] as List).whereType<Map>() : const <Map>[];
    return [
      for (final l in res)
        if (l['latitude'] is num && l['longitude'] is num)
          (label: '${l['name']}${l['admin1'] != null ? ', ${l['admin1']}' : ''} (${l['country'] ?? ''})', lat: (l['latitude'] as num).toDouble(), lon: (l['longitude'] as num).toDouble()),
    ];
  }
}

/// `AppBar.actions` for screens pushed on top of the main pages: the same pill, so it stays in the top right corner there too.
List<Widget> weatherActions(BuildContext context) => [
      Padding(padding: EdgeInsets.only(right: 0.75 * context.pek.rem), child: const Center(child: WeatherBadge())),
    ];

/// The pill in the top right corner of the main pages. Tap = open Weather settings (choose city / unit).
class WeatherBadge extends StatefulWidget {
  const WeatherBadge({super.key});
  @override
  State<WeatherBadge> createState() => _WeatherBadgeState();
}

class _WeatherBadgeState extends State<WeatherBadge> {
  @override
  void initState() {
    super.initState();
    Weather.startBadge();
    Weather.refreshBadge(); // a page that was just opened shows a reading at most 5 minutes old
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ValueListenableBuilder<String>(
      valueListenable: Weather.badge,
      builder: (context, text, _) => Semantics(
        button: true,
        label: 'Weather $text. Open weather settings',
        child: PekFocusable(
          onTap: () => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const WeatherSettingsScreen())),
          radius: 999,
          background: t.surface,
          borderColor: t.border,
          minHeight: p.isTv ? 3 * rem : 2.5 * rem,
          alignment: Alignment.center,
          padding: EdgeInsets.symmetric(horizontal: 1.1 * rem, vertical: 0.45 * rem),
          child: Text(text, maxLines: 1, style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600, color: t.text, height: 1.2)),
        ),
      ),
    );
  }
}

/// The dashboard tile.
class WeatherTile extends StatefulWidget {
  const WeatherTile({super.key});
  @override
  State<WeatherTile> createState() => _WeatherTileState();
}

class _WeatherTileState extends State<WeatherTile> {
  String _title = '--\u00b0';
  String _sub = 'Loading\u2026';
  bool _noCity = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    Weather.changes.addListener(_refresh);
    _refresh();
    _timer = Timer.periodic(const Duration(minutes: 30), (_) => _refresh());
  }

  @override
  void dispose() {
    Weather.changes.removeListener(_refresh);
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _refresh() async {
    final c = Weather.city;
    if (c == null) {
      if (mounted) {
        setState(() {
          _noCity = true;
          _title = 'Weather';
          _sub = 'Choose your city';
        });
      }
      return;
    }
    final cached = Weather.last(c.label);
    if (mounted && cached != null) {
      setState(() {
        _noCity = false;
        _title = Weather.format(cached.tempC);
        _sub = '${cached.condition} \u2014 ${c.label}';
      });
    }
    final r = await Weather.fetch(c.lat, c.lon, c.label);
    if (!mounted) return;
    setState(() {
      _noCity = false;
      if (r != null) {
        _title = Weather.format(r.tempC);
        _sub = '${r.condition} \u2014 ${c.label}';
      } else if (cached == null) {
        _title = '--\u00b0';
        _sub = 'Weather unavailable \u2014 ${c.label}';
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return PekCard(
      title: _title,
      subtitle: _sub,
      onTap: () => _noCity ? _open() : _refresh(),
    ).withLongOpen(_open);
  }

  void _open() => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const WeatherSettingsScreen()));
}

extension on Widget {
  /// A tile that refreshes on tap also needs a way to the settings; a small button under it does that.
  Widget withLongOpen(VoidCallback open) => Builder(builder: (context) {
        final p = context.pek;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          this,
          SizedBox(height: 0.5 * p.rem),
          PekButton(compact: true, label: 'Weather settings', onTap: open),
        ]);
      });
}

/// Pick the city and the unit.
class WeatherSettingsScreen extends StatefulWidget {
  const WeatherSettingsScreen({super.key});
  @override
  State<WeatherSettingsScreen> createState() => _WeatherSettingsScreenState();
}

class _WeatherSettingsScreenState extends State<WeatherSettingsScreen> {
  final _q = TextEditingController();
  List<({String label, double lat, double lon})> _hits = const [];
  String _note = '';
  bool _busy = false;

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _find() async {
    final q = _q.text.trim();
    if (q.length < 2 || _busy) return;
    setState(() {
      _busy = true;
      _note = 'Searching\u2026';
    });
    try {
      final r = await Weather.search(q);
      if (!mounted) return;
      setState(() {
        _busy = false;
        _hits = r;
        _note = r.isEmpty ? 'No city found. Try another spelling.' : '';
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _note = 'Could not reach the weather service.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final city = Weather.city;
    return SubScreen(
      title: 'Weather',
      body: ListView(padding: p.pagePad, children: [
        Section(
          title: 'City',
          hint: city == null ? 'No city chosen yet.' : 'Now showing: ${city.label}',
          children: [
            PekField(label: 'Search for a city', controller: _q, onSubmitted: _find, autofocus: true),
            Align(alignment: Alignment.centerLeft, child: PekButton(label: _busy ? 'Searching\u2026' : 'Search', primary: true, onTap: _busy ? null : _find)),
            if (_note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.5 * p.rem), child: Text(_note, style: TextStyle(color: t.textMuted))),
            for (final h in _hits)
              ListRow(
                title: h.label,
                onTap: () async {
                  await Weather.setCity(h.lat, h.lon, h.label);
                  if (mounted) Navigator.pop(context);
                },
              ),
            if (city != null) Padding(padding: EdgeInsets.only(top: 0.5 * p.rem), child: Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Remove city', onTap: () async {
              await Weather.clearCity();
              if (mounted) Navigator.pop(context);
            }))),
          ],
        ),
        Section(
          title: 'Unit',
          children: [
            Wrap(spacing: 8, children: [
              PekButton(label: 'Fahrenheit', primary: Weather.unit == 'F', onTap: () async {
                await Weather.setUnit('F');
                if (mounted) setState(() {});
              }),
              PekButton(label: 'Celsius', primary: Weather.unit == 'C', onTap: () async {
                await Weather.setUnit('C');
                if (mounted) setState(() {});
              }),
            ]),
          ],
        ),
      ]),
    );
  }
}
