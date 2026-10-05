// ============================================================
// MainApp: Appearance: clock badge, weather reading, skins and layout
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppAppearanceMethods {

    // ---------------- Clock (built-in header widget) ----------------
    _deviceUses12h() {
        try { return new Intl.DateTimeFormat().resolvedOptions().hour12 !== false; }
        catch (e) { return true; }
    }

    _readClock() {
        const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
        const h = get(CLOCK_12H_KEY), d = get(CLOCK_DATE_KEY), z = get(CLOCK_TZ_KEY);
        return {
            hour12: h === null ? this._deviceUses12h() : h === '1',
            showDate: d === null ? true : d === '1',
            tz: z || ''
        };
    }

    _saveClock(patch) {
        const clock = { ...this.state.clock, ...patch };
        try {
            localStorage.setItem(CLOCK_12H_KEY, clock.hour12 ? '1' : '0');
            localStorage.setItem(CLOCK_DATE_KEY, clock.showDate ? '1' : '0');
            localStorage.setItem(CLOCK_TZ_KEY, clock.tz || '');
        } catch (e) { /* storage unavailable: the choice lasts until restart */ }
        // The whole UI repaints on setState; keep the settings list where it was.
        const panel = document.querySelector('.theme-panel');
        const top = panel ? panel.scrollTop : 0;
        this.setState({ clock });
        const again = document.querySelector('.theme-panel');
        if (again) again.scrollTop = top;
    }

    _clockZoneLabel(tz) {
        if (!tz) return '';
        const z = CLOCK_ZONES.find(x => x.id === tz);
        return z ? z.label : tz;
    }

    // { time, day } for a moment, in the chosen format and zone.
    _formatClock(date, clock) {
        try {
            const t = { hour: clock.hour12 ? 'numeric' : '2-digit', minute: '2-digit', hour12: clock.hour12 };
            const d = { weekday: 'short', month: 'short', day: 'numeric' };
            if (clock.tz) { t.timeZone = clock.tz; d.timeZone = clock.tz; }
            // en-GB gives a steady 00-23 clock for the 24-hour option.
            let time = new Intl.DateTimeFormat(clock.hour12 ? undefined : 'en-GB', t).format(date);
            time = time.replace(/^24/, '00');
            return { time, day: new Intl.DateTimeFormat(undefined, d).format(date) };
        } catch (e) {
            return { time: date.toLocaleTimeString(), day: date.toDateString() };
        }
    }

    // The two lines shown in the header badge.
    _clockLines(clock) {
        const { time, day } = this._formatClock(new Date(), clock);
        const zone = this._clockZoneLabel(clock.tz);
        const dateLine = clock.showDate ? (zone ? day + ' \u00b7 ' + zone : day) : zone;
        return { time, dateLine };
    }

    _renderClockBadge() {
        const { createElement } = this.props.engine;
        const { time, dateLine } = this._clockLines(this.state.clock);
        return createElement('button', {
            className: 'clock-badge focusable',
            title: 'Clock settings',
            onClick: () => this.setState({ showClockSettings: true })
        },
            createElement('span', { className: 'clock-time' }, time),
            dateLine ? createElement('span', { className: 'clock-date' }, dateLine) : null
        );
    }

    // Updates the badge text in place once a second, so the app is not
    // repainted (and focus is not disturbed) every tick.
    _startClockTicker() {
        if (this._clockTimer) return;
        this._clockTimer = setInterval(() => {
            const badges = document.querySelectorAll('.clock-badge');
            if (!badges.length) return;
            const { time, dateLine } = this._clockLines(this.state.clock);
            badges.forEach(b => {
                const t = b.querySelector('.clock-time');
                if (t && t.textContent !== time) t.textContent = time;
                const d = b.querySelector('.clock-date');
                if (d && d.textContent !== dateLine) d.textContent = dateLine;
            });
        }, 1000);
    }

    _renderClockSettings() {
        if (!this.state.showClockSettings) return null;
        const { createElement, ui } = this.props.engine;
        const { clock } = this.state;
        const now = new Date();

        const zones = [{ id: '', label: 'This device' }].concat(CLOCK_ZONES).map(z => {
            const f = this._formatClock(now, { ...clock, tz: z.id });
            const selected = (clock.tz || '') === z.id;
            return ui.listRow((selected ? '\u2713  ' : '') + z.label, f.time + ' \u00b7 ' + f.day,
                () => this._saveClock({ tz: z.id }));
        });

        const body = createElement('div', {},
            ui.toggle('24-hour time', !clock.hour12, (on) => this._saveClock({ hour12: !on })),
            ui.toggle('Show date', clock.showDate, (on) => this._saveClock({ showDate: on })),
            createElement('p', { className: 'sub', style: { margin: '1.2rem 0 0.5rem' } }, 'Time zone'),
            createElement('div', {}, ...zones)
        );
        return ui.modal('Clock', body, () => this.setState({ showClockSettings: false }));
    }

    // ---------------- Weather (driven by the Weather plugin) ----------------

    _readWeather() {
        try { return localStorage.getItem(WEATHER_TEMP_KEY) || '--°'; } catch (e) { return '--°'; }
    }

    _findWeatherPlugin(plugins) {
        return (plugins || this.state.pluginsList).find(p =>
            p.folder === 'weather' || /weather/i.test(p.app_name || '')
        );
    }

    // The plugin only publishes a reading once its render() has run, so run it
    // once in the background (detached node, never shown) at boot.
    _warmWeatherPlugin(plugins) {
        const p = this._findWeatherPlugin(plugins);
        if (!p || typeof p.render !== 'function') return;
        try { p.render(this.props.engine); } catch (err) {
            console.warn('[Hesper] Weather plugin failed to warm up:', err);
        }
    }

    // ---------------- Skins ----------------

    async loadSkins() {
        const builtIn = { id: 'default', name: 'Hesper Default', author: 'Hesper', description: 'The standard look.' };
        let skins = [];
        try {
            const res = await fetch('/api/skins');
            const data = await res.json();
            const manifests = await Promise.all((data.skins || []).map(async ({ id }) => {
                if (!SKIN_ID_RE.test(id)) return null;
                try {
                    const m = await fetch(`/skins/${id}/skin.json`).then(r => r.json());
                    return { ...m, id, name: m.name || id };
                } catch (err) {
                    console.warn(`[Hesper] Skipping skin "${id}": bad skin.json`, err);
                    return null;
                }
            }));
            skins = manifests.filter(Boolean);
        } catch (err) {
            console.warn('[Hesper] Could not load skins:', err);
        }
        if (!skins.some(s => s.id === 'default')) skins.unshift(builtIn);
        this.setState({ skins });
    }

    // Choosing a skin sets its colours (tokens) and swaps its stylesheet.
    // The theme is reset first so one skin's colours never linger in the next.
    applySkin(id) {
        const skin = this.state.skins.find(s => s.id === id);
        if (!skin) return;
        const theme = this.props.engine.theme;
        try {
            theme.reset();
            if (skin.tokens && typeof skin.tokens === 'object') theme.setTokens(skin.tokens);
            hesperSetSkinCss(id, true);
            localStorage.setItem(SKIN_KEY, id);
        } catch (err) {
            console.warn('[Hesper] Could not apply skin, reverting to default:', err);
            theme.reset();
            hesperSetSkinCss('default');
            id = 'default';
            try { localStorage.setItem(SKIN_KEY, 'default'); } catch (e) { /* ignore */ }
        }
        this.setState({ activeSkin: id });
    }

    // ---------------- Layouts ----------------

    setLayout(id) {
        if (!LAYOUTS.some(l => l.id === id)) return;
        try { localStorage.setItem(LAYOUT_KEY, id); } catch (e) { /* lasts until restart */ }
        hesperApplyLayout(id, this.state.posterSize);
        this.setState({ layout: id });
    }

    setPosterSize(size) {
        if (!POSTER_SIZES.some(z => z.id === size)) return;
        try { localStorage.setItem(POSTER_SIZE_KEY, size); } catch (e) { /* lasts until restart */ }
        hesperApplyLayout(this.state.layout, size);
        this.setState({ posterSize: size });
    }

    setViewMode(mode) {
        if (mode !== 'grid' && mode !== 'list') return;
        try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch (e) { /* lasts until restart */ }
        this.setState({ viewMode: mode });
    }

    // One option in a row of choices (poster size, grid/list). The chosen one gets an accent border.
    _choiceButton(label, selected, onClick) {
        const btn = this.props.engine.ui.button(label, onClick);
        if (selected) btn.classList.add('sx-selected');
        return btn;
    }
}

hesperMixin(MainApp, MainAppAppearanceMethods);
