import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:http/http.dart' as http;

import 'cloud.dart';
import 'common.dart';
import 'store.dart';
import 'tokens.dart';
import 'widgets.dart';

/// One message from Settings > Updates (news, an update note or a coupon code). You post them with cloud/worker.js
/// (`POST /v1/news/post`, or the news-admin page on the website); the app only reads them.
class NewsItem {
  const NewsItem({required this.id, required this.created, required this.kind, required this.title, this.body = '', this.code = '', this.link = ''});

  final int id;
  final int created; // ms since epoch
  final String kind; // news | update | coupon
  final String title;
  final String body;
  final String code; // a coupon code to copy (may be empty)
  final String link;

  Map<String, dynamic> toJson() => {'id': id, 'created': created, 'kind': kind, 'title': title, 'body': body, 'code': code, 'link': link};
}

/// The Updates feed: fetched from the cloud worker (no sign-in needed), cached on the device, with an "unread" count for
/// the badge on Settings > Updates. The newest id the person has opened is remembered on the device (not per profile).
class News {
  static const _kSeen = 'pek_news_seen';
  static const _kCache = 'pek_news_cache';

  /// How many messages are newer than the last one the person opened. Settings shows it next to "Updates".
  static final unread = ValueNotifier<int>(0);

  static List<NewsItem> items = const [];
  static bool _cacheLoaded = false;
  static int _lastFetch = 0;

  /// Reads the list the worker sent. Anything that does not look right is skipped. Newest first. Pure, so it can be tested.
  static List<NewsItem> parse(Object? raw) {
    final out = <NewsItem>[];
    if (raw is! List) return out;
    for (final e in raw) {
      if (e is! Map) continue;
      final id = e['id'];
      final title = e['title'];
      if (id is! num || title is! String || title.isEmpty) continue;
      String s(String k) => e[k] is String ? e[k] as String : '';
      final created = e['created'];
      out.add(NewsItem(id: id.toInt(), created: created is num ? created.toInt() : 0, kind: s('kind').isEmpty ? 'news' : s('kind'), title: title, body: s('body'), code: s('code'), link: s('link')));
    }
    out.sort((a, b) => b.id.compareTo(a.id));
    return out;
  }

  /// How many of [all] are newer than [seen]. Pure, so it can be tested.
  static int countUnread(List<NewsItem> all, int seen) => all.where((i) => i.id > seen).length;

  static int seenId() => int.tryParse(Store.strGet(_kSeen, scoped: false) ?? '') ?? 0;

  /// Shows what was fetched last time, so the screen is not empty while (or when) the phone is offline.
  static void loadCache() {
    if (_cacheLoaded) return;
    _cacheLoaded = true;
    try {
      final raw = Store.strGet(_kCache, scoped: false);
      if (raw != null && raw.isNotEmpty) items = parse(jsonDecode(raw));
      unread.value = countUnread(items, seenId());
    } catch (_) {/* a bad cache is just ignored */}
  }

  /// Asks the cloud for the current messages (at most every 5 minutes unless [force]). Never throws: offline = keep what we have.
  static Future<void> refresh({bool force = false}) async {
    loadCache();
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!force && _lastFetch != 0 && now - _lastFetch < 5 * 60 * 1000) return;
    try {
      final r = await http.get(Uri.parse('${Cloud.api}/v1/news')).timeout(const Duration(seconds: 15));
      if (r.statusCode != 200) return;
      final o = jsonDecode(utf8.decode(r.bodyBytes));
      if (o is! Map || o['ok'] != true) return;
      items = parse(o['items']);
      _lastFetch = now;
      await Store.strSet(_kCache, jsonEncode([for (final i in items) i.toJson()]), scoped: false);
      unread.value = countUnread(items, seenId());
    } catch (_) {/* offline or the cloud is busy: try again next time */}
  }

  /// The person opened Updates: everything up to the newest message counts as read.
  static Future<void> markAllSeen() async {
    if (items.isEmpty) return;
    final top = items.first.id;
    if (top > seenId()) await Store.strSet(_kSeen, '$top', scoped: false);
    unread.value = 0;
  }
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _date(int ms) {
  if (ms <= 0) return '';
  final d = DateTime.fromMillisecondsSinceEpoch(ms);
  return '${_months[d.month - 1]} ${d.day}, ${d.year}';
}

