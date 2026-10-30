import 'dart:convert';
import 'dart:io' show ZLibDecoder;
import 'dart:typed_data';

import 'package:crypto/crypto.dart' show sha256;

import 'plugin_store.dart';

/// Reads a plugin `.PEK` file (format version 1, see PEK_FORMAT.md; `tools/pektool.py` builds and checks them).
///
/// This is the ONLY way a plugin file is opened. Plain .zip files are refused, by name and by content. Every check
/// the Python tool makes is made here too, because a hand-made file must not get further than a tool-made one:
/// signature, header checksum, version, whole-file SHA-256, a table of contents that tiles the data exactly (no gaps
/// that could hide a payload, no overlaps), every file's own SHA-256, and size caps (2 MB per file, 8 MB in total,
/// inflate stops at the declared size so a "zip bomb" cannot use up memory). Anything wrong throws a [StoreException]
/// whose message starts with [rejected], which the install screens draw in red. The server's own plugin checks
/// (backend/plugin_install.h) still run afterwards, exactly as before.
class PluginPek {
  static const maxFileBytes = 2 * 1024 * 1024;
  static const maxTotalBytes = 8 * 1024 * 1024;
  static const maxFiles = 200;
  static const maxPekBytes = maxTotalBytes + 1024 * 1024;
  static const formatVersion = 1;
  static const headerSize = 64;
  static const footerSize = 32;
  static const entrySize = 52;

  /// Every rejection message starts with this; the install screens show such a message in red.
  static const rejected = 'REJECTED: ';

  static const _magic = <int>[0x89, 0x50, 0x45, 0x4B, 0x0D, 0x0A, 0x1A, 0x0A];
  static final _id = RegExp(r'^[a-z0-9][a-z0-9_-]{0,39}$');

  static StoreException _no(String why) => StoreException('$rejected$why');

  static const _zipHelp = 'PEK TV does not install .zip files, only .PEK plugins. Convert it first with: python tools/pektool.py convert yourplugin.zip';

  /// True when [bytes] start like a zip file (any kind of zip).
  static bool looksLikeZip(Uint8List b) => b.length >= 4 && b[0] == 0x50 && b[1] == 0x4B && (b[2] == 0x03 || b[2] == 0x05 || b[2] == 0x07) && (b[3] == 0x04 || b[3] == 0x06 || b[3] == 0x08);

  /// Opens a picked / downloaded file as a plugin and returns what the install screen needs.
  /// [fileName] must end in .PEK (any letter case). A .zip is refused by its name AND by its content.
  static PreparedPlugin prepare(Uint8List bytes, {required String fileName}) {
    final lower = fileName.toLowerCase();
    if (lower.endsWith('.zip') || looksLikeZip(bytes)) throw _no('"$fileName" is a .zip file. $_zipHelp');
    if (!lower.endsWith('.pek')) throw _no('"$fileName" is not a .PEK file. PEK TV only installs plugins in the .PEK format.');
    final pek = read(bytes);
    return PreparedPlugin.fromFiles(pek.id, pek.files);
  }

