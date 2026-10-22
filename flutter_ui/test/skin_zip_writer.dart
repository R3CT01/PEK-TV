import 'dart:convert';
import 'dart:typed_data';

import 'package:pek_tv_ui/src/plugin_store.dart' show PluginFile;

// Test helper: builds a skin .zip in memory (it used to live in the Dart SkinBuilder, which the Skin maker plugin replaced).
/// Writes a .zip with the files stored (no compression; skins are a few KB). What `PluginZip.read` and the web
/// installer read.
class SkinZipWriter {
  static Uint8List write(String folder, List<PluginFile> files) {
    final out = BytesBuilder();
    final central = BytesBuilder();
    var count = 0;
    void u16(BytesBuilder b, int v) => b.add([v & 0xff, (v >> 8) & 0xff]);
    void u32(BytesBuilder b, int v) => b.add([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
    const dosDate = 0x0021; // 1980-01-01, so the same skin gives the same bytes every time
    for (final f in files) {
      final name = utf8.encode(folder.isEmpty ? f.path : '$folder/${f.path}');
      final crc = _crc32(f.data);
      final offset = out.length;
      u32(out, 0x04034b50);
      u16(out, 20);
      u16(out, 0x0800); // names are UTF-8
      u16(out, 0); // stored
      u16(out, 0);
      u16(out, dosDate);
      u32(out, crc);
      u32(out, f.data.length);
      u32(out, f.data.length);
      u16(out, name.length);
      u16(out, 0);
      out.add(name);
      out.add(f.data);

      u32(central, 0x02014b50);
      u16(central, 20);
      u16(central, 20);
      u16(central, 0x0800);
      u16(central, 0);
      u16(central, 0);
      u16(central, dosDate);
      u32(central, crc);
      u32(central, f.data.length);
      u32(central, f.data.length);
      u16(central, name.length);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u32(central, 0x81A40000); // -rw-r--r--
      u32(central, offset);
      central.add(name);
      count++;
    }
    final cdOffset = out.length;
    final cd = central.takeBytes();
    out.add(cd);
    u32(out, 0x06054b50);
    u16(out, 0);
    u16(out, 0);
    u16(out, count);
    u16(out, count);
    u32(out, cd.length);
    u32(out, cdOffset);
    u16(out, 0);
    return out.takeBytes();
  }

  static Uint32List? _table;
  static int _crc32(List<int> bytes) {
    var t = _table;
    if (t == null) {
      t = Uint32List(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1);
        }
        t[n] = c;
      }
      _table = t;
    }
    var crc = 0xFFFFFFFF;
    for (final b in bytes) {
      crc = t[(crc ^ b) & 0xff] ^ (crc >> 8);
    }
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF;
  }
}
