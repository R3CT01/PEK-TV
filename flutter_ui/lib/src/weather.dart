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

  // ---- forecast (the dashboard's Forecast widget): next hours and next days, same free source, no key ----
  static const _kFc = 'pek_weather_forecast';

  /// The last good forecast for [label] (shown at once and when offline), or null.
  static WeatherForecast? lastForecast(String label) {
    try {
      final o = jsonDecode(Store.strGet(_kFc, scoped: false) ?? 'null');
      if (o is Map && o['city'] == label) return WeatherForecast.fromJson(o);
    } catch (_) {}
    return null;
  }

  /// A fresh forecast, or null when offline (callers fall back to [lastForecast]).
  static Future<WeatherForecast?> fetchForecast(double lat, double lon, String label) async {
    try {
      final r = await _c
          .get(Uri.parse('https://api.open-meteo.com/v1/forecast?latitude=$lat&longitude=$lon'
              '&hourly=temperature_2m,weather_code,precipitation_probability,is_day'
              '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,'
              'apparent_temperature_max,apparent_temperature_min,wind_speed_10m_max,wind_gusts_10m_max,'
              'wind_direction_10m_dominant,precipitation_sum,uv_index_max,sunrise,sunset'
              '&timezone=auto&forecast_days=7'))
          .timeout(const Duration(seconds: 8));
      if (r.statusCode != 200) return null;
      final j = jsonDecode(utf8.decode(r.bodyBytes)) as Map;
      final f = WeatherForecast.fromApi(label, j);
      if (f.hours.isEmpty && f.days.isEmpty) return null;
      await Store.strSet(_kFc, jsonEncode(f.toJson()), scoped: false);
      return f;
    } catch (_) {
      return null;
    }
  }

  /// A temperature with just the degree sign (\u00b0), in the chosen unit: "65\u00b0".
  static String degrees(double tempC) => '${unit == 'C' ? tempC.round() : (tempC * 9 / 5 + 32).round()}\u00b0';

  /// The icon for an Open-Meteo weather code ([day] false = after dark).
  static IconData iconFor(int code, {bool day = true}) {
    if (code == 0 || code == 1) return day ? Icons.wb_sunny : Icons.nightlight_round;
    if (code == 2) return day ? Icons.wb_cloudy : Icons.nights_stay;
    if (code == 3) return Icons.cloud;
    if (code == 45 || code == 48) return Icons.blur_on;
    if (code >= 51 && code <= 57) return Icons.grain;
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return Icons.water_drop;
    if ((code >= 71 && code <= 77) || code == 85 || code == 86) return Icons.ac_unit;
    if (code >= 95) return Icons.flash_on;
    return Icons.cloud_queue;
  }

  static String describe(int code) => _codes[code] ?? 'Clear';

  /// A wind speed (given in km/h) in the chosen unit: "12 mph" (Fahrenheit) or "19 km/h" (Celsius).
  static String speed(double kmh) => unit == 'C' ? '${kmh.round()} km/h' : '${(kmh * 0.621371).round()} mph';

  /// A rain or snow amount (given in mm) in the chosen unit: "0.3 in" or "7.6 mm".
  static String amount(double mm) {
    if (unit == 'C') return '${mm < 10 ? mm.toStringAsFixed(1) : mm.round().toString()} mm';
    final i = mm / 25.4;
    return '${i < 0.01 && i > 0 ? '<0.01' : i.toStringAsFixed(2)} in';
  }

  /// The compass point the wind comes from, for a direction in degrees: "NW".
  static String compass(double deg) {
    const p = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return p[(((deg % 360) + 360) % 360 / 22.5 + 0.5).floor() % 16];
  }

  /// A word for a UV index.
  static String uvLabel(double uv) => uv < 3 ? 'Low' : (uv < 6 ? 'Moderate' : (uv < 8 ? 'High' : (uv < 11 ? 'Very high' : 'Extreme')));

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

/// The dashboard tile: the same card as the web UI's weather widget (big temperature, "condition \u00b7 city" under it).
/// Tap = Weather settings (choose city / unit), like the web tile opening the Weather plugin; press and hold = [onLongPress]
/// (customize the dashboard).
class WeatherTile extends StatefulWidget {
  const WeatherTile({super.key, this.onLongPress});
  final VoidCallback? onLongPress;
  @override
  State<WeatherTile> createState() => _WeatherTileState();
}

class _WeatherTileState extends State<WeatherTile> {
  String _title = '--\u00b0';
  String _sub = '';
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

  String _line(String condition, String city) => [condition, city].where((e) => e.isNotEmpty).join(' \u00b7 ');

