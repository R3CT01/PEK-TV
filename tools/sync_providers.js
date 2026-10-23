#!/usr/bin/env node
// Regenerates the Android package allow-list and the Python provider table from tools/providers.json
// (the one place the streaming services are listed):
//   - AndroidManifest.xml          <queries> <package/> entries (Android 11+ must declare apps it wants to look up)
//   - FlutterHostActivity.kt       streamingPackages (what a plugin's "Watch on ..." button may ask PEK to open)
//   - pek_providers.py             the table the Python plugin screens use (pek_ui.provider_button)
// Run from the project root after adding or changing a service:   node tools/sync_providers.js
// To add a service, add a row to providers.json. A plugin only says WHICH service (TMDb's name) and WHICH title;
// it never supplies an address or an app name, so a button cannot be used to open something else.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const table = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8')).providers;
const pkgs = Array.from(new Set([].concat(...table.map(p => p.pkgs)))).sort();

function swap(file, startMark, endMark, lines) {
    let s = fs.readFileSync(file, 'utf8');
    const a = s.indexOf(startMark), b = s.indexOf(endMark);
    if (a < 0 || b < a) throw new Error('markers missing in ' + file);
    const lineStart = s.lastIndexOf('\n', a) + 1;
    const indent = s.slice(lineStart, a);
    s = s.slice(0, a + startMark.length) + '\n' + lines.map(l => indent + l).join('\n') + '\n' + indent + s.slice(b);
    fs.writeFileSync(file, s);
}
swap(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<!-- PKGS-START -->', '<!-- PKGS-END -->',
    pkgs.map(p => '<package android:name="' + p + '" />'));
swap(path.join(root, 'android/app/src/flutter/java/com/pektv/app/flutter/FlutterHostActivity.kt'), '// PKGS-START', '// PKGS-END',
    pkgs.map((p, i) => '"' + p + '"' + (i < pkgs.length - 1 ? ',' : '')));

const pyStr = s => JSON.stringify(String(s));
const rows = table.map(p => '    (r"' + p.match + '", ' + pyStr(p.name) + ', [' + p.pkgs.map(pyStr).join(', ') + '], ' +
    pyStr(p.home) + ', ' + (p.search ? pyStr(p.search) : 'None') + '),');
fs.writeFileSync(path.join(root, 'android/app/src/main/python/pek_providers.py'),
    '"""Streaming services the "Watch on ..." buttons know (generated from tools/providers.json by tools/sync_providers.js; do not edit).\n\n' +
    'Each row: (regex on the normalised service name, display name, Android packages, home page, search link with {q} or None).\n"""\n' +
    'TABLE = [\n' + rows.join('\n') + '\n]\n');
console.log('synced ' + pkgs.length + ' packages');
