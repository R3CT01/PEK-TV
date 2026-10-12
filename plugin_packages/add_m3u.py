#!/usr/bin/env python3
"""add_m3u.py - put .m3u / .m3u8 channel lists INTO a TV plugin (Cable Shot by default), then rebuild its zip.

This is a developer tool. It runs on your computer (or Termux), NOT inside PEK TV, and it is not
part of the plugin zip. The stream links are copied into the plugin as JSON files, so they stay in
the plugin after it is zipped and installed.

    python3 add_m3u.py my_channels.m3u               add one list
    python3 add_m3u.py news.m3u sports.m3u8 lists/   several files, and every .m3u/.m3u8 in a folder
    python3 add_m3u.py https://example.com/list.m3u  download one first
    python3 add_m3u.py my.m3u --name "UK TV"         choose the list's name (single input only)
    python3 add_m3u.py --channel "News 24" https://host/live/index.m3u8 --group News
    python3 add_m3u.py --list                        show what the plugin holds
    python3 add_m3u.py --remove "UK TV"              remove one list
    python3 add_m3u.py --clear                       remove every list and guide

Guide (what is on now / next):
    --epg-url https://host/guide.xml    live XMLTV address the plugin loads when it opens (https; the
                                        plugin can read about 1 MB, gzip is not supported, redirects are
                                        not followed). Its host is added to plugin.json "network".
    --epg-file guide.xml(.gz)           XMLTV file copied into the plugin as a snapshot of the next ~3 days
                                        (only for the channels in the lists). Go stale: re-run to refresh.

Other options:
    --logo-hosts N     allow channel logos from the N most common https logo hosts (adds them to "network")
    --no-zip           do not rebuild live-tv.zip
    --plugin NAME|DIR  which plugin to fill: a folder name next to this script or a path
                       (default: cable-shot, the third-party copy. PEK's official live-tv ships without channels.)

Channel lists are the user's own responsibility: only add streams you have the right to use.
"""
import argparse
import datetime
import gzip
import io
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PART_BYTES = 900_000            # the plugin reads at most 1 MB per file
MAX_TOTAL = 7_500_000           # PEK TV accepts 8 MB per plugin
MAX_FILES = 190                 # ... and 200 files
ATTR = re.compile(r'([A-Za-z0-9_-]+)\s*=\s*("([^"]*)"|\'([^\']*)\')')
HOST_OK = re.compile(r'^(\*\.)?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$')


# ---------------------------------------------------------------- names (same rule as ui.js)

def norm_name(s):
    n = ''.join(c for c in str(s or '').lower() if c.isalnum())
    t = re.sub(r'(fhd|uhd|hevc|4k|hd|sd)+$', '', n)
    return t or n


def epg_key(tvg_id, name):
    return 'i:' + tvg_id.lower() if tvg_id else 'n:' + norm_name(name)


def slug(s):
    out = re.sub(r'[^a-z0-9]+', '-', str(s).lower()).strip('-')
    return (out or 'list')[:40]


# ---------------------------------------------------------------- m3u parsing

