import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/ratings.dart';
import 'package:pek_tv_ui/src/recs.dart';
import 'package:pek_tv_ui/src/store.dart';

HistoryEntry watched(String title, {String kind = 'movie', int year = 2020, int at = 0, int count = 1}) =>
    HistoryEntry(key: '$kind|$title', kind: kind, title: title, year: year, season: kind == 'episode' ? 1 : 0, episode: kind == 'episode' ? 1 : 0, at: at, count: count);

RatingEntry rated(String title, int rating, {String kind = 'movie', int year = 2020}) =>
    RatingEntry(key: '$kind|$title', kind: kind, title: title, year: year, season: 0, episode: 0, rating: rating, at: 1, updated: 1);

void main() {
  test('genres: unknown ids and repeats are dropped, the order is kept', () {
    expect(Recs.cleanGenres(['comedy', 'nope', 'drama', 'comedy', 5]), ['comedy', 'drama']);
    expect(Recs.cleanGenres('comedy'), isEmpty);
    expect(Recs.cleanGenres(null), isEmpty);
  });

  test('not interested: only movie / show keys, newest 30 kept', () {
    expect(Recs.cleanHidden(['m603', 't1396', 'x1', 'm', 'm603']), ['m603', 't1396']);
    final many = [for (var i = 1; i <= 40; i++) 'm$i'];
    final kept = Recs.cleanHidden(many);
    expect(kept.length, Recs.maxHidden);
    expect(kept.last, 'm40');
  });

  test('the cloud copy: nothing usable gives null, offered and picks survive', () {
    expect(Recs.cleanSync(null), isNull);
    expect(Recs.cleanSync({'g': ['nope']}), isNull);
    expect(Recs.cleanSync({'o': 1, 'g': ['scifi', 'horror'], 'n': ['m1']}), {'o': 1, 'g': ['scifi', 'horror'], 'n': ['m1']});
    expect(Recs.cleanSync({'o': 1}), {'o': 1, 'g': <String>[], 'n': <String>[]});
  });

  test('TMDb results: needs an id, a title and a safe poster path', () {
    final items = RecFeed.parseResults({
      'results': [
        {'id': 1, 'title': 'A', 'poster_path': '/a.jpg', 'release_date': '2019-05-01', 'overview': 'x'},
        {'id': 2, 'title': 'No poster', 'poster_path': null},
        {'id': 3, 'title': '', 'poster_path': '/c.jpg'},
        {'id': 4, 'title': 'Bad path', 'poster_path': 'https://evil.example/x.jpg'},
        'junk',
      ],
    }, false);
    expect(items.map((e) => e.title), ['A']);
    expect(items.first.year, 2019);
    expect(items.first.key, 'm1');
    final tv = RecFeed.parseResults({'results': [{'id': 9, 'name': 'Show', 'poster_path': '/s.png', 'first_air_date': '2011-04-17'}]}, true);
    expect(tv.first.key, 't9');
    expect(tv.first.image, 'https://image.tmdb.org/t/p/w342/s.png');
    expect(RecFeed.parseResults(null, true), isEmpty);
  });

  test('movies and shows are mixed one by one', () {
    const m1 = RecItem(id: 1, tv: false, title: 'm1', year: 0, poster: '/1.jpg');
    const m2 = RecItem(id: 2, tv: false, title: 'm2', year: 0, poster: '/2.jpg');
    const t1 = RecItem(id: 3, tv: true, title: 't1', year: 0, poster: '/3.jpg');
    expect(RecFeed.interleave([m1, m2], [t1]).map((e) => e.title), ['m1', 't1', 'm2']);
  });

  test('seeds: a high rating beats a single watch, a low rating is never a seed', () {
    const now = 100 * 24 * 3600 * 1000;
    final seeds = RecFeed.seedsFrom(
      [watched('Old Movie', at: 1), watched('Loved Movie', at: 1), watched('Hated Movie', at: now)],
      [rated('Loved Movie', 9), rated('Hated Movie', 2)],
      now,
    );
    expect(seeds.map((s) => s.title), ['Loved Movie', 'Old Movie']);
    expect(seeds.first.liked, isTrue);
    expect(seeds.last.liked, isFalse);
  });

  test('seeds: episodes of one show add up to one seed, capped', () {
    final eps = [for (var i = 0; i < 30; i++) watched('Some Show', kind: 'episode', at: 1)];
    final seeds = RecFeed.seedsFrom(eps, const [], 1000 * 24 * 3600 * 1000);
    expect(seeds.length, 1);
    expect(seeds.first.tv, isTrue);
    expect(seeds.first.weight, lessThanOrEqualTo(1.5));
  });

  test('nothing watched or rated gives no seeds', () {
    expect(RecFeed.seedsFrom(const [], const [], 0), isEmpty);
  });
}
