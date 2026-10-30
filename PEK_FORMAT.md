# .PEK plugin format, version 1

A `.PEK` file is one plugin for PEK TV: its files, a table of contents, and checksums, in a single binary container. All numbers are **little-endian**. Extension is `.PEK` (readers accept any case).

```
offset 0          header            64 bytes, fixed
offset 64         data area         every file's bytes, back to back
toc_offset        table of contents id + one entry per file
size - 32         footer            SHA-256 of everything before it
```

## Header (64 bytes)

| Offset | Size | Field | Rule |
|---|---|---|---|
| 0 | 8 | magic | `89 50 45 4B 0D 0A 1A 0A` (`\x89PEK\r\n\x1a\n`) |
| 8 | 2 | format_version | `1` |
| 10 | 2 | flags | must be `0` (bit 0 is reserved for a future signature block) |
| 12 | 4 | file_count | 0..200 |
| 16 | 8 | toc_offset | start of the table of contents |
| 24 | 8 | toc_length | bytes in the table of contents |
| 32 | 8 | data_offset | must be `64` |
| 40 | 8 | file_size | the real size of the whole file |
| 48 | 12 | reserved | zeros |
| 60 | 4 | header_crc32 | CRC-32 of bytes 0..59 |

The magic is PNG-style: the high-bit first byte stops it being mistaken for text, and the `\r\n` / `\x1a` / `\n` bytes make a CRLF conversion or text-mode transfer visible immediately.

## Table of contents

```
u8   id_len
     id                 ASCII plugin id, 1-40 chars of a-z 0-9 _ -
per file (file_count times):
u16  path_len
u8   method             0 = stored, 1 = raw deflate (zlib wbits -15)
u8   entry_flags        must be 0
u64  offset             absolute offset of this file's data
u32  stored_size        bytes in the data area
u32  raw_size           bytes after unpacking
b32  sha256             SHA-256 of the unpacked bytes
     path               UTF-8, "/" separated, relative
```

Entries are written sorted by path (byte order), so packing the same files always gives the same bytes: no timestamps, no machine names. `plugin.json` is always stored uncompressed, so `strings plugin.PEK` shows the manifest.

## Footer (32 bytes)

SHA-256 of every byte before the footer. This detects damage and tampering with the file. It does **not** prove who made it (anyone can recompute it). Signing is reserved for version 2 via `flags` bit 0.

## What a reader must check

1. File is at least 96 bytes, magic matches, header CRC matches, `format_version == 1`, `flags == 0`, reserved bytes are zero.
2. `file_size` equals the real size; `toc_offset + toc_length == file_size - 32`.
3. Footer SHA-256 matches.
4. The table of contents parses without running past its end, with no leftover bytes.
5. The entries tile the data area exactly, from byte 64 to `toc_offset`: no gap (a gap could hide a payload), no overlap.
6. Per entry: method is 0 or 1, `raw_size <= 2 MB`, unpacking yields exactly `raw_size` bytes (cap the output at `raw_size + 1` while inflating, so a zip bomb can't grow), and the SHA-256 matches.
7. The plugin rules below.

Every length in the file is attacker-controlled: bounds-check before every read.

## Plugin rules

These mirror `backend/plugin_install.h`, so a PEK the tool accepts is one the installer accepts.

- Required: `plugin.json` (a JSON object, max 16 KB, with `name`, `version` and `flutter.screen`) and `screen.py` at the top level.
- If `plugin.json` names an `icon` or a `flutter.screen`, that file must exist.
- Max 200 files, 2 MB per file, 8 MB total, `.py` files max 200 KB.
- Allowed types: `json css md txt png jpg jpeg gif webp ico woff woff2 ttf otf py`. No `.js`, `.so`, `.dex`, `.html`, `.svg`.
- Paths: relative, `/` separated, no `.` or `..`, no hidden names, no `\ : * ? " < > |`, max 120 bytes, max 6 levels deep, no duplicates (case-insensitive).
- `skin.json` means it is a skin, not a plugin.
- `hesper-tmdb.aquariusibeats.workers.dev` is reserved for official plugins.
- Built-in ids (`weather`, `tmdb-discover`, `skin-maker`, `sample_scraper`, `sample_counter`) are refused by the installer except for Official store updates. The tool warns about these rather than rejecting.

## Where the app reads it

`flutter_ui/lib/src/plugin_pek.dart` is the app's reader. It makes every check above, then hands the files to the same install screens and the same server checks (`POST /api/plugins/install`, `backend/plugin_install.h`) that a plugin has always gone through. `tools/pektool.py` is the writer and inspector; the two must agree, so change the format in both. A plain `.zip` is refused by the app (in red), by name and by content.

## Versioning

A reader that sees a `format_version` it doesn't know must reject the file and say which version it found. New optional features go behind `flags` bits, so old readers refuse them instead of misreading them.
