// Shows a loading ring when a request to the Hesper server is slow (>0.5 s):
// removing a folder, browsing folders, loading a big library, and so on.
// Background chatter (progress polling, poster/detail lookups) is ignored.
(function () {
    var IGNORE = ['/api/scan-status', '/api/discover', '/api/status', '/api/plugins', '/api/skins',
                  '/api/movie-details', '/api/show-details', '/api/episode-details'];
    var pending = 0, timer = null, el = null;

    function ring() {
        if (el) return el;
        var css = document.createElement('style');
        css.textContent = '.hs-slow{position:fixed;inset:0;z-index:2900;display:flex;align-items:center;' +
            'justify-content:center;pointer-events:none;background:rgba(0,0,0,.25)}';
        document.head.appendChild(css);
        el = document.createElement('div');
        el.className = 'hs-slow';
        el.innerHTML = '<div class="hs-ring lg"></div>';
        return el;
    }
    function show() {
        timer = null;
        if (pending > 0 && !document.querySelector('.hs-busy')) document.body.appendChild(ring());
    }
    function done() {
        pending = Math.max(0, pending - 1);
        if (pending === 0) {
            if (timer) { clearTimeout(timer); timer = null; }
            if (el && el.parentNode) el.parentNode.removeChild(el);
        }
    }
    function tracked(input) {
        try {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            var path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
            if (path.indexOf('/api/') !== 0) return false;
            for (var i = 0; i < IGNORE.length; i++) if (path === IGNORE[i]) return false;
            return true;
        } catch (e) { return false; }
    }

    var orig = window.fetch;
    window.fetch = function (input, init) {
        if (!tracked(input)) return orig.apply(this, arguments);
        pending++;
        if (!timer && !el) timer = setTimeout(show, 500);
        return orig.apply(this, arguments).then(
            function (r) { done(); return r; },
            function (e) { done(); throw e; });
    };
})();
