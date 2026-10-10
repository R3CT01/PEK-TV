/* Hesper streaming providers  (window.HesperProviders)
 *
 * Turns a "Watch on Netflix / Hulu / ..." button into an action:
 *   - Android app: opens the provider's app (on its page for the title when the app supports the link),
 *     or the provider's website when the app is not installed.
 *   - Everything else (the main Hesper in a browser): opens the provider's website in a new tab.
 *
 * A plugin only says WHICH provider (TMDb's name) and WHICH title. It never supplies an address or an
 * app name: those come from the table below, so a plugin cannot use a button to open something else.
 *
 * To add a service, add a row here. `pkgs` are Android package names (the first installed one wins).
 * Android also needs the same names in the app's allow-list (MainActivity.kt) and <queries>
 * (AndroidManifest.xml); tools/sync_providers.js in the Android project regenerates both from this file.
 * `search` is a link with {q} for the title; without it the service's home page is used.
 * A service that is not in the table opens the title's "where to watch" page on TMDb instead.
 */
(function () {
    'use strict';

    // PROVIDERS-START
    var TABLE = [
        { re: /^netflix\b/, name: 'Netflix', pkgs: ['com.netflix.mediaclient', 'com.netflix.ninja'],
          home: 'https://www.netflix.com/', search: 'https://www.netflix.com/search?q={q}' },
        { re: /^hulu\b/, name: 'Hulu', pkgs: ['com.hulu.plus', 'com.hulu.livingroomplus'],
          home: 'https://www.hulu.com/', search: 'https://www.hulu.com/search?q={q}' },
        { re: /^disney plus\b/, name: 'Disney+', pkgs: ['com.disney.disneyplus'],
          home: 'https://www.disneyplus.com/' },
        { re: /^(hbo max|max)\b/, name: 'Max', pkgs: ['com.wbd.stream', 'com.hbo.hbonow'],
          home: 'https://www.max.com/' },
        { re: /^(amazon prime video|prime video|amazon video)\b/, name: 'Prime Video', pkgs: ['com.amazon.avod.thirdpartyclient', 'com.amazon.amazonvideo.livingroom'],
          home: 'https://www.primevideo.com/', search: 'https://www.primevideo.com/search?phrase={q}' },
        { re: /^apple tv\b/, name: 'Apple TV', pkgs: ['com.apple.atve.androidtv.appletv'],
          home: 'https://tv.apple.com/' },
        { re: /^paramount plus\b/, name: 'Paramount+', pkgs: ['com.cbs.app', 'com.cbs.ott'],
          home: 'https://www.paramountplus.com/' },
        { re: /^peacock\b/, name: 'Peacock', pkgs: ['com.peacocktv.peacockandroid'],
          home: 'https://www.peacocktv.com/' },
        { re: /^crunchyroll\b/, name: 'Crunchyroll', pkgs: ['com.crunchyroll.crunchyroid'],
          home: 'https://www.crunchyroll.com/', search: 'https://www.crunchyroll.com/search?q={q}' },
        { re: /^tubi\b/, name: 'Tubi', pkgs: ['com.tubitv'],
          home: 'https://tubitv.com/', search: 'https://tubitv.com/search/{q}' },
        { re: /^pluto tv\b/, name: 'Pluto TV', pkgs: ['tv.pluto.android'],
          home: 'https://pluto.tv/' },
        { re: /^(youtube|youtube premium)$/, name: 'YouTube', pkgs: ['com.google.android.youtube', 'com.google.android.youtube.tv'],
          home: 'https://www.youtube.com/', search: 'https://www.youtube.com/results?search_query={q}' },
        { re: /^google play (movies|tv)/, name: 'Google Play', pkgs: ['com.google.android.videos'],
          home: 'https://play.google.com/store/movies', search: 'https://play.google.com/store/search?q={q}&c=movies' },
        { re: /^(vudu|fandango at home)\b/, name: 'Fandango at Home', pkgs: ['air.com.vudu.air.DownloaderTablet'],
          home: 'https://athome.fandango.com/' },
        { re: /^starz\b/, name: 'Starz', pkgs: ['com.bydeluxe.d3.android.program.starz'],
          home: 'https://www.starz.com/' },
        { re: /^showtime\b/, name: 'Showtime', pkgs: ['com.showtime.standalone'],
          home: 'https://www.paramountplus.com/' },
        { re: /^(freevee|amazon freevee)\b/, name: 'Freevee', pkgs: ['com.amazon.imdb.tv.android.app'],
          home: 'https://www.amazon.com/freevee' },
        { re: /^the roku channel\b/, name: 'The Roku Channel', pkgs: ['com.roku.web.trc'],
          home: 'https://therokuchannel.roku.com/' },
        { re: /^plex\b/, name: 'Plex', pkgs: ['com.plexapp.android'],
          home: 'https://watch.plex.tv/' },
        { re: /^criterion channel\b/, name: 'Criterion Channel', pkgs: ['com.criterionchannel'],
          home: 'https://www.criterionchannel.com/', search: 'https://www.criterionchannel.com/search?q={q}' },
        { re: /^mubi\b/, name: 'MUBI', pkgs: ['com.mubi'],
          home: 'https://mubi.com/' },
        { re: /^kanopy\b/, name: 'Kanopy', pkgs: ['com.kanopy'],
          home: 'https://www.kanopy.com/' },
        { re: /^hoopla\b/, name: 'hoopla', pkgs: ['com.hoopladigital.android'],
          home: 'https://www.hoopladigital.com/' }
    ];
    // PROVIDERS-END

    function normName(s) {
        return String(s || '').toLowerCase().replace(/\+/g, ' plus ').replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function find(name) {
        var n = normName(name);
        for (var i = 0; i < TABLE.length; i++) if (TABLE[i].re.test(n)) return TABLE[i];
        return null;
    }

    // What to open for one button press. Always an https address built here.
    function plan(spec) {
        var title = String(spec.title || '').slice(0, 200);
        var type = spec.type === 'tv' ? 'tv' : 'movie';
        var id = Math.floor(Number(spec.tmdbId)) || 0;
        var region = /^[A-Za-z]{2}$/.test(spec.region || '') ? String(spec.region).toUpperCase() : 'US';
        var p = find(spec.name);
        if (p) {
            var url = p.search && title ? p.search.replace('{q}', encodeURIComponent(title)) : p.home;
            return { name: p.name, pkgs: p.pkgs.slice(), url: url, known: true };
        }
        // A service Hesper has no row for: TMDb's own "where to watch" page for the title.
        var tmdb = id ? 'https://www.themoviedb.org/' + type + '/' + id + '/watch?locale=' + region
                      : 'https://www.themoviedb.org/';
        return { name: String(spec.name || 'this service').slice(0, 60), pkgs: [], url: tmdb, known: false };
    }

    function toast(text) {
        try { if (window.hesperFramework) window.hesperFramework.ui.toast(text, 3000); } catch (e) { /* no toast */ }
    }

    function open(spec) {
        var p = plan(spec || {});
        var A = window.HesperAndroid;
        try {
            if (A && typeof A.openStreamingApp === 'function' && p.pkgs.length) {
                A.openStreamingApp(p.pkgs.join(','), p.url);          // app first, website if it is not installed
                return p;
            }
            if (A && typeof A.openUrl === 'function') { A.openUrl(p.url); return p; }
            var w = window.open(p.url, '_blank', 'noopener,noreferrer');
            if (!w) toast('Your browser blocked the new tab. Allow pop-ups for PEK TV and try again.');
        } catch (e) {
            toast("Couldn't open " + p.name + '.');
        }
        return p;
    }

    window.HesperProviders = { find: find, plan: plan, open: open, table: TABLE };
    if (typeof module !== 'undefined' && module.exports) module.exports = window.HesperProviders;
})();
