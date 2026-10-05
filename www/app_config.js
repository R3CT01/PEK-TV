// ============================================================
// Hesper App Shell
// ============================================================

window.HESPER_APP_BUILD = 'v16';

// Phones (narrow screens) get a bottom tab bar with these tabs plus a "More" sheet
// holding every other tab. Wider screens and TVs keep the left sidebar.
const PHONE_MQ = '(max-width: 720px)';
const PHONE_PRIMARY_TABS = ['dashboard', 'movies', 'shows', 'music'];

const NAV_ITEMS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'movies', label: 'Movies' },
    { id: 'shows', label: 'TV Shows' },
    { id: 'music', label: 'Music' },
    { id: 'duplicates', label: 'Duplicates' },
    { id: 'unknown', label: 'Unknown' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'settings', label: 'Settings' }
];

// "Resume Watching" is added after Dashboard only once something has been watched.
const RESUME_NAV_ITEM = { id: 'resume', label: 'Resume Watching' };
const HISTORY_NAV_ITEM = { id: 'history', label: 'Watch History' };   // shown once something has been finished
const PROGRESS_KEY = 'hesper_progress_v1';
const RESUME_MIN_SEC = 30;        // watched less than this: nothing to resume
const RESUME_DONE_RATIO = 0.95;   // watched this much: counts as finished

// Library tabs -> backend endpoint (see server.cpp)
const LIBRARY_ENDPOINTS = {
    movies: '/api/movies',
    shows: '/api/shows',
    duplicates: '/api/duplicates',
    unknown: '/api/unknown'
};

// The Weather plugin (plugins/weather/ui.js) writes its formatted reading
// (e.g. "84°F") here and fires a window 'storage' event whenever it changes.
const WEATHER_TEMP_KEY = 'hesper_weather_current_temp';

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
];

function hesperFormatBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

// ---------------- Skins ----------------
// A skin is a folder in skins/<id>/ with skin.json (+ optional skin.css).
// The saved skin's CSS is injected immediately at load so the page never
// flashes the default look first.
const SKIN_KEY = 'hesper-skin';
const SKIN_ID_RE = /^[A-Za-z0-9_-]+$/;

function hesperSetSkinCss(id, bust) {
    const old = document.getElementById('hesper-skin-css');
    if (old) old.remove();
    if (!id || id === 'default' || !SKIN_ID_RE.test(id)) return;
    const link = document.createElement('link');
    link.id = 'hesper-skin-css';
    link.rel = 'stylesheet';
    link.href = `/skins/${id}/skin.css` + (bust ? `?t=${Date.now()}` : '');
    link.onerror = () => link.remove();   // a skin without a skin.css is fine
    document.head.appendChild(link);
}

try { hesperSetSkinCss(localStorage.getItem(SKIN_KEY)); } catch (e) { /* storage unavailable */ }

// ---------------- Layouts ----------------
// A layout is a built-in preset of structure (where the menu sits, how big the
// posters are), separate from a skin (colours). It is applied as data-layout and
// data-poster attributes on <html>; style.css does the rest. Phones always use
// the bottom tab bar, so on a phone a layout only changes poster size.
const LAYOUT_KEY = 'hesper-layout';
const POSTER_SIZE_KEY = 'hesper-poster-size';
const VIEW_MODE_KEY = 'hesper-view';
const LAYOUTS = [
    { id: 'classic', name: 'Classic', poster: 'm', description: 'Menu on the left, medium posters.' },
    { id: 'topbar',  name: 'Top bar', poster: 'm', description: 'Menu across the top, like Arctic. Phones keep the bottom bar.' },
    { id: 'wall',    name: 'Wall',    poster: 'l', description: 'Big posters and a slimmer menu.' },
    { id: 'compact', name: 'Compact', poster: 's', description: 'Smaller posters and tighter spacing, so more fits on screen.' }
];
const POSTER_SIZES = [
    { id: 'auto', label: 'Auto' }, { id: 's', label: 'Small' }, { id: 'm', label: 'Medium' }, { id: 'l', label: 'Large' }
];

function hesperReadPref(key, fallback, allowed) {
    try {
        const v = localStorage.getItem(key);
        return v && allowed.includes(v) ? v : fallback;
    } catch (e) { return fallback; }
}

function hesperApplyLayout(layoutId, posterSize) {
    const layout = LAYOUTS.find(l => l.id === layoutId) || LAYOUTS[0];
    const poster = posterSize && posterSize !== 'auto' ? posterSize : layout.poster;
    document.documentElement.setAttribute('data-layout', layout.id);
    document.documentElement.setAttribute('data-poster', poster);
}

hesperApplyLayout(
    hesperReadPref(LAYOUT_KEY, 'classic', LAYOUTS.map(l => l.id)),
    hesperReadPref(POSTER_SIZE_KEY, 'auto', POSTER_SIZES.map(z => z.id))
);


// Lets a feature file add methods to a class that is declared in another file.
// The methods are copied across exactly as written (same names, same `this`).
function hesperMixin(target, source) {
    Object.getOwnPropertyNames(source.prototype).forEach(name => {
        if (name === 'constructor') return;
        Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(source.prototype, name));
    });
}

// Native-app feel: no long-press / right-click context menu (copy, select, share)
// anywhere except text fields.
document.addEventListener('contextmenu', (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    ev.preventDefault();
});
