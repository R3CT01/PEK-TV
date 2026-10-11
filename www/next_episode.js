// ============================================================
// Up next: offers the next episode near the end of the one that is playing.
//
// Where the next episode comes from (in this order):
//   1. Your own library. If the next episode is in a folder you gave PEK, it is offered.
//   2. The plugin you are watching from. Only for streams a plugin started (Stream Media and
//      similar): PEK asks that plugin to look for the next episode and a stream for it.
//   3. Nothing. Watching a file from your own drive that has no next episode there: no card.
//
// The card sits on the right side of the player. It appears for the last ~5 minutes (long credits),
// OK / tap plays it. If the episode ends while the card is up, the next one starts after a
// 5 second countdown that can be cancelled.
//
//   HesperNext.Controller  the card (player.js builds one per player)
//   MainApp methods        _nextProvider(track): what to offer and how to play it
// ============================================================

(function () {
    'use strict';

    const SHOW_LEFT = 300;       // show the card when this many seconds are left (5 min: some series have 4 min of credits)
    const LOOK_LEFT = 420;       // start looking for the next episode this many seconds before the end (must be > SHOW_LEFT)
    const COUNTDOWN = 5;         // seconds before the next episode starts on its own once this one ended
    const MIN_LENGTH = 300;      // clips shorter than this never get a card
    const STYLE_ID = 'hp-next-style';

    function isTv() {
        try { const a = window.HesperAndroid; return !(a && typeof a.isPhone === 'function' && a.isPhone()); }
        catch (e) { return true; }
    }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = `
.hp-next { position: absolute; right: 22px; top: 50%; z-index: 3; display: none; width: 290px; max-width: 46vw; box-sizing: border-box;
    padding: 16px 18px 16px; border-radius: 16px; color: #f6f2ec; color: var(--hp-fg, #f6f2ec);
    background-color: rgba(28, 24, 21, 0.88); background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.9);
    border: 1px solid rgba(246, 242, 236, 0.22); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.22);
    box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5); -webkit-transform: translateY(-50%); transform: translateY(-50%); }
.hp-next.hp-on { display: block; -webkit-animation: hp-next-in 0.3s ease-out; animation: hp-next-in 0.3s ease-out; }
.hp-menu.hp-open ~ .hp-next, .hp-confirm.hp-open ~ .hp-next { display: none !important; }
.hp-next-kicker { font-size: 0.72rem; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.7; }
.hp-next-ep { font-size: 1.35rem; font-weight: 800; margin-top: 4px; }
.hp-next-name { font-size: 0.95rem; opacity: 0.92; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-next-via { font-size: 0.78rem; opacity: 0.6; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hp-next-row { display: flex; gap: 10px; margin-top: 14px; }
.hp-next-btn { font: inherit; font-weight: 700; font-size: 0.92rem; padding: 10px 16px; border-radius: 999px; cursor: pointer; white-space: nowrap;
    background: transparent; color: inherit; border: 1px solid rgba(246, 242, 236, 0.35); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.35); }
.hp-next-play { flex: 1; background-color: #f3eee7; background-color: var(--hp-hi, #f3eee7); color: #1c1815; color: var(--hp-ink, #1c1815); border-color: transparent; }
.hp-next-btn.hp-focused, .hp-next-btn:active { -webkit-transform: scale(1.05); transform: scale(1.05); box-shadow: 0 0 0 2px rgba(246, 242, 236, 0.9); }
.hp-next-btn[disabled] { opacity: 0.6; cursor: default; }
.hp-next.hp-tv { right: 56px; width: 360px; padding: 20px 24px; border-radius: 10px; }
.hp-next.hp-tv .hp-next-ep { font-size: 1.7rem; } .hp-next.hp-tv .hp-next-name { font-size: 1.1rem; }
.hp-next.hp-tv .hp-next-btn { font-size: 1.1rem; padding: 12px 22px; }
.hp-next-key { font-size: 0.72rem; font-weight: 700; padding: 1px 7px; border-radius: 4px; border: 1.5px solid currentColor; opacity: 0.7; margin-left: 8px; }
@-webkit-keyframes hp-next-in { from { opacity: 0; margin-right: -24px; } to { opacity: 1; margin-right: 0; } }
@keyframes hp-next-in { from { opacity: 0; margin-right: -24px; } to { opacity: 1; margin-right: 0; } }
@media (max-width: 700px) { .hp-next { right: 12px; width: 230px; padding: 12px 14px; } .hp-next-ep { font-size: 1.1rem; } }
`;
        document.head.appendChild(s);
    }

    class Controller {
        // provider = { resolve(): Promise<offer|null>, start(offer, player): Promise }
        // offer    = { kind, season, episode, name?, via? }
        constructor(player, provider) {
            this.player = player;
            this.provider = provider || null;
            this.offer = null;
            this.el = null;
            this.playBtn = null;
            this._resolved = false;
            this._dismissed = false;
            this._busy = false;
            this._dead = false;
            this._shown = false;
            this._pos = 0;
            this._dur = 0;
            this._cd = null;           // countdown after the episode ended
        }

        mount(root) {
            if (!this.provider) return;
            injectStyle();
            const mk = (cls, txt) => { const e = document.createElement('div'); e.className = cls; if (txt) e.textContent = txt; return e; };
            const el = mk('hp-next' + (isTv() ? ' hp-tv' : ''));
            this.kickerEl = mk('hp-next-kicker', 'Up next');
            this.epEl = mk('hp-next-ep');
            this.nameEl = mk('hp-next-name');
            this.viaEl = mk('hp-next-via');
            const row = mk('hp-next-row');
            const play = document.createElement('button');
            play.type = 'button'; play.className = 'hp-next-btn hp-next-play';
            play.addEventListener('click', (ev) => { ev.stopPropagation(); this.activate(); });
            const no = document.createElement('button');
            no.type = 'button'; no.className = 'hp-next-btn'; no.textContent = 'Not now';
            no.addEventListener('click', (ev) => { ev.stopPropagation(); this.dismiss(); });
            [play, no].forEach(b => b.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); }));   // do not toggle the controls
            row.appendChild(play); row.appendChild(no);
            [this.kickerEl, this.epEl, this.nameEl, this.viaEl, row].forEach(c => el.appendChild(c));
            root.appendChild(el);
            this.el = el; this.playBtn = play; this.noBtn = no;
            this._fill();
        }

        destroy() {
            this._dead = true;
            clearInterval(this._cd); this._cd = null;
            if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
            this.el = null;
        }

        visible() { return !!(this.el && this._shown && this.offer && !this._dead); }

        // Called with every time update from the player.
        tick(pos, dur) {
            this._pos = pos || 0; this._dur = dur || 0;
            if (this._dead || !this.provider || this._dismissed || this._dur < MIN_LENGTH) return;
            const left = this._dur - this._pos;
            if (!this._resolved && left <= LOOK_LEFT && this._pos >= this._dur * 0.5) this._resolve();
            this._evaluate();
        }

        _evaluate() {
            if (!this.el) return;
            const left = this._dur - this._pos;
            const showLeft = Math.min(SHOW_LEFT, this._dur * 0.35);   // short episodes: never in the first third
            const want = !!this.offer && !this._dismissed && !this._dead && (left <= showLeft || !!this._cd);
            if (!want && this._shown && left > showLeft + 20 && !this._cd) this._setShown(false);   // wound back: hide again
            else if (want && !this._shown) this._setShown(true);
        }

        _setShown(on) {
            this._shown = on;
            if (this.el) this.el.classList.toggle('hp-on', on);
            if (this.player && this.player._updateButtons) this.player._updateButtons();
            if (on && this.player && this.player._updateFocus) this.player._updateFocus();
        }

        async _resolve() {
            this._resolved = true;
            let offer = null;
            try { offer = await this.provider.resolve(); } catch (e) { offer = null; }
            if (this._dead) return;
            this.offer = offer && typeof offer === 'object' && offer.episode > 0 ? offer : null;
            this._fill();
            this._evaluate();
        }

        _fill(status) {
            if (!this.el) return;
            const o = this.offer;
            this.epEl.textContent = o ? 'S' + o.season + ' \u00b7 E' + o.episode : '';
            this.nameEl.textContent = o && o.name ? o.name : '';
            this.nameEl.style.display = o && o.name ? '' : 'none';
            this.viaEl.textContent = o ? (o.kind === 'library' ? 'From your library' : 'Finds a stream with ' + (o.via || 'the plugin')) : '';
            const busy = this._busy || !!this._cd;
            this.playBtn.textContent = status || '\u25b6  Play now';
            this.playBtn.disabled = this._busy;
            this.noBtn.textContent = this._cd ? 'Cancel' : 'Not now';
            this.noBtn.disabled = this._busy;
            if (!busy && isTv() && !status) {
                const k = document.createElement('span'); k.className = 'hp-next-key'; k.textContent = 'OK';
                this.playBtn.appendChild(k);
            }
        }

        // OK / tap on "Play now"
        activate() {
            if (!this.offer || this._busy || this._dead) return;
            clearInterval(this._cd); this._cd = null;
            this._busy = true;
            this._fill('Starting\u2026');
            const offer = this.offer;
            Promise.resolve().then(() => this.provider.start(offer, this.player)).catch(() => { /* the app shows its own message */ }).then(() => {
                if (this._dead) return;
                this._busy = false;          // the player is still open (nothing started): offer it again
                this._fill();
            });
        }

        // "Not now" / "Cancel"
        dismiss() {
            if (this._busy) return;
            const wasCounting = !!this._cd;
            clearInterval(this._cd); this._cd = null;
            this._dismissed = true;
            this._setShown(false);
            if (wasCounting && this.player && !this.player._closed) this.player.close();    // it had ended: just leave
        }

        // The video reached its end. True = this took over (the player must not close itself yet).
        onEnded() {
            if (this._dead || !this.offer || this._dismissed || this._busy) return false;
            let n = COUNTDOWN;
            this._setShown(true);
            const tickText = () => { this.playBtn.textContent = 'Starting in ' + n + '\u2026'; this.noBtn.textContent = 'Cancel'; };
            this._cd = setInterval(() => {
                n -= 1;
                if (n <= 0) { clearInterval(this._cd); this._cd = null; this.activate(); return; }
                tickText();
            }, 1000);
            tickText();
            return true;
        }
    }

    window.HesperNext = { Controller };
})();


