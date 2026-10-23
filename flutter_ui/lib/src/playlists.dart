import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';

import 'api.dart';
import 'store.dart';

class Playlist {
  Playlist({required this.id, required this.name, List<Track>? tracks}) : tracks = tracks ?? [];
  final String id;
  String name;
  final List<Track> tracks;

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'tracks': [for (final t in tracks) t.toJson()]};

  factory Playlist.fromJson(Map<String, dynamic> j) => Playlist(
        id: '${j['id']}',
        name: '${j['name'] ?? 'Playlist'}',
        tracks: [for (final t in (j['tracks'] as List?) ?? const []) if (t is Map && t['id'] != null) Track.fromJson(Map<String, dynamic>.from(t))],
      );

  /// The first song that has a picture: the playlist's cover.
  Track? get cover {
    for (final t in tracks) {
      if (t.art || t.albumId.isNotEmpty) return t;
    }
    return null;
  }
}

/// The user's playlists (create / rename / delete / add to playlist /
/// removeFromPlaylist), kept on this device per profile. Listeners repaint when anything changes or the profile does.
class Playlists extends ChangeNotifier {
  Playlists._() {
    Store.profile.addListener(_load);
    _load();
  }
  static final Playlists instance = Playlists._();

  static const _key = 'pek_music_playlists';
  List<Playlist> _lists = [];

  List<Playlist> get all => List.unmodifiable(_lists);
  Playlist? byId(String id) {
    for (final p in _lists) {
      if (p.id == id) return p;
    }
    return null;
  }

  void _load() {
    try {
      final raw = Store.strGet(_key);
      final d = raw == null ? const [] : jsonDecode(raw);
      _lists = [for (final e in (d is List ? d : const [])) if (e is Map) Playlist.fromJson(Map<String, dynamic>.from(e))];
    } catch (_) {
      _lists = [];
    }
    notifyListeners();
  }

  void _save() {
    Store.strSet(_key, jsonEncode([for (final p in _lists) p.toJson()]));
    notifyListeners();
  }

  Playlist create(String name, [List<Track> tracks = const []]) {
    final n = name.trim();
    final seen = <String>{};
    final p = Playlist(
      id: 'pl${DateTime.now().millisecondsSinceEpoch.toRadixString(36)}${math.Random().nextInt(1296).toRadixString(36)}',
      name: n.isEmpty ? 'New playlist' : n,
      tracks: [for (final t in tracks) if (seen.add(t.id)) t],
    );
    _lists.add(p);
    _save();
    return p;
  }

  void rename(String id, String name) {
    final p = byId(id);
    if (p == null || name.trim().isEmpty) return;
    p.name = name.trim();
    _save();
  }

  void delete(String id) {
    _lists.removeWhere((p) => p.id == id);
    _save();
  }

  /// Returns how many songs were really added (songs already in the playlist are skipped).
  int add(String id, List<Track> tracks) {
    final p = byId(id);
    if (p == null) return 0;
    final have = {for (final t in p.tracks) t.id};
    var added = 0;
    for (final t in tracks) {
      if (have.add(t.id)) {
        p.tracks.add(t);
        added++;
      }
    }
    if (added > 0) _save();
    return added;
  }

  void removeAt(String id, int i) {
    final p = byId(id);
    if (p == null || i < 0 || i >= p.tracks.length) return;
    p.tracks.removeAt(i);
    _save();
  }

  /// Drag-and-drop / "Move up" / "Move down": the song at [from] goes to position [to].
  void move(String id, int from, int to) {
    final p = byId(id);
    if (p == null || from < 0 || from >= p.tracks.length) return;
    final t = p.tracks.removeAt(from);
    p.tracks.insert(to.clamp(0, p.tracks.length).toInt(), t);
    _save();
  }
}
