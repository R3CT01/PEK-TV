/* ============================================================
   PEK TV live overlay (live_overlay.js)

   Used by player.js when a plugin starts a live channel with a "live session"
   (see PLUGINS.md, pek.live.onQuery). Three pieces, all dark glass like the rest of the player:

     - an on-air banner (what is on now + up next) that shows while the controls are hidden,
       i.e. after the user stops pressing keys / touching the screen
     - a channel switcher on the RIGHT (Right arrow, or the Channels button)
     - the full channel guide on the LEFT (Left arrow, or the Guide button), when the plugin has guide data

   The plugin keeps all the data. This file only asks it questions (list, now, guide, url) through
   ctl.query(...) and treats every answer as untrusted text: it is only ever shown with textContent.
   ctl = { channel, query(req) -> Promise, check(url) -> checked url (throws if not allowed) }
   ============================================================ */
(function () {
    'use strict';

    const STYLE_ID = 'pek-live-style';
    const CSS = `
.pl-glass { background-color: rgba(28, 24, 21, 0.66);
    background-color: rgba(var(--hp-base-rgb, 28, 24, 21), 0.66);
    -webkit-backdrop-filter: blur(22px) saturate(1.5); backdrop-filter: blur(22px) saturate(1.5);
    border: 1px solid rgba(246, 242, 236, 0.16); border: 1px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16);
    color: #f6f2ec; color: var(--hp-fg, #f6f2ec); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35); }
.pl-banner { position: absolute; left: 22px; bottom: 22px; width: min(520px, calc(100% - 44px)); box-sizing: border-box;
    padding: 14px 18px 15px; border-radius: 16px; border-radius: var(--hp-pr, 16px);
    opacity: 0; pointer-events: none; -webkit-transform: translateY(8px); transform: translateY(8px);
    -webkit-transition: opacity 0.35s ease, -webkit-transform 0.35s ease; transition: opacity 0.35s ease, transform 0.35s ease; z-index: 3; }
.pl-banner.pl-on { opacity: 1; -webkit-transform: none; transform: none; }
.pl-b-ch { font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; margin-bottom: 6px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-b-row { display: flex; align-items: baseline; gap: 10px; margin-top: 3px; min-width: 0; }
.pl-b-tag { flex: none; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.1em; padding: 2px 7px; border-radius: 6px;
    background: rgba(246, 242, 236, 0.16); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.16); }
.pl-b-tag.pl-now { background: #e5484d; color: #fff; }
.pl-b-title { flex: 1; min-width: 0; font-size: 1.06rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-next .pl-b-title { font-size: 0.92rem; font-weight: 500; opacity: 0.85; }
.pl-b-time { flex: none; font-size: 0.8rem; opacity: 0.7; }
.pl-bar { height: 4px; border-radius: 3px; margin: 9px 0 5px; background: rgba(246, 242, 236, 0.18);
    background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.18); overflow: hidden; }
.pl-bar i { display: block; height: 100%; width: 0; border-radius: 3px; background: #f6f2ec; background: var(--hp-hi, #f6f2ec); }

.pl-panel { position: absolute; top: 3vh; bottom: 3vh; display: flex; flex-direction: column; box-sizing: border-box; padding: 14px 14px 12px;
    border-radius: 20px; border-radius: calc(var(--hp-pr, 16px) + 4px); z-index: 6; opacity: 0; visibility: hidden;
    -webkit-transition: opacity 0.22s ease, -webkit-transform 0.22s ease, visibility 0s linear 0.22s; transition: opacity 0.22s ease, transform 0.22s ease, visibility 0s linear 0.22s; }
.pl-panel.pl-open { opacity: 1; visibility: visible; -webkit-transform: none; transform: none; -webkit-transition-delay: 0s; transition-delay: 0s; }
.pl-right { right: 2vw; width: min(400px, 92vw); -webkit-transform: translateX(30px); transform: translateX(30px); }
.pl-left { left: 2vw; width: min(760px, 96vw); -webkit-transform: translateX(-30px); transform: translateX(-30px); }
.pl-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.pl-title { flex: none; font-size: 1rem; font-weight: 700; letter-spacing: 0.02em; }
.pl-tabs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
.pl-arrow { flex: none; width: 30px; height: 30px; border-radius: 50%; border: 0; cursor: pointer; font-size: 1rem; line-height: 30px; padding: 0;
    background: rgba(246, 242, 236, 0.12); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.12); color: inherit; }
.pl-tab { flex: 1; min-width: 0; text-align: center; font-size: 0.9rem; font-weight: 600; padding: 6px 10px; border-radius: 999px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    background: rgba(246, 242, 236, 0.12); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.12); }
.pl-tab.pl-focus { outline: 2px solid #f6f2ec; outline: 2px solid var(--hp-hi, #f6f2ec); }
.pl-close { flex: none; width: 30px; height: 30px; border-radius: 50%; border: 0; cursor: pointer; font-size: 1.1rem; line-height: 30px; padding: 0;
    background: rgba(246, 242, 236, 0.12); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.12); color: inherit; }
.pl-list { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 5px; }
.pl-row { flex: 1; min-height: 0; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-radius: 12px; border-radius: var(--hp-ir, 12px);
    cursor: pointer; overflow: hidden; border: 2px solid transparent; box-sizing: border-box;
    background: rgba(246, 242, 236, 0.06); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.06); }
.pl-row.pl-sel { background: rgba(246, 242, 236, 0.2); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.2); border-color: #f6f2ec; border-color: var(--hp-hi, #f6f2ec); }
.pl-row.pl-cur .pl-name::before { content: '\\25B6  '; font-size: 0.7em; opacity: 0.8; }
.pl-num { flex: none; width: 2.6em; text-align: right; font-size: 0.8rem; opacity: 0.55; }
.pl-mid { flex: 1; min-width: 0; }
.pl-name { font-size: 0.98rem; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-sub { font-size: 0.82rem; opacity: 0.72; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.pl-empty { padding: 28px 10px; text-align: center; opacity: 0.7; font-size: 0.95rem; }
.pl-foot { flex: none; min-height: 2.4em; margin-top: 8px; font-size: 0.85rem; opacity: 0.85; }
.pl-foot b { font-weight: 700; }

.pl-axis { display: flex; margin-left: 150px; margin-bottom: 6px; position: relative; height: 1.3em; font-size: 0.78rem; opacity: 0.7; }
.pl-axis span { position: absolute; top: 0; -webkit-transform: translateX(-50%); transform: translateX(-50%); white-space: nowrap; }
.pl-grow { flex: 1; min-height: 0; display: flex; align-items: stretch; gap: 8px; }
.pl-glabel { flex: none; width: 142px; display: flex; align-items: center; font-size: 0.9rem; font-weight: 600; overflow: hidden; }
.pl-glabel span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pl-gline { flex: 1; min-width: 0; position: relative; overflow: hidden; border-radius: 10px;
    background: rgba(246, 242, 236, 0.05); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.05); }
.pl-blk { position: absolute; top: 2px; bottom: 2px; box-sizing: border-box; padding: 0 9px; display: flex; align-items: center; overflow: hidden; cursor: pointer;
    border-radius: 9px; font-size: 0.85rem; white-space: nowrap; border: 2px solid rgba(246, 242, 236, 0.14);
    border: 2px solid rgba(var(--hp-fg-rgb, 246, 242, 236), 0.14); background: rgba(246, 242, 236, 0.1); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.1); }
.pl-blk span { overflow: hidden; text-overflow: ellipsis; }
.pl-blk.pl-air { background: rgba(246, 242, 236, 0.22); background: rgba(var(--hp-fg-rgb, 246, 242, 236), 0.22); }
.pl-blk.pl-focus { border-color: #f6f2ec; border-color: var(--hp-hi, #f6f2ec); }
.pl-grow.pl-sel .pl-glabel { color: #f6f2ec; color: var(--hp-hi, #f6f2ec); }
.pl-nowline { position: absolute; top: 0; bottom: 0; width: 2px; background: #e5484d; z-index: 2; pointer-events: none; }
`;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    const str = (v, max) => String(v == null ? '' : v).slice(0, max || 200);
    const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
    const nowSec = () => Math.floor(Date.now() / 1000);

    function clock(sec) {
        try { return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
        catch (e) { return new Date(sec * 1000).toTimeString().slice(0, 5); }
    }

    // [[start, stop, title, desc?], ...] from the plugin -> clean array, at most `cap` items
    function cleanProgs(arr, cap) {
        const out = [];
        if (!Array.isArray(arr)) return out;
        for (let i = 0; i < arr.length && out.length < cap; i++) {
            const p = arr[i];
            if (!Array.isArray(p)) continue;
            const s = num(p[0]), e = num(p[1]);
            if (s > 0 && e > s) out.push([s, e, str(p[2], 120), str(p[3], 200)]);
        }
        return out;
    }

    class Controller {
        constructor(player, ctl) {
            this.p = player;
            this.ctl = ctl || {};
            this.cur = str(this.ctl.channel, 200);       // id of the channel on screen
            this.curName = str(this.ctl.title, 120);
            this.chs = [];                               // [{id, name, group, g}]
            this.byId = {};
            this.groups = [];                            // [{name, n}]
            this.hasGuide = false;
            this.ready = false;
            this.panel = null;                           // null | 'channels' | 'guide'
            this.tab = 0;
            this.rows = [];
            this.sel = 0;
            this.top = 0;
            this.focus = 'list';                         // 'list' | 'tabs' (guide only)
            this.nowCache = {};                          // id -> [cur|0, next|0]
            this.gcache = {};                            // id -> programmes in the guide window
            this.gStart = 0;
            this.gProg = 0;                              // selected programme index in the selected row
            this.flash = 0;
            this.busy = false;
            this._closed = false;
            this._timer = null;
            this._flashTimer = null;
        }

        // ---------- setup ----------
        attach() {
            injectStyle();
            const root = this.p.root;
            this.banner = el('div', 'pl-glass pl-banner');
            this.bChan = el('div', 'pl-b-ch');
            this.bNow = el('div', 'pl-b-row');
            this.bBar = el('div', 'pl-bar');
            this.bFill = el('i');
            this.bBar.appendChild(this.bFill);
            this.bNext = el('div', 'pl-b-row pl-next');
            this.banner.appendChild(this.bChan);
            this.banner.appendChild(this.bNow);
            this.banner.appendChild(this.bBar);
            this.banner.appendChild(this.bNext);

            this.chanEl = this._buildPanel('pl-right', 'Channels');
            this.guideEl = this._buildPanel('pl-left', 'Guide');
            root.appendChild(this.banner);
            root.appendChild(this.chanEl.box);
            root.appendChild(this.guideEl.box);

            this._timer = setInterval(() => this._tick(), 15000);
            this._load();
        }

        destroy() {
            this._closed = true;
            clearInterval(this._timer);
            clearTimeout(this._flashTimer);
        }

        _buildPanel(cls, title) {
            const box = el('div', 'pl-glass pl-panel ' + cls);
            const head = el('div', 'pl-head');
            head.appendChild(el('div', 'pl-title', title));
            const tabs = el('div', 'pl-tabs');
            const prev = el('button', 'pl-arrow', '\u25C0');
            const tab = el('div', 'pl-tab');
            const next = el('button', 'pl-arrow', '\u25B6');
            prev.setAttribute('type', 'button'); next.setAttribute('type', 'button');
            prev.addEventListener('click', (ev) => { ev.stopPropagation(); this._tabBy(-1); });
            next.addEventListener('click', (ev) => { ev.stopPropagation(); this._tabBy(1); });
            tab.addEventListener('click', (ev) => { ev.stopPropagation(); this._tabBy(1); });
            tabs.appendChild(prev); tabs.appendChild(tab); tabs.appendChild(next);
            const close = el('button', 'pl-close', '\u2715');
            close.setAttribute('type', 'button');
            close.setAttribute('aria-label', 'Close');
            close.addEventListener('click', (ev) => { ev.stopPropagation(); this.close(); });
            head.appendChild(tabs);
            head.appendChild(close);
            const body = el('div', 'pl-list');
            const foot = el('div', 'pl-foot');
            box.appendChild(head);
            box.appendChild(body);
            box.appendChild(foot);
            box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
            return { box: box, tab: tab, body: body, foot: foot };
        }

        _load() {
            this._ask({ op: 'list' }).then((r) => {
                if (this._closed || !r || typeof r !== 'object') return;
                const list = Array.isArray(r.channels) ? r.channels : [];
                for (let i = 0; i < list.length && i < 20000; i++) {
                    const c = list[i];
                    if (!Array.isArray(c)) continue;
                    const ch = { id: str(c[0], 200), name: str(c[1], 120), group: str(c[2], 80), g: !!c[3] };
                    if (!ch.id) continue;
                    this.chs.push(ch);
                    this.byId[ch.id] = ch;
                }
                const gs = {};
                this.chs.forEach((c) => { gs[c.group] = (gs[c.group] || 0) + 1; });
                this.groups = Object.keys(gs).sort((a, b) => (a ? (b ? (a.toLowerCase() < b.toLowerCase() ? -1 : 1) : -1) : 1)).map((g) => ({ name: g, n: gs[g] }));
                this.hasGuide = r.guide === true && this.chs.some((c) => c.g);
                if (this.byId[this.cur]) this.curName = this.byId[this.cur].name;
                this.ready = this.chs.length > 0;
                this._buttons();
                this._fetchNow([this.cur]);
            }, () => { /* no list: the overlay stays quiet and the player works as before */ });
        }

        // the player has two buttons for us (built in player.js); show them once the plugin answered
        _buttons() {
            const b = this.p.btns || {};
            if (b.lchan) b.lchan.style.display = this.ready ? '' : 'none';
            if (b.lguide) b.lguide.style.display = (this.ready && this.hasGuide) ? '' : 'none';
        }

        buttonsShown() { return { channels: this.ready, guide: this.ready && this.hasGuide }; }

        _ask(req) {
            try { return Promise.resolve(this.ctl.query(req)); } catch (e) { return Promise.reject(e); }
        }

        // ---------- now / next ----------
        _fetchNow(ids, done) {
            const need = [];
            ids.forEach((id) => { if (id && need.indexOf(id) < 0) need.push(id); });
            if (!need.length) { if (done) done(); return; }
            this._ask({ op: 'now', ids: need.slice(0, 40) }).then((r) => {
                if (this._closed) return;
                const t = nowSec();
                need.forEach((id) => {
                    const v = r && typeof r === 'object' ? r[id] : null;
                    const a = Array.isArray(v) ? v : [];
                    const one = (x) => { const p = cleanProgs([x], 1)[0]; return p || 0; };
                    this.nowCache[id] = { cur: one(a[0]), next: one(a[1]), at: t };
                });
                if (done) done();
                this._renderBanner();
            }, () => { need.forEach((id) => { if (!this.nowCache[id]) this.nowCache[id] = { cur: 0, next: 0, at: nowSec() }; }); if (done) done(); });
        }

        _tick() {
            if (this._closed) return;
            const n = this.nowCache[this.cur];
            const t = nowSec();
            if (!n || (n.cur && n.cur[1] <= t) || (!n.cur && t - n.at > 120) || t - n.at > 600) this._fetchNow([this.cur]);
            else this._renderBanner();
            if (this.panel === 'channels') this._renderChannels(true);
        }

        // ---------- banner ----------
        onHidden() {                                    // the controls hid itself: nobody is touching anything
            this._wantBanner = true;
            this._renderBanner();
        }

        onShown() {
            this._wantBanner = false;
            this.banner.classList.remove('pl-on');
        }

        _flashBanner(sec) {
            this.flash = Date.now() + sec * 1000;
            clearTimeout(this._flashTimer);
            this._renderBanner();
            this._flashTimer = setTimeout(() => this._renderBanner(), sec * 1000 + 50);
        }

        _renderBanner() {
            if (this._closed || !this.banner) return;
            const n = this.nowCache[this.cur];
            const flashing = Date.now() < this.flash;
            const idle = this._wantBanner && this.p.mode === 'hidden';
            const has = !!(n && (n.cur || n.next));
            const show = !this.panel && (idle ? (has || flashing) : flashing);
            if (!show) { this.banner.classList.remove('pl-on'); return; }
            const t = nowSec();
            this.bChan.textContent = this.curName || 'Live';
            this.bNow.textContent = ''; this.bNext.textContent = '';
            let frac = 0;
            if (n && n.cur) {
                const c = n.cur;
                this.bNow.appendChild(el('span', 'pl-b-tag pl-now', 'NOW'));
                this.bNow.appendChild(el('span', 'pl-b-title', c[2]));
                this.bNow.appendChild(el('span', 'pl-b-time', clock(c[0]) + ' \u2013 ' + clock(c[1])));
                frac = Math.max(0, Math.min(1, (t - c[0]) / (c[1] - c[0])));
            } else if (n && n.next) {
                this.bNow.appendChild(el('span', 'pl-b-title', 'No listing for this moment'));
            } else {
                this.bNow.appendChild(el('span', 'pl-b-title', 'No guide information for this channel'));
            }
            this.bFill.style.width = Math.round(frac * 100) + '%';
            this.bBar.style.display = (n && n.cur) ? '' : 'none';
            if (n && n.next) {
                this.bNext.appendChild(el('span', 'pl-b-tag', 'NEXT'));
                this.bNext.appendChild(el('span', 'pl-b-title', n.next[2]));
                this.bNext.appendChild(el('span', 'pl-b-time', clock(n.next[0])));
            }
            this.banner.classList.add('pl-on');
        }

        // ---------- opening / closing ----------
        open(which) {
            if (!this.ready) return;
            if (which === 'guide' && !this.hasGuide) return;
            this.panel = which;
            this.p.mode = 'live';
            this.p.root.classList.remove('hp-show');
            this.p._updateFocus();
            this.banner.classList.remove('pl-on');
            this.focus = 'list';
            const cur = this.byId[this.cur];
            const g = cur ? cur.group : '';
            this.tab = 0;
            const gi = this._tabs().findIndex((t) => t.group === g);
            if (gi > 0) this.tab = gi;
            this._rebuildRows();
            const at = this.rows.findIndex((c) => c.id === this.cur);
            this.sel = at >= 0 ? at : 0;
            this.top = 0;
            this.gProg = 0;
            if (which === 'guide') {
                this.gStart = Math.floor(nowSec() / 1800) * 1800;
                this.gcache = {};
            }
            this.chanEl.box.classList.toggle('pl-open', which === 'channels');
            this.guideEl.box.classList.toggle('pl-open', which === 'guide');
            this._render();
        }

        close() {
            if (!this.panel) return;
            this.panel = null;
            this.chanEl.box.classList.remove('pl-open');
            this.guideEl.box.classList.remove('pl-open');
            if (this.p.mode === 'live') this.p.mode = 'hidden';
            this.p._show();
        }

        onBack() {
            if (!this.panel) return false;
            this.close();
            return true;
        }

        // ---------- tabs (groups) and rows ----------
        _tabs() {
            const tabs = [{ name: 'All channels', group: null, n: this.chs.length }];
            this.groups.forEach((g) => {
                if (this.panel === 'guide' && !this.chs.some((c) => c.group === g.name && c.g)) return;
                tabs.push({ name: g.name || 'Other', group: g.name, n: g.n });
            });
            return tabs;
        }

        _rebuildRows() {
            const tabs = this._tabs();
            if (this.tab >= tabs.length) this.tab = 0;
            const g = tabs[this.tab].group;
            this.rows = this.chs.filter((c) => (g === null || c.group === g) && (this.panel !== 'guide' || c.g));
        }

        _tabBy(d) {
            const n = this._tabs().length;
            if (!n) return;
            this.tab = (this.tab + d + n) % n;
            this._rebuildRows();
            this.sel = 0; this.top = 0; this.gProg = 0;
            this._render();
        }

        _visible() {
            const h = (typeof window !== 'undefined' && window.innerHeight) || 720;
            const per = this.panel === 'guide' ? 54 : 56;
            return Math.max(4, Math.min(11, Math.floor((h * 0.94 - 120) / per)));
        }

        _render() {
            if (this.panel === 'channels') this._renderChannels(false);
            else if (this.panel === 'guide') this._renderGuide();
        }

        _scrollIntoView() {
            const v = this._visible();
            if (this.sel < this.top) this.top = this.sel;
            if (this.sel >= this.top + v) this.top = this.sel - v + 1;
            this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - v)));
        }

        _setTab(p) {
            const tabs = this._tabs();
            const t = tabs[this.tab] || tabs[0];
            p.tab.textContent = t.name + '  \u00B7  ' + t.n;
            p.tab.classList.toggle('pl-focus', this.focus === 'tabs');
        }

        // ---------- channel switcher (right) ----------
        _renderChannels(keepScroll) {
            const p = this.chanEl;
            if (!keepScroll) this._scrollIntoView();
            this._setTab(p);
            const v = this._visible();
            const shown = this.rows.slice(this.top, this.top + v);
            const missing = shown.map((c) => c.id).filter((id) => !this.nowCache[id] || nowSec() - this.nowCache[id].at > 300);
            p.body.textContent = '';
            if (!shown.length) p.body.appendChild(el('div', 'pl-empty', 'No channels here.'));
            shown.forEach((c, i) => {
                const idx = this.top + i;
                const row = el('div', 'pl-row' + (idx === this.sel ? ' pl-sel' : '') + (c.id === this.cur ? ' pl-cur' : ''));
                row.appendChild(el('div', 'pl-num', String(idx + 1)));
                const mid = el('div', 'pl-mid');
                mid.appendChild(el('div', 'pl-name', c.name));
                const n = this.nowCache[c.id];
                mid.appendChild(el('div', 'pl-sub', n && n.cur ? n.cur[2] : (c.g ? '' : 'No guide info')));
                row.appendChild(mid);
                row.addEventListener('click', (ev) => { ev.stopPropagation(); this.sel = idx; this.tune(c.id); });
                p.body.appendChild(row);
            });
            const s = this.rows[this.sel];
            p.foot.textContent = '';
            if (s) {
                const n = this.nowCache[s.id];
                if (n && n.cur) {
                    const b = el('b', null, 'Now: ');
                    p.foot.appendChild(b);
                    p.foot.appendChild(document.createTextNode(n.cur[2] + '  (' + clock(n.cur[0]) + ' \u2013 ' + clock(n.cur[1]) + ')'));
                    if (n.next) p.foot.appendChild(document.createTextNode('   Next: ' + n.next[2]));
                }
            }
            if (missing.length) this._fetchNow(missing, () => { if (this.panel === 'channels') this._renderChannels(true); });
        }

        // ---------- full guide (left) ----------
        _renderGuide() {
            const p = this.guideEl;
            this._scrollIntoView();
            this._setTab(p);
            const WIN = 3 * 3600, t0 = this.gStart, t1 = t0 + WIN, now = nowSec();
            const v = this._visible();
            const shown = this.rows.slice(this.top, this.top + v);
            p.body.textContent = '';

            const axis = el('div', 'pl-axis');
            for (let k = 0; k <= 6; k++) {
                const sp = el('span', null, clock(t0 + k * 1800));
                sp.style.left = (k / 6 * 100) + '%';
                axis.appendChild(sp);
            }
            const axisWrap = el('div', null);
            axisWrap.style.marginRight = '0';
            axisWrap.appendChild(axis);
            p.body.appendChild(axisWrap);

            const need = shown.map((c) => c.id).filter((id) => !this.gcache[id]);
            if (!shown.length) p.body.appendChild(el('div', 'pl-empty', 'No guide data for this group.'));
            shown.forEach((c, i) => {
                const idx = this.top + i;
                const sel = idx === this.sel;
                const row = el('div', 'pl-grow' + (sel ? ' pl-sel' : ''));
                const lab = el('div', 'pl-glabel');
                lab.appendChild(el('span', null, c.name));
                const line = el('div', 'pl-gline');
                const progs = this.gcache[c.id] || [];
                const idxAir = progs.findIndex((x) => x[0] <= now && x[1] > now);
                progs.forEach((x, pi) => {
                    if (x[1] <= t0 || x[0] >= t1) return;
                    const s = Math.max(x[0], t0), e = Math.min(x[1], t1);
                    const b = el('div', 'pl-blk' + (pi === idxAir ? ' pl-air' : '') + (sel && this.focus === 'list' && pi === this._gSelIndex(progs) ? ' pl-focus' : ''));
                    b.style.left = ((s - t0) / WIN * 100) + '%';
                    b.style.width = (((e - s) / WIN * 100)) + '%';
                    b.appendChild(el('span', null, x[2]));
                    b.addEventListener('click', (ev) => { ev.stopPropagation(); this.sel = idx; this.gProg = pi; this.tune(c.id); });
                    line.appendChild(b);
                });
                if (now >= t0 && now < t1) {
                    const nl = el('div', 'pl-nowline');
                    nl.style.left = ((now - t0) / WIN * 100) + '%';
                    line.appendChild(nl);
                }
                row.appendChild(lab);
                row.appendChild(line);
                p.body.appendChild(row);
            });

            p.foot.textContent = '';
            const cs = this.rows[this.sel];
            const sp = cs ? (this.gcache[cs.id] || [])[this._gSelIndex(this.gcache[cs.id] || [])] : null;
            if (cs && sp) {
                p.foot.appendChild(el('b', null, cs.name + ': '));
                p.foot.appendChild(document.createTextNode(sp[2] + '  (' + clock(sp[0]) + ' \u2013 ' + clock(sp[1]) + ')' + (sp[3] ? '  ' + sp[3] : '')));
            }
            if (need.length) {
                const stamp = t0;
                this._ask({ op: 'guide', ids: need.slice(0, 40), from: t0 - 6 * 3600, to: t1 + 6 * 3600 }).then((r) => {
                    if (this._closed || this.gStart !== stamp) return;
                    need.forEach((id) => { this.gcache[id] = cleanProgs(r && typeof r === 'object' ? r[id] : null, 60); });
                    if (this.panel === 'guide') this._renderGuide();
                }, () => {
                    need.forEach((id) => { this.gcache[id] = []; });
                    if (this.panel === 'guide') this._renderGuide();
                });
            }
        }

        // the programme the cursor is on in the selected row: gProg counts only blocks inside the window
        _gSelIndex(progs) {
            const t0 = this.gStart, t1 = t0 + 3 * 3600;
            const idx = [];
            progs.forEach((x, i) => { if (x[1] > t0 && x[0] < t1) idx.push(i); });
            if (!idx.length) return -1;
            if (this.gProg === 0 && !this._gMoved) {                 // first time on this row: the one on air (or the first shown)
                const now = nowSec();
                const air = idx.find((i) => progs[i][0] <= now && progs[i][1] > now);
                return air != null ? air : idx[0];
            }
            return idx[Math.max(0, Math.min(idx.length - 1, this.gProg))];
        }

        _gMove(d) {
            const cs = this.rows[this.sel];
            const progs = cs ? (this.gcache[cs.id] || []) : [];
            const t0 = this.gStart, t1 = t0 + 3 * 3600;
            const idx = [];
            progs.forEach((x, i) => { if (x[1] > t0 && x[0] < t1) idx.push(i); });
            const curPi = this._gSelIndex(progs);
            let at = idx.indexOf(curPi);
            if (at < 0) at = 0;
            const to = at + d;
            if (to < 0) {
                if (t0 > Math.floor(nowSec() / 1800) * 1800 - 6 * 3600) { this.gStart -= 3600; this.gcache = {}; this._gMoved = true; this.gProg = 0; }
            } else if (to >= idx.length) {
                this.gStart += 3600; this.gcache = {}; this._gMoved = true; this.gProg = 0;
            } else {
                this._gMoved = true; this.gProg = to;
            }
            this._renderGuide();
        }

        // ---------- keys ----------
        handleKey(key) {
            if (!this.panel) {
                if (this.p.mode !== 'hidden' || !this.ready) return false;
                if (key === 'right') { this.open('channels'); return true; }
                if (key === 'left' && this.hasGuide) { this.open('guide'); return true; }
                return false;
            }
            if (key === 'playpause') { this.p._toggle(); return true; }
            if (key === 'ff' || key === 'rew') return true;
            if (key === 'back') { this.close(); return true; }
            const guide = this.panel === 'guide';
            if (guide && this.focus === 'tabs') {
                if (key === 'left') this._tabBy(-1);
                else if (key === 'right') this._tabBy(1);
                else if (key === 'down' || key === 'ok') { this.focus = 'list'; this._render(); }
                return true;
            }
            if (key === 'up') {
                if (this.sel > 0) { this.sel--; this._gMoved = false; this.gProg = 0; }
                else if (guide) this.focus = 'tabs';
                this._render();
            } else if (key === 'down') {
                if (this.sel < this.rows.length - 1) { this.sel++; this._gMoved = false; this.gProg = 0; }
                this._render();
            } else if (key === 'left') {
                if (guide) this._gMove(-1); else this._tabBy(-1);
            } else if (key === 'right') {
                if (guide) this._gMove(1); else this._tabBy(1);
            } else if (key === 'ok') {
                const c = this.rows[this.sel];
                if (c) this.tune(c.id);
            }
            return true;
        }

        // ---------- changing channel ----------
        tune(id) {
            if (this.busy || !id) return;
            if (id === this.cur) { this.close(); return; }
            this.busy = true;
            this._ask({ op: 'url', id: id }).then((r) => {
                const url = r && typeof r === 'object' ? str(r.url, 2000) : '';
                if (!url) throw new Error('no address');
                const safe = this.ctl.check ? this.ctl.check(url) : url;   // same rules as pek.live.play
                const title = str(r.title || (this.byId[id] && this.byId[id].name), 120);
                this._switch(id, safe, title);
            }).catch((e) => {
                this.p.errorBox.textContent = 'Could not switch channel' + (e && e.message ? ': ' + str(e.message, 120) : '.');
                this.p.errorBox.style.display = 'block';
            }).then(() => { this.busy = false; });
        }

        _switch(id, url, title) {
            const p = this.p;
            this.cur = id;
            this.curName = title;
            p.title = title;
            if (p.topTitle) p.topTitle.textContent = title;
            if (p.backend && 'title' in p.backend) p.backend.title = title;
            p.errorBox.style.display = 'none';
            p.state.buffering = true;
            p.state.position = 0;
            p.state.duration = 0;
            this.panel = null;
            this.chanEl.box.classList.remove('pl-open');
            this.guideEl.box.classList.remove('pl-open');
            if (p.mode === 'live') p.mode = 'hidden';
            p.backend.load(url, 0);
            p._show();
            this._fetchNow([id]);
            this._flashBanner(6);
        }
    }

    window.PekLive = { Controller: Controller, _test: { cleanProgs: cleanProgs } };
})();