def is_hls_stream(text):
    return any(t in text for t in ('#EXT-X-STREAM-INF', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE'))


def parse_m3u(text):
    """-> (channels, epg_hints, stats). channel = [name, url, group, tvg_id, logo]"""
    chans, hints = [], []
    stats = {'skipped_scheme': 0, 'header_urls': 0, 'no_name': 0}
    pending, group = None, ''
    for raw in text.splitlines():
        line = raw.strip().lstrip('\ufeff')
        if not line:
            continue
        up = line.upper()
        if up.startswith('#EXTM3U'):
            for m in ATTR.finditer(line):
                if m.group(1).lower() in ('url-tvg', 'x-tvg-url', 'tvg-url'):
                    val = m.group(3) if m.group(3) is not None else m.group(4)
                    hints += [u.strip() for u in val.split(',') if u.strip()]
            continue
        if up.startswith('#EXTINF'):
            body = line.split(':', 1)[1] if ':' in line else ''
            at = {m.group(1).lower(): (m.group(3) if m.group(3) is not None else m.group(4)) for m in ATTR.finditer(body)}
            rest = ATTR.sub('', body)
            name = rest.split(',', 1)[1].strip() if ',' in rest else ''
            pending = {'name': name or at.get('tvg-name', ''), 'group': at.get('group-title', ''),
                       'id': at.get('tvg-id', ''), 'logo': at.get('tvg-logo', '')}
            continue
        if up.startswith('#EXTGRP:'):
            group = line.split(':', 1)[1].strip()
            continue
        if line.startswith('#'):
            continue
        url = line
        if '|' in url:                       # Kodi style "url|User-Agent=..." headers: PEK TV cannot send them
            url = url.split('|', 1)[0]
            stats['header_urls'] += 1
        if not re.match(r'^https?://', url, re.I):
            stats['skipped_scheme'] += 1
            pending = None
            continue
        info = pending or {'name': '', 'group': '', 'id': '', 'logo': ''}
        name = info['name']
        if not name:
            stats['no_name'] += 1
            name = urllib.parse.urlparse(url).netloc or 'Channel'
        logo = info['logo'] if re.match(r'^https?://', info['logo'] or '', re.I) else ''
        chans.append([name[:100], url[:1500], (info['group'] or group)[:60], info['id'][:80], logo[:300]])
        pending = None
    return chans, hints, stats


def fetch(src):
    req = urllib.request.Request(src, headers={'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20'})
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read(60_000_000)
    if data[:2] == b'\x1f\x8b':
        data = gzip.decompress(data)
    return data


def read_source(src):
    """-> (text, is_url)"""
    if re.match(r'^https?://', src, re.I):
        return fetch(src).decode('utf-8', 'replace'), True
    with open(src, 'rb') as f:
        data = f.read()
    return data.decode('utf-8', 'replace'), False


def default_name(src):
    if re.match(r'^https?://', src, re.I):
        u = urllib.parse.urlparse(src)
        stem = os.path.splitext(os.path.basename(u.path))[0]
        return stem if stem and stem.lower() not in ('index', 'playlist', 'get', 'live') else u.netloc
    return os.path.splitext(os.path.basename(src))[0]


def expand_inputs(items):
    out = []
    for it in items:
        if not re.match(r'^https?://', it, re.I) and os.path.isdir(it):
            found = sorted(f for f in os.listdir(it) if f.lower().endswith(('.m3u', '.m3u8')))
            if not found:
                print('  (no .m3u / .m3u8 files in %s)' % it)
            out += [os.path.join(it, f) for f in found]
        else:
            out.append(it)
    return out


# ---------------------------------------------------------------- plugin folder

class Plugin:
    def __init__(self, folder):
        self.dir = folder
        self.pl = os.path.join(folder, 'playlists')
        self.index_path = os.path.join(self.pl, 'index.json')
        os.makedirs(self.pl, exist_ok=True)
        if os.path.exists(self.index_path):
            with open(self.index_path, encoding='utf-8') as f:
                self.index = json.load(f)
        else:
            self.index = {}
        self.index.setdefault('v', 1)
        self.index.setdefault('playlists', [])
        self.index.setdefault('epg', {})
        self.index['epg'].setdefault('urls', [])
        self.index['epg'].setdefault('parts', [])
        self.index['epg'].setdefault('generated', 0)
        self.index.setdefault('logoHosts', [])

    def write_parts(self, base, key, rows):
        """Write rows into <base>.N.json files of at most PART_BYTES. Returns the file names."""
        parts, cur, size = [], [], 2

        def flush():
            if cur:
                parts.append(list(cur))
                cur.clear()
        for r in rows:
            n = len(json.dumps(r, ensure_ascii=False, separators=(',', ':'))) + 1
            if cur and size + n > PART_BYTES:
                flush()
                size = 2
            cur.append(r)
            size += n
        flush()
        names = []
        for i, chunk in enumerate(parts or [[]], 1):
            name = '%s.%d.json' % (base, i)
            with open(os.path.join(self.pl, name), 'w', encoding='utf-8') as f:
                json.dump({key: chunk}, f, ensure_ascii=False, separators=(',', ':'))
            names.append(name)
        return names

    def delete_files(self, names):
        for n in names:
            p = os.path.join(self.pl, n)
            if os.path.exists(p):
                os.remove(p)

    def find(self, name):
        for p in self.index['playlists']:
            if p['name'].lower() == name.lower() or p['id'] == slug(name):
                return p
        return None

    def all_channels(self):
        rows = []
        for p in self.index['playlists']:
            for part in p['parts']:
                with open(os.path.join(self.pl, part), encoding='utf-8') as f:
                    rows += json.load(f)['c']
        return rows

    def save(self):
        self.index['logoHosts'] = sorted(set(self.index['logoHosts']))
        with open(self.index_path, 'w', encoding='utf-8') as f:
            json.dump(self.index, f, ensure_ascii=False, separators=(',', ':'))
        self.sync_manifest()

    def sync_manifest(self):
        path = os.path.join(self.dir, 'plugin.json')
        with open(path, encoding='utf-8') as f:
            man = json.load(f)
        hosts = set(self.index['logoHosts'])
        for u in self.index['epg']['urls']:
            h = urllib.parse.urlparse(u).hostname
            if h:
                hosts.add(h)
        man.setdefault('permissions', {})['network'] = sorted(h for h in hosts if HOST_OK.match(h) and not re.match(r'^[\d.]+$', h))
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(man, f, indent=2, ensure_ascii=False)
            f.write('\n')


# ---------------------------------------------------------------- guide (XMLTV)

def xmltv_time(s):
    m = re.match(r'^\s*(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?\s*$', s or '')
    if not m:
        return 0
    t = datetime.datetime(int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5]), int(m[6] or 0), tzinfo=datetime.timezone.utc).timestamp()
    if m[7]:
        off = int(m[7][1:3]) * 3600 + int(m[7][3:5]) * 60
        t -= -off if m[7][0] == '-' else off
    return int(t)


