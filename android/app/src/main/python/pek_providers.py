"""Streaming services the "Watch on ..." buttons know (generated from www/providers.js by tools/sync_providers.js; do not edit).

Each row: (regex on the normalised service name, display name, Android packages, home page, search link with {q} or None).
"""
TABLE = [
    (r"^netflix\b", "Netflix", ["com.netflix.mediaclient", "com.netflix.ninja"], "https://www.netflix.com/", "https://www.netflix.com/search?q={q}"),
    (r"^hulu\b", "Hulu", ["com.hulu.plus", "com.hulu.livingroomplus"], "https://www.hulu.com/", "https://www.hulu.com/search?q={q}"),
    (r"^disney plus\b", "Disney+", ["com.disney.disneyplus"], "https://www.disneyplus.com/", None),
    (r"^(hbo max|max)\b", "Max", ["com.wbd.stream", "com.hbo.hbonow"], "https://www.max.com/", None),
    (r"^(amazon prime video|prime video|amazon video)\b", "Prime Video", ["com.amazon.avod.thirdpartyclient", "com.amazon.amazonvideo.livingroom"], "https://www.primevideo.com/", "https://www.primevideo.com/search?phrase={q}"),
    (r"^apple tv\b", "Apple TV", ["com.apple.atve.androidtv.appletv"], "https://tv.apple.com/", None),
    (r"^paramount plus\b", "Paramount+", ["com.cbs.app", "com.cbs.ott"], "https://www.paramountplus.com/", None),
    (r"^peacock\b", "Peacock", ["com.peacocktv.peacockandroid"], "https://www.peacocktv.com/", None),
    (r"^crunchyroll\b", "Crunchyroll", ["com.crunchyroll.crunchyroid"], "https://www.crunchyroll.com/", "https://www.crunchyroll.com/search?q={q}"),
    (r"^tubi\b", "Tubi", ["com.tubitv"], "https://tubitv.com/", "https://tubitv.com/search/{q}"),
    (r"^pluto tv\b", "Pluto TV", ["tv.pluto.android"], "https://pluto.tv/", None),
    (r"^(youtube|youtube premium)$", "YouTube", ["com.google.android.youtube", "com.google.android.youtube.tv"], "https://www.youtube.com/", "https://www.youtube.com/results?search_query={q}"),
    (r"^google play (movies|tv)", "Google Play", ["com.google.android.videos"], "https://play.google.com/store/movies", "https://play.google.com/store/search?q={q}&c=movies"),
    (r"^(vudu|fandango at home)\b", "Fandango at Home", ["air.com.vudu.air.DownloaderTablet"], "https://athome.fandango.com/", None),
    (r"^starz\b", "Starz", ["com.bydeluxe.d3.android.program.starz"], "https://www.starz.com/", None),
    (r"^showtime\b", "Showtime", ["com.showtime.standalone"], "https://www.paramountplus.com/", None),
    (r"^(freevee|amazon freevee)\b", "Freevee", ["com.amazon.imdb.tv.android.app"], "https://www.amazon.com/freevee", None),
    (r"^the roku channel\b", "The Roku Channel", ["com.roku.web.trc"], "https://therokuchannel.roku.com/", None),
    (r"^plex\b", "Plex", ["com.plexapp.android"], "https://watch.plex.tv/", None),
    (r"^criterion channel\b", "Criterion Channel", ["com.criterionchannel"], "https://www.criterionchannel.com/", "https://www.criterionchannel.com/search?q={q}"),
    (r"^mubi\b", "MUBI", ["com.mubi"], "https://mubi.com/", None),
    (r"^kanopy\b", "Kanopy", ["com.kanopy"], "https://www.kanopy.com/", None),
    (r"^hoopla\b", "hoopla", ["com.hoopladigital.android"], "https://www.hoopladigital.com/", None),
]
