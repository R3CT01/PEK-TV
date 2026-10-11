// Magnet Player: paste a magnet link, PEK TV streams it (permission: torrent).
// Recent links are kept in this plugin's private storage (permission: storage).

var draft = '';
var error = '';
var recent = [];          // [{ link, title }], newest first
var engine = null;        // { available, configured } from pek.torrent.info()
var busy = false;

var MAX_RECENT = 10;

pek.storage.get('recent').then(function (v) {
    try { recent = JSON.parse(v || '[]'); } catch (e) { recent = []; }
    if (!Array.isArray(recent)) recent = [];
    pek.requestRender();
}).catch(function () {});

pek.torrent.info().then(function (i) { engine = i; pek.requestRender(); }).catch(function () {});

function nameFromMagnet(link) {
    var m = /[?&]dn=([^&]+)/i.exec(link);
    if (!m) return 'Magnet link';
    try { return decodeURIComponent(m[1].replace(/\+/g, ' ')).slice(0, 120) || 'Magnet link'; }
    catch (e) { return 'Magnet link'; }
}

function validate(link) {
    if (!/^magnet:\?/i.test(link)) return 'Paste a link that starts with magnet:?';
    if (!/[?&]xt=urn:(btih|btmh):/i.test(link)) return 'This magnet link has no torrent hash (xt=urn:btih:...).';
    if (link.length > 4000) return 'This link is too long.';
    return '';
}

function remember(link, title) {
    recent = recent.filter(function (r) { return r.link !== link; });
    recent.unshift({ link: link, title: title });
    recent = recent.slice(0, MAX_RECENT);
    pek.storage.set('recent', JSON.stringify(recent)).catch(function () {});
}

function play(link) {
    link = String(link || '').trim();
    var bad = validate(link);
    if (bad) { error = bad; pek.requestRender(); return; }
    if (busy) return;
    busy = true;
    error = '';
    var title = nameFromMagnet(link);
    pek.requestRender();
    pek.torrent.play({ source: link, title: title }).then(function () {
        remember(link, title);
        draft = '';
    }).catch(function (e) {
        var msg = String((e && e.message) || e || '');
        if (msg !== 'Cancelled') error = msg || 'Could not start the stream.';
    }).then(function () {
        busy = false;
        pek.requestRender();
    });
}

pek.render(function (ui) {
    var kids = [
        ui.heading('Magnet Player'),
        ui.text('Paste a magnet link. PEK TV downloads the start, then opens the player while the rest arrives.')
    ];

    if (engine && !engine.available) {
        kids.push(ui.card('Torrent engine not included',
            'This build of PEK TV cannot play torrents, so Magnet Player cannot start a stream.'));
    }
    if (error) kids.push(ui.card('Problem', error));

    kids.push(ui.textInput('Magnet link', draft, function (v) { draft = v; },
        { placeholder: 'magnet:?xt=urn:btih:\u2026', onSubmit: function (v) { play(v); } }));
    kids.push(busy
        ? ui.spinner('Starting\u2026')
        : ui.button('Play', function () { play(draft); }, { primary: true, autofocus: 'magnet-play' }));

    if (recent.length) {
        kids.push(ui.heading('Recent'));
        recent.forEach(function (r) {
            kids.push(ui.listRow(r.title, 'Tap to play again', function () { play(r.link); }));
        });
        kids.push(ui.button('Clear recent', function () {
            recent = [];
            pek.storage.remove('recent').catch(function () {});
            pek.requestRender();
        }));
    }
    return ui.column.apply(ui, kids);
});
