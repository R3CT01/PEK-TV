// ============================================================
// HesperTorrent: the web side of torrent playback.
//
// The C++ backend does the real work (/api/torrent/*). This file:
//   - reads/saves the search-provider settings (Settings > Torrents),
//   - searches for releases of a movie / episode,
//   - starts a torrent, shows a "Buffering" box with live progress, and hands the stream
//     URL to PEK's player once enough is downloaded,
//   - stops the torrent (and deletes its temporary data) when the player closes.
// Plugins never touch this directly: plugin_sandbox.js calls it for plugins that declare
// "torrent": true in plugin.json.
// ============================================================
(function () {
    'use strict';
    const API = '/api/torrent';
    const POLL_MS = 400;                   // status poll while buffering: short, so "ready" is noticed straight away
    const NO_METADATA_MS = 90 * 1000;      // magnet never produced a file list
    const NO_PEERS_MS = 120 * 1000;        // buffering but nobody to download from

    async function call(url, opts) {
        let res;
        try { res = await fetch(url, opts); } catch (e) { throw new Error("Couldn't reach PEK's server."); }
        let data = {};
        try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
        return data;
    }
    const post = (url, obj) => call(url, { method: 'POST', body: new URLSearchParams(obj || {}) });

    const fmtSpeed = kb => kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB/s' : kb + ' KB/s';
    const fmtSize = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB';

    let busy = false;

    function makeOverlay(title, onCancel) {
        const box = document.createElement('div');
        box.setAttribute('role', 'dialog');
        box.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;' +
            'background:rgba(0,0,0,.72);font-family:inherit;padding:16px';
        const card = document.createElement('div');
        card.style.cssText = 'width:min(420px,100%);padding:20px;border-radius:var(--sx-radius,14px);' +
            'background:var(--sx-bg-elevated,#1b1b22);color:var(--sx-text,#fff);border:1px solid var(--sx-border,#ffffff22);' +
            'box-shadow:0 10px 40px rgba(0,0,0,.5)';
        const h = document.createElement('div');
        h.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:4px;word-break:break-word';
        h.textContent = title || 'Starting stream';
        const line = document.createElement('div');
        line.style.cssText = 'font-size:14px;color:var(--sx-text-muted,#aaa);min-height:20px;margin:6px 0 12px;white-space:pre-line';
        const bar = document.createElement('div');
        bar.style.cssText = 'height:8px;border-radius:4px;background:var(--sx-surface,#ffffff18);overflow:hidden';
        const fill = document.createElement('div');
        fill.style.cssText = 'height:100%;width:3%;background:var(--sx-accent,#6cf);transition:width .4s';
        bar.appendChild(fill);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Cancel';
        btn.style.cssText = 'margin-top:16px;padding:10px 18px;border-radius:10px;border:1px solid var(--sx-border,#ffffff33);' +
            'background:transparent;color:inherit;font-size:15px;cursor:pointer';
        btn.addEventListener('click', onCancel);
        card.append(h, line, bar, btn);
        box.appendChild(card);
        document.body.appendChild(box);
        btn.focus();
        return {
            set(text, frac) { line.textContent = text; if (frac != null) fill.style.width = Math.max(3, Math.min(100, frac * 100)) + '%'; },
            done() { box.remove(); }
        };
    }

    // What to remember for Resume Watching: an id for the item plus what the Resume card needs to show
    // and to start the same release again. null = do not track (no usable title).
    function makeTrack(opts) {
        const t = opts && opts.track, S = window.HesperSync;
        if (!t || !t.meta || !S || typeof S.histKey !== 'function') return null;
        const m = t.meta;
        let key;
        if (m.kind === 'other') {   // no movie/episode identity: remembered by its title only (not synced)
            const nt = String(m.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
            key = nt ? 'o|' + nt + '|' + (m.season | 0) + '|' + (m.episode | 0) : null;
        } else {
            key = S.histKey(m);
        }
        if (!key) return null;
        const meta = { kind: m.kind };
        if (m.kind === 'movie') { meta.title = m.title; meta.year = m.year | 0; }
        else if (m.kind === 'other') { meta.title = m.title; meta.season = m.season | 0; meta.episode = m.episode | 0; }
        else { meta.showTitle = m.showTitle; meta.season = m.season | 0; meta.episode = m.episode | 0; }
        if (m.image) meta.image = m.image;
        const og = t.origin || m.origin;
        if (og && og.name) meta.origin = { id: String(og.id || '').slice(0, 80), name: String(og.name).slice(0, 60) };
        meta.torrent = { source: opts.source, title: opts.title || '', season: opts.season | 0, episode: opts.episode | 0 };
        return { id: 'tor:' + key, meta, startSec: opts.startSec > 0 ? opts.startSec : 0 };
    }

    window.HesperTorrent = {
        info() { return call(API + '/info'); },
        getSettings() { return call(API + '/settings'); },
        saveSettings(url, key) { return post(API + '/settings', { url: url || '', key: key || '' }); },
        // Lets the server download this .torrent link when it is started (called by plugin_sandbox.js only).
        allowLink(url) { return post(API + '/allow', { url: String(url || '') }); },

        // q: { kind: 'movie'|'episode', title, year, season, episode }  ->  [{title, source, sizeText, seeders, quality, pack}]
        async search(q) {
            const p = new URLSearchParams();
            p.set('kind', q.kind === 'episode' ? 'episode' : 'movie');
            p.set(q.kind === 'episode' ? 'show' : 'title', String(q.title || '').slice(0, 200));
            if (q.year > 0) p.set('year', String(q.year | 0));
            if (q.season > 0) p.set('season', String(q.season | 0));
            if (q.episode > 0) p.set('episode', String(q.episode | 0));
            const d = await call(API + '/search?' + p.toString());
            return d.results || [];
        },

        // Starts `source` (a magnet link or a link from a search result), shows the buffering box and
        // opens the player when it is ready. Resolves once the player is open; rejects if it failed
        // or the user cancelled.
        //   opts: { source, title, season, episode, track?: { meta }, startSec? }
        async open(opts) {
            if (busy) throw new Error('Another stream is already starting');
            if (!window.HesperHost || typeof window.HesperHost.playStream !== 'function') throw new Error('PEK cannot play streams here');
            busy = true;
            let hash = '';
            let cancelled = false;
            const overlay = makeOverlay(opts.title, () => { cancelled = true; });
            try {
                overlay.set('Contacting the swarm\u2026', 0.03);
                const started = await post(API + '/start', { source: opts.source, season: opts.season | 0, episode: opts.episode | 0 });
                hash = started.hash;
                const t0 = Date.now();
                let lastGood = Date.now();
                for (;;) {
                    if (cancelled) throw new Error('Cancelled');
                    const s = await call(API + '/' + hash + '/status');
                    if (s.state === 'error') throw new Error(s.error || 'The torrent failed');
                    if (s.state === 'metadata') {
                        overlay.set('Getting the file list\u2026 (' + s.peers + ' peers)', 0.05);
                        if (Date.now() - t0 > NO_METADATA_MS) throw new Error("Couldn't get this torrent's file list. It may have no seeders.");
                    } else if (s.ready) {
                        break;
                    } else {
                        if (s.peers > 0 || s.downKBps > 0) lastGood = Date.now();
                        overlay.set('Loading ' + Math.round((s.bufferProgress || 0) * 100) + '%  ' + (s.file || '') + '\n' + s.peers + ' peers \u00b7 ' + fmtSpeed(s.downKBps) +
                            (s.fileSize ? ' \u00b7 ' + fmtSize(s.fileSize) : ''), 0.1 + 0.9 * (s.bufferProgress || 0));
                        if (Date.now() - lastGood > NO_PEERS_MS) throw new Error('No one is sending data for this release. Try another one.');
                    }
                    await new Promise(r => setTimeout(r, POLL_MS));
                }
                overlay.done();
                const url = window.location.origin + API + '/' + hash + '/stream';
                window.HesperHost.playStream(url, opts.title || '', () => {
                    post(API + '/' + hash + '/stop').catch(() => {});
                }, makeTrack(opts));
                busy = false;
                return { hash: hash };
            } catch (e) {
                if (hash) post(API + '/' + hash + '/stop').catch(() => {});
                overlay.done();
                busy = false;
                throw e;
            }
        }
    };
})();
