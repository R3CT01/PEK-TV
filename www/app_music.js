/* ============================================================
   PEK TV - Music tab (screens)
   Albums / Artists / Songs / Playlists / Search, album and artist pages, the Now Playing screen with the queue.
   The audio itself lives in music_player.js (window.PekMusic); the library comes from /api/music/* (music.h).
   ============================================================ */
class MainAppMusicMethods {

    // ---------------------------------------------------------------- state
    _mu() {
        if (this._mv) return this._mv;
        this._mv = { tab: 'albums', sort: 'artist', shownAlbums: 120, shownArtists: 200, album: null, artist: null, playlist: null, now: false, dialog: null, q: '' };
        this._mc = { albums: null, artists: null, scanning: false, at: 0, loading: false, error: false, pollUntil: 0, detail: {}, artistDetail: {}, search: null,
                     songs: { items: [], total: 0, loading: false, done: false } };
        this._mStack = [];
        const P = window.PekMusic;
        P.onToast = (m) => this.props.engine.ui.toast(m);
        P.onOpenNowPlaying = () => { this._mv.now = true; if (this.state.activeTab !== 'music') this.selectTab('music'); else this._mRepaint(); };
        P.on((kind) => { if ((kind === 'track' || kind === 'playlists') && this.state.activeTab === 'music') this._mSoftRepaint(); });
        return this._mv;
    }
    _mRepaint() {
        clearTimeout(this._mRepaintT);
        this._mRepaintT = setTimeout(() => this.setState({ musicTick: Date.now() }), 30);
    }
    // For repaints nobody asked for (a song ended and the next began, the scan found more albums): while a text
    // field has the keyboard open, rebuilding the screen would close it. Wait until the field lets go.
    _mSoftRepaint() {
        const a = document.activeElement;
        if (a && a.tagName === 'INPUT' && a.type !== 'range') {
            if (!this._mDeferred) {
                this._mDeferred = true;
                a.addEventListener('focusout', () => { this._mDeferred = false; this._mRepaint(); }, { once: true });
            }
            return;
        }
        this._mRepaint();
    }
    // New page inside the tab => new key => the content pane starts at the top (see app.js).
    _musicScrollKey() {
        const v = this._mv;
        if (!v) return '';
        return [v.now ? 'now' : '', v.album || '', v.artist || '', v.playlist || '', v.tab].join(':');
    }
    _mNav(patch) {
        const v = this._mu();
        this._mStack.push({ album: v.album, artist: v.artist, playlist: v.playlist });
        Object.assign(v, { album: null, artist: null, playlist: null }, patch);
        this._mRepaint();
    }
    // Called from goBack() in app.js. True when the Music tab handled the Back press.
    _musicBack() {
        if (this.state.activeTab !== 'music' || !this._mv) return false;
        const v = this._mv;
        if (v.dialog) { v.dialog = null; this._mRepaint(); return true; }
        if (v.now) { v.now = false; this._mRepaint(); return true; }
        if (v.album || v.artist || v.playlist) {
            const prev = this._mStack.pop() || { album: null, artist: null, playlist: null };
            Object.assign(v, { album: null, artist: null, playlist: null }, prev);
            this._mRepaint();
            return true;
        }
        return false;
    }