def build_snapshot(xml_bytes, channels, hours_back=3, hours_ahead=72):
    """XMLTV -> {epg_key: [[start, stop, title], ...]} for the bundled channels only."""
    wanted = {}                                   # xmltv channel id (lower) -> set of keys
    by_id, by_name = {}, {}
    for ch in channels:
        k = epg_key(ch[3], ch[0])
        if ch[3]:
            by_id.setdefault(ch[3].lower(), set()).add(k)
        by_name.setdefault(norm_name(ch[0]), set()).add(k)
    for _ev, el in ET.iterparse(io.BytesIO(xml_bytes), events=('end',)):
        if el.tag == 'channel':
            cid = (el.get('id') or '').lower()
            keys = set(by_id.get(cid, ()))
            for dn in el.findall('display-name'):
                keys |= by_name.get(norm_name(dn.text or ''), set())
            if cid and keys:
                wanted.setdefault(cid, set()).update(keys)
            el.clear()
    now = time.time()
    lo, hi = now - hours_back * 3600, now + hours_ahead * 3600
    progs = {}
    for _ev, el in ET.iterparse(io.BytesIO(xml_bytes), events=('end',)):
        if el.tag == 'programme':
            cid = (el.get('channel') or '').lower()
            if cid in wanted:
                s, e = xmltv_time(el.get('start')), xmltv_time(el.get('stop'))
                title = ' '.join((el.findtext('title') or '').split())
                if title and s and e and e > lo and s < hi:
                    for k in wanted[cid]:
                        progs.setdefault(k, []).append([s, e, title[:80]])
            el.clear()
    for k in progs:
        seen, out = set(), []
        for p in sorted(progs[k]):
            if (p[0], p[1]) not in seen:
                seen.add((p[0], p[1]))
                out.append(p)
        progs[k] = out
    return progs


