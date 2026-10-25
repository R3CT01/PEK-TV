import 'package:flutter_test/flutter_test.dart';
import 'package:pek_tv_ui/src/whats_new.dart';

const a = ReleaseNotes('2.0.0', 'A', ['a']);
const b = ReleaseNotes('2.1.0', 'B', ['b']);
const c = ReleaseNotes('2.2.0', 'C', ['c']);
const all = [c, b, a];

List<String> pick(String installed, String seen) => [for (final r in WhatsNew.select(all, installed, seen)) r.version];

void main() {
  test('an update shows the notes of the new version once', () {
    expect(pick('2.2.0', '2.1.0'), ['2.2.0']);
    expect(pick('2.2.0', '2.2.0'), isEmpty);
  });

  test('skipping versions shows every release in between, newest first', () {
    expect(pick('2.2.0', '2.0.0'), ['2.2.0', '2.1.0']);
  });

  test('the first time (nothing remembered) shows only the newest notes, not the whole history', () {
    expect(pick('2.2.0', ''), ['2.2.0']);
  });

  test('notes for a version newer than the running app are not shown', () {
    expect(pick('2.1.0', '2.0.0'), ['2.1.0']);
    expect(pick('1.9.0', ''), isEmpty);
  });

  test('a release with no entry shows nothing', () {
    expect(pick('2.2.1', '2.2.0'), isEmpty);
  });

  test('-debug and -dev.N suffixes and +build numbers are ignored', () {
    expect(pick('2.2.0-dev.4', '2.1.0'), ['2.2.0']);
    expect(pick('2.2.0-debug', '2.1.0+19'), ['2.2.0']);
    expect(pick('2.2.0+19', '2.2.0-dev.1'), isEmpty);
  });
}