    // ---------------------------------------------------------------- data
    _mGet(url) {
        return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    _mLoadLibrary(force) {
        const c = this._mc;
        if (c.loading) return;
        if (!force && c.albums && Date.now() - c.at < 30000 && !c.scanning) return;
        c.loading = true;
        if (c.onlineAvail === undefined) this._mGet('/api/music/online').then(d => { c.onlineAvail = !!d.available; c.online = !!d.enabled; this._mSoftRepaint(); }).catch(() => { c.onlineAvail = false; });
        Promise.all([this._mGet('/api/music/albums'), this._mGet('/api/music/artists')]).then(([a, r]) => {
            const changed = !c.albums || c.albums.length !== a.albums.length || !c.artists || c.artists.length !== r.artists.length || c.scanning !== !!a.scanning;
            c.albums = a.albums; c.artists = r.artists; c.scanning = !!a.scanning; c.at = Date.now(); c.loading = false; c.error = false;
            if (changed) { c.songs = { items: [], total: 0, loading: false, done: false }; c.detail = {}; c.artistDetail = {}; this._mSoftRepaint(); }
            if (c.scanning || Date.now() < c.pollUntil) setTimeout(() => { if (this.state.activeTab === 'music') this._mLoadLibrary(true); }, 2500);
        }).catch(() => {
            c.loading = false; c.error = true; c.at = Date.now();
            if (!c.albums) { c.albums = []; c.artists = []; }
            this._mRepaint();
        });
    }
    _mLoadSongs() {
        const s = this._mc.songs;
        if (s.loading || s.done) return;
        s.loading = true;
        this._mGet('/api/music/songs?limit=200&offset=' + s.items.length).then(d => {
            s.items = s.items.concat(d.songs || []);
            s.total = d.total || 0;
            if (s.items.length >= s.total || !(d.songs || []).length) s.done = true;
            s.loading = false;
            this._mRepaint();
        }).catch(() => { s.loading = false; s.done = true; this._mRepaint(); });
    }
    _mFetchAlbum(id) {
        const c = this._mc;
        if (c.detail[id]) return Promise.resolve(c.detail[id]);
        return this._mGet('/api/music/album?id=' + encodeURIComponent(id)).then(d => { c.detail[id] = d; return d; });
    }
    _mFetchArtist(id) {
        const c = this._mc;
        if (c.artistDetail[id]) return Promise.resolve(c.artistDetail[id]);
        return this._mGet('/api/music/artist?id=' + encodeURIComponent(id)).then(d => { c.artistDetail[id] = d; return d; });
    }
    _mAlbumTracks(d) {
        // "Singles" is a loose pile of songs: each one gets its own cover instead of one picture for all
        return (d.list || []).map(t => Object.assign({}, t, d.singles ? { album: d.title, albumId: '', art: d.art } : { album: d.title, albumId: d.id, art: d.art }));
    }
    _mArtistIdByName(name) {
        const list = (this._mc && this._mc.artists) || [];
        const n = String(name || '').toLowerCase();
        const a = list.find(x => x.name.toLowerCase() === n);
        return a ? a.id : null;
    }
    // Every song of an artist, in album order (loads each album page once).
    _mArtistTracks(artistId) {
        return this._mFetchArtist(artistId).then(a => Promise.all(a.albums.map(al => this._mFetchAlbum(al.id)))).then(ds => [].concat(...ds.map(d => this._mAlbumTracks(d))));
    }
    _mAllSongs(limit) {
        const out = [];
        const step = () => this._mGet('/api/music/songs?limit=500&offset=' + out.length).then(d => {
            (d.songs || []).forEach(t => out.push(t));
            if (out.length < (d.total || 0) && out.length < limit && (d.songs || []).length) return step();
            return out;
        });
        return step();
    }

    // ---------------------------------------------------------------- small pieces
    _mArt(url, cls) {
        const { createElement } = this.props.engine;
        const wrap = createElement('div', { className: 'pm-art ' + (cls || '') }, createElement('span', { className: 'pm-art-note' }, '\u266A'));
        if (url) {
            const img = createElement('img', { src: url, alt: '' });
            img.loading = 'lazy'; img.decoding = 'async';
            img.addEventListener('error', () => img.remove());
            wrap.appendChild(img);
        }
        return wrap;
    }
    _mAlbumArtUrl(a) { return a && a.art ? '/api/music/art?album=' + encodeURIComponent(a.id) : ''; }
    _mCount(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
    _mAlbumCard(a) {
        const { createElement, ui } = this.props.engine;
        const bits = [a.artist];
        if (a.year) bits.push(a.year);
        const el = createElement('div', { className: 'focusable sx-card pm-album', title: a.title + ' \u2013 ' + a.artist, onClick: () => this._mNav({ album: a.id }) },
            this._mArt(this._mAlbumArtUrl(a), 'pm-album-art'),
            createElement('div', { className: 'pm-album-title' }, a.title),
            createElement('div', { className: 'pm-album-sub' }, bits.join(' \u00B7 ')));
        return ui._longPress(el, () => this._mAlbumMenu(a));
    }
    _mTrackRow(t, o) {
        const { createElement, ui } = this.props.engine;
        const P = window.PekMusic;
        const cur = P.current();
        const isCur = !!cur && cur.id === t.id && o.highlight !== false;
        const subBits = [];
        if (o.showArtist !== false && t.artist) subBits.push(t.artist);
        if (o.showAlbum && t.album) subBits.push(t.album);
        const more = createElement('button', { className: 'focusable pm-more', type: 'button', title: 'More', 'aria-label': 'More options' }, '\u22EF');
        more.addEventListener('click', (e) => { e.stopPropagation(); this._mTrackMenu(t, o); });
        const row = createElement('div', { className: 'plugin-row focusable pm-track' + (isCur ? ' pm-current' : ''), onClick: o.onPlay || (() => {}) },
            createElement('span', { className: 'pm-track-no' }, isCur ? '\u25B6' : (o.num != null ? String(o.num) : '')),
            o.art ? this._mArt(o.art, 'pm-track-art') : null,
            createElement('div', { className: 'pm-track-main' },
                createElement('h3', {}, t.title || 'Unknown song'),
                subBits.length ? createElement('p', {}, subBits.join(' \u00B7 ')) : null),
            createElement('span', { className: 'pm-track-time' }, t.duration ? P.fmt(t.duration) : ''),
            more);
        return ui._longPress(row, () => this._mTrackMenu(t, o));
    }
    _mSectionTitle(text, right) {
        const { createElement } = this.props.engine;
        return createElement('div', { className: 'pm-section' }, createElement('h3', {}, text), right || null);
    }
    _mEmpty(title, text, buttons) {
        const { createElement, ui } = this.props.engine;
        return createElement('div', { className: 'pm-empty' }, ui.card(title, text), buttons ? ui.row(...buttons) : null);
    }

    // ---------------------------------------------------------------- dialogs (menus, name, confirm, add to playlist)
    _mOpenDialog(d) { this._mu().dialog = d; this._mRepaint(); }
    _mCloseDialog() { this._mu().dialog = null; this._mRepaint(); }
    _mMenu(title, items) { this._mOpenDialog({ type: 'menu', title, items: items.filter(Boolean) }); }
    _mDialog() {
        const v = this._mu();
        const d = v.dialog;
        if (!d) return null;
        const { createElement, ui } = this.props.engine;
        const close = () => this._mCloseDialog();
        let body;
        if (d.type === 'menu') {
            body = createElement('div', { className: 'pm-menu' }, ...d.items.map(it => ui.button(it.label, () => { v.dialog = null; this._mRepaint(); setTimeout(it.fn, 0); })));
        } else if (d.type === 'name') {
            const submit = () => { const val = (d.value || '').trim(); if (!val) return; v.dialog = null; this._mRepaint(); setTimeout(() => d.onSubmit(val), 0); };
            body = createElement('div', { className: 'pm-menu' },
                ui.textInput('Name', d.value || '', (val) => { d.value = val; }, { autocomplete: 'off', noAssist: true, enterKeyHint: 'done', onSubmit: submit }),
                ui.button('Save', submit, { variant: 'primary' }));
        } else if (d.type === 'confirm') {
            body = createElement('div', { className: 'pm-menu' },
                createElement('p', {}, d.text),
                ui.button(d.confirmLabel || 'Delete', () => { v.dialog = null; this._mRepaint(); setTimeout(d.onConfirm, 0); }, { variant: 'primary' }));
        } else if (d.type === 'addTo') {
            const lists = window.PekMusic.playlists();
            body = createElement('div', { className: 'pm-menu' },
                ui.button('+ New playlist\u2026', () => {
                    this._mOpenDialog({ type: 'name', title: 'New playlist', value: '', onSubmit: (name) => {
                        window.PekMusic.createPlaylist(name, d.tracks);
                        ui.toast(this._mCount(d.tracks.length, 'song', 'songs') + ' added to \u201C' + name + '\u201D');
                    } });
                }),
                ...lists.map(p => ui.button(p.name + ' (' + p.tracks.length + ')', () => {
                    v.dialog = null; this._mRepaint();
                    const n = window.PekMusic.addToPlaylist(p.id, d.tracks);
                    ui.toast(n ? this._mCount(n, 'song', 'songs') + ' added to \u201C' + p.name + '\u201D' : 'Already in \u201C' + p.name + '\u201D');
                })));
        } else return null;
        return ui.modal(d.title, body, close);
    }
    // src: an array of songs or a promise of one
    _mAddTo(src) {
        Promise.resolve(src).then(tracks => {
            if (!tracks || !tracks.length) return;
            this._mOpenDialog({ type: 'addTo', title: 'Add to playlist', tracks });
        }).catch(() => this.props.engine.ui.toast('Could not load those songs'));
    }
    _mTrackMenu(t, o) {
        const P = window.PekMusic;
        const v = this._mu();
        const artistId = this._mArtistIdByName(t.artist);
        this._mMenu(t.title || 'Song', [
            { label: 'Play next', fn: () => P.playNext([t]) },
            { label: 'Add to queue', fn: () => P.enqueue([t]) },
            { label: 'Add to playlist\u2026', fn: () => this._mAddTo([t]) },
            t.albumId && v.album !== t.albumId ? { label: 'Go to album', fn: () => { v.now = false; this._mNav({ album: t.albumId }); } } : null,
            artistId && v.artist !== artistId ? { label: 'Go to artist', fn: () => { v.now = false; this._mNav({ artist: artistId }); } } : null,
            o && o.onRemove ? { label: o.removeLabel || 'Remove', fn: o.onRemove } : null
        ]);
    }
    _mAlbumMenu(a) {
        const P = window.PekMusic;
        const tracks = () => this._mFetchAlbum(a.id).then(d => this._mAlbumTracks(d));
        this._mMenu(a.title, [
            { label: 'Play', fn: () => tracks().then(t => P.play(t, 0)) },
            { label: 'Shuffle', fn: () => tracks().then(t => P.play(t, Math.floor(Math.random() * t.length), { shuffle: true })) },
            { label: 'Play next', fn: () => tracks().then(t => P.playNext(t)) },
            { label: 'Add to queue', fn: () => tracks().then(t => P.enqueue(t)) },
            { label: 'Add to playlist\u2026', fn: () => this._mAddTo(tracks()) }
        ]);
    }

    // ---------------------------------------------------------------- entry
    _renderMusic() {
        const { createElement } = this.props.engine;
        const v = this._mu();
        this._mLoadLibrary(false);
        let body;
        if (v.now) body = this._mNowView();
        else if (v.album) body = this._mAlbumView(v.album);
        else if (v.artist) body = this._mArtistView(v.artist);
        else if (v.playlist) body = this._mPlaylistView(v.playlist);
        else body = this._mHome();
        return createElement('div', { className: 'pm-root' }, body, this._mDialog());
    }
    // The persistent mini player, placed into every repaint of the shell (see app.js).
    _musicBarNode() {
        const P = window.PekMusic;
        if (!P) return null;
        this._mu();                                  // makes sure the bar's buttons are wired to this screen
        document.documentElement.classList.toggle('pm-hide-bar', !!(this.state.activeTab === 'music' && this._mv && this._mv.now));
        if (!P.hasQueue()) { document.documentElement.classList.remove('pm-has-bar'); return null; }
        return P.bar();
    }

    // ---------------------------------------------------------------- home (tabs)
    _mHome() {
        const { createElement, ui } = this.props.engine;
        const v = this._mu(), c = this._mc;
        const tabs = [{ id: 'albums', label: 'Albums' }, { id: 'artists', label: 'Artists' }, { id: 'songs', label: 'Songs' }, { id: 'playlists', label: 'Playlists' }, { id: 'search', label: 'Search' }];
        const parts = [this._renderHeader('Music'), ui.tabs(tabs, v.tab, (id) => { v.tab = id; this._mRepaint(); })];
        if (c.onlineAvail && (v.tab === 'albums' || v.tab === 'artists') && c.albums && c.albums.length) {
            parts.push(createElement('div', { className: 'pm-online' },
                ui.button(c.online ? 'Online art & lyrics: On' : 'Online art & lyrics: Off', () => this._mToggleOnline(), { variant: c.online ? 'primary' : undefined })));
        }
        if (c.scanning) parts.push(createElement('p', { className: 'pm-note' }, 'Looking for music\u2026 ' + (c.albums ? this._mCount(c.albums.length, 'album', 'albums') + ' so far.' : '')));
        if (!c.albums) parts.push(createElement('p', { className: 'pm-note' }, 'Loading your music\u2026'));
        else if (v.tab === 'albums') parts.push(this._mAlbumsTab());
        else if (v.tab === 'artists') parts.push(this._mArtistsTab());
        else if (v.tab === 'songs') parts.push(this._mSongsTab());
        else if (v.tab === 'playlists') parts.push(this._mPlaylistsTab());
        else parts.push(this._mSearchTab());
        return createElement('div', { className: 'pm-home' }, ...parts);
    }
    // Online art: artist photos, album covers and covers for single songs, fetched when the files have none.
    _mToggleOnline() {
        const c = this._mc, on = !c.online;
        fetch('/api/music/online?enabled=' + (on ? '1' : '0'), { method: 'POST' }).then(r => r.json()).then(d => {
            c.online = !!d.enabled;
            this.props.engine.ui.toast(c.online
                ? 'Online art is on. Artist, album and song names are sent to Deezer, Apple and LRCLIB to find pictures and lyrics; they are kept until the next rescan.'
                : 'Online art is off.');
            c.albums = null; c.artists = null; c.detail = {}; c.artistDetail = {}; c.at = 0;     // reload so every picture link is refreshed
            this._mRepaint();
            this._mLoadLibrary(true);
        }).catch(() => this.props.engine.ui.toast('Could not change Online art'));
    }
    _mNothing() {
        const { ui } = this.props.engine;
        const c = this._mc;
        if (c.error) return this._mEmpty('Music is not available', 'The music library could not be reached. Try again in a moment.', [ui.button('Try again', () => { this._mc.at = 0; this._mLoadLibrary(true); })]);
        return this._mEmpty('No music found yet',
            'Music is read from the same folders you added for movies and shows (local folders and network sources). Put your songs in one of them, or add a folder under Settings \u203A Sources, then scan again.',
            [ui.button('Scan now', () => { this._mc.pollUntil = Date.now() + 90000; this.rescan(); this._mLoadLibrary(true); }, { variant: 'primary' })]);
    }

    _mAlbumsTab() {
        const { createElement, ui } = this.props.engine;
        const v = this._mv, c = this._mc;
        if (!c.albums.length && !c.scanning) return this._mNothing();
        const sorts = [{ id: 'artist', label: 'By artist' }, { id: 'title', label: 'A\u2013Z' }, { id: 'added', label: 'Recently added' }, { id: 'year', label: 'Year' }];
        let list = c.albums.slice();
        const key = (s) => String(s || '').toLowerCase().replace(/^the /, '');
        if (v.sort === 'title') list.sort((a, b) => key(a.title) < key(b.title) ? -1 : key(a.title) > key(b.title) ? 1 : 0);
        else if (v.sort === 'added') list.sort((a, b) => b.added - a.added);
        else if (v.sort === 'year') list.sort((a, b) => (b.year || 0) - (a.year || 0));
        const shown = list.slice(0, v.shownAlbums);
        const parts = [ui.tabs(sorts, v.sort, (id) => { v.sort = id; v.shownAlbums = 120; this._mRepaint(); })];
        parts.push(createElement('div', { className: 'pm-sub' }, this._mCount(list.length, 'album', 'albums')));
        parts.push(ui.grid(shown.map(a => this._mAlbumCard(a)), { className: 'pm-grid' }));
        if (list.length > shown.length) parts.push(ui.button('Show more (' + (list.length - shown.length) + ' left)', () => { v.shownAlbums += 120; this._mRepaint(); }));
        return createElement('div', {}, ...parts);
    }
    // One row of the artist list (also used by search): a round photo when Online art is on.
    _mArtistRow(a) {
        const row = this.props.engine.ui.listRow(a.name, this._mCount(a.albums, 'album', 'albums') + ' \u00B7 ' + this._mCount(a.tracks, 'song', 'songs'), () => this._mNav({ artist: a.id }));
        if (a.photo) {
            row.classList.add('pm-artist-row');
            row.insertBefore(this._mArt('/api/music/art?artist=' + encodeURIComponent(a.id), 'pm-artist-art'), row.firstChild);
        }
        return row;
    }
    _mArtistsTab() {
        const { createElement, ui } = this.props.engine;
        const v = this._mv, c = this._mc;
        if (!c.artists.length && !c.scanning) return this._mNothing();
        const shown = c.artists.slice(0, v.shownArtists);
        const rows = shown.map(a => this._mArtistRow(a));
        const parts = [createElement('div', { className: 'pm-sub' }, this._mCount(c.artists.length, 'artist', 'artists')), createElement('div', { className: 'pm-list' }, ...rows)];
        if (c.artists.length > shown.length) parts.push(ui.button('Show more (' + (c.artists.length - shown.length) + ' left)', () => { v.shownArtists += 200; this._mRepaint(); }));
        return createElement('div', {}, ...parts);
    }
    _mSongsTab() {
        const { createElement, ui } = this.props.engine;
        const c = this._mc, s = c.songs, P = window.PekMusic;
        if (!c.albums.length && !c.scanning) return this._mNothing();
        if (!s.items.length && !s.done) this._mLoadSongs();
        const rows = s.items.map((t, i) => this._mTrackRow(t, {
            num: i + 1, showAlbum: true, art: t.art ? P.artUrl(t) : '',
            onPlay: () => P.play(s.items, i)
        }));
        const parts = [ui.row(
            ui.button('Shuffle all', () => { this._mAllSongs(5000).then(list => { if (list.length) P.play(list, Math.floor(Math.random() * list.length), { shuffle: true }); }); }, { variant: 'primary' }),
            ui.button('Play all', () => { this._mAllSongs(5000).then(list => { if (list.length) P.play(list, 0); }); })
        ), createElement('div', { className: 'pm-sub' }, this._mCount(s.total || s.items.length, 'song', 'songs')), createElement('div', { className: 'pm-list' }, ...rows)];
        if (!s.done) parts.push(ui.button(s.loading ? 'Loading\u2026' : 'Show more', () => this._mLoadSongs()));
        return createElement('div', {}, ...parts);
    }
    _mPlaylistsTab() {
        const { createElement, ui } = this.props.engine;
        const lists = window.PekMusic.playlists();
        const newBtn = ui.button('+ New playlist', () => this._mOpenDialog({ type: 'name', title: 'New playlist', value: '', onSubmit: (name) => { const p = window.PekMusic.createPlaylist(name, []); this._mNav({ playlist: p.id }); } }), { variant: 'primary' });
        if (!lists.length) return createElement('div', {}, this._mEmpty('No playlists yet', 'Make a playlist, then add songs from any album with the \u22EF button (or press and hold a song).', [newBtn]));
        const rows = lists.map(p => ui.listRow(p.name, this._mCount(p.tracks.length, 'song', 'songs'), () => this._mNav({ playlist: p.id })));
        return createElement('div', {}, newBtn, createElement('div', { className: 'pm-list' }, ...rows));
    }

    // ---- search: the input and the results are updated in place (the whole screen is not rebuilt while typing)
    _mSearchTab() {
        const { createElement, ui } = this.props.engine;
        const v = this._mv, c = this._mc;
        const input = ui.textInput('Search artists, albums and songs', v.q, (val) => { v.q = val; this._mSearchSoon(); },
            { autocomplete: 'off', noAssist: true, enterKeyHint: 'search', onSubmit: () => this._mSearchNow() });
        const box = createElement('div', { className: 'pm-search-results' }, ...this._mSearchNodes());
        if (v.q.trim() && !c.search) setTimeout(() => this._mSearchNow(), 0);
        return createElement('div', {}, input, box);
    }
    _mSearchSoon() { clearTimeout(this._mSearchT); this._mSearchT = setTimeout(() => this._mSearchNow(), 250); }
    _mSearchNow() {
        const v = this._mv, c = this._mc, q = v.q.trim();
        if (!q) { c.search = null; this._mPaintSearch(); return; }
        this._mGet('/api/music/search?q=' + encodeURIComponent(q)).then(d => {
            if (q !== v.q.trim()) return;
            c.search = d; c.searchQ = q;
            this._mPaintSearch();
        }).catch(() => {});
    }
    _mPaintSearch() {
        const box = document.querySelector('.pm-search-results');
        if (!box) return;
        box.replaceChildren(...this._mSearchNodes());
        if (this.props.engine.refreshFocusList) this.props.engine.refreshFocusList();
    }
    _mSearchNodes() {
        const { createElement, ui } = this.props.engine;
        const v = this._mv, d = this._mc.search, P = window.PekMusic;
        if (!v.q.trim()) return [createElement('p', { className: 'pm-note' }, 'Type a name to search your music.')];
        if (!d) return [createElement('p', { className: 'pm-note' }, 'Searching\u2026')];
        if (!d.artists.length && !d.albums.length && !d.songs.length) return [createElement('p', { className: 'pm-note' }, 'Nothing found for \u201C' + v.q.trim() + '\u201D.')];
        const out = [];
        if (d.artists.length) {
            out.push(this._mSectionTitle('Artists'));
            out.push(createElement('div', { className: 'pm-list' }, ...d.artists.map(a => this._mArtistRow(a))));
        }
        if (d.albums.length) {
            out.push(this._mSectionTitle('Albums'));
            out.push(ui.grid(d.albums.map(a => this._mAlbumCard(a)), { className: 'pm-grid' }));
        }
        if (d.songs.length) {
            out.push(this._mSectionTitle('Songs'));
            out.push(createElement('div', { className: 'pm-list' }, ...d.songs.map((t, i) => this._mTrackRow(t, { showAlbum: true, art: t.art ? P.artUrl(t) : '', onPlay: () => P.play(d.songs, i) }))));
        }
        return out;
    }

    // ---------------------------------------------------------------- album page
    _mBackBar(title) {
        const { createElement, ui } = this.props.engine;
        return createElement('div', { className: 'pm-backbar' }, ui.button('\u2190 Back', () => this._musicBack()), title ? createElement('span', { className: 'pm-backtitle' }, title) : null);
    }
    _mAlbumView(id) {
        const { createElement, ui } = this.props.engine;
        const P = window.PekMusic, c = this._mc;
        const d = c.detail[id];
        if (!d) {
            this._mFetchAlbum(id).then(() => this._mRepaint()).catch(() => { this.props.engine.ui.toast('Could not open that album'); this._musicBack(); });
            return createElement('div', {}, this._mBackBar(), createElement('p', { className: 'pm-note' }, 'Loading\u2026'));
        }
        const tracks = this._mAlbumTracks(d);
        const artistId = this._mArtistIdByName(d.artist);
        const discs = new Set(tracks.map(t => t.disc || 1));
        const meta = [d.year || null, this._mCount(tracks.length, 'song', 'songs'), d.duration ? P.fmtLong(d.duration) : null].filter(Boolean).join(' \u00B7 ');
        const artistEl = artistId
            ? createElement('button', { className: 'focusable pm-link', type: 'button', onClick: () => this._mNav({ artist: artistId }) }, d.artist)
            : createElement('span', { className: 'pm-link-plain' }, d.artist);
        const hero = createElement('div', { className: 'pm-hero' },
            this._mArt(this._mAlbumArtUrl(d), 'pm-hero-art'),
            createElement('div', { className: 'pm-hero-info' },
                createElement('h2', {}, d.title), artistEl, createElement('div', { className: 'pm-sub' }, meta),
                ui.row(
                    ui.button('Play', () => P.play(tracks, 0), { variant: 'primary' }),
                    ui.button('Shuffle', () => P.play(tracks, Math.floor(Math.random() * tracks.length), { shuffle: true })),
                    ui.button('Add to playlist\u2026', () => this._mAddTo(tracks)))));
        const rows = [];
        let lastDisc = 0;
        tracks.forEach((t, i) => {
            if (discs.size > 1 && (t.disc || 1) !== lastDisc) { lastDisc = t.disc || 1; rows.push(createElement('div', { className: 'pm-disc' }, 'Disc ' + lastDisc)); }
            rows.push(this._mTrackRow(t, { num: t.track || i + 1, showArtist: t.artist && t.artist !== d.artist, onPlay: () => P.play(tracks, i) }));
        });
        return createElement('div', {}, this._mBackBar(), hero, createElement('div', { className: 'pm-list' }, ...rows));
    }

    // ---------------------------------------------------------------- artist page
    _mArtistView(id) {
        const { createElement, ui } = this.props.engine;
        const P = window.PekMusic, c = this._mc;
        const d = c.artistDetail[id];
        if (!d) {
            this._mFetchArtist(id).then(() => this._mRepaint()).catch(() => { this.props.engine.ui.toast('Could not open that artist'); this._musicBack(); });
            return createElement('div', {}, this._mBackBar(), createElement('p', { className: 'pm-note' }, 'Loading\u2026'));
        }
        const all = () => this._mArtistTracks(id);
        return createElement('div', {}, this._mBackBar(),
            createElement('div', { className: 'pm-hero pm-hero-artist' },
                d.photo ? this._mArt('/api/music/art?artist=' + encodeURIComponent(d.id), 'pm-hero-art pm-artist-photo') : null,
                createElement('div', { className: 'pm-hero-info' },
                    createElement('h2', {}, d.name),
                    createElement('div', { className: 'pm-sub' }, this._mCount(d.albums.length, 'album', 'albums') + ' \u00B7 ' + this._mCount(d.tracks, 'song', 'songs')),
                    ui.row(
                        ui.button('Play all', () => all().then(t => P.play(t, 0)), { variant: 'primary' }),
                        ui.button('Shuffle', () => all().then(t => P.play(t, Math.floor(Math.random() * t.length), { shuffle: true }))),
                        ui.button('Add to playlist\u2026', () => this._mAddTo(all()))))),
            this._mSectionTitle('Albums'),
            ui.grid(d.albums.map(a => this._mAlbumCard(a)), { className: 'pm-grid' }));
    }

    // ---------------------------------------------------------------- playlist page
    _mPlaylistView(id) {
        const { createElement, ui } = this.props.engine;
        const P = window.PekMusic;
        const p = P.playlist(id);
        if (!p) { setTimeout(() => this._musicBack(), 0); return createElement('div', {}); }
        const tracks = p.tracks;
        const rows = tracks.map((t, i) => this._mTrackRow(t, {
            num: i + 1, showAlbum: true, art: t.art ? P.artUrl(t) : '',
            onPlay: () => P.play(tracks, i),
            removeLabel: 'Remove from playlist', onRemove: () => P.removeFromPlaylist(id, i)
        }));
        return createElement('div', {}, this._mBackBar(),
            createElement('div', { className: 'pm-hero pm-hero-artist' },
                createElement('div', { className: 'pm-hero-info' },
                    createElement('h2', {}, p.name),
                    createElement('div', { className: 'pm-sub' }, this._mCount(tracks.length, 'song', 'songs')),
                    ui.row(
                        ui.button('Play', () => { if (tracks.length) P.play(tracks, 0); }, { variant: 'primary' }),
                        ui.button('Shuffle', () => { if (tracks.length) P.play(tracks, Math.floor(Math.random() * tracks.length), { shuffle: true }); }),
                        ui.button('Rename', () => this._mOpenDialog({ type: 'name', title: 'Rename playlist', value: p.name, onSubmit: (name) => P.renamePlaylist(id, name) })),
                        ui.button('Delete', () => this._mOpenDialog({ type: 'confirm', title: 'Delete playlist?', text: '\u201C' + p.name + '\u201D will be deleted. Your songs are not touched.', onConfirm: () => { P.deletePlaylist(id); this._musicBack(); } }))))),
            tracks.length ? createElement('div', { className: 'pm-list' }, ...rows) : this._mEmpty('This playlist is empty', 'Add songs from an album with the \u22EF button (or press and hold a song).'));
    }

    // ---------------------------------------------------------------- Now Playing
    _mNowView() {
        const { createElement, ui } = this.props.engine;
        const P = window.PekMusic;
        const t = P.current();
        if (!t) { setTimeout(() => { this._mv.now = false; this._mRepaint(); }, 0); return createElement('div', {}); }
        const artistId = this._mArtistIdByName(t.artist);
        const range = createElement('input', { type: 'range', min: '0', max: '1000', value: '0', className: 'pm-range', 'data-pm-range': '', 'aria-label': 'Position' });
        range.addEventListener('input', () => range.setAttribute('data-drag', '1'));
        range.addEventListener('change', () => { range.removeAttribute('data-drag'); P.seekFraction(Number(range.value) / 1000); });
        const controls = createElement('div', { className: 'pm-controls' },
            P.button('shuffle'), P.button('prev'), P.button('toggle', 'pm-btn-main'), P.button('next'), P.button('repeat'));
        const skipRow = createElement('div', { className: 'pm-controls pm-controls-small' }, P.button('back15'), P.button('fwd15'));
        const q = P.queue(), idx = P.index();
        const qRows = q.map((s, i) => {
            const row = this._mTrackRow(s, { num: i + 1, highlight: false, art: s.art ? P.artUrl(s) : '', onPlay: () => P.jump(i), removeLabel: 'Remove from queue', onRemove: () => P.removeAt(i) });
            if (i === idx) row.classList.add('pm-current');
            return row;
        });
        const sub = createElement('div', { className: 'pm-now-sub' },
            artistId ? createElement('button', { className: 'focusable pm-link', type: 'button', onClick: () => { this._mv.now = false; this._mNav({ artist: artistId }); } }, t.artist) : createElement('span', {}, t.artist || ''),
            t.album ? createElement('span', { className: 'pm-dot' }, ' \u00B7 ') : null,
            t.album && t.albumId ? createElement('button', { className: 'focusable pm-link', type: 'button', onClick: () => { this._mv.now = false; this._mNav({ album: t.albumId }); } }, t.album) : (t.album ? createElement('span', {}, t.album) : null));
        const view = createElement('div', { className: 'pm-now' },
            this._mBackBar('Now playing'),
            createElement('div', { className: 'pm-now-top' },
                this._mArt(t.art ? P.artUrl(t) : '', 'pm-now-art'),
                createElement('div', { className: 'pm-now-info' },
                    createElement('h2', {}, t.title || 'Unknown song'), sub,
                    createElement('div', { className: 'pm-seek' },
                        createElement('span', { className: 'pm-time', 'data-pm-time': '' }, '0:00'), range,
                        createElement('span', { className: 'pm-time', 'data-pm-total': '' }, t.duration ? P.fmt(t.duration) : '--:--')),
                    controls, skipRow)),
            P.lyricsPanel(),
            this._mSectionTitle('Queue (' + q.length + ')', ui.button('Clear', () => { P.clear(); this._mv.now = false; this._mRepaint(); })),
            createElement('div', { className: 'pm-list' }, ...qRows));
        setTimeout(() => { P.sync(); }, 0);       // paint the progress / button states into the freshly built screen
        return view;
    }
}

pekMixin(MainApp, MainAppMusicMethods);