// ============================================================
// App side: what to offer and how to play it. Added to MainApp.prototype.
// ============================================================
class MainAppNextMethods {

    // track = { id, meta, startSec } as the player gets it. null = no card for this video.
    _nextProvider(track) {
        const m = track && track.meta;
        if (!m || m.kind !== 'episode' || !m.showTitle || !(m.episode > 0) || !(m.season >= 0)) return null;
        // meta.origin is set by PEK itself for streams a plugin started. Files from your own drive have none.
        const origin = m.origin && m.origin.id ? String(m.origin.id) : '';
        return {
            resolve: () => this._nextResolve(m, origin),
            start: (offer, player) => this._nextStart(m, offer, player)
        };
    }

    _nextPlugin(folder) {
        const p = (this.state.pluginsList || []).find(x => x.folder === folder && x.sandboxed && x.sandbox);
        return p && p.sandbox && p.sandbox.started ? p : null;
    }

    async _nextResolve(m, origin) {
        const lib = await this._nextInLibrary(m);
        if (lib) return lib;
        if (!origin) return null;                       // from your own drive and nothing next there: no card
        const p = this._nextPlugin(origin);
        if (!p) return null;
        const r = await p.sandbox.nextEpisode({ phase: 'check', showTitle: m.showTitle, season: m.season | 0, episode: m.episode | 0 }, 90000);
        if (!r || !r.ok || !(r.episode > 0)) return null;
        return { kind: 'plugin', folder: origin, season: r.season, episode: r.episode, name: r.name || '', via: p.app_name || origin };
    }

