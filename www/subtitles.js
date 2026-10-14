/* ============================================================
   PEK TV automatic subtitles (PekSubs)

   When something plays that has no subtitles of its own (typically a torrent stream), this looks
   them up online (OpenSubtitles.com, through the app's own backend: /api/subtitles/*), picks the best
   match and switches it on. The subtitle menu also gets a "Find subtitles online" entry to choose by hand.

   What is playing is worked out from, in order: the library / torrent metadata the player was opened
   with (movie title + year, or show + season + episode), then the release name of the torrent, then the
   player's title. Release names like "Show.Name.S02E05.1080p.WEB-DL.x264-GRP" are cleaned up here.

   Nobody needs an account: the app's backend asks one shared OpenSubtitles account kept in the cloud worker
   (cloud/worker.js), which also keeps every subtitle it has downloaded so it is only ever fetched once.

   Settings (Settings > Subtitles, kept in this device's local storage):
     pek_subs_lang                                   language code(s), e.g. "en" or "en,es"
     pek_subs_auto                                   '0' = never search on its own (default: on)

   Used by player.js:
     new PekSubs.Controller(player, meta)   .onTracks()  .available()  .menuItems()  .find(auto)  .destroy()
   Also:  PekSubs.parseName(text)  PekSubs.toVtt(srt)  PekSubs.config / PekSubs.setConfig(...)
   ============================================================ */
