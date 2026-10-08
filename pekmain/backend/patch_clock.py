import sys, os
www = sys.argv[1] if len(sys.argv) > 1 else "www"
ap, cp = os.path.join(www, "app.js"), os.path.join(www, "style.css")
js, css = open(ap).read(), open(cp).read()

def sub1(text, old, new, what):
    assert text.count(old) == 1, "app.js: could not find " + what
    return text.replace(old, new, 1)

if "_renderClockBadge" in js:
    print("app.js already patched")
else:
    # 1) constants
    js = sub1(js, "const WEATHER_TEMP_KEY = 'hesper_weather_current_temp';",
r'''const WEATHER_TEMP_KEY = 'hesper_weather_current_temp';

// Built-in header clock: saved choices and the time zones offered in its settings.
const CLOCK_12H_KEY  = 'hesper_clock_12h';
const CLOCK_DATE_KEY = 'hesper_clock_show_date';
const CLOCK_TZ_KEY   = 'hesper_clock_tz';     // '' = this device's own zone
const CLOCK_ZONES = [
    { id: 'UTC', label: 'UTC' },
    { id: 'Pacific/Honolulu', label: 'Honolulu' },
    { id: 'America/Anchorage', label: 'Anchorage' },
    { id: 'America/Los_Angeles', label: 'Los Angeles' },
    { id: 'America/Phoenix', label: 'Phoenix' },
    { id: 'America/Denver', label: 'Denver' },
    { id: 'America/Chicago', label: 'Chicago' },
    { id: 'America/Mexico_City', label: 'Mexico City' },
    { id: 'America/New_York', label: 'New York' },
    { id: 'America/Toronto', label: 'Toronto' },
    { id: 'America/Sao_Paulo', label: 'S\u00e3o Paulo' },
    { id: 'America/Argentina/Buenos_Aires', label: 'Buenos Aires' },
    { id: 'Atlantic/Reykjavik', label: 'Reykjav\u00edk' },
    { id: 'Europe/London', label: 'London' },
    { id: 'Europe/Paris', label: 'Paris' },
    { id: 'Europe/Berlin', label: 'Berlin' },
    { id: 'Europe/Madrid', label: 'Madrid' },
    { id: 'Europe/Rome', label: 'Rome' },
    { id: 'Europe/Athens', label: 'Athens' },
    { id: 'Europe/Istanbul', label: 'Istanbul' },
    { id: 'Europe/Moscow', label: 'Moscow' },
    { id: 'Africa/Lagos', label: 'Lagos' },
    { id: 'Africa/Cairo', label: 'Cairo' },
    { id: 'Africa/Nairobi', label: 'Nairobi' },
    { id: 'Africa/Johannesburg', label: 'Johannesburg' },
    { id: 'Asia/Dubai', label: 'Dubai' },
    { id: 'Asia/Karachi', label: 'Karachi' },
    { id: 'Asia/Kolkata', label: 'Mumbai / Delhi' },
    { id: 'Asia/Dhaka', label: 'Dhaka' },
    { id: 'Asia/Bangkok', label: 'Bangkok' },
    { id: 'Asia/Singapore', label: 'Singapore' },
    { id: 'Asia/Hong_Kong', label: 'Hong Kong' },
    { id: 'Asia/Shanghai', label: 'Beijing / Shanghai' },
    { id: 'Asia/Seoul', label: 'Seoul' },
    { id: 'Asia/Tokyo', label: 'Tokyo' },
    { id: 'Australia/Perth', label: 'Perth' },
    { id: 'Australia/Sydney', label: 'Sydney' },
    { id: 'Pacific/Auckland', label: 'Auckland' }
];''', "WEATHER_TEMP_KEY")

    # 2) state
    js = sub1(js, "            weatherText: this._readWeather()\n",
              "            clock: this._readClock(),        // { hour12, showDate, tz }\n            showClockSettings: false,\n            weatherText: this._readWeather()\n", "state weatherText")

    # 3) start the ticker
    js = sub1(js, "        this.loadSkins();\n", "        this.loadSkins();\n        this._startClockTicker();\n", "loadSkins() call in componentDidMount")

    # 4) Back closes the clock settings
    js = sub1(js, "        if (this.state.showThemePanel) { this.setState({ showThemePanel: false }); return true; }\n",
              "        if (this.state.showThemePanel) { this.setState({ showThemePanel: false }); return true; }\n        if (this.state.showClockSettings) { this.setState({ showClockSettings: false }); return true; }\n", "goBack theme line")

    # 5) badge in the header
    js = sub1(js, "                refreshBtn,\n                createElement('button', {\n                    className: 'weather-badge focusable',",
              "                refreshBtn,\n                this._renderClockBadge(),\n                createElement('button', {\n                    className: 'weather-badge focusable',", "header weather badge")

    # 6) modal in the shell
    js = sub1(js, "            this._renderDetailModal(),\n            this._renderPicker()",
              "            this._renderDetailModal(),\n            this._renderClockSettings(),\n            this._renderPicker()", "shell modals")

    # 7) methods
    marker = "    // ---------------- Weather (driven by the Weather plugin) ----------------"
    methods = r'''    // ---------------- Clock (built-in header widget) ----------------
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

'''
    js = sub1(js, marker, methods + marker, "weather section marker")
    open(ap, "w").write(js)
    print("app.js patched")

if "Header clock" in css:
    print("style.css already patched")
else:
    css += '''

/* ============================================================
   Header clock
   ============================================================ */
.clock-badge {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    line-height: 1.15;
    padding: 0.35rem 0.95rem;
    border-radius: 16px;
    cursor: pointer;
    flex-shrink: 0;
    font-family: inherit;
    background: #161b22;
    background: var(--sx-surface, #161b22);
    color: #f0f6fc;
    color: var(--sx-text, #f0f6fc);
    border: 1px solid #30363d;
    border: 1px solid var(--sx-border, #30363d);
}

.clock-time {
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
}

.clock-date {
    font-size: 0.72rem;
    color: #8b949e;
    color: var(--sx-text-muted, #8b949e);
    white-space: nowrap;
}

@media (max-width: 700px) {
    .content-header { flex-wrap: wrap; }
    .header-actions { flex-wrap: wrap; justify-content: flex-end; }
    .clock-badge { padding: 0.3rem 0.7rem; }
    .clock-time { font-size: 1rem; }
}
'''
    open(cp, "w").write(css)
    print("style.css patched")
