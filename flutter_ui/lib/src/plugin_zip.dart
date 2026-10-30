import 'dart:convert';
import 'dart:io' show ZLibDecoder;
import 'dart:typed_data';

import 'package:flutter/services.dart' show MethodChannel, MissingPluginException, PlatformException;
import 'package:http/http.dart' as http;

import 'api.dart';
import 'plugin_store.dart';

/// A small .zip reader. PLUGINS NO LONGER USE IT: a plugin is a .PEK file (plugin_pek.dart) and a .zip is refused. It stays
/// only because skins are still installed from a .zip (skin_install.dart).
/// Opens a skin .zip in memory, with these limits:
/// 2 MB per file, 8 MB in total, 400 files. It checks every file's CRC and stops inflating as soon as a file grows past its
/// limit (so a "zip bomb" cannot use up memory). Not supported, and reported as an error: ZIP64, encrypted and split zips.
class PluginZip {
  static const maxFileBytes = 2 * 1024 * 1024;
  static const maxTotalBytes = 8 * 1024 * 1024;
  static const maxEntries = 400;
  static const maxZipBytes = 10 * 1024 * 1024;

  /// Every file in the zip (folders are left out). Throws a [StoreException] with a plain-English message.
  static List<PluginFile> read(Uint8List u8) {
    if (u8.length < 22) throw const StoreException('this does not look like a .zip file');
    final dv = ByteData.sublistView(u8);
    int u16(int o) => dv.getUint16(o, Endian.little);
    int u32(int o) => dv.getUint32(o, Endian.little);

    // End of central directory record: scan backwards (a comment may follow it).
    var eocd = -1;
    final stop = u8.length - 22 - 65535 < 0 ? 0 : u8.length - 22 - 65535;
    for (var i = u8.length - 22; i >= stop; i--) {
      if (u32(i) == 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw const StoreException('this does not look like a .zip file');
    final diskNo = u16(eocd + 4), total = u16(eocd + 10);
    final cdSize = u32(eocd + 12), cdOff = u32(eocd + 16);
    if (diskNo != 0 || total == 0xffff || cdSize == 0xffffffff || cdOff == 0xffffffff) {
      throw const StoreException('this kind of zip (ZIP64 or split) is not supported; re-zip the plugin normally');
    }
    if (total > maxEntries) throw const StoreException('the zip has too many files');
    if (cdOff + cdSize > u8.length) throw const StoreException('the zip is damaged');

    final entries = <_Entry>[];
    var p = cdOff, declared = 0;
    for (var n = 0; n < total; n++) {
      if (p + 46 > u8.length || u32(p) != 0x02014b50) throw const StoreException('the zip is damaged (directory)');
      final flags = u16(p + 8), method = u16(p + 10), crc = u32(p + 16);
      final csize = u32(p + 20), usize = u32(p + 24);
      final nameLen = u16(p + 28), extraLen = u16(p + 30), commentLen = u16(p + 32);
      final lho = u32(p + 42);
      if (p + 46 + nameLen > u8.length) throw const StoreException('the zip is damaged (names)');
      var name = utf8.decode(u8.sublist(p + 46, p + 46 + nameLen), allowMalformed: true);
      p += 46 + nameLen + extraLen + commentLen;
      if (csize == 0xffffffff || usize == 0xffffffff || lho == 0xffffffff) {
        throw const StoreException('this kind of zip (ZIP64) is not supported; re-zip the plugin normally');
      }
      name = name.replaceAll('\\', '/');
      if (name.endsWith('/')) continue; // folder entry
      if (flags & 1 != 0) throw const StoreException('encrypted zips are not supported');
      if (method != 0 && method != 8) throw StoreException('unsupported zip compression ($method)');
      if (usize > maxFileBytes) throw StoreException('$name is too large (limit 2 MB per file)');
      declared += usize;
      if (declared > maxTotalBytes) throw const StoreException('the plugin is too large (limit 8 MB in total)');
      entries.add(_Entry(name, method, crc, csize, usize, lho));
    }

    final files = <PluginFile>[];
    var produced = 0;
    for (final e in entries) {
      if (e.lho + 30 > u8.length || u32(e.lho) != 0x04034b50) throw const StoreException('the zip is damaged (file header)');
      final start = e.lho + 30 + u16(e.lho + 26) + u16(e.lho + 28);
      if (start + e.csize > u8.length) throw const StoreException('the zip is damaged (file data)');
      final raw = Uint8List.sublistView(u8, start, start + e.csize);
      Uint8List data;
      if (e.method == 0) {
        if (e.csize != e.usize) throw StoreException('the zip is damaged (${e.name})');
        data = Uint8List.fromList(raw);
      } else {
        final cap = maxFileBytes < maxTotalBytes - produced ? maxFileBytes : maxTotalBytes - produced;
        data = _inflate(raw, cap);
      }
      if (data.length != e.usize) throw StoreException('the zip is damaged (${e.name})');
      if (_crc32(data) != e.crc) throw StoreException('the zip is damaged (checksum of ${e.name})');
      produced += data.length;
      files.add(PluginFile(e.name, data));
    }
    return files;
  }

  /// Raw deflate, cut off as soon as the output would pass [cap] bytes.
  static Uint8List _inflate(Uint8List src, int cap) {
    final sink = _CapSink(cap);
    try {
      final conv = ZLibDecoder(raw: true).startChunkedConversion(sink);
      const step = 16 * 1024;
      for (var i = 0; i < src.length; i += step) {
        conv.add(Uint8List.sublistView(src, i, i + step > src.length ? src.length : i + step));
      }
      conv.close();
    } on StoreException {
      rethrow;
    } catch (_) {
      throw const StoreException('the zip is damaged (could not unpack a file)');
    }
    return sink.bytes();
  }

  static Uint32List? _table;
  static int _crc32(Uint8List bytes) {
    var t = _table;
    if (t == null) {
      t = Uint32List(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) {
          c = (c & 1) != 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c;
      }
      _table = t;
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = t[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) & 0xFFFFFFFF;
  }

  // ------------------------------------------------------------------ helpers

  /// Same id rule as the web UI: lower case letters and digits, "-" between, at most 40 characters.
  static String slug(String text) {
    var s = text.toLowerCase().replaceFirst(RegExp(r'\.(zip|pek)$'), '');
    s = s.replaceAll(RegExp(r'[^a-z0-9]+'), '-').replaceAll(RegExp(r'^-+|-+$'), '');
    if (s.length > 40) s = s.substring(0, 40);
    return s.replaceAll(RegExp(r'-+$'), '');
  }
}

class _Entry {
  const _Entry(this.name, this.method, this.crc, this.csize, this.usize, this.lho);
  final String name;
  final int method, crc, csize, usize, lho;
}

class _CapSink extends ByteConversionSinkBase {
  _CapSink(this.cap);
  final int cap;
  final BytesBuilder _out = BytesBuilder(copy: false);

  @override
  void add(List<int> chunk) {
    if (_out.length + chunk.length > cap) throw const StoreException('a file in the zip is too large');
    _out.add(chunk);
  }

  @override
  void close() {}

  Uint8List bytes() => _out.takeBytes();
}

/// One row of the .zip picker: a folder, or a .zip file small enough to be a plugin.
/// This device has no system file picker.
class NoSystemPicker implements Exception {
  const NoSystemPicker();
}

class ZipEntry {
  const ZipEntry({required this.name, required this.path, required this.dir, required this.size});
  final String name, path;
  final bool dir;
  final int size;
}

class ZipListing {
  const ZipListing({required this.path, required this.parent, required this.entries});
  final String path, parent;
  final List<ZipEntry> entries;
}

/// Finds .zip files through PEK TV's own server, so it also works on TV boxes that have no system file picker, and on
/// network folders (SMB, NFS, FTP, WebDAV): `POST /api/plugins/browse` lists, `POST /api/plugins/fetch` reads one file.
class ZipPicker {
  static const _channel = MethodChannel('pek/plugins');

  /// Android's own file picker (no storage permission, so no "All files access" needed): the person picks a .zip anywhere
  /// (Downloads, Drive, a USB stick) and the app gets just that file. Null when they cancel. Throws [NoSystemPicker] when
  /// this device has none (some TV boxes), and the screen then offers the in-app browser instead.
  static Future<({String name, Uint8List bytes})?> pickNative({String ext = 'zip'}) async {
    try {
      final r = await _channel.invokeMethod<Map<Object?, Object?>>('pickFile', {'ext': ext});
      if (r == null) return null;
      final bytes = r['bytes'];
      if (bytes is! Uint8List || bytes.isEmpty) throw const StoreException('the file could not be read');
      final name = '${r['name'] ?? 'plugin.$ext'}';
      return (name: name, bytes: bytes);
    } on MissingPluginException {
      throw const NoSystemPicker();
    } on PlatformException catch (e) {
      if (e.code == 'no_picker') throw const NoSystemPicker();
      throw StoreException(e.message ?? 'the file could not be read');
    }
  }

  /// [path] is '@local' (this device), a library folder, or a network address. [ext] is the file type listed: 'pek'
  /// (plugins, the default of the server) or 'zip' (skins only).
  static Future<ZipListing> browse(String path, {String ext = 'zip'}) async {
    http.Response r;
    try {
      r = await http.post(Uri.parse('${Api.base}/api/plugins/browse'), body: {'path': path, 'ext': ext}).timeout(const Duration(seconds: 30));
    } catch (_) {
      throw const StoreException("Couldn't reach PEK TV's server.");
    }
    Object? j;
    try {
      j = jsonDecode(utf8.decode(r.bodyBytes));
    } catch (_) {}
    if (j is! Map || j['ok'] != true) {
      if (j is Map && j['auth'] == true) {
        throw const StoreException('This device asks for a login. Add it once as a media source in Settings, then try again.');
      }
      throw StoreException(j is Map && '${j['error'] ?? ''}'.isNotEmpty ? '${j['error']}' : "Couldn't open that location.");
    }
    return ZipListing(
      path: '${j['path'] ?? path}',
      parent: '${j['parent'] ?? ''}',
      entries: [
        for (final e in ((j['entries'] as List?) ?? const []))
          if (e is Map) ZipEntry(name: '${e['name']}', path: '${e['path']}', dir: e['dir'] == true, size: (e['size'] as num?)?.toInt() ?? 0),
      ],
    );
  }

  /// The bytes of one file the person chose in [browse] (a .PEK for a plugin, a .zip for a skin: see [ext]).
  static Future<Uint8List> fetch(String path, {String ext = 'zip'}) async {
    http.Response r;
    try {
      r = await http.post(Uri.parse('${Api.base}/api/plugins/fetch'), body: {'path': path, 'ext': ext}).timeout(const Duration(seconds: 60));
    } catch (_) {
      throw const StoreException("Couldn't reach PEK TV's server.");
    }
    final type = r.headers['content-type'] ?? '';
    if (r.statusCode != 200 || type.startsWith('application/json')) {
      var msg = '';
      try {
        msg = '${(jsonDecode(utf8.decode(r.bodyBytes)) as Map)['error'] ?? ''}';
      } catch (_) {}
      throw StoreException(msg.isEmpty ? 'the file could not be read' : msg);
    }
    return r.bodyBytes;
  }
}