(function () {
    'use strict';

    const K = { lang: 'pek_subs_lang', auto: 'pek_subs_auto' };
    const AUTO_DELAY_MS = 2500;      // wait for the file's own subtitle tracks to show up before deciding there are none
    const AUTO_MIN_SCORE = 8;        // the backend's ranking: below this the best match is too doubtful to switch on by itself
    const MENU_RESULTS = 12;

    function read(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
    function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: setting just isn't kept */ } }

    const config = {
        get lang() { return String(read(K.lang, 'en')).trim() || 'en'; },
        get auto() { return read(K.auto, '1') !== '0'; }
    };
    function setConfig(o) {
        if (!o) return;
        if ('lang' in o) write(K.lang, String(o.lang || 'en').trim() || 'en');
        if ('auto' in o) write(K.auto, o.auto ? '1' : '0');
    }
    function configured() { return true; }   // the shared service needs no set-up on the device

    // ---------------- what is playing ----------------

    const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10?\+?|hdr|dv|dolby\s*vision|blu-?ray|bdrip|brrip|web-?dl|web-?rip|webrip|web|hdtv|dvdrip|dvd|remux|x\.?26[45]|h\.?26[45]|hevc|avc|xvid|divx|aac|ac3|eac3|dd[p+]?\s*5\s*1|dts|truehd|atmos|10bit|8bit|proper|repack|extended|unrated|remastered|imax|multi|dual|subbed|hardsub)\b/i;

    // "Show.Name.S02E05.1080p.WEB-DL-GRP.mkv"  ->  { title: 'Show Name', season: 2, episode: 5, year: 0 }
    function parseName(raw) {
        let s = String(raw || '').trim();
        s = s.replace(/\.(mkv|mp4|m4v|avi|mov|wmv|webm|ts|m2ts|mpg|mpeg|srt)$/i, '');
        s = s.replace(/\[[^\]]*\]/g, ' ').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
        let season = 0, episode = 0, year = 0, cut = s.length;

        let m = /\bS(\d{1,2})\s*[.\-_ ]?\s*E(\d{1,3})\b/i.exec(s) || /\b(\d{1,2})x(\d{2,3})\b/i.exec(s);
        if (m) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); cut = Math.min(cut, m.index); }
        else if ((m = /\bseason\s*(\d{1,2})\D{0,6}episode\s*(\d{1,3})\b/i.exec(s))) { season = parseInt(m[1], 10); episode = parseInt(m[2], 10); cut = Math.min(cut, m.index); }

        // a year only counts once something comes before it ("2012" alone is a title)
        const re = /\b(19[2-9]\d|20[0-4]\d)\b/g;
        let y;
        while ((y = re.exec(s))) {
            if (y.index > 2) { year = parseInt(y[1], 10); if (!season) cut = Math.min(cut, y.index); break; }
        }
        const j = JUNK.exec(s);
        if (j && j.index > 2) cut = Math.min(cut, j.index);

        let title = s.slice(0, cut).replace(/[\(\[\-:\s]+$/g, '').replace(/^[\s\-]+/, '').trim();
        if (!title) title = s.replace(JUNK, ' ').replace(/\s+/g, ' ').trim();
        return { title: title, season: season, episode: episode, year: year };
    }

    // meta = what the player was opened with (see app_watch / torrent.js), name = the player's title
    function identify(meta, name) {
        const m = meta || {};
        const rel = (m.torrent && m.torrent.title) ? String(m.torrent.title) : '';
        let q = null;
        if (m.kind === 'movie' && m.title) q = { title: String(m.title), year: m.year | 0, season: 0, episode: 0 };
        else if (m.kind === 'episode' && m.showTitle && (m.season | 0) > 0 && (m.episode | 0) > 0) {
            q = { title: String(m.showTitle), year: 0, season: m.season | 0, episode: m.episode | 0 };
        }
        if (!q) {
            const p = parseName(rel || m.title || name);
            q = { title: p.title, year: p.year, season: p.season, episode: p.episode };
            if ((m.season | 0) > 0 && (m.episode | 0) > 0) { q.season = m.season | 0; q.episode = m.episode | 0; }
        }
        q.file = rel || String(name || '');
        return q;
    }

    // ---------------- backend calls ----------------

    function form(o) {
        const p = new URLSearchParams();
        Object.keys(o).forEach(k => { if (o[k] !== undefined && o[k] !== null && o[k] !== '') p.set(k, String(o[k])); });
        return p.toString();
    }

    async function call(path, params) {
        let r;
        try {
            r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) });
        } catch (e) { throw new Error('Could not reach the app. Check your connection.'); }
        let j = null;
        try { j = await r.json(); } catch (e) { /* not JSON */ }
        if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('Subtitle lookup failed (HTTP ' + r.status + ').'));
        return j;
    }

    function search(q) {
        return call('/api/subtitles/search', {
            title: q.title, year: q.year > 0 ? q.year : '', season: q.season > 0 ? q.season : '',
            episode: q.episode > 0 ? q.episode : '', lang: config.lang, file: q.file
        }).then(j => j.results || []);
    }

    function download(id) {
        return call('/api/subtitles/fetch', { id: id });
    }

    // SubRip -> WebVTT, for the <video> element's text tracks (mpv reads SubRip as it is).
    function toVtt(srt) {
        let t = String(srt || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
        t = t.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
        t = t.replace(/\{\\an?\d+\}/g, '');
        t = t.replace(/<font[^>]*>|<\/font>/gi, '');
        return 'WEBVTT\n\n' + t;
    }

    function fmtCount(n) {
        n = n | 0;
        return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
    }

    function labelOf(r) {
        let name = String(r.name || r.title || 'Subtitle');
        if (name.length > 46) name = name.slice(0, 45) + '\u2026';
        const bits = [String(r.lang || '').toUpperCase()].filter(Boolean);
        if (r.trusted) bits.push('trusted');
        if (r.hi) bits.push('HI');
        if (r.ai) bits.push('auto-translated');
        if (r.downloads) bits.push(fmtCount(r.downloads) + ' downloads');
        return name + '  \u00b7  ' + bits.join(' \u00b7 ');
    }

    // ---------------- the controller: one per player ----------------

    class Controller {
        constructor(player, meta) {
            this.player = player;
            this.meta = meta || null;
            this.status = 'idle';       // idle | searching | results | none | error
            this.error = '';
            this.results = [];
            this.applied = null;        // the result currently on screen
            this._autoDone = false;
            this._timer = null;
            this._gen = 0;              // bumped when a new search starts, so a slow old one is ignored
            this._dead = false;
        }

        available() { return configured(); }

        destroy() { this._dead = true; clearTimeout(this._timer); }

        // The player tells us whenever the file's track list changes.
        onTracks() {
            if (this._dead || this._autoDone || !config.auto || !configured()) return;
            clearTimeout(this._timer);
            this._timer = setTimeout(() => {
                if (this._dead || this._autoDone) return;
                this._autoDone = true;
                if (this.player.state.subtitles.length > 0) return;   // the file brings its own: leave it alone
                this.find(true);
            }, AUTO_DELAY_MS);
        }

        _toast(text) { try { this.player._toast(text); } catch (e) { /* player closed */ } }
        _notify() { try { this.player._refreshSubMenu(); } catch (e) { /* player closed */ } }

        // auto = true: pick the best match and switch it on. auto = false: just fill the list for the menu.
        async find(auto) {
            if (this._dead) return;
            const gen = ++this._gen;
            this.status = 'searching';
            this.error = '';
            this._notify();
            if (auto) this._toast('Looking for subtitles\u2026');
            let list;
            try {
                list = await search(identify(this.meta, this.player.title));
            } catch (e) {
                if (gen !== this._gen || this._dead) return;
                this.status = 'error';
                this.error = e.message || 'Subtitle lookup failed.';
                this._notify();
                if (auto) this._toast(this.error);
                return;
            }
            if (gen !== this._gen || this._dead) return;
            this.results = list;
            if (!list.length) {
                this.status = 'none';
                this._notify();
                if (auto) this._toast('No subtitles found for this one');
                return;
            }
            this.status = 'results';
            this._notify();
            if (!auto) return;
            if (list[0].score >= AUTO_MIN_SCORE) await this.apply(list[0]);
            else this._toast('Subtitles found. Pick one in the subtitle menu.');
        }

        async apply(r) {
            if (this._dead) return;
            const b = this.player.backend;
            if (!b || typeof b.addSubtitle !== 'function') { this._toast("This player can't load extra subtitles"); return; }
            this._toast('Downloading subtitles\u2026');
            try {
                const f = await download(r.id);
                if (this._dead) return;
                const ok = await b.addSubtitle(window.location.origin + f.url, labelOf(r));
                if (ok === false) { this._toast("This player can't load extra subtitles"); return; }
                this.applied = r;
                this._toast('Subtitles on: ' + String(r.lang || '').toUpperCase() + (r.name ? ' \u00b7 ' + String(r.name).slice(0, 40) : ''));
            } catch (e) {
                this._toast((e && e.message) || "Couldn't load those subtitles");
            }
        }

        // Rows for the "Find subtitles" menu (player.js renders them; an item with keep: true leaves the menu open).
        menuItems() {
            if (this.status === 'searching') return [{ label: 'Searching\u2026', keep: true, action: function () {} }];
            if (this.status === 'error') {
                return [{ label: this.error || 'Subtitle lookup failed', keep: true, action: function () {} },
                        { label: 'Try again', keep: true, action: () => this.find(false) }];
            }
            if (this.status === 'none') {
                return [{ label: 'No subtitles found', keep: true, action: function () {} },
                        { label: 'Try again', keep: true, action: () => this.find(false) }];
            }
            return this.results.slice(0, MENU_RESULTS).map(r => ({
                label: labelOf(r), selected: !!(this.applied && this.applied.id === r.id), action: () => this.apply(r)
            }));
        }

        // Called when the menu opens: search if nothing has been searched yet.
        openList() {
            if (this.status === 'idle' || this.status === 'error') this.find(false);
        }
    }

    window.PekSubs = {
        Controller: Controller,
        parseName: parseName,
        identify: identify,
        toVtt: toVtt,
        config: config,
        setConfig: setConfig,
        configured: configured,
        // Settings > Subtitles > Test: a search for a well-known film proves the service answers.
        test: function () { return search({ title: 'The Matrix', year: 1999, season: 0, episode: 0, file: '' }); },
        languages: [
            ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
            ['pt-br', 'Portuguese (BR)'], ['pt-pt', 'Portuguese (PT)'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ar', 'Arabic'],
            ['tr', 'Turkish'], ['pl', 'Polish'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh-cn', 'Chinese']
        ]
    };
})();