IconData _icon(String kind) => kind == 'coupon' ? Icons.local_offer_outlined : kind == 'update' ? Icons.system_update_alt : Icons.campaign_outlined;

/// Settings > Updates.
class NewsSection extends StatefulWidget {
  const NewsSection({super.key});
  @override
  State<NewsSection> createState() => _NewsSectionState();
}

class _NewsSectionState extends State<NewsSection> {
  int _seenBefore = 0; // messages newer than this are shown as new
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _seenBefore = News.seenId();
    News.loadCache();
    _load();
  }

  Future<void> _load() async {
    await News.refresh(force: true);
    if (!mounted) return;
    setState(() => _loading = false);
    await News.markAllSeen();
  }

  Future<void> _open(NewsItem i) async {
    final p = context.pek;
    var copied = false;
    await showDialog<void>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => StatefulBuilder(
        builder: (c, setD) => Dialog(
          backgroundColor: p.tokens.glassStrong,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(p.tokens.radius), side: BorderSide(color: p.tokens.border)),
          child: Padding(
            padding: EdgeInsets.all(1.5 * p.rem),
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(i.title, style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
              if (_date(i.created).isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.2 * p.rem), child: Text(_date(i.created), style: TextStyle(color: p.tokens.textMuted, fontSize: 0.85 * p.rem))),
              SizedBox(height: 0.7 * p.rem),
              Flexible(
                child: SingleChildScrollView(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    if (i.body.isNotEmpty) Text(i.body, style: TextStyle(color: p.tokens.textMuted)),
                    if (i.code.isNotEmpty) ...[
                      SizedBox(height: 0.8 * p.rem),
                      SelectableText(i.code, style: TextStyle(fontSize: 1.4 * p.rem, fontWeight: FontWeight.w800, letterSpacing: 2, color: p.tokens.accent)),
                      SizedBox(height: 0.3 * p.rem),
                      Text('Enter this code on the payment page at ${Cloud.accountPage}', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.85 * p.rem)),
                    ],
                    if (i.link.isNotEmpty) ...[
                      SizedBox(height: 0.6 * p.rem),
                      SelectableText(i.link, style: TextStyle(color: p.tokens.accent, fontSize: 0.9 * p.rem)),
                    ],
                  ]),
                ),
              ),
              SizedBox(height: 1.1 * p.rem),
              Wrap(spacing: 0.75 * p.rem, runSpacing: 0.75 * p.rem, children: [
                if (i.code.isNotEmpty)
                  PekButton(
                    label: copied ? 'Copied' : 'Copy code',
                    primary: true,
                    onTap: () async {
                      await Clipboard.setData(ClipboardData(text: i.code));
                      setD(() => copied = true);
                    },
                  ),
                PekButton(label: 'Close', autofocus: i.code.isEmpty, onTap: () => Navigator.pop(c)),
              ]),
            ]),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    final items = News.items;
    return Section(
      title: 'Updates',
      hint: 'News about PEK TV, offers and coupon codes.',
      children: [
        if (items.isEmpty)
          Text(_loading ? 'Loading\u2026' : 'Nothing here yet. Check back later.', style: TextStyle(color: t.textMuted))
        else
          for (final i in items)
            ListRow(
              leading: Icon(_icon(i.kind), color: t.accent),
              title: i.title,
              subtitle: [_date(i.created), if (i.code.isNotEmpty) 'Code ${i.code}'].where((x) => x.isNotEmpty).join(' \u00b7 '),
              highlight: i.id > _seenBefore,
              trailing: Icon(Icons.chevron_right, color: t.textMuted),
              onTap: () => _open(i),
            ),
      ],
    );
  }
}
