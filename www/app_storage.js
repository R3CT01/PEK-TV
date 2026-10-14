// ============================================================
// MainApp: storage permission (Android)
// PEK TV asks once when it first starts. If the user said no, it asks again at the moment they
// open a file/folder browser, so they are never left looking at an empty list without a reason.
// Loaded after app.js. On other platforms every call says "yes".
// ============================================================

class MainAppStorageMethods {

    _storageBridge() {
        const a = window.PekAndroid;
        return a && typeof a.hasStoragePermission === 'function' ? a : null;
    }

    // Resolves true when PEK TV may read storage (asking the user first if needed).
    _ensureStorage() {
        const a = this._storageBridge();
        if (!a || a.hasStoragePermission()) return Promise.resolve(true);
        const { ui } = this.props.engine;
        return new Promise((resolve) => {
            const done = (granted) => {
                if (window.__pekStorage === handler) window.__pekStorage = null;
                if (!granted) ui.toast('PEK TV needs storage access to browse files. Allow it in the permission prompt, or in Android Settings \u2192 Apps \u2192 PEK TV \u2192 Permissions.', 6000);
                resolve(!!granted);
            };
            const handler = (granted, opened) => { if (opened) { ui.toast('Turn on Storage for PEK TV, then come back and try again.', 6000); resolve(false); } else done(granted); };
            window.__pekStorage = handler;
            try { a.requestStoragePermission(false); } catch (e) { done(false); }
        });
    }

    // "All files access" (Android 11+): without it Android hides .zip files from PEK's own file browser.
    // True when the app can still gain something by asking for it.
    _needsAllFiles() {
        const a = window.PekAndroid;
        return !!(a && typeof a.hasAllFilesAccess === 'function' && typeof a.requestAllFilesAccess === 'function' && !a.hasAllFilesAccess());
    }

    askAllFilesAccess() {
        const { ui } = this.props.engine;
        let opened = false;
        try { opened = !!window.PekAndroid.requestAllFilesAccess(); } catch (e) { opened = false; }
        if (opened) ui.toast('Turn on \u201cAllow access to manage all files\u201d for PEK TV, then press Back to return.', 7000);
        else ui.toast('This device has no \u201cAll files access\u201d screen. Put the .zip on a network folder, or use the system file picker.', 7000);
    }

    // Called by the Android app when the user comes back from the "All files access" screen.
    _onAllFilesAnswer(granted) {
        const pp = this.state.pluginPick;
        if (granted) this.props.engine.ui.toast('All files access allowed.', 2500);
        if (pp && pp.stage === 'browse' && pp.path) this.pluginPickBrowse(pp.path);   // list the folder again, now with .zip files
        else if (pp) this.setState({ pluginPick: Object.assign({}, pp) });             // repaint the start list without the prompt
    }

    // Called by the Android app whenever a storage permission answer arrives (including the first-start prompt).
    _onStorageAnswer(granted) {
        if (!granted) return;
        this.props.engine.ui.toast('Storage allowed.', 2500);
        if ((this.state.sources || []).length) { try { this.rescan(); } catch (e) { /* rescan when asked */ } }
    }
}

pekMixin(MainApp, MainAppStorageMethods);