  Future<void> _refresh() async {
    final c = Weather.city;
    if (c == null) {
      if (mounted) setState(() => _noCity = true);
      return;
    }
    final cached = Weather.last(c.label);
    if (mounted) {
      setState(() {
        _noCity = false;
        _title = cached != null ? Weather.format(cached.tempC) : '--\u00b0';
        _sub = _line(cached?.condition ?? '', c.label);
      });
    }
    final r = await Weather.fetch(c.lat, c.lon, c.label);
    if (!mounted || r == null || Weather.city?.label != c.label) return;
    setState(() {
      _title = Weather.format(r.tempC);
      _sub = _line(r.condition, c.label);
    });
  }

  void _open() => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const WeatherSettingsScreen()));

  @override
  Widget build(BuildContext context) {
    if (_noCity) return DashTile(heading: 'Weather', body: 'Tap to choose your city', onTap: _open, onLongPress: widget.onLongPress);
    return DashTile(big: _title, sub: _sub, onTap: _open, onLongPress: widget.onLongPress);
  }
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
    _debounce?.cancel();
    _q.dispose();
    super.dispose();
  }

  Timer? _debounce;
  int _seq = 0; // numbers each search, so a slow answer for text that was already changed is dropped

  /// Suggestions as you type: after a short pause, from 2 letters on (like the web UI's city box).
  void _typed(String _) {
    _debounce?.cancel();
    if (_q.text.trim().length < 2) {
      _seq++;
      setState(() {
        _hits = const [];
        _note = '';
        _busy = false;
      });
      return;
    }
    _debounce = Timer(const Duration(milliseconds: 300), _find);
  }

  Future<void> _find() async {
    _debounce?.cancel();
    final q = _q.text.trim();
    if (q.length < 2) return;
    final seq = ++_seq;
    setState(() {
      _busy = true;
      if (_hits.isEmpty) _note = 'Searching\u2026'; // with suggestions on screen they just update, no flicker
    });
    try {
      final r = await Weather.search(q);
      if (!mounted || seq != _seq) return;
      setState(() {
        _busy = false;
        _hits = r;
        _note = r.isEmpty ? 'No city found. Try another spelling.' : '';
      });
    } catch (_) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _busy = false;
        _note = 'Could not reach the weather service.';
      });
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
            PekField(label: 'Search for a city', controller: _q, onChanged: _typed, onSubmitted: _find, autofocus: true),
            Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Search', primary: true, onTap: _find)),
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

/// One hour of the forecast. [time] is local to the city, like "2026-10-22T14:00".
class ForecastHour {
  const ForecastHour({required this.time, required this.tempC, required this.code, required this.day, required this.rain});
  final String time;
  final double tempC;
  final int code;
  final bool day;
  final int rain; // chance of rain, percent

  int get hour => int.tryParse(time.length >= 13 ? time.substring(11, 13) : '') ?? 0;
}

/// One day of the forecast. [date] is like "2026-10-22". The fields after [rain] are null when the cached forecast is older
/// than the details (the next refresh fills them in).
class ForecastDay {
  const ForecastDay({
    required this.date,
    required this.hiC,
    required this.loC,
    required this.code,
    required this.rain,
    this.feelsHiC,
    this.feelsLoC,
    this.windKmh,
    this.gustKmh,
    this.windDir,
    this.precipMm,
    this.uv,
    this.sunrise,
    this.sunset,
  });
  final String date;
  final double hiC, loC;
  final int code;
  final int rain;
  final double? feelsHiC, feelsLoC; // "feels like" high and low
  final double? windKmh, gustKmh; // strongest wind and gust of the day
  final double? windDir; // degrees the wind comes from
  final double? precipMm; // rain + snow total
  final double? uv; // highest UV index
  final String? sunrise, sunset; // local to the city, like "2026-10-22T07:12"
}

/// The hourly and daily forecast for one city (Open-Meteo), as the dashboard's Forecast widget shows it.
class WeatherForecast {
  const WeatherForecast({required this.city, required this.utcOffset, required this.hours, required this.days});
  final String city;
  final int utcOffset; // seconds: how far the city's clock is from UTC
  final List<ForecastHour> hours;
  final List<ForecastDay> days;

  static double _d(dynamic v) => v is num ? v.toDouble() : 0;
  static int _i(dynamic v) => v is num ? v.round() : 0;