    // The next episode that is in the library folders (same season, else the first one of a later season).
    async _nextInLibrary(m) {
        const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        let data = null;
        const c = this._nextShows;
        if (c && Date.now() - c.t < 60000) data = c.data;
        else {
            try { data = await (await fetch('/api/shows')).json(); this._nextShows = { t: Date.now(), data }; }
            catch (e) { return null; }
        }
        const want = norm(m.showTitle);
        const show = ((data && data.shows) || []).find(s => norm(s.showTitle) === want);
        if (!show) return null;
        const eps = [];
        (show.seasons || []).forEach(se => (se.episodes || []).forEach(e => eps.push({ id: e.id, season: e.season | 0, episode: e.episode | 0 })));
        const byEp = (a, b) => a.episode - b.episode;
        let next = eps.filter(e => e.season === (m.season | 0) && e.episode > (m.episode | 0)).sort(byEp)[0];
        if (!next) {
            const later = eps.filter(e => e.season > (m.season | 0) && e.season > 0);
            if (later.length) {
                const s = Math.min.apply(null, later.map(e => e.season));
                next = later.filter(e => e.season === s).sort(byEp)[0];
            }
        }
        if (!next) return null;
        let name = '';
        try {      // the episode's title, if TMDb answers quickly; the card works without it
            const q = `show=${encodeURIComponent(m.showTitle)}&season=${next.season}&episode=${next.episode}`;
            const d = await Promise.race([fetch('/api/episode-details?' + q).then(r => r.json()), new Promise(r => setTimeout(() => r(null), 4000))]);
            if (d && typeof d.name === 'string') name = d.name.slice(0, 120);
        } catch (e) { /* no title */ }
        return { kind: 'library', id: next.id, season: next.season, episode: next.episode, name, via: '' };
    }

    async _nextStart(m, offer, player) {
        const pad = n => (n < 10 ? '0' : '') + n;
        const label = `${m.showTitle} S${pad(offer.season)}E${pad(offer.episode)}`;
        const { ui } = this.props.engine;
        if (offer.kind === 'library') {
            const meta = { kind: 'episode', showTitle: m.showTitle, season: offer.season, episode: offer.episode };
            player.close();                              // one player at a time
            await this.playMedia(offer.id, label, meta, 0);
            return;
        }
        const p = this._nextPlugin(offer.folder);
        if (!p) { ui.toast("Couldn't reach " + (offer.via || 'the plugin') + '.'); return; }
        player.close();                                  // the plugin's stream opens its own player once it is buffered
        const r = await p.sandbox.nextEpisode({ phase: 'play', showTitle: m.showTitle, season: offer.season, episode: offer.episode }, 16 * 60 * 1000);
        if (!r || !r.ok) {
            const why = r && r.error && r.error !== 'Cancelled' ? ' ' + r.error : '';
            if (!r || r.error !== 'Cancelled') ui.toast("Couldn't start " + label + '.' + why);
        }
    }
}

if (typeof hesperMixin === 'function' && typeof MainApp !== 'undefined') hesperMixin(MainApp, MainAppNextMethods);
