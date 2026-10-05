// Bump this whenever HesperUIKit's method signatures change in a
// way that could break existing plugins. Plugin authors can guard
// with: if (hesperFramework.ui.version < 2) { ...fallback... }
const HESPER_UI_KIT_VERSION = 1;

class HesperComponent {
    constructor(props = {}) {
        this.props = props;
        this.state = {};
        this.element = null;
    }

    setState(newState) {
        this.state = { ...this.state, ...newState };
        this._update();
    }

    _update() {
        if (this.element && this.element.parentNode) {
            // A repaint builds brand-new elements, which would reset every scroll position.
            // Elements marked data-keep-scroll="key" get theirs carried over to the
            // replacement that has the same key.
            const kept = new Map();
            this.element.querySelectorAll('[data-keep-scroll]').forEach(el => {
                kept.set(el.dataset.keepScroll, [el.scrollLeft, el.scrollTop]);
            });
            const newElem = this.render();
            this.element.parentNode.replaceChild(newElem, this.element);
            this.element = newElem;
            newElem.querySelectorAll('[data-keep-scroll]').forEach(el => {
                const pos = kept.get(el.dataset.keepScroll);
                if (pos) { el.scrollLeft = pos[0]; el.scrollTop = pos[1]; }
            });
            window.hesperFramework.refreshFocusList();
        }
    }

    render() {
        throw new Error("Components must implement a render() method.");
    }
}

/* ============================================================
   HesperTheme
   Public theming API. A developer (or the in-app theme panel)
   can call any of these to change the UI live:

     hesperFramework.theme.set('accent', '#ff2d55');
     hesperFramework.theme.setTokens({ accent: '#ff2d55', radius: '4px' });
     hesperFramework.theme.applyPreset('amoled');
     hesperFramework.theme.registerPreset('cyberpunk', { accent: '#ff2d55', ... });
     hesperFramework.theme.onChange(tokens => console.log('theme changed', tokens));
     hesperFramework.theme.reset();

   Every token maps directly to a CSS custom property on
   :root, named `--sx-<kebab-case-key>` (see style.css), so
   any stylesheet rule that reads a --sx-* variable updates
   immediately. Changes are persisted to localStorage and
   restored on next launch.
   ============================================================ */

// Surface tokens for panels that sit on top of content (hero glass, toasts, dialogs
// backdrop). Dark skins/presets use HESPER_DARK_EXTRAS; the default cream theme has its own.
const HESPER_DARK_EXTRAS = {
    overlay: 'rgba(5, 8, 15, 0.75)',
    shadow: 'rgba(0, 0, 0, 0.5)',
    glass: 'rgba(10, 14, 24, 0.45)',
    glassStrong: 'rgba(13, 18, 30, 0.92)',
    glassFill: 'rgba(255, 255, 255, 0.05)',
    glassEdge: 'rgba(255, 255, 255, 0.10)'
};

// Default look: warm cream (matches the Hesper splash screen), ink-dark text.
const HESPER_DEFAULT_THEME = {
    bg: '#E9E2DA',
    bgElevated: '#F3EEE7',
    surface: '#F8F4EE',
    surfaceFocused: '#2b262218',
    border: '#D5CABD',
    borderFocus: '#2b2622',
    text: '#2b2622',
    textMuted: '#7a6f66',
    accent: '#2b2622',
    accentGlow: 'rgba(43, 38, 34, 0.22)',
    radius: '16px',
    overlay: 'rgba(60, 48, 38, 0.35)',
    shadow: 'rgba(70, 52, 36, 0.22)',
    glass: 'rgba(255, 255, 255, 0.50)',
    glassStrong: 'rgba(250, 246, 240, 0.96)',
    glassFill: 'rgba(255, 255, 255, 0.55)',
    glassEdge: 'rgba(60, 48, 38, 0.14)'
};

// The previous dark default, kept as the "midnight" preset.
const HESPER_MIDNIGHT = {
    ...HESPER_DARK_EXTRAS,
    bg: '#090d16', bgElevated: '#0d121e', surface: '#161b22', surfaceFocused: '#1f6feb22',
    border: '#30363d', borderFocus: '#58a6ff', text: '#f0f6fc', textMuted: '#8b949e',
    accent: '#58a6ff', accentGlow: 'rgba(88, 166, 255, 0.35)', radius: '16px'
};

// True if a background colour is dark (used to pick light/dark surface extras).
function hesperIsDark(hex) {
    const c = hesperContrast(hex, '#ffffff');
    return c !== null && c > 4;
}