  factory WeatherForecast.fromApi(String city, Map j) {
    final h = j['hourly'] is Map ? j['hourly'] as Map : const {};
    final d = j['daily'] is Map ? j['daily'] as Map : const {};
    List l(Map m, String k) => m[k] is List ? m[k] as List : const [];
    final ht = l(h, 'time');
    final dt = l(d, 'time');
    return WeatherForecast(
      city: city,
      utcOffset: _i(j['utc_offset_seconds']),
      hours: [
        for (var i = 0; i < ht.length; i++)
          ForecastHour(
            time: '${ht[i]}',
            tempC: _d(i < l(h, 'temperature_2m').length ? l(h, 'temperature_2m')[i] : 0),
            code: _i(i < l(h, 'weather_code').length ? l(h, 'weather_code')[i] : 0),
            day: _i(i < l(h, 'is_day').length ? l(h, 'is_day')[i] : 1) != 0,
            rain: _i(i < l(h, 'precipitation_probability').length ? l(h, 'precipitation_probability')[i] : 0),
          ),
      ],
      days: [
        for (var i = 0; i < dt.length; i++)
          ForecastDay(
            date: '${dt[i]}',
            hiC: _d(i < l(d, 'temperature_2m_max').length ? l(d, 'temperature_2m_max')[i] : 0),
            loC: _d(i < l(d, 'temperature_2m_min').length ? l(d, 'temperature_2m_min')[i] : 0),
            code: _i(i < l(d, 'weather_code').length ? l(d, 'weather_code')[i] : 0),
            rain: _i(i < l(d, 'precipitation_probability_max').length ? l(d, 'precipitation_probability_max')[i] : 0),
            feelsHiC: _n(l(d, 'apparent_temperature_max'), i),
            feelsLoC: _n(l(d, 'apparent_temperature_min'), i),
            windKmh: _n(l(d, 'wind_speed_10m_max'), i),
            gustKmh: _n(l(d, 'wind_gusts_10m_max'), i),
            windDir: _n(l(d, 'wind_direction_10m_dominant'), i),
            precipMm: _n(l(d, 'precipitation_sum'), i),
            uv: _n(l(d, 'uv_index_max'), i),
            sunrise: _s(l(d, 'sunrise'), i),
            sunset: _s(l(d, 'sunset'), i),
          ),
      ],
    );
  }

  static double? _n(List l, int i) => i < l.length && l[i] is num ? (l[i] as num).toDouble() : null;
  static String? _s(List l, int i) => i < l.length && l[i] is String ? l[i] as String : null;

  factory WeatherForecast.fromJson(Map o) => WeatherForecast(
        city: '${o['city']}',
        utcOffset: _i(o['off']),
        hours: [
          for (final e in (o['h'] as List? ?? const []))
            if (e is List && e.length >= 5) ForecastHour(time: '${e[0]}', tempC: _d(e[1]), code: _i(e[2]), day: _i(e[3]) != 0, rain: _i(e[4])),
        ],
        days: [
          for (final e in (o['d'] as List? ?? const []))
            if (e is List && e.length >= 5)
              ForecastDay(
                date: '${e[0]}',
                hiC: _d(e[1]),
                loC: _d(e[2]),
                code: _i(e[3]),
                rain: _i(e[4]),
                // Older caches have just the first five values.
                feelsHiC: e.length >= 14 ? _n(e, 5) : null,
                feelsLoC: e.length >= 14 ? _n(e, 6) : null,
                windKmh: e.length >= 14 ? _n(e, 7) : null,
                gustKmh: e.length >= 14 ? _n(e, 8) : null,
                windDir: e.length >= 14 ? _n(e, 9) : null,
                precipMm: e.length >= 14 ? _n(e, 10) : null,
                uv: e.length >= 14 ? _n(e, 11) : null,
                sunrise: e.length >= 14 ? _s(e, 12) : null,
                sunset: e.length >= 14 ? _s(e, 13) : null,
              ),
        ],
      );

  Map<String, dynamic> toJson() => {
        'city': city,
        'off': utcOffset,
        'h': [for (final e in hours) [e.time, e.tempC, e.code, e.day ? 1 : 0, e.rain]],
        'd': [
          for (final e in days) [e.date, e.hiC, e.loC, e.code, e.rain, e.feelsHiC, e.feelsLoC, e.windKmh, e.gustKmh, e.windDir, e.precipMm, e.uv, e.sunrise, e.sunset],
        ],
      };

  /// The city's clock right now, as "2026-10-22T14:00" (rounded down to the hour): what the hourly times are compared with.
  String get nowHour {
    final w = DateTime.now().toUtc().add(Duration(seconds: utcOffset));
    String two(int n) => n.toString().padLeft(2, '0');
    return '${w.year.toString().padLeft(4, '0')}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:00';
  }

  /// Today's date in the city, "2026-10-22".
  String get today => nowHour.substring(0, 10);

  /// The next [count] hours, starting with the current one.
  List<ForecastHour> nextHours([int count = 24]) {
    final n = nowHour;
    return [for (final h in hours) if (h.time.compareTo(n) >= 0) h].take(count).toList();
  }

  /// The days from today on.
  List<ForecastDay> upcomingDays() {
    final t = today;
    return [for (final d in days) if (d.date.compareTo(t) >= 0) d];
  }
}
