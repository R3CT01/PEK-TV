#!/usr/bin/env node
// Regenerates the Android package allow-list from www/providers.js (the one place the services are listed):
//   - MainActivity.kt        streamingPackages  (what the web UI may ask Hesper to open)
//   - AndroidManifest.xml    <queries> <package/> entries (Android 11+ must declare apps it wants to look up)
// Run from the project root after adding or changing a service:   node tools/sync_providers.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
global.window = {};
const table = require(path.join(root, 'www', 'providers.js')).table || global.window.HesperProviders.table;
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
swap(path.join(root, 'android/app/src/main/java/com/hesper/app/MainActivity.kt'), '// PKGS-START', '// PKGS-END',
    pkgs.map((p, i) => '"' + p + '"' + (i < pkgs.length - 1 ? ',' : '')));
swap(path.join(root, 'android/app/src/main/AndroidManifest.xml'), '<!-- PKGS-START -->', '<!-- PKGS-END -->',
    pkgs.map(p => '<package android:name="' + p + '" />'));
console.log('synced ' + pkgs.length + ' packages');
