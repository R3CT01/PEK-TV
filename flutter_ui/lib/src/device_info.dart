import 'package:flutter/services.dart';

/// What this device is and what it is called, e.g. `Android TV` / `Living room TV`.
/// It goes to the PEK cloud with every sign-in, which puts it in the sign-in email ("device, name, time") and on the
/// website's verify page, so the owner can tell which device is asking.
class DeviceInfo {
  static const _host = MethodChannel('pek/host');
  static const _fallback = <String, String>{'type': 'Android device', 'name': 'PEK TV app'};
  static Map<String, String>? _known;

  static Future<Map<String, String>> read() async {
    final k = _known;
    if (k != null) return k;
    try {
      final m = await _host.invokeMethod<Map<dynamic, dynamic>>('deviceInfo').timeout(const Duration(seconds: 2));
      final type = '${m?['type'] ?? ''}'.trim();
      final name = '${m?['name'] ?? ''}'.trim();
      if (type.isEmpty && name.isEmpty) return _fallback;
      return _known = {'type': type.isEmpty ? _fallback['type']! : type, 'name': name.isEmpty ? _fallback['name']! : name};
    } catch (_) {
      return _fallback; // not asked again until it works
    }
  }
}
