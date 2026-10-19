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
/// Celsius. The city and unit belong to the device, not to a profile.
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
  static Future<void> setUnit(String u) async {
    await Store.strSet(_kUnit, u, scoped: false);
    changes.value++;
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
  }

  static Future<void> clearCity() async {
    await Store.strDel(_kCoords, scoped: false);
    await Store.strDel(_kLast, scoped: false);
    changes.value++;
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
