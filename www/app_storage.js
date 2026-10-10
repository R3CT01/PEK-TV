// ============================================================
// MainApp: storage permission (Android)
// Hesper asks once when it first starts. If the user said no, it asks again at the moment they
// open a file/folder browser, so they are never left looking at an empty list without a reason.
// Loaded after app.js. On other platforms every call says "yes".
// ============================================================

class MainAppStorageMethods {

    _storageBridge() {
        const a = window.HesperAndroid;
        return a && typeof a.hasStoragePermission === 'function' ? a : null;
    }

    // Resolves true when Hesper may read storage (asking the user first if needed).
    _ensureStorage() {
        const a = this._storageBridge();
        if (!a || a.hasStoragePermission()) return Promise.resolve(true);
        const { ui } = this.props.engine;
        return new Promise((resolve) => {
            const done = (granted) => {
                if (window.__hesperStorage === handler) window.__hesperStorage = null;
                if (!granted) ui.toast('PEK TV needs storage access to browse files. Allow it in the permission prompt, or in Android Settings \u2192 Apps \u2192 PEK TV \u2192 Permissions.', 6000);
                resolve(!!granted);
            };
            const handler = (granted, opened) => { if (opened) { ui.toast('Turn on Storage for PEK TV, then come back and try again.', 6000); resolve(false); } else done(granted); };
            window.__hesperStorage = handler;
            try { a.requestStoragePermission(false); } catch (e) { done(false); }
        });
    }

    // Called by the Android app whenever a storage permission answer arrives (including the first-start prompt).
    _onStorageAnswer(granted) {
        if (!granted) return;
        this.props.engine.ui.toast('Storage allowed.', 2500);
        if ((this.state.sources || []).length) { try { this.rescan(); } catch (e) { /* rescan when asked */ } }
    }
}

hesperMixin(MainApp, MainAppStorageMethods);
