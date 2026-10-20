#!/usr/bin/env node
// Regenerates the Android package allow-list from www/providers.js (the one place the services are listed):
//   - MainActivity.kt        streamingPackages  (what the web UI may ask PEK to open)
//   - AndroidManifest.xml    <queries> <package/> entries (Android 11+ must declare apps it wants to look up)
// Run from the project root after adding or changing a service:   node tools/sync_providers.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
const table = require(path.join(root, 'www', 'providers.js')).table || global.window.PekProviders.table;
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
swap(path.join(root, 'android/app/src/main/java/com/pektv/app/MainActivity.kt'), '// PKGS-START', '// PKGS-END',
    pkgs.map((p, i) => '"' + p + '"' + (i < pkgs.length - 1 ? ',' : '')));
swap(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<!-- PKGS-START -->', '<!-- PKGS-END -->',
    pkgs.map(p => '<package android:name="' + p + '" />'));
swap(path.join(root, 'android/app/src/flutter/java/com/pektv/app/flutter/FlutterHostActivity.kt'), '// PKGS-START', '// PKGS-END',
    pkgs.map((p, i) => '"' + p + '"' + (i < pkgs.length - 1 ? ',' : '')));

// The Flutter UI's plugin screens build the same plan in Python (pek_ui.provider_button), from this same table.
const pyStr = s => JSON.stringify(String(s));
const rows = table.map(p => '    (r"' + p.re.source + '", ' + pyStr(p.name) + ', [' + p.pkgs.map(pyStr).join(', ') + '], ' +
    pyStr(p.home) + ', ' + (p.search ? pyStr(p.search) : 'None') + '),');
fs.writeFileSync(path.join(root, 'android/app/src/main/python/pek_providers.py'),
    '"""Streaming services the "Watch on ..." buttons know (generated from www/providers.js by tools/sync_providers.js; do not edit).\n\n' +
    'Each row: (regex on the normalised service name, display name, Android packages, home page, search link with {q} or None).\n"""\n' +
    'TABLE = [\n' + rows.join('\n') + '\n]\n');
console.log('synced ' + pkgs.length + ' packages');
