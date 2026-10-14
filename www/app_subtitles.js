// ============================================================
// MainApp: Settings > Subtitles (automatic subtitle look-up, see subtitles.js)
// Loaded after app.js. These methods are added to MainApp.prototype.
// ============================================================

class MainAppSubtitleMethods {

    _renderSubtitleSettings() {
        const S = window.PekSubs;
        if (!S) return null;
        const { createElement, ui } = this.props.engine;
        const c = S.config;
        const langs = S.languages;
        const current = c.lang.split(',')[0].trim().toLowerCase();
        return createElement('div', { className: 'settings-section' },
            createElement('h2', {}, 'Subtitles'),
            createElement('p', { className: 'sub' },
                'Finds subtitles online for anything that plays without its own, like torrents. ' +
                'Nothing to set up. Pick the language you want.'),
            ui.toggle('Find subtitles automatically', c.auto, (on) => { S.setConfig({ auto: on }); this.setState({}); }),
            createElement('p', { className: 'sub' }, 'Language'),
            createElement('div', { className: 'section-actions' },
                ...langs.map(l => this._choiceButton(l[1], current === l[0], () => { S.setConfig({ lang: l[0] }); this.setState({}); }))
            ),
            createElement('div', { className: 'section-actions' },
                ui.button(this._subsTesting ? 'Testing\u2026' : 'Test', () => this.testSubtitleSettings())
            ),
            this._subsMsg ? createElement('p', { className: 'sub' }, this._subsMsg) : null
        );
    }

    async testSubtitleSettings() {
        const S = window.PekSubs;
        if (this._subsTesting) return;
        this._subsTesting = true;
        this._subsMsg = '';
        this.setState({});
        try {
            const list = await S.test();
            this._subsMsg = list.length ? 'Subtitle service is working.' : 'Connected, but the test search found nothing.';
        } catch (e) {
            this._subsMsg = (e && e.message) || 'The test failed.';
        }
        this._subsTesting = false;
        this.setState({});
    }
}

pekMixin(MainApp, MainAppSubtitleMethods);
