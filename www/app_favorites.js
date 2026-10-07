// ============================================================
// MainApp: Favorites tab, and opening a plugin on one particular title
// Loaded after app.js. These methods are added to MainApp.prototype.
//
// The list itself lives in favorites.js (window.HesperFavorites). Plugins with the "favorites"
// permission add and remove titles; this file shows them and opens them again.
// ============================================================

class MainAppFavoritesMethods {

    // ---------------- opening a plugin on a title ----------------

    // Installed plugins that say they can play movies and shows ("provides": {"stream": true}).
    // Used for the "Play with ..." buttons on a plugin's detail page. `exceptFolder` = the caller.
    _streamPlugins(exceptFolder) {
        return (this.state.pluginsList || [])
            .filter(p => p.sandboxed && p.folder !== exceptFolder && p.manifest && p.manifest.provides && p.manifest.provides.stream)
            .map(p => ({ id: p.folder, name: p.app_name }));
    }

    // Opens the plugin and asks it to show one title ({type, id, title, year}). False if it is not installed.
    openPluginOnTitle(folder, intent) {
        const p = (this.state.pluginsList || []).find(x => x.folder === folder && x.sandboxed);
        if (!p) return false;
        this.openPlugin(p);
        p.sandbox.launch(intent);
        return true;
    }

    // A favorite was tapped: open it where it was added, else in Discover, else in any plugin that can play titles.
    openFavorite(f) {
        const { ui } = this.props.engine;
        const intent = { type: f.type, id: f.id, title: f.title, year: f.year || 0 };
        const order = (f.from || []).concat('tmdb-discover', this._streamPlugins('').map(p => p.id));
        for (let i = 0; i < order.length; i++) {
            if (this.openPluginOnTitle(order[i], intent)) return;
        }
        ui.toast('Install TMDb Discover or Snake Skin (Settings \u2192 Plugins) to open this title.');
    }

    // ---------------- removing ----------------

    askRemoveFavorite(f) { this.setState({ favRemove: { key: f.key, title: f.title } }); }
    cancelRemoveFavorite() { this.setState({ favRemove: null }); }

    confirmRemoveFavorite() {
        const fr = this.state.favRemove;
        if (!fr) return;
        window.HesperFavorites.remove(fr.key);          // fires 'hesper-favorites', which refreshes the tab
        this.setState({ favRemove: null });
        this.props.engine.ui.toast('Removed from favorites');
    }

    _renderFavoriteRemoveModal() {
        const fr = this.state.favRemove;
        if (!fr) return null;
        const { createElement, ui } = this.props.engine;
        const body = createElement('div', {},
            createElement('div', { className: 'glass-panel' },
                createElement('p', {}, 'It stays in TMDb Discover and Snake Skin. You can add it back any time.')
            ),
            ui.button('Remove', () => this.confirmRemoveFavorite(), { variant: 'primary' })
        );
        return ui.modal(`Remove \u201c${fr.title}\u201d from favorites?`, body, () => this.cancelRemoveFavorite());
    }

    // ---------------- the tab ----------------

    _renderFavorites() {
        const { createElement, ui } = this.props.engine;
        const all = this.state.favorites || [];
        if (!all.length) {
            return createElement('div', {},
                ui.card('No favorites yet',
                    'Open a movie or show in TMDb Discover or Snake Skin and press \u2661 Add to favorites. It will show up here.'),
                createElement('div', { className: 'section-actions' },
                    ui.button('Open Plugins', () => this.selectTab('plugins'))
                )
            );
        }
        const movies = all.filter(f => f.type === 'movie').length;
        const shows = all.length - movies;
        const filter = this.state.favFilter;
        const list = filter === 'all' ? all : all.filter(f => f.type === filter);
        const set = (v) => this.setState({ favFilter: v });

        const filters = createElement('div', { className: 'section-actions' },
            this._choiceButton(`All (${all.length})`, filter === 'all', () => set('all')),
            this._choiceButton(`Movies (${movies})`, filter === 'movie', () => set('movie')),
            this._choiceButton(`TV Shows (${shows})`, filter === 'tv', () => set('tv'))
        );
        const cards = list.map(f => ui.posterCard(
            f.title,
            [f.year || '', f.type === 'tv' ? 'TV' : 'Movie'].filter(Boolean).join(' \u00b7 '),
            window.HesperFavorites.posterUrl(f),
            () => this.openFavorite(f),
            { onLongPress: () => this.askRemoveFavorite(f) }
        ));
        return createElement('div', {},
            filters,
            list.length
                ? ui.grid(cards, { minColWidth: '200px', className: 'sx-poster-grid' })
                : ui.card('Nothing here', filter === 'movie' ? 'No movies in your favorites yet.' : 'No TV shows in your favorites yet.'),
            createElement('p', { className: 'sub' }, 'Press a title to open it. Press and hold to remove it.')
        );
    }
}

hesperMixin(MainApp, MainAppFavoritesMethods);
