import 'dart:async';

import 'cloud.dart';
import 'store.dart';

/// Marking movies / episodes watched or unwatched (the web UI's `_setWatched` / `_setSeasonWatched`).
///
/// The record is Watch History itself (`Store`), the same one the player writes when something finishes, so the Watch History
/// page, the ✓ marks, Resume Watching and plugins all agree. A change is pushed to PEK Cloud a moment later (a removal goes up
/// as a `{deleted}` marker); cloud.dart's own 5-minute timer and the next sign-in merge cover the case where this push fails.
class Watched {
  static Timer? _timer;

  /// Marks [items] watched ([on] true) or unwatched. Only movies and episodes count; others are ignored.
  static Future<void> set(Iterable<Progress> items, bool on) async {
    final changed = await Store.setWatched(items, on);
    if (changed) _syncSoon();
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