  /// Parses and fully verifies a .PEK. Throws [StoreException] (message starts with [rejected]) if anything is wrong.
  static ({String id, List<PluginFile> files}) read(Uint8List u8) {
    final n = u8.length;
    if (looksLikeZip(u8)) throw _no('this is a .zip file renamed to .PEK. $_zipHelp');
    if (n > maxPekBytes) throw _no('the file is bigger than any valid .PEK can be (limit about 9 MB).');
    if (n < headerSize + footerSize) throw _no('the file is only $n bytes: too short to be a .PEK.');
    for (var i = 0; i < 8; i++) {
      if (u8[i] != _magic[i]) {
        if (u8[0] == _magic[0] && u8[1] == _magic[1] && u8[2] == _magic[2] && u8[3] == _magic[3]) {
          throw _no('the .PEK signature is damaged. The file probably went through a text-mode transfer. Copy it again in binary mode.');
        }
        throw _no('this is not a .PEK file (wrong signature).');
      }
    }

    final dv = ByteData.sublistView(u8);
    if (_crc32(Uint8List.sublistView(u8, 0, 60)) != dv.getUint32(60, Endian.little)) {
      throw _no('the header checksum is wrong: the file is damaged.');
    }
    final version = dv.getUint16(8, Endian.little);
    if (version != formatVersion) throw _no('unsupported .PEK format version $version (this app understands version $formatVersion). Update PEK TV.');
    if (dv.getUint16(10, Endian.little) != 0) throw _no('the file uses features this version of PEK TV does not understand (unknown flags).');
    for (var i = 48; i < 60; i++) {
      if (u8[i] != 0) throw _no('the reserved header bytes are not zero.');
    }
    final count = dv.getUint32(12, Endian.little);
    final tocOff = dv.getUint64(16, Endian.little);
    final tocLen = dv.getUint64(24, Endian.little);
    if (dv.getUint64(32, Endian.little) != headerSize) throw _no('the data area does not start where it should.');
    if (dv.getUint64(40, Endian.little) != n) throw _no('the file size does not match its header: it is cut short or has extra bytes.');
    if (tocOff < headerSize || tocOff > n || tocLen < 0 || tocLen > n || tocOff + tocLen != n - footerSize) {
      throw _no('the table of contents does not fit the file.');
    }
    if (count > maxFiles) throw _no('the plugin has too many files (limit $maxFiles).');

    // Whole-file SHA-256: catches damage and later edits.
    final footer = Uint8List.sublistView(u8, n - footerSize);
    if (!_same(sha256.convert(Uint8List.sublistView(u8, 0, n - footerSize)).bytes, footer)) {
      throw _no('the file was modified or damaged after it was packed (SHA-256 does not match).');
    }

    final toc = Uint8List.sublistView(u8, tocOff, tocOff + tocLen);
    final tv = ByteData.sublistView(toc);
    if (toc.isEmpty || 1 + toc[0] > toc.length) throw _no('the table of contents is cut short.');
    final idLen = toc[0];
    String id;
    try {
      id = ascii.decode(toc.sublist(1, 1 + idLen));
    } on FormatException {
      throw _no('the plugin id is not plain ASCII.');
    }
    if (!_id.hasMatch(id)) throw _no('the plugin id "$id" is not valid (1-40 lowercase letters, digits, - or _).');

    var cur = 1 + idLen;
    final entries = <_Entry>[];
    for (var k = 0; k < count; k++) {
      if (cur + entrySize > toc.length) throw _no('the table of contents is cut short at file ${k + 1} of $count.');
      final plen = tv.getUint16(cur, Endian.little);
      final method = toc[cur + 2];
      final eflags = toc[cur + 3];
      final off = tv.getUint64(cur + 4, Endian.little);
      final stored = tv.getUint32(cur + 12, Endian.little);
      final raw = tv.getUint32(cur + 16, Endian.little);
      final digest = Uint8List.sublistView(toc, cur + 20, cur + 52);
      cur += entrySize;
      if (cur + plen > toc.length) throw _no('the table of contents is cut short inside a file name.');
      String path;
      try {
        path = utf8.decode(toc.sublist(cur, cur + plen));
      } on FormatException {
        throw _no('a file name in the plugin is not valid UTF-8.');
      }
      cur += plen;
      entries.add(_Entry(path, method, eflags, off, stored, raw, digest));
    }
    if (cur != toc.length) throw _no('unexpected extra bytes after the table of contents.');

    // The entries must tile the data area exactly: a gap could hide data, an overlap could confuse the reader.
    final sorted = [...entries]..sort((a, b) => a.off.compareTo(b.off));
    var expect = headerSize;
    for (final e in sorted) {
      if (e.off != expect) throw _no('${e.path}: unaccounted data or overlapping files inside the plugin.');
      if (e.stored < 0 || e.off + e.stored > tocOff) throw _no('${e.path}: its data lies outside the data area.');
      expect = e.off + e.stored;
    }
    if (expect != tocOff) throw _no('unaccounted data between the last file and the table of contents.');

    final files = <PluginFile>[];
    final seen = <String>{};
    var total = 0;
    for (final e in entries) {
      if (!seen.add(e.path.toLowerCase())) throw _no('the same file appears twice: ${e.path}');
      if (e.method != 0 && e.method != 1) throw _no('${e.path}: unknown compression method ${e.method}.');
      if (e.eflags != 0) throw _no('${e.path}: unknown file flags.');
      if (e.raw > maxFileBytes) throw _no('${e.path} is too large (limit 2 MB per file).');
      total += e.raw;
      if (total > maxTotalBytes) throw _no('the plugin is too large (limit 8 MB in total).');
      final blob = Uint8List.sublistView(u8, e.off, e.off + e.stored);
      Uint8List data;
      if (e.method == 0) {
        if (e.stored != e.raw) throw _no('${e.path}: stored size and real size disagree.');
        data = Uint8List.fromList(blob);
      } else {
        data = _inflate(blob, e.raw, e.path);
        if (data.length != e.raw) throw _no('${e.path}: unpacks to the wrong size (damaged file).');
      }
      if (!_same(sha256.convert(data).bytes, e.sha)) throw _no('${e.path}: contents do not match their SHA-256 (damaged or changed).');
      files.add(PluginFile(e.path, data));
    }
    return (id: id, files: files);
  }

  /// Raw deflate, cut off as soon as the output would pass [cap] bytes.
  static Uint8List _inflate(Uint8List src, int cap, String path) {
    final sink = _CapSink(cap, path);
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
      throw _no('$path: the compressed data is damaged.');
    }
    return sink.bytes();
  }

  static bool _same(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a[i] ^ b[i];
    }
    return diff == 0;
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
}

class _Entry {
  const _Entry(this.path, this.method, this.eflags, this.off, this.stored, this.raw, this.sha);
  final String path;
  final int method, eflags, off, stored, raw;
  final Uint8List sha;
}

class _CapSink extends ByteConversionSinkBase {
  _CapSink(this.cap, this.path);
  final int cap;
  final String path;
  final BytesBuilder _out = BytesBuilder(copy: false);

  @override
  void add(List<int> chunk) {
    if (_out.length + chunk.length > cap) throw StoreException('${PluginPek.rejected}$path unpacks to more than it declares (damaged file).');
    _out.add(chunk);
  }

  @override
  void close() {}

  Uint8List bytes() => _out.takeBytes();
}