const HESPER_BUILTIN_PRESETS = {
    cream: { ...HESPER_DEFAULT_THEME },
    midnight: { ...HESPER_MIDNIGHT },
    amoled: {
        bg: '#000000', bgElevated: '#000000', surface: '#0a0a0a', surfaceFocused: '#ffffff14',
        border: '#1a1a1a', borderFocus: '#00e5ff', text: '#ffffff', textMuted: '#8a8a8a',
        accent: '#00e5ff', accentGlow: 'rgba(0, 229, 255, 0.35)', radius: '12px'
    },
    sunset: {
        bg: '#1a0f0f', bgElevated: '#201414', surface: '#2b1818', surfaceFocused: '#ff6b3522',
        border: '#3d2424', borderFocus: '#ff6b35', text: '#fdf1ea', textMuted: '#c99a91',
        accent: '#ff6b35', accentGlow: 'rgba(255, 107, 53, 0.35)', radius: '18px'
    },
    forest: {
        bg: '#0c1410', bgElevated: '#101a14', surface: '#16211a', surfaceFocused: '#3fb95022',
        border: '#233229', borderFocus: '#3fb950', text: '#eafff0', textMuted: '#8fae9a',
        accent: '#3fb950', accentGlow: 'rgba(63, 185, 80, 0.35)', radius: '10px'
    },
    neon: {
    bg: '#05050a', 
    bgElevated: '#0b0b14', 
    surface: '#121222', 
    surfaceFocused: '#ff007f33',
    border: '#222244', 
    borderFocus: '#ff007f', 
    text: '#ffffff', 
    textMuted: '#9999bb',
    accent: '#ff007f', 
    accentGlow: 'rgba(255, 0, 127, 0.35)', 
    radius: '8px'
},
    crimson: {
    bg: '#0f0507',
    bgElevated: '#1a080c',
    surface: '#290e14',
    surfaceFocused: '#ff224722',
    border: '#451721',
    borderFocus: '#ff2247',
    text: '#fff0f2',
    textMuted: '#c48b94',
    accent: '#ff2247',
    accentGlow: 'rgba(255, 34, 71, 0.35)',
    radius: '12px'
}
};


