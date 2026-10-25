import 'library_match.dart';
import 'plugin_hooks.dart';
import 'store.dart';

/// Favorites a plugin (Trakt) reads and changes: movies and shows only.
///
/// PEK TV keeps two favorite lists per profile: library favorites (a movie of the library `m:<id>`, a show `s:<title>`) and
/// favorites saved by plugin screens (TMDb titles, `movie:603` / `tv:1396`). A plugin sees one list of `{kind, title, year, tmdb}`.
/// When a plugin ADDS a favorite, the library's own movie / show is favorited when exactly one fits (library_match.dart); a title
/// the library does not have is kept as a plugin favorite when its TMDb id is known, and skipped otherwise. When a plugin REMOVES
/// one, both lists are checked. A removal never undoes a favorite made here after the time the plugin last looked (`at`).
class PluginFavorites {
  /// What plugins see: library favorites plus plugin favorites, each title once.
  static List<Map<String, dynamic>> snapshot() {
    final out = <Map<String, dynamic>>[];
    final seen = <String>{};
    void add(String kind, String title, int year, int tmdb) {
      final n = Store.normalize(title);
      if (n.isEmpty) return;
      final y = kind == 'movie' ? year : 0;
      if (seen.add('$kind|$n|$y')) out.add({'kind': kind, 'title': title, 'year': y, 'tmdb': tmdb});
    }

    for (final f in Store.favorites()) {
      if (f.kind == 'movie' || f.kind == 'show') add(f.kind, f.title, f.year, f.tmdb > 0 ? f.tmdb : 0);
    }
    for (final e in Store.pluginFavorites()) {
      final tv = '${e['type']}' == 'tv';
      add(tv ? 'show' : 'movie', '${e['title'] ?? ''}', (e['year'] as num?)?.toInt() ?? 0, (e['id'] as num?)?.toInt() ?? 0);
    }
    return out;
  }

  static int _n(Object? v) => (v as num?)?.toInt() ?? 0;

  /// A favorite a plugin asked to add ([value] true) or remove (false). Titles of a plugin and of the library are lined up first.
  /// The plugin [source] is not told about its own change; other plugins are.
  static Future<void> setFromPlugin(List<Map> items, bool value, String source) async {
    final changed = <({String kind, String title, int year, int tmdb})>[];
    for (final it in items.take(300)) {
      final kind = '${it['kind']}';
      final title = '${it['title'] ?? ''}'.trim();
      if ((kind != 'movie' && kind != 'show') || title.isEmpty) continue;
      final year = kind == 'movie' ? _n(it['year']) : 0;
      final tmdb = _n(it['tmdb']);
      final lookedAt = Store.watchTimeFromSeconds(it['at']); // a removal: when the plugin last looked (ms), or null
      var did = false;
      if (value) {
        did = await _add(kind, title, year, tmdb, source);
      } else {
        did = await _remove(kind, title, year, tmdb, lookedAt);
      }
      if (did) changed.add((kind: kind, title: title, year: year, tmdb: tmdb));
    }
    if (changed.isNotEmpty) PluginHooks.favorited(changed, value, except: source);
  }

  static Future<bool> _add(String kind, String title, int year, int tmdb, String source) async {
    if (kind == 'movie') {
      final m = await LibraryMatch.movieFor(title, year);
      if (m != null) {
        if (Store.isFavorite('m:${m.id}')) return false;
        await Store.toggleFavorite(Favorite.movie(m.id, m.title, m.year), notify: false);
        return true;
      }
      if (tmdb <= 0 || Store.pluginFavoriteKeys().contains('movie:$tmdb')) return false;
      await Store.addPluginFavorite(plugin: source, type: 'movie', id: tmdb, title: title, year: year, notify: false);
      return true;
    }
    final name = await LibraryMatch.showFor(title);
    if (name != null) {
      if (Store.isFavorite('s:$name')) return false;
      await Store.toggleFavorite(Favorite.show(name), notify: false);
      return true;
    }
    if (tmdb <= 0 || Store.pluginFavoriteKeys().contains('tv:$tmdb')) return false;
    await Store.addPluginFavorite(plugin: source, type: 'tv', id: tmdb, title: title, year: 0, notify: false);
    return true;
  }

  static Future<bool> _remove(String kind, String title, int year, int tmdb, int? lookedAt) async {
    var did = false;
    // library favorite
    String? libKey;
    if (kind == 'movie') {
      final m = await LibraryMatch.movieFor(title, year);
      if (m != null) libKey = 'm:${m.id}';
    } else {
      final name = await LibraryMatch.showFor(title);
      if (name != null) libKey = 's:$name';
    }
    if (libKey != null) {
      for (final f in Store.favorites()) {
        if (f.key != libKey) continue;
        if (lookedAt != null && (f.updated > 0 ? f.updated : f.added) > lookedAt) break; // favorited here since the plugin looked
        await Store.toggleFavorite(f, notify: false);
        did = true;
        break;
      }
    }
    // plugin favorite: by TMDb id, or by title (and year)
    final n = Store.normalize(title);
    for (final e in Store.pluginFavorites()) {
      final tv = '${e['type']}' == 'tv';
      if (tv != (kind == 'show')) continue;
      final sameId = tmdb > 0 && _n(e['id']) == tmdb;
      final sameTitle = n.isNotEmpty && Store.normalize('${e['title'] ?? ''}') == n && (kind == 'show' || year == 0 || _n(e['year']) == 0 || _n(e['year']) == year);
      if (!sameId && !sameTitle) continue;
      if (lookedAt != null && (_n(e['updated']) > 0 ? _n(e['updated']) : _n(e['added'])) > lookedAt) continue;
      await Store.removePluginFavorite('${e['key']}', notify: false);
      did = true;
      break;
    }
    return did;
  }
}