def write_snapshot(plugin, progs):
    plugin.delete_files(plugin.index['epg']['parts'])
    items = sorted(progs.items())
    parts, cur, size = [], {}, 2
    for k, v in items:
        n = len(json.dumps([k, v], ensure_ascii=False, separators=(',', ':'))) + 2
        if cur and size + n > PART_BYTES:
            parts.append(cur)
            cur, size = {}, 2
        cur[k] = v
        size += n
    if cur:
        parts.append(cur)
    names = []
    for i, chunk in enumerate(parts, 1):
        name = 'epg.%d.json' % i
        with open(os.path.join(plugin.pl, name), 'w', encoding='utf-8') as f:
            json.dump({'p': chunk}, f, ensure_ascii=False, separators=(',', ':'))
        names.append(name)
    plugin.index['epg']['parts'] = names
    plugin.index['epg']['generated'] = int(time.time())


# ---------------------------------------------------------------- zip

def total_size(folder):
    files, size = 0, 0
    for root, _d, names in os.walk(folder):
        for n in names:
            files += 1
            size += os.path.getsize(os.path.join(root, n))
    return files, size


def build_zip(plugin_dir, zip_path):
    base = os.path.basename(os.path.normpath(plugin_dir))
    allowed = {'.js', '.json', '.css', '.md', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'}
    entries = []
    for root, dirs, names in os.walk(plugin_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d != '__pycache__')
        for n in sorted(names):
            if n.startswith('.') or os.path.splitext(n)[1].lower() not in allowed:
                continue
            full = os.path.join(root, n)
            entries.append((full, base + '/' + os.path.relpath(full, plugin_dir).replace(os.sep, '/')))
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for full, arc in entries:
            z.write(full, arc)
    return len(entries)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description='Add .m3u/.m3u8 channel lists to the Live TV Guide plugin and rebuild its zip.',
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument('inputs', nargs='*', help='.m3u/.m3u8 files, folders of them, or http(s) addresses')
    ap.add_argument('--name', help="name for the list (only with a single input)")
    ap.add_argument('--channel', nargs=2, metavar=('NAME', 'URL'), help='add one stream (for a plain .m3u8 address)')
    ap.add_argument('--group', default='', help='category for --channel')
    ap.add_argument('--epg-url', action='append', default=[], metavar='URL', help='live XMLTV address (https), repeatable')
    ap.add_argument('--epg-file', metavar='FILE', help='XMLTV file (.xml or .xml.gz) to bundle as a snapshot')
    ap.add_argument('--logo-hosts', type=int, default=None, metavar='N', help='allow logos from the N most common https hosts (0 = none)')
    ap.add_argument('--list', action='store_true', help='show what the plugin holds')
    ap.add_argument('--remove', metavar='NAME', help='remove one list')
    ap.add_argument('--clear', action='store_true', help='remove every list and the guide')
    ap.add_argument('--no-zip', action='store_true', help='do not rebuild the zip')
    ap.add_argument('--plugin', default='cable-shot', help='plugin folder name (next to this script) or path; default cable-shot')
    a = ap.parse_args()

    plugin_dir = os.path.abspath(a.plugin)
    if not os.path.exists(os.path.join(plugin_dir, 'plugin.json')):
        plugin_dir = os.path.join(HERE, a.plugin)                    # a plain folder name means "next to this script"
    if not os.path.exists(os.path.join(plugin_dir, 'plugin.json')):
        found = sorted(d for d in os.listdir(HERE) if os.path.exists(os.path.join(HERE, d, 'plugin.json')) and os.path.isdir(os.path.join(HERE, d, 'playlists')))
        sys.exit('No plugin "%s". Plugins this tool can fill: %s' % (a.plugin, ', '.join(found) or 'none found next to add_m3u.py'))
    print('Plugin: %s' % os.path.basename(plugin_dir))
    pl = Plugin(plugin_dir)
    changed = False
    hint_urls = []

    if a.list:
        total = 0
        for p in pl.index['playlists']:
            print('  %-28s %6d channels  (%s)' % (p['name'], p['count'], p.get('added', '')))
            total += p['count']
        print('  %d channels in %d list(s)' % (total, len(pl.index['playlists'])))
        e = pl.index['epg']
        print('  guide snapshot: %s' % (datetime.datetime.fromtimestamp(e['generated']).strftime('%Y-%m-%d %H:%M') if e['parts'] else 'none'))
        print('  live guide addresses: %s' % (', '.join(e['urls']) or 'none'))
        files, size = total_size(plugin_dir)
        print('  plugin size: %d files, %.2f MB of 8 MB' % (files, size / 1e6))
        return

    if a.clear:
        for p in pl.index['playlists']:
            pl.delete_files(p['parts'])
        pl.delete_files(pl.index['epg']['parts'])
        pl.index['playlists'] = []
        pl.index['epg'] = {'urls': [], 'parts': [], 'generated': 0}
        pl.index['logoHosts'] = []
        print('Cleared every list and the guide.')
        changed = True

    if a.remove:
        p = pl.find(a.remove)
        if not p:
            sys.exit('No list called "%s". Use --list to see them.' % a.remove)
        pl.delete_files(p['parts'])
        pl.index['playlists'].remove(p)
        print('Removed "%s" (%d channels).' % (p['name'], p['count']))
        changed = True

    def add_list(name, chans, source):
        # drop repeats of the same address inside one list
        seen, uniq = set(), []
        for c in chans:
            if c[1] not in seen:
                seen.add(c[1])
                uniq.append(c)
        old = pl.find(name)
        pid = old['id'] if old else slug(name)
        if not old and any(x['id'] == pid for x in pl.index['playlists']):
            pid = '%s-%d' % (pid, len(pl.index['playlists']) + 1)
        if old:
            pl.delete_files(old['parts'])
            pl.index['playlists'].remove(old)
        parts = pl.write_parts(pid, 'c', uniq)
        pl.index['playlists'].append({'id': pid, 'name': name[:60], 'count': len(uniq), 'parts': parts,
                                      'source': source[:200], 'added': datetime.date.today().isoformat()})
        print('  %s "%s": %d channels%s' % ('Replaced' if old else 'Added', name, len(uniq),
                                            (' (%d repeated addresses dropped)' % (len(chans) - len(uniq))) if len(uniq) != len(chans) else ''))

    def add_single(name, url, group, source):
        """Streams added one by one live together in a list called "Single channels"."""
        old = pl.find('Single channels')
        rows = []
        if old:
            for part in old['parts']:
                with open(os.path.join(pl.pl, part), encoding='utf-8') as f:
                    rows += json.load(f)['c']
        rows = [r for r in rows if r[1] != url] + [[name[:100], url[:1500], group[:60], '', '']]
        add_list('Single channels', rows, source)

    if a.channel:
        name, url = a.channel
        if not re.match(r'^https?://', url, re.I):
            sys.exit('--channel needs an http(s) address.')
        add_single(name, url, a.group, 'added by hand')
        changed = True

    inputs = expand_inputs(a.inputs)
    if a.name and len(inputs) != 1:
        sys.exit('--name only works with a single input.')
    for src in inputs:
        print('Reading %s' % src)
        try:
            text, is_url = read_source(src)
        except Exception as e:                 # noqa: BLE001 - tell the developer what failed
            print('  FAILED: %s' % e)
            continue
        if is_hls_stream(text) and '#EXTINF:-1' not in text and not re.search(r'#EXTINF:[^\n]*(tvg-|group-title)', text):
            if is_url:
                add_single(a.name or default_name(src), src, a.group, src)
                changed = True
            else:
                print('  This file is a single HLS stream (segments), not a channel list. Add its web address instead:\n'
                      '    python3 add_m3u.py --channel "Name" https://host/path/index.m3u8')
            continue
        chans, hints, stats = parse_m3u(text)
        if not chans:
            print('  No http(s) channels found in this file.')
            continue
        add_list(a.name or default_name(src), chans, src if is_url else os.path.basename(src))
        hint_urls += hints
        notes = []
        if stats['skipped_scheme']:
            notes.append('%d entries skipped (only http:// and https:// streams can be played)' % stats['skipped_scheme'])
        if stats['header_urls']:
            notes.append('%d addresses had |header suffixes that PEK TV cannot send, so they were cut off' % stats['header_urls'])
        if stats['no_name']:
            notes.append('%d entries had no name' % stats['no_name'])
        for n in notes:
            print('  note: ' + n)
        changed = True

    if a.epg_url:
        for u in a.epg_url:
            p = urllib.parse.urlparse(u)
            if p.scheme != 'https' or not p.hostname:
                sys.exit('--epg-url must be an https:// address: %s' % u)
            if u not in pl.index['epg']['urls']:
                pl.index['epg']['urls'].append(u)
        print('Live guide addresses: %s' % ', '.join(pl.index['epg']['urls']))
        changed = True

    if a.epg_file:
        try:
            with open(a.epg_file, 'rb') as f:
                data = f.read()
            if data[:2] == b'\x1f\x8b':
                data = gzip.decompress(data)
            rows = pl.all_channels()
            progs = build_snapshot(data, rows)
            write_snapshot(pl, progs)
            print('Guide snapshot: schedules for %d of %d channels (matched by tvg-id, then by name).' % (len(progs), len(rows)))
            changed = True
        except Exception as e:                 # noqa: BLE001
            print('Could not read the guide file: %s' % e)

    if a.logo_hosts is not None:
        counts = {}
        for r in pl.all_channels():
            if r[4].lower().startswith('https://'):
                h = urllib.parse.urlparse(r[4]).hostname
                if h and HOST_OK.match(h) and not re.match(r'^[\d.]+$', h):
                    counts[h] = counts.get(h, 0) + 1
        pl.index['logoHosts'] = [h for h, _ in sorted(counts.items(), key=lambda x: -x[1])[:max(0, a.logo_hosts)]]
        print('Logo hosts allowed: %s' % (', '.join(pl.index['logoHosts']) or 'none'))
        changed = True

    if hint_urls and not a.epg_url and not pl.index['epg']['urls']:
        print('Tip: the list(s) mention a guide address (%s). Add it with --epg-url if it is an https XMLTV file under 1 MB.' % hint_urls[0])

    if not changed:
        if not a.inputs and not a.channel:
            ap.print_help()
        return

    pl.save()
    files, size = total_size(plugin_dir)
    if size > MAX_TOTAL or files > MAX_FILES:
        print('\nWARNING: the plugin is %d files / %.2f MB. PEK TV accepts at most 200 files and 8 MB, so it will refuse this zip. '
              'Remove a list with --remove.' % (files, size / 1e6))
    if not a.no_zip:
        zip_path = os.path.join(os.path.dirname(plugin_dir), os.path.basename(plugin_dir) + '.zip')
        n = build_zip(plugin_dir, zip_path)
        print('\nRebuilt %s (%d files, %.2f MB unzipped).' % (zip_path, n, size / 1e6))
        print('Install it in PEK TV: Settings -> Plugins -> Install plugin from .zip')
    else:
        print('\nUpdated %s (zip not rebuilt).' % plugin_dir)


if __name__ == '__main__':
    main()