// Returns the WCAG contrast ratio between two CSS hex colors, or null if either
// isn't a plain hex value (rgba() etc. are left alone).
function hesperContrast(a, b) {
    const lum = (hex) => {
        let h = String(hex || '').trim().replace('#', '');
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (h.length === 8) h = h.slice(0, 6);
        if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
        const ch = [0, 2, 4].map(i => {
            const v = parseInt(h.slice(i, i + 2), 16) / 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    const la = lum(a), lb = lum(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// True if a token set would make the UI unreadable (text same as its background).
function hesperThemeUnreadable(t) {
    const pairs = [['text', 'bg'], ['text', 'surface'], ['text', 'bgElevated']];
    return pairs.some(([fg, bg]) => {
        const c = hesperContrast(t[fg], t[bg]);
        return c !== null && c < 2;
    });
}

class HesperTheme {
    constructor(storageKey = 'hesper-theme') {
        this.storageKey = storageKey;
        this.tokens = { ...HESPER_DEFAULT_THEME };
        this.presets = { ...HESPER_BUILTIN_PRESETS };
        this._listeners = [];
        this._loadSaved();
        this._apply();
    }

    /** Set a single token, e.g. theme.set('accent', '#ff2d55') */
    set(key, value) {
        if (hesperThemeUnreadable({ ...this.tokens, [key]: value })) {
            console.warn(`[HesperTheme] Ignored ${key}=${value}: text would be unreadable on its background.`);
            return this;
        }
        this.tokens[key] = value;
        this._apply();
        this._save();
        this._notify();
        return this;
    }

    /** Merge several tokens at once: theme.setTokens({ accent: '#ff2d55', radius: '4px' }) */
    setTokens(partialTokens) {
        if (hesperThemeUnreadable({ ...this.tokens, ...partialTokens })) {
            console.warn('[HesperTheme] Ignored setTokens: text would be unreadable on its background.');
            return this;
        }
        const extras = (partialTokens.bg && !partialTokens.glass && hesperIsDark(partialTokens.bg)) ? HESPER_DARK_EXTRAS : {};
        this.tokens = { ...this.tokens, ...extras, ...partialTokens };
        this._apply();
        this._save();
        this._notify();
        return this;
    }

    get(key) {
        return this.tokens[key];
    }

    getAll() {
        return { ...this.tokens };
    }

    /** Switch to a named preset: 'midnight' | 'amoled' | 'sunset' | 'forest' | any registered custom name */
    applyPreset(name) {
        if (!this.presets[name]) {
            console.warn(`[HesperTheme] Unknown preset "${name}"`);
            return this;
        }
        const preset = this.presets[name];
        this.tokens = { ...HESPER_DEFAULT_THEME, ...(hesperIsDark(preset.bg) ? HESPER_DARK_EXTRAS : {}), ...preset };
        this._apply();
        this._save();
        this._notify();
        return this;
    }

    /** Register a reusable custom preset a developer defines once, e.g. for a branded add-on */
    registerPreset(name, tokens) {
        this.presets[name] = { ...HESPER_DEFAULT_THEME, ...(hesperIsDark(tokens.bg) ? HESPER_DARK_EXTRAS : {}), ...tokens };
        return this;
    }

    listPresets() {
        return Object.keys(this.presets);
    }

    reset() {
        this.tokens = { ...HESPER_DEFAULT_THEME };
        this._apply();
        this._save();
        this._notify();
        return this;
    }

    /** Subscribe to every theme change: const unsubscribe = theme.onChange(tokens => ...) */
    onChange(fn) {
        this._listeners.push(fn);
        return () => {
            this._listeners = this._listeners.filter(l => l !== fn);
        };
    }

    _apply() {
        const root = document.documentElement;
        for (const [key, value] of Object.entries(this.tokens)) {
            root.style.setProperty(`--sx-${this._kebab(key)}`, value);
        }
    }

    _kebab(str) {
        return str.replace(/[A-Z]/g, match => '-' + match.toLowerCase());
    }

    _save() {
        try {
            localStorage.setItem(this.storageKey, JSON.stringify(this.tokens));
        } catch (err) {
            console.warn('[HesperTheme] Could not persist theme:', err);
        }
    }

    _loadSaved() {
        try {
            const saved = localStorage.getItem(this.storageKey);
            if (saved) {
                const parsed = JSON.parse(saved);
                // Saved before the cream default existed and never customised: drop it so the
                // new cream default shows. Other saved dark themes keep working (dark extras).
                if (parsed.bg === '#090d16' && !parsed.glass) {
                    localStorage.removeItem(this.storageKey);
                    return;
                }
                const extras = (!parsed.glass && parsed.bg && hesperIsDark(parsed.bg)) ? HESPER_DARK_EXTRAS : {};
                const merged = { ...this.tokens, ...extras, ...parsed };
                if (hesperThemeUnreadable(merged)) {
                    console.warn('[HesperTheme] Saved theme was unreadable (text matches background); using defaults.');
                    localStorage.removeItem(this.storageKey);
                } else {
                    this.tokens = merged;
                }
            }
        } catch (err) {
            console.warn('[HesperTheme] Could not load saved theme:', err);
        }
    }

    _notify() {
        this._listeners.forEach(fn => {
            try {
                fn(this.getAll());
            } catch (err) {
                console.error('[HesperTheme] onChange listener threw:', err);
            }
        });
    }
}

/* ============================================================
   HesperUIKit
   The ONLY sanctioned way for plugin ui.js code to build visible
   UI. Every element it returns is plain DOM built from the same
   --sx-* CSS variables and the same classes the core app uses
   (.focusable, .empty-state, .theme-panel, etc.), so:

     1. Plugin UI automatically re-themes when the user changes
        presets (HesperTheme.onChange fires, CSS vars update,
        no plugin code involved).
     2. Plugin UI automatically gets D-pad/remote focus nav for
        free, because every interactive kit element carries
        .focusable and HesperEngine.refreshFocusList() just
        walks the DOM for that class.
     3. Plugins can never hardcode a hex color or an inline style
        that would clash with a user's theme, because the kit
        never accepts raw CSS as input.

   Usage inside a plugin's ui.js:

     const { ui } = window.hesperFramework;
     const card = ui.card('My Show', '3 new episodes', () => {...});

   Accessed as hesperFramework.ui.* ; version pinned at ui.version.
   ============================================================ */
class HesperUIKit {
    constructor(engine) {
        this.engine = engine;
        this.version = HESPER_UI_KIT_VERSION;
    }

    /** A primary or secondary call-to-action button. */
    button(label, onClick, opts = {}) {
        const variant = opts.variant === 'primary' ? 'theme-launch-btn' : 'nav-item';
        return this.engine.createElement('button', {
            className: `focusable sx-btn ${variant}`,
            onClick
        }, label);
    }

    /** A clickable content tile, e.g. a movie poster placeholder or a plugin screen. */
    card(title, subtitle, onClick, opts = {}) {
        const el = this.engine.createElement('div', {
            className: 'empty-state focusable sx-card',
            onClick: onClick || (() => {})
        },
            this.engine.createElement('h3', { className: 'empty-heading' }, title),
            subtitle ? this.engine.createElement('p', {}, subtitle) : null
        );
        return this._longPress(el, opts.onLongPress);
    }

    /** A poster-art tile. Falls back to the plain titled card when there is
     *  no poster, or if the image fails to load. */
    posterCard(title, subtitle, posterUrl, onClick, opts = {}) {
        if (!posterUrl) return this.card(title, subtitle, onClick, opts);
        const wrap = this.engine.createElement('div', {
            className: 'focusable sx-card sx-poster-card',
            title: title,
            onClick: onClick || (() => {})
        });
        const img = this.engine.createElement('img', { className: 'sx-poster-img', src: posterUrl, alt: title });
        img.addEventListener('error', () => {
            const plain = this.card(title, subtitle, onClick, opts);
            if (wrap.parentNode) {
                wrap.parentNode.replaceChild(plain, wrap);
                this.engine.refreshFocusList();
            }
        });
        wrap.appendChild(img);
        wrap.appendChild(this.engine.createElement('div', { className: 'sx-poster-caption' }, title));
        return this._longPress(wrap, opts.onLongPress);
    }

    /** Adds a press-and-hold action to an element (touch/mouse hold, or hold OK on a
     *  remote - the engine's key handler looks at el._hesperLongPress). */
    _longPress(el, handler) {
        if (!handler) return el;
        el.classList.add('sx-longpress');
        el._hesperLongPress = handler;
        if (!HesperUIKit._lpInstalled) {
            HesperUIKit._lpInstalled = true;
            // After a long press fires, swallow the click that follows the release.
            document.addEventListener('click', (ev) => {
                const t = ev.target && ev.target.closest ? ev.target.closest('.sx-longpress') : null;
                if (t && t._lpSuppress) { t._lpSuppress = false; ev.stopPropagation(); ev.preventDefault(); }
            }, true);
        }
        let timer = null;
        const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
        el.addEventListener('pointerdown', () => {
            cancel();
            timer = setTimeout(() => { timer = null; el._lpSuppress = true; handler(); }, 550);
        });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => el.addEventListener(n, () => {
            cancel();
            if (el._lpSuppress) setTimeout(() => { el._lpSuppress = false; }, 350);
        }));
        el.addEventListener('contextmenu', (ev) => ev.preventDefault());
        return el;
    }

    /** A small themed message at the bottom of the screen that fades away. */
    toast(text, ms = 3500) {
        const old = document.querySelector('.sx-toast');
        if (old && old.parentNode) old.parentNode.removeChild(old);
        const el = this.engine.createElement('div', { className: 'sx-toast' }, text);
        document.body.appendChild(el);
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, ms);
    }

    /** A horizontal row of children, e.g. a set of cards. */
    row(...children) {
        return this.engine.createElement('div', { className: 'sx-row' }, ...children);
    }

    /** A responsive multi-column grid of children, e.g. posters. */
    grid(children, opts = {}) {
        return this.engine.createElement('div', {
            className: 'sx-grid' + (opts.className ? ' ' + opts.className : ''),
            style: opts.minColWidth ? { '--sx-grid-min': opts.minColWidth } : {}
        }, ...children);
    }

    /** A single-line list row, matching the plugin-list look used elsewhere in the app. */
    listRow(title, subtitle, onClick, opts = {}) {
        const el = this.engine.createElement('div', {
            className: 'plugin-row focusable sx-list-row',
            onClick: onClick || (() => {})
        },
            this.engine.createElement('div', {},
                this.engine.createElement('h3', {}, title),
                subtitle ? this.engine.createElement('p', {}, subtitle) : null
            ),
            opts.statusDot ? this.engine.createElement('div', { className: 'plugin-status-dot' }) : null
        );
        return this._longPress(el, opts.onLongPress);
    }

    /** A themed modal overlay. bodyNode is any DOM node, e.g. built from other kit calls. */
    modal(title, bodyNode, onClose) {
        return this.engine.createElement('div', {
            className: 'theme-panel-overlay',
            onClick: (e) => { if (e.target.classList.contains('theme-panel-overlay')) onClose(); }
        },
            this.engine.createElement('div', { className: 'theme-panel' },
                this.engine.createElement('h2', {}, title),
                bodyNode,
                this.button('Close', onClose, { variant: 'primary' })
            )
        );
    }

    /** An on/off switch bound to a boolean, calling onChange(nextValue). */
    toggle(label, checked, onChange) {
        const dot = this.engine.createElement('span', { className: 'sx-toggle-dot' });
        const track = this.engine.createElement('span', {
            className: `sx-toggle-track${checked ? ' on' : ''}`
        }, dot);
        return this.engine.createElement('div', {
            className: 'focusable sx-toggle-row',
            onClick: () => onChange(!checked)
        },
            this.engine.createElement('span', { className: 'sx-toggle-label' }, label),
            track
        );
    }

    /** A themed single-line text input. onInput(value) fires on every change. */
    textInput(label, value, onInput, opts = {}) {
        const input = this.engine.createElement('input', {
            className: 'focusable sx-text-input',
            type: opts.type || 'text',
            value: value || '',
            placeholder: opts.placeholder || '',
            onInput: (e) => onInput(e.target.value)
        });
        return this.engine.createElement('div', { className: 'sx-field' },
            label ? this.engine.createElement('label', { className: 'sx-field-label' }, label) : null,
            input
        );
    }

    /** A row of tabs; activeId marks the selected one, onSelect(id) fires on click. */
    tabs(items, activeId, onSelect) {
        return this.engine.createElement('div', { className: 'sx-tabs' },
            ...items.map(item => this.engine.createElement('button', {
                className: `focusable sx-tab${item.id === activeId ? ' active' : ''}`,
                onClick: () => onSelect(item.id)
            }, item.label))
        );
    }
}

/* ============================================================
   HesperWindow
   An abstract base class, written in the C++ style this project
   uses: private fields (#) for real encapsulation (not just
   underscore-prefixed convention), a constructor that refuses to
   be instantiated directly (the closest JS gets to a pure virtual
   class), and explicit lifecycle hooks instead of implicit
   framework magic.

   A "window" is a full screen a plugin (or the host app) owns —
   heavier-weight than a HesperComponent, meant for a plugin's
   main surface. Subclasses MUST implement render(); onCreate()/
   onDestroy() are optional overrides, like a virtual method with
   a default (empty) base implementation.
   ============================================================ */
class HesperWindow {
    #id;
    #engine;
    #mounted = false;
    #rootElement = null;

    constructor(engine, props = {}) {
        if (new.target === HesperWindow) {
            throw new TypeError('HesperWindow is abstract — extend it, never instantiate it directly.');
        }
        this.#id = `win_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        this.#engine = engine;
        this.props = props;
        this.state = {};
    }

    // Read-only, like a C++ const accessor — no external code can
    // reassign a window's id or swap its engine reference.
    get id() { return this.#id; }
    get engine() { return this.#engine; }
    get isMounted() { return this.#mounted; }

    /** Pure virtual — every window subclass must build its own DOM tree. */
    render() {
        throw new Error(`${this.constructor.name} must implement render().`);
    }

    /** Virtual hooks — override freely, default implementations do nothing. */
    onCreate() {}
    onDestroy() {}

    setState(patch) {
        this.state = { ...this.state, ...patch };
        this.#repaint();
    }

    #repaint() {
        if (!this.#mounted) return;
        // Repainting builds brand-new elements, so any scrollable strip (e.g. the
        // phone tab bar) would snap back to 0. Elements marked data-keep-scroll
        // get their scroll position carried over to their replacement.
        const kept = new Map();
        this.#rootElement.querySelectorAll('[data-keep-scroll]').forEach(el => {
            kept.set(el.dataset.keepScroll, [el.scrollLeft, el.scrollTop]);
        });
        const next = this.render();
        if (this.#engine.gsap) {
            this.#engine.gsap.fromTo(next, { opacity: 0 }, { opacity: 1, duration: 0.2, ease: 'power1.out' });
        }
        this.#rootElement.replaceWith(next);
        this.#rootElement = next;
        next.querySelectorAll('[data-keep-scroll]').forEach(el => {
            const pos = kept.get(el.dataset.keepScroll);
            if (pos) { el.scrollLeft = pos[0]; el.scrollTop = pos[1]; }
        });
        this.#engine.refreshFocusList();
    }

    // Prefixed with _ as a convention signal ("protected — window
    // manager internals only"), matching this project's existing
    // style elsewhere; JS has no real `protected` keyword to enforce it.
    _mount(container) {
        this.#rootElement = this.render();
        container.appendChild(this.#rootElement);
        this.#mounted = true;
        this.onCreate();
        this.#engine.refreshFocusList();
        return this.#rootElement;
    }

    _unmount() {
        this.onDestroy();
        if (this.#rootElement && this.#rootElement.parentNode) {
            this.#rootElement.parentNode.removeChild(this.#rootElement);
        }
        this.#mounted = false;
    }
}

/* ============================================================
   HesperWindowManager
   Owns a single container and a back-stack of HesperWindow
   instances — think of it as a tiny Activity/Window manager.
   The create() method here is what window.create(...) is sugar
   for (see the bottom of this file): a developer passes a CLASS
   (not an instance) that extends HesperWindow, and the manager
   instantiates, mounts, and GSAP-transitions it in.
   ============================================================ */
class HesperWindowManager {
    #engine;
    #container;
    #active = null;
    #stack = [];
    #returnIndex = null;   // D-pad position to restore when the last window closes

    constructor(engine, container) {
        this.#engine = engine;
        this.#container = container;
    }

    /** hesperFramework.windows.create(MyWindowClass, props) */
    create(WindowClass, props = {}) {
        if (!(WindowClass.prototype instanceof HesperWindow)) {
            throw new TypeError('windows.create() requires a class that extends HesperWindow.');
        }
        const instance = new WindowClass(this.#engine, props);
        this.#push(instance);
        return instance;
    }

    /** Pop back to the previous window on the stack, if any. */
    back() {
        if (!this.#active) return false;
        this.#active._unmount();
        this.#active = this.#stack.pop() || null;
        if (this.#active) {
            const el = this.#active._mount(this.#container);
            if (this.#engine.gsap) {
                this.#engine.gsap.from(el, { opacity: 0, duration: 0.2, ease: 'power1.out' });
            }
        } else {
            // Last window closed: the D-pad list still points at the window's removed
            // buttons, so rebuild it from the main screen or the D-pad stops working.
            // Put the highlight back on whatever opened the window.
            if (this.#returnIndex !== null) this.#engine.currentIndex = this.#returnIndex;
            this.#returnIndex = null;
            this.#engine.refreshFocusList();
        }
        return true;
    }

    get activeWindow() { return this.#active; }

    #push(instance) {
        if (!this.#active) this.#returnIndex = this.#engine.currentIndex;
        if (this.#active) {
            this.#active._unmount();
            this.#stack.push(this.#active);
        }
        this.#active = instance;
        const el = instance._mount(this.#container);
        if (this.#engine.gsap) {
            this.#engine.gsap.from(el, { opacity: 0, y: 16, duration: 0.28, ease: 'power2.out' });
        } else {
            console.warn('[HesperWindowManager] GSAP not found on window — window opened without a transition.');
        }
    }
}

/* ============================================================
   HesperNav
   A small, LRUD-inspired directional focus engine. The real
   `lrud` package (bbc/lrud) isn't reliably distributed as a
   browser-ready bundle, so this reimplements its core idea —
   named focus "groups" containing elements, with directional
   (up/down/left/right) resolution done by real screen geometry
   — as a private-field class rather than pulling in an unverified
   CDN dependency. Swap in the real package later behind this same
   class shape if you set up a bundler.

   Usage from a window's render():
     engine.nav.registerGroup('posterGrid', gridElement);
   Then ArrowUp/Down/Left/Right resolves the nearest focusable
   element in that direction using getBoundingClientRect(), instead
   of the flat array walk HesperEngine's own .focusable list uses.
   ============================================================ */
class HesperNav {
    #groups = new Map();

    registerGroup(name, containerEl) {
        this.#groups.set(name, containerEl);
    }

    unregisterGroup(name) {
        this.#groups.delete(name);
    }

    /** Move focus from `current` in `direction` ('up'|'down'|'left'|'right'), searched within its nearest registered group. */
    move(current, direction) {
        const group = this.#findGroupFor(current);
        if (!group) return null;

        const candidates = Array.from(group.querySelectorAll('.focusable')).filter(el => el !== current);
        if (candidates.length === 0) return null;

        const from = current.getBoundingClientRect();
        let best = null;
        let bestScore = Infinity;

        for (const el of candidates) {
            const rect = el.getBoundingClientRect();
            if (!this.#isInDirection(from, rect, direction)) continue;
            const score = this.#distance(from, rect, direction);
            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        }

        if (best) {
            current.classList.remove('focused');
            best.classList.add('focused');
            best.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
        return best;
    }

    #findGroupFor(el) {
        for (const container of this.#groups.values()) {
            if (container.contains(el)) return container;
        }
        return null;
    }

    #isInDirection(from, rect, direction) {
        switch (direction) {
            case 'up': return rect.bottom <= from.top;
            case 'down': return rect.top >= from.bottom;
            case 'left': return rect.right <= from.left;
            case 'right': return rect.left >= from.right;
            default: return false;
        }
    }

    #distance(from, rect, direction) {
        const dx = (rect.left + rect.width / 2) - (from.left + from.width / 2);
        const dy = (rect.top + rect.height / 2) - (from.top + from.height / 2);
        // Weight the perpendicular axis more heavily so navigation
        // prefers staying roughly aligned (classic LRUD behavior)
        // rather than jumping diagonally to a "closer" element.
        if (direction === 'up' || direction === 'down') {
            return Math.abs(dy) + Math.abs(dx) * 2;
        }
        return Math.abs(dx) + Math.abs(dy) * 2;
    }
}

/* ============================================================
   Spatial D-pad navigation
   Picks the focusable element that is nearest to `from` in the
   pressed direction, so Right/Left move sideways and Up/Down move
   vertically, whatever order the elements sit in the DOM.
   Elements lined up with the current one win over diagonal ones.
   ============================================================ */
function hesperSpatialTarget(from, elements, dir) {
    const EPS = 4;                                   // tolerate slight overlap between neighbours
    const f = from.getBoundingClientRect();
    const horizontal = dir === 'left' || dir === 'right';
    // Up/Down stay inside the same area (sidebar or content) so you can't
    // jump from a card to a far-away menu item; Left/Right cross between areas.
    const regionOf = (el) => (el.closest && el.closest('.hesper-sidebar, .hesper-content')) || null;
    const fromRegion = regionOf(from);
    let best = null;
    let bestScore = Infinity;

    for (const el of elements) {
        if (el === from || el.disabled) continue;
        if (!horizontal && regionOf(el) !== fromRegion) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;            // hidden / not rendered

        let primary, gapAcross, centreAcross;
        if (horizontal) {
            // Must sit fully on that side, so a wide card never counts as "to the right" of itself.
            if (dir === 'right' ? r.left < f.right - EPS : r.right > f.left + EPS) continue;
            primary = dir === 'right' ? Math.max(0, r.left - f.right) : Math.max(0, f.left - r.right);
            gapAcross = Math.max(0, r.top - f.bottom, f.top - r.bottom);   // 0 when rows overlap
            centreAcross = Math.abs((r.top + r.height / 2) - (f.top + f.height / 2));
        } else {
            if (dir === 'down' ? r.top < f.bottom - EPS : r.bottom > f.top + EPS) continue;
            primary = dir === 'down' ? Math.max(0, r.top - f.bottom) : Math.max(0, f.top - r.bottom);
            gapAcross = Math.max(0, r.left - f.right, f.left - r.right);   // 0 when columns overlap
            centreAcross = Math.abs((r.left + r.width / 2) - (f.left + f.width / 2));
        }

        const score = primary + gapAcross * 3 + centreAcross * 0.5;
        if (score < bestScore) {
            bestScore = score;
            best = el;
        }
    }
    return best;
}

/* ============================================================
   HesperPluginLoader
   Plugin folder convention — this is the same root-level "plugins"
   folder the legacy Python scraper plugins live in (plugin_dir in
   core.cpp). Loose .py files there are legacy plugins; subfolders
   here are the current plugin format, each shaped like:

     plugins/
       my-plugin/
         ui.js        (required — sets `app_name`, e.g. var app_name = "My Plugin";)
         backend.py   (optional — Python, run server-side by the C++
                        core's runFolderPlugins(); never loaded in the
                        browser)

   On boot, call hesperFramework.plugins.discover(). It asks the
   backend which folders exist under plugins_dir and whether each has
   a backend.py, then loads each plugin's ui.js — served at
   /plugins/<folder>/... — as a plain <script> tag, reading the
   `app_name` each ui.js sets on window. Plugins load one at a
   time so app_name is never read from the wrong plugin. Returns
   an array of
     { folder, app_name, hasBackend }
   ============================================================ */
class HesperPluginLoader {
    constructor(manifestEndpoint = '/api/plugins', pluginsBasePath = '/plugins') {
        this.manifestEndpoint = manifestEndpoint;
        this.pluginsBasePath = pluginsBasePath;
        this.plugins = [];
    }

    async discover() {
        this.plugins = [];

        let entries = [];
        try {
            const res = await fetch(this.manifestEndpoint);
            const data = await res.json();
            entries = data.plugins || [];
        } catch (err) {
            console.warn('[HesperPluginLoader] Could not reach the plugins API:', err);
            return this.plugins;
        }

        for (const entry of entries) {
            try {
                this.plugins.push(await this._loadOne(entry.folder, entry.hasBackend));
            } catch (err) {
                console.warn(`[HesperPluginLoader] Skipped plugin "${entry.folder}":`, err);
            }
        }

        return this.plugins;
    }

    _loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
    }

    // Plugins allowed to run their ui.js directly in this page (full access, the old
    // way). Only what ships with Hesper. Every other plugin runs in the sandbox
    // (plugin_sandbox.js). To trust one you wrote yourself while developing, run in the
    // browser console:  localStorage.setItem('hesper-trusted-plugins', '["my_plugin"]')
    static isTrusted(folder) {
        if (folder === 'weather') return true;
        try {
            const list = JSON.parse(localStorage.getItem('hesper-trusted-plugins') || '[]');
            return Array.isArray(list) && list.includes(folder);
        } catch (e) { return false; }
    }

    async _loadSandboxed(folder, hasBackend) {
        const base = `${this.pluginsBasePath}/${encodeURIComponent(folder)}`;
        let raw = null;
        try {
            const r = await fetch(`${base}/plugin.json`, { cache: 'no-store' });
            if (r.ok) raw = await r.json();
        } catch (e) { /* no manifest: no permissions */ }
        const manifest = HesperSandbox.normalizeManifest(raw);

        let source = '';
        try {
            const r = await fetch(`${base}/ui.js`, { cache: 'no-store' });
            if (r.ok) source = await r.text();
        } catch (e) { /* no UI */ }
        if (!source) throw new Error('no ui.js');

        return {
            folder,
            app_name: manifest.name || folder,
            app_version: manifest.version,
            hasBackend: !!hasBackend,
            sandboxed: true,
            manifest,
            sandbox: new HesperSandbox(folder, manifest, source),
            render: null
        };
    }

    async _loadOne(folder, hasBackend) {
        if (!HesperPluginLoader.isTrusted(folder)) return this._loadSandboxed(folder, hasBackend);
        // Clear the previous plugin's globals so a plugin that forgets
        // to set one doesn't accidentally inherit the last plugin's
        // values (app_name, app_version, and its render hook).
        window.app_name = undefined;
        window.app_version = undefined;
        window.render = undefined;

        await this._loadScript(`${this.pluginsBasePath}/${folder}/ui.js`);
        const appName = window.app_name || folder;
        const appVersion = window.app_version || null;
        // Optional: window.render(hesperFramework) => DOM node, built
        // entirely from hesperFramework.ui.* calls. Captured here (not
        // called yet) so the plugin's own screen renders themed and
        // focus-navigable whenever the host app chooses to show it.
        const render = typeof window.render === 'function' ? window.render : null;

        return { folder, app_name: appName, app_version: appVersion, hasBackend: !!hasBackend, render };
    }
}

class HesperEngine {
    constructor(rootElement) {
        this.root = rootElement;
        this.version = '1.0.0';
        this.focusableElements = [];
        this.currentIndex = 0;
        this.theme = new HesperTheme();
        this.plugins = new HesperPluginLoader();
        this.ui = new HesperUIKit(this);
        this.nav = new HesperNav();
        this.gsap = window.gsap || null;
        if (!this.gsap) {
            console.warn('[HesperEngine] GSAP was not found on window — window transitions and animated setState() will no-op.');
        }
        this.windows = new HesperWindowManager(this, this.root);
        window.hesperFramework = this;
        // Sugar so plugin authors can write `create(MyWindowClass)`
        // directly, matching a C++-style "create the window" call,
        // instead of the more verbose hesperFramework.windows.create(...).
        window.create = (WindowClass, props) => this.windows.create(WindowClass, props);
        this._initGlobalListener();
    }

    // Hyperscript helper for clean DOM generation
    createElement(tag, attributes = {}, ...children) {
        const el = document.createElement(tag);

        for (const [key, value] of Object.entries(attributes || {})) {
            if (key === 'className') el.className = value;
            else if (key === 'style' && value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) {
                    if (k.startsWith('--')) el.style.setProperty(k, v);
                    else el.style[k] = v;
                }
            }
            else if (key.startsWith('on') && typeof value === 'function') {
                el.addEventListener(key.slice(2).toLowerCase(), value);
            } else {
                el.setAttribute(key, value);
            }
        }

        children.flat().forEach(child => {
            if (typeof child === 'string' || typeof child === 'number') {
                el.appendChild(document.createTextNode(child));
            } else if (child instanceof HTMLElement) {
                el.appendChild(child);
            }
        });

        return el;
    }

    mount(component) {
        this.root.innerHTML = '';
        const rendered = component.render();
        component.element = rendered;
        this.root.appendChild(rendered);
        this.refreshFocusList();
    }

    // Focus is limited to the topmost layer: an open plugin window covers the
    // whole screen, and a modal overlay covers the shell — arrow keys must not
    // wander onto the hidden elements underneath.
    _focusScope() {
        const wins = this.root.querySelectorAll('.plugin-window');
        if (wins.length) return wins[wins.length - 1];
        const modals = this.root.querySelectorAll('.theme-panel-overlay');
        if (modals.length) return modals[modals.length - 1];
        return this.root;
    }

    refreshFocusList() {
        this.focusableElements = Array.from(this._focusScope().querySelectorAll('.focusable'));
        if (this.focusableElements.length > 0) {
            this.currentIndex = Math.min(this.currentIndex, this.focusableElements.length - 1);
            // A repaint only re-marks the focused element; it must not scroll to it,
            // or the phone tab strip snaps back to the first tab after every repaint.
            this._applyFocus(false);
        }
    }

    _initGlobalListener() {
        window.addEventListener('keydown', (e) => {
            if (!this.focusableElements.length) return;

            const t = e.target;
            const typing = t && t.matches && t.matches('textarea, input:not([type=color]):not([type=checkbox]):not([type=button])');
            if (typing && ['ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return;

            const dirs = { ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up' };
            if (dirs[e.key]) {
                // Leaving a text field with Up/Down hides the keyboard.
                if (typing && t.blur) t.blur();
                // First press just shows the highlight; after that, move spatially.
                const hasFocus = this.focusableElements.some(el => el.classList.contains('focused'));
                if (hasFocus) {
                    const current = this.focusableElements[this.currentIndex];
                    const target = current ? hesperSpatialTarget(current, this.focusableElements, dirs[e.key]) : null;
                    if (target) this.currentIndex = this.focusableElements.indexOf(target);
                }
                this._applyFocus();
                e.preventDefault();
            } else if (e.key === 'Enter') {
                const active = this.focusableElements[this.currentIndex];
                if (active) {
                    // A text field needs real DOM focus (not a click) to open the keyboard.
                    if (active.matches('textarea, input:not([type=color]):not([type=checkbox]):not([type=button])')) active.focus();
                    else if (active._hesperLongPress) {
                        // Hold OK for the long-press action; a short press clicks on release.
                        if (!e.repeat && !this._lpTimer && !this._lpFiredByKey) {
                            this._lpTarget = active;
                            this._lpTimer = setTimeout(() => {
                                this._lpTimer = null; this._lpTarget = null;
                                this._lpFiredByKey = true;
                                active._hesperLongPress();
                            }, 550);
                        }
                    } else active.click();
                }
                e.preventDefault();
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key !== 'Enter') return;
            this._lpFiredByKey = false;
            if (this._lpTimer) {
                clearTimeout(this._lpTimer);
                this._lpTimer = null;
                const t = this._lpTarget; this._lpTarget = null;
                if (t && t.isConnected) t.click();
            }
        });
    }

    _applyFocus(scroll = true) {
        this.focusableElements.forEach((el, idx) => {
            if (idx === this.currentIndex) {
                el.classList.add('focused');
                if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            } else {
                el.classList.remove('focused');
            }
        });
    }
}

// Exposed so a plugin or dev tool can build a standalone theme
// instance too, e.g. to preview a palette before applying it.
window.HesperTheme = HesperTheme;
window.HesperPluginLoader = HesperPluginLoader;
window.HesperUIKit = HesperUIKit;
window.HesperWindow = HesperWindow;
window.HesperWindowManager = HesperWindowManager;
window.HesperNav = HesperNav;
