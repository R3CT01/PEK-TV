import 'dart:async';

import 'cloud.dart';
import 'library_match.dart';
import 'plugin_hooks.dart';
import 'store.dart';

/// Marking movies / episodes watched or unwatched (the web UI's `_setWatched` / `_setSeasonWatched`).
///
/// The record is Watch History itself (`Store`), the same one the player writes when something finishes, so the Watch History
/// page, the ✓ marks, Resume Watching and plugins all agree. A change is pushed to PEK Cloud a moment later (a removal goes up
/// as a `{deleted}` marker); cloud.dart's own 5-minute timer and the next sign-in merge cover the case where this push fails.
class Watched {
  static Timer? _timer;

  /// Marks [items] watched ([on] true) or unwatched. Only movies and episodes count; others are ignored.
  /// Plugins with the "playback" permission are told which items really changed (one already watched is not a change),
  /// except the plugin named in [source] (the one that asked for this change: a Trakt import must not go back to Trakt).
  ///
  /// A change a plugin asked for ([source] set) may carry the time it was really watched (Progress.updated, e.g. Trakt's own
  /// date); Watch History then shows and sorts by that time. Anything else is dated now.
  static Future<void> set(Iterable<Progress> items, bool on, {String? source}) async {
    // A plugin names things its own way (Trakt: "The Office", the library: "The Office (US)"): its titles are lined up with
    // the library's own first, only where exactly one library title fits (library_match.dart).
    final Iterable<Progress> list = source != null ? await LibraryMatch.resolve(items.toList()) : items;
    final changedItems = <Progress>[];
    final changed = await Store.setWatched(list, on, changedOut: changedItems, keepTime: source != null);
    if (!changed) return;
    _syncSoon();
    PluginHooks.watched(changedItems, on, except: source);
  }

  /// Schedules one light sync, however many marks happen in a row (a season is one call, tapping several episodes is one push).
  static void _syncSoon() {
    if (!Cloud.linked) return;
    _timer?.cancel();
    _timer = Timer(const Duration(seconds: 2), () => unawaited(Cloud.sync(light: true)));
  }

  /// Tells the cloud about a change that was written to history some other way.
  static void syncSoon() => _syncSoon();
}
