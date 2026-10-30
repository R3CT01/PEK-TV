import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/news.dart';

void main() {
  test('messages are read newest first and bad entries are skipped', () {
    final items = News.parse([
      {'id': 1, 'created': 10, 'kind': 'news', 'title': 'Old'},
      {'id': 3, 'created': 30, 'kind': 'coupon', 'title': 'New', 'code': 'SAVE10'},
      {'id': 2, 'title': ''},
      'junk',
      {'title': 'no id'},
    ]);
    expect(items.map((i) => i.id), [3, 1]);
    expect(items.first.code, 'SAVE10');
  });

  test('anything that is not a list gives no messages', () {
    expect(News.parse(null), isEmpty);
    expect(News.parse({'a': 1}), isEmpty);
  });

  test('unread counts the messages newer than the last one opened', () {
    final items = News.parse([
      {'id': 5, 'title': 'a'},
      {'id': 4, 'title': 'b'},
      {'id': 2, 'title': 'c'},
    ]);
    expect(News.countUnread(items, 0), 3);
    expect(News.countUnread(items, 4), 1);
    expect(News.countUnread(items, 5), 0);
  });
}
