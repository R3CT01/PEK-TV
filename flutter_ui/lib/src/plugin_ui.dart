import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData, KeyDownEvent, KeyEvent, KeyUpEvent, LogicalKeyboardKey;
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

import 'activity.dart';
import 'common.dart';
import 'fields.dart';
import 'live_tv.dart';
import 'player.dart';
import 'ratings.dart';
import 'plugin_host.dart';
import 'skin_widgets.dart';
import 'skins.dart';
import 'settings_extra.dart' show ToggleRow;
import 'store.dart';
import 'torrent.dart';
import 'tokens.dart';
import 'watched.dart';
import 'weather.dart' show Weather, WeatherBadge;
import 'widgets.dart';
import 'art_cache.dart';

/// Opens a plugin's screen on top of the current one (a phone, or a TV from a place that is not the sidebar).
Future<void> openPluginScreen(BuildContext context, {required String pluginId, required String title, Map<String, dynamic>? launch}) {
  Activity.note('$title started', detail: true);
  return Navigator.push<void>(
    context,
    MaterialPageRoute<void>(
      builder: (_) => SubScreen(
        title: title,
        body: Builder(builder: (c) => PluginView(pluginId: pluginId, padding: c.pek.pagePad, launch: launch)),
      ),
    ),
  );
}

/// Draws a plugin's Python screen.
///
/// The screen is a JSON tree (see python/pek_ui.py for the vocabulary: column, row, text, heading, button, card,
/// listrow, poster, grid, tabs, input, toggle, provider, spinner). Every tap goes back to Python, which runs the
/// plugin's callback and sends the next tree. This is the Flutter twin of the web UI's plugin_sandbox.js: the plugin
/// can only describe a screen and ask for a few effects; it never runs code here.
class PluginView extends StatefulWidget {
  const PluginView({super.key, required this.pluginId, required this.padding, this.launch, this.embedded = false, this.onExit});

  final String pluginId;
  final EdgeInsets padding;

  /// Open the plugin on this title ({type, id, title, year}), like pek.onLaunch.
  final Map<String, dynamic>? launch;

  /// Shown inside the TV shell instead of on its own route: Back goes through [PluginBack], and a plugin that
  /// closes itself calls [onExit].
  final bool embedded;
  final VoidCallback? onExit;

  @override
  State<PluginView> createState() => _PluginViewState();
}

class _InputState {
  _InputState(this.controller, this.sent);
  final TextEditingController controller;
  String sent; // what the plugin last heard from this box
}

class _PluginViewState extends State<PluginView> {
  final ScrollController _scroll = ScrollController();
  final Map<String, _InputState> _inputs = {};
  final Set<String> _autofocused = {};
  late final bool Function() _backFn = _onBack;

  Map<String, dynamic>? _tree;
  String? _error;
  List<String> _hosts = const [];
  int _version = -1;
  int _scrollMark = 0;
  bool _busy = false; // the plugin has background work running (a fetch)
  bool _back = false; // the plugin wants Back for itself
  int _pending = 0; // calls in flight
  bool _polling = false;
  Timer? _timer;
  Future<void> _chain = Future<void>.value();

  @override
  void initState() {
    super.initState();
    // context.pek needs the inherited scope, so the first call waits for the first frame.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _open();
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    if (PluginBack.current == _backFn) PluginBack.current = null;
    for (final s in _inputs.values) {
      s.controller.dispose();
    }
    _scroll.dispose();
    super.dispose();
  }

  Map<String, dynamic> _ctx() => PluginHost.context(isTv: context.pek.isTv);

  // ---------------------------------------------------------------- talking to Python

  Future<void> _open({bool fresh = false}) async {
    setState(() {
      _error = null;
      if (fresh) _tree = null;
    });
    if (PluginHost.streamers == null) await PluginHost.refreshStreamers();
    if (!mounted) return;
    final r = await PluginHost.open(widget.pluginId, ctx: _ctx(), launch: widget.launch, fresh: fresh);
    if (mounted) _apply(r);
  }

  void _send(String handler, {Object? value}) {
    if (handler.isEmpty) return;
    final inputs = <String, String>{};
    for (final e in _inputs.entries) {
      e.value.sent = e.value.controller.text;
      inputs[e.key] = e.value.sent;
    }
    setState(() => _pending++);
    _chain = _chain.then((_) async {
      final r = await PluginHost.event(widget.pluginId, handler, ctx: _ctx(), value: value, inputs: inputs);
      if (!mounted) return;
      setState(() => _pending--);
      _apply(r);
    });
  }

  Future<void> _tick() async {
    if (_polling || _pending > 0 || !mounted) return;
    _polling = true;
    try {
      final r = await PluginHost.poll(widget.pluginId, _version, ctx: _ctx());
      if (mounted) _apply(r);
    } finally {
      _polling = false;
    }
  }

  void _apply(Map<String, dynamic> r) {
    if (r['ok'] != true) {
      setState(() {
        _error = '${r['error'] ?? 'The plugin could not be opened.'}';
        _busy = false;
        _back = false;
      });
      _syncTimer();
      _syncBack();
      return;
    }
    final effects = (r['effects'] as List?) ?? const [];
    if (r['same'] == true) {
      final busy = r['busy'] == true;
      if (busy != _busy) setState(() => _busy = busy);
    } else {
      final tree = r['tree'];
      _hosts = ((r['hosts'] as List?) ?? const []).map((e) => '$e').toList();
      if (tree is Map<String, dynamic>) _syncInputs(tree);
      final mark = (r['scroll'] as num?)?.toInt() ?? 0;
      setState(() {
        _error = null;
        if (tree is Map<String, dynamic>) _tree = tree;
        _version = (r['v'] as num?)?.toInt() ?? _version;
        _busy = r['busy'] == true;
        _back = r['back'] == true;
      });
      if (tree is Map<String, dynamic>) _prefetchPosters(tree);
      if (mark != _scrollMark) {
        _scrollMark = mark;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (_scroll.hasClients) _scroll.jumpTo(0);
        });
      }
      _syncBack();
    }
    _syncTimer();
    if (effects.isNotEmpty) unawaited(_run(effects));
  }

  /// Starts downloading every poster on the screen, not only the ones a sideways row has built so far: a row builds its cards as
  /// they scroll into view, so without this each card began its download only when the finger got there.
  void _prefetchPosters(Map<String, dynamic> tree) {
    final urls = <String>[];
    void walk(Map<String, dynamic> n) {
      if (n['t'] == 'poster') {
        final u = '${n['img'] ?? ''}';
        if (u.isNotEmpty && PluginHosts.allows(_hosts, u)) urls.add(u);
      }
      for (final c in _kids(n)) {
        walk(c);
      }
    }

    walk(tree);
    if (urls.isNotEmpty) ArtCache.prefetch(urls);
  }

  /// While the plugin has a fetch running, ask now and then whether it finished (the web sandbox's requestRender).
  void _syncTimer() {
    if (_busy && _timer == null) {
      _timer = Timer.periodic(const Duration(milliseconds: 250), (_) => _tick());
    } else if (!_busy && _timer != null) {
      _timer!.cancel();
      _timer = null;
    }
  }

  void _syncBack() {
    if (widget.embedded && _back) {
      PluginBack.current = _backFn;
    } else if (PluginBack.current == _backFn) {
      PluginBack.current = null;
    }
  }

  bool _onBack() {
    _send('back');
    return true;
  }

  /// The year a poster stands for: the one the plugin passed, else a "(2010)" in the title, else a year in the sub line
  /// ("2010 \u00b7 Movie"). 0 = unknown.
  static int _posterYear(String title, String sub, int given) {
    if (given > 0) return given;
    final inTitle = RegExp(r'\((19|20)\d{2}\)\s*$').firstMatch(title);
    if (inTitle != null) return int.parse(inTitle.group(0)!.replaceAll(RegExp(r'[^0-9]'), ''));
    final inSub = RegExp(r'(?<!\d)(19|20)\d{2}(?!\d)').firstMatch(sub);
    return inSub == null ? 0 : int.parse(inSub.group(0)!);
  }

  /// The title without a trailing "(2010)", which is how plugins often write it.
  static String _posterName(String title) => title.replaceFirst(RegExp(r'\s*\((19|20)\d{2}\)\s*$'), '').trim();

  /// Is this poster's movie in Watch History? With a year it must match exactly; without one it matches by title when
  /// Settings > Plugin posters allows it.
  bool _posterWatched(String title, int year) {
    final name = _posterName(title);
    if (year > 0) return Store.isWatched(kind: 'movie', title: name, year: year);
    if (!Store.pluginWatchedLoose) return false;
    return Store.watchedMovieTitles().contains(Store.normalize(name));
  }

  /// Press and hold on a plugin poster: mark / un-mark the movie (un-marking a poster with no year clears every year of that title).
  Future<void> _togglePosterWatched(String title, int year) async {
    final name = _posterName(title);
    if (Store.keyFor(kind: 'movie', title: name, year: year) == null) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    Progress movie(String t, int y) => Progress(id: '', title: t, kind: 'movie', position: 0, duration: 0, updated: now, year: y);
    final seen = _posterWatched(title, year);
    if (!seen) {
      await Watched.set([movie(name, year)], true);
      _toast('Marked as watched');
      return;
    }
    final keys = year > 0 ? [Store.keyFor(kind: 'movie', title: name, year: year)!] : Store.watchedMovieKeysFor(name);
    final items = <Progress>[
      for (final k in keys) movie(name, int.tryParse(k.substring(k.lastIndexOf('|') + 1)) ?? 0),
    ];
    await Watched.set(items, false);
    _toast('Marked as unwatched');
  }

  /// A movie or episode a plugin named: `{kind: 'movie', title, year}` or `{kind: 'episode', title (the show's), season, episode}`.
  Progress? _watchedItem(Map it) {
    final kind = '${it['kind']}';
    final title = '${it['title'] ?? ''}';
    // "at": when it was really watched (seconds since 1970), if the plugin knows; otherwise now.
    final now = Store.watchTimeFromSeconds(it['at']) ?? DateTime.now().millisecondsSinceEpoch;
    if (kind == 'movie') {
      final year = (it['year'] as num?)?.toInt() ?? 0;
      return Store.keyFor(kind: 'movie', title: title, year: year) == null
          ? null
          : Progress(id: '', title: title, kind: 'movie', position: 0, duration: 0, updated: now, year: year);
    }
    if (kind == 'episode') {
      final season = (it['season'] as num?)?.toInt() ?? 0;
      final episode = (it['episode'] as num?)?.toInt() ?? 0;
      return Store.keyFor(kind: 'episode', showTitle: title, season: season, episode: episode) == null
          ? null
          : Progress(id: '', title: title, kind: 'episode', position: 0, duration: 0, updated: now, showTitle: title, season: season, episode: episode);
    }
    return null;
  }

  /// Text boxes keep what the person typed across redraws. The plugin's own value only replaces it when the person
  /// has not typed since the plugin last heard from the box (so a plugin can clear or fill a box itself).
  void _syncInputs(Map<String, dynamic> n) {
    if (n['t'] == 'input') {
      final key = '${n['key']}';
      final value = '${n['value'] ?? ''}';
      final st = _inputs[key];
      if (st == null) {
        _inputs[key] = _InputState(TextEditingController(text: value), value);
      } else if (st.controller.text != value && st.controller.text == st.sent) {
        st.controller.text = value;
        st.sent = value;
      }
    }
    for (final c in _kids(n)) {
      _syncInputs(c);
    }
  }

  // ---------------------------------------------------------------- effects the plugin may ask for

  Future<void> _run(List effects) async {
    for (final raw in effects) {
      if (raw is! Map) continue;
      final op = '${raw['op']}';
      if (op == 'open_url') {
        final ok = await PluginHost.openUrl('${raw['url']}');
        if (!ok) _toast('Could not open that link on this device.');
      } else if (op == 'open_app') {
        final ok = await PluginHost.openApp('${raw['packages']}', '${raw['url']}');
        if (!ok) _toast('Could not open that service on this device.');
      } else if (op == 'open_plugin') {
        // Another plugin's screen on a title ("Play with ..."). Only plugins that declared "provides": {"stream": true}.
        final id = '${raw['id']}';
        final known = (PluginHost.streamers ?? const <Map<String, String>>[]).where((e) => e['id'] == id).firstOrNull;
        final intent = raw['intent'];
        if (known == null || intent is! Map || !mounted) continue;
        unawaited(openPluginScreen(context, pluginId: id, title: known['name'] ?? id, launch: Map<String, dynamic>.from(intent)));
      } else if (op == 'watched.set' || op == 'watched.set_many') {
        // Watch History, the same record the library and the cloud sync use. Movies and episodes; the plugin's permission
        // was already checked in Python (pek_ui.set_watched), and Watched.set pushes the change to PEK Cloud shortly after.
        final on = raw['value'] == true;
        final list = op == 'watched.set_many' ? (raw['items'] is List ? raw['items'] as List : const []) : [raw];
        final items = <Progress>[];
        for (final it in list.take(300)) {
          if (it is! Map) continue;
          final p = _watchedItem(it);
          if (p != null) items.add(p);
        }
        if (items.isNotEmpty) await Watched.set(items, on, source: widget.pluginId);
      } else if (op == 'ratings.set_many') {
        // A rating made on a plugin screen (pek_ui.set_ratings_many): saved for the open profile like a rating made on PEK TV's own
        // pages, so it shows on the cards, syncs to PEK Cloud and is passed on to plugins such as Trakt. (The permission was
        // already checked in Python.)
        final list = raw['items'] is List ? raw['items'] as List : const [];
        for (final it in list.take(300)) {
          if (it is! Map) continue;
          final title = '${it['title'] ?? ''}'.trim();
          if (title.isEmpty) continue;
          int n(Object? v) => (v as num?)?.toInt() ?? 0;
          final kind = '${it['kind'] ?? 'movie'}';
          final RateTarget t = kind == 'episode' ? Ratings.episode(title, n(it['season']), n(it['episode'])) : kind == 'show' ? Ratings.show(title) : Ratings.movie(title, n(it['year']));
          await Ratings.rateTarget(t, n(it['rating']));
        }
      } else if (op == 'favorite.add') {
        await Store.addPluginFavorite(
          plugin: widget.pluginId,
          type: '${raw['type']}',
          id: (raw['id'] as num?)?.toInt() ?? 0,
          title: '${raw['title'] ?? ''}',
          year: (raw['year'] as num?)?.toInt() ?? 0,
          posterPath: '${raw['posterPath'] ?? ''}',
        );
      } else if (op == 'favorite.remove') {
        await Store.removePluginFavorite('${raw['key']}');
      } else if (op == 'torrent.play') {
        // A plugin screen with the "torrent" permission started a release (pek_ui.play_torrent): PEK's own loading box and
        // player take over, and the watch is kept under Resume Watching like any other torrent stream.
        final src = '${raw['source'] ?? ''}';
        if (!mounted || !(src.startsWith('magnet:?') || src.startsWith('https://'))) continue;
        final isEp = '${raw['kind']}' == 'episode';
        final name = '${raw['name'] ?? ''}';
        final season = (raw['season'] as num?)?.toInt() ?? 0;
        final episode = (raw['episode'] as num?)?.toInt() ?? 0;
        final tt = TorrentTitle(
          kind: isEp ? 'episode' : 'movie',
          title: '${raw['title'] ?? ''}'.isNotEmpty ? '${raw['title']}' : name,
          showTitle: isEp ? name : '',
          year: (raw['year'] as num?)?.toInt() ?? 0,
          season: season,
          episode: episode,
        );
        unawaited(playTorrent(context, track: tt.track(src, origin: widget.pluginId, image: _artwork('${raw['image'] ?? ''}'))));
      } else if (op == 'live.play') {
        // A plugin with the "live" permission started a channel (pek_ui.live_play): PEK's own player takes over. When the plugin
        // also ships a live file, the player offers the channel switcher and the TV guide, asking the plugin for the answers.
        // Python checked the address; this is a second lock (http or https, nothing else).
        final url = '${raw['url'] ?? ''}';
        final u = Uri.tryParse(url);
        if (!mounted || u == null || !(u.scheme == 'https' || u.scheme == 'http') || u.host.isEmpty) continue;
        unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => PlayerScreen(url: url, title: '${raw['title'] ?? ''}', live: LiveSource(widget.pluginId, '${raw['channel'] ?? ''}')),
        )));
      } else if (op == 'clipboard.copy') {
        // Text the plugin asked to copy (the Skin maker's skin.json). Short text only; the person is told it was copied.
        final text = '${raw['text'] ?? ''}';
        if (text.isNotEmpty && text.length <= 20000) {
          await Clipboard.setData(ClipboardData(text: text));
          _toast('${raw['note'] ?? 'Copied.'}');
        }
      } else if (op.startsWith('skin.')) {
        // Skins are PEK's official Skin maker's job; Python already checked its permission, and this is a second lock.
        if (widget.pluginId != 'skin-maker') continue;
        await _skinEffect(op, raw);
      } else if (op == 'weather.set') {
        // The Weather plugin choosing the app's city / unit (pek_ui.weather_set / weather_unit); a second lock after Python's.
        if (widget.pluginId != 'weather') continue;
        final lat = (raw['lat'] as num?)?.toDouble(), lon = (raw['lon'] as num?)?.toDouble();
        final label = '${raw['label'] ?? ''}'.trim();
        if (lat != null && lon != null && lat.isFinite && lon.isFinite && lat.abs() <= 90 && lon.abs() <= 180 && label.isNotEmpty && label.length <= 120) {
          await Weather.setCity(lat, lon, label);
        }
        final u = raw['unit'];
        if (u == 'C' || u == 'F') await Weather.setUnit(u as String);
      } else if (op == 'toast') {
        _toast('${raw['text'] ?? ''}');
      } else if (op == 'exit') {
        if (!mounted) return;
        if (widget.embedded) {
          widget.onExit?.call();
        } else {
          unawaited(Navigator.maybePop(context));
        }
      }
    }
  }

  /// skin.save / skin.use / skin.delete from the Skin maker plugin. Only skins made here (id "custom-...") can be changed or
  /// removed: a built-in or installed skin is never touched, and a colour set that is hard to read is refused again here.
  Future<void> _skinEffect(String op, Map raw) async {
    final id = '${raw['id'] ?? ''}';
    if (op == 'skin.use') {
      if (Skins.all.any((s) => s.id == id)) await Skins.set(id);
    } else if (op == 'skin.delete') {
      if (id.startsWith('custom-') && Skins.customSkins.any((s) => s.id == id)) await Skins.deleteCustom(id);
    } else if (op == 'skin.save') {
      final tokens = SkinJson.tokensFrom((raw['tokens'] is Map ? Map<String, dynamic>.from(raw['tokens'] as Map) : const <String, dynamic>{}));
      if (tokens == null) {
        _toast('That skin has no colours in it.');
        return;
      }
      if (SkinJson.unreadable(tokens)) {
        _toast('The text would be hard to read on those colours.');
        return;
      }
      final name = '${raw['name'] ?? ''}'.trim();
      final saveId = id.startsWith('custom-') ? id : Skins.newId();
      final skin = Skin(saveId, name.isEmpty ? 'My skin' : (name.length > 60 ? name.substring(0, 60) : name), '${raw['description'] ?? ''}'.trim(), tokens,
          custom: true, author: '${raw['author'] ?? ''}');
      await Skins.saveCustom(skin);
      if (raw['use'] == true) await Skins.set(skin.id);
      _toast(raw['use'] == true ? '${skin.name} saved and in use.' : '${skin.name} saved. Pick it under Settings > Appearance.');
    }
  }

  /// A TMDb picture for Continue Watching: a poster / still path ("/abc.jpg") or an image.tmdb.org address. Anything else is dropped.
  static String _artwork(String v) {
    final x = v.trim();
    if (RegExp(r'^/[A-Za-z0-9_\-]+\.(jpg|jpeg|png|webp)$').hasMatch(x)) return 'https://image.tmdb.org/t/p/w342$x';
    final u = Uri.tryParse(x);
    return (u != null && u.scheme == 'https' && u.host == 'image.tmdb.org') ? x : '';
  }

  void _toast(String text) {
    if (!mounted || text.isEmpty) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(text)));
  }

  // ---------------------------------------------------------------- drawing

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    // A trailer is the first thing in the scrolling page (full width; the top half of the screen on a TV), so it scrolls
    // away with the page instead of staying pinned and squeezing the buttons under it. It is not restarted when the
    // screen is redrawn (same key), and it stops once it has scrolled well out of view.
    final video = (_error == null && _tree != null) ? _findVideo(_tree!) : null;
    final Widget body;
    if (_error != null) {
      body = ListView(padding: widget.padding, children: [
        Text(_error!, style: TextStyle(fontSize: 0.95 * p.rem, height: 1.4, color: t.text)),
        SizedBox(height: p.rem),
        Wrap(children: [PekButton(shrink: true, label: 'Try again', primary: true, autofocus: true, onTap: () => _open(fresh: true))]),
      ]);
    } else if (_tree == null) {
      body = Center(child: CircularProgressIndicator(color: t.accent));
    } else {
      body = LayoutBuilder(builder: (context, box) {
        final heroH = video == null
            ? 0.0
            : (p.isTv ? box.maxHeight * 0.5 : math.min(box.maxWidth * 9 / 16, box.maxHeight * 0.5));
        return ListView(controller: _scroll, padding: EdgeInsets.zero, addAutomaticKeepAlives: false, children: [
          if (video != null)
            SizedBox(
              height: heroH,
              child: Stack(fit: StackFit.expand, children: [
                _PluginTrailer(key: ValueKey('trailer-${video['id']}'), id: '${video['id']}', autoplay: video['autoplay'] == true, muted: video['muted'] == true),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 2.5 * p.rem,
                  child: IgnorePointer(
                    child: DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [t.bg.withAlpha(0), t.bg]))),
                  ),
                ),
              ]),
            ),
          Padding(padding: widget.padding, child: _node(_tree!)),
        ]);
      });
    }
    final bar = (_busy || _pending > 0)
        ? LinearProgressIndicator(minHeight: 3, color: t.accent, backgroundColor: Colors.transparent)
        : const SizedBox(height: 3);
    final content = Column(children: [
      bar,
      if (widget.embedded) Padding(padding: EdgeInsets.fromLTRB(widget.padding.left, 0.5 * p.rem, widget.padding.right, 0), child: const Align(alignment: Alignment.centerRight, child: WeatherBadge())),
      Expanded(child: body),
    ]);
    if (widget.embedded) return content;
    return PopScope(
      canPop: !_back,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _send('back');
      },
      child: content,
    );
  }

  List<Map<String, dynamic>> _kids(Map<String, dynamic> n) => ((n['c'] as List?) ?? const []).whereType<Map<String, dynamic>>().toList();

  Map<String, dynamic>? _findVideo(Map<String, dynamic> n) {
    if (n['t'] == 'video') return n;
    for (final c in _kids(n)) {
      final v = _findVideo(c);
      if (v != null) return v;
    }
    return null;
  }

  bool _af(Map<String, dynamic> n) {
    final k = '${n['af'] ?? ''}';
    return k.isNotEmpty && _autofocused.add(k);
  }

  Widget _node(Map<String, dynamic> n) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final on = '${n['on'] ?? ''}';
    switch ('${n['t']}') {
      case 'column':
        final kids = _kids(n);
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < kids.length; i++) ...[
              if (i > 0) SizedBox(height: 0.75 * rem),
              _node(kids[i]),
            ],
          ],
        );
      case 'row':
        return Wrap(
          spacing: 0.6 * rem,
          runSpacing: 0.6 * rem,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [for (final c in _kids(n)) _node(c)],
        );
      case 'grid':
        return _grid(n);
      case 'video':
        return const SizedBox.shrink(); // drawn as the first item of the list by build()
      case 'text':
        return Text('${n['s'] ?? ''}', softWrap: true, style: TextStyle(fontSize: 0.92 * rem, height: 1.45, color: t.text.withAlpha(230)));
      case 'heading':
        return Padding(
          padding: EdgeInsets.only(top: 0.4 * rem),
          child: Text('${n['s'] ?? ''}', softWrap: true, style: TextStyle(fontSize: (p.compact ? 1.15 : 1.3) * rem, fontWeight: FontWeight.w700, letterSpacing: -0.3, height: 1.2, color: t.text)),
        );
      case 'spinner':
        final label = '${n['s'] ?? ''}';
        final size = (n['big'] == true ? 2.0 : 1.2) * rem;
        // The label is Flexible so a long title wraps onto the next line instead of running off the screen.
        return Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
          SizedBox(width: size, height: size, child: CircularProgressIndicator(strokeWidth: 2.5, color: t.accent)),
          if (label.isNotEmpty) ...[SizedBox(width: 0.7 * rem), Flexible(child: Text(label, style: TextStyle(color: t.textMuted, fontSize: 0.92 * rem, height: 1.3)))],
        ]);
      case 'button':
        final selected = n['sel'] == true;
        return PekButton(
          shrink: true,
          label: '${n['s'] ?? ''}',
          primary: n['primary'] == true || selected,
          leading: selected && n['primary'] != true ? Icon(Icons.check, size: 1.1 * rem, color: t.bg) : null,
          autofocus: _af(n),
          onTap: on.isEmpty ? null : () => _send(on),
        );
      case 'card':
        final sub = '${n['sub'] ?? ''}';
        return PekCard(title: '${n['s'] ?? ''}', subtitle: sub.isEmpty ? null : sub, autofocus: _af(n), onTap: on.isEmpty ? null : () => _send(on));
      case 'listrow':
        return ListRow(title: '${n['s'] ?? ''}', subtitle: '${n['sub'] ?? ''}', autofocus: _af(n), onTap: on.isEmpty ? null : () => _send(on));
      case 'poster':
        final img0 = '${n['img'] ?? ''}';
        final wimg = '${n['wimg'] ?? ''}';
        // On a TV a card that has a landscape picture (backdrop) is drawn 16:9; on a phone it stays a portrait poster.
        final landscape = p.isTv && n['wide'] == true;
        final img = landscape && wimg.isNotEmpty ? wimg : img0;
        final ptitle = '${n['s'] ?? ''}';
        final psub = '${n['sub'] ?? ''}';
        final isMovie = '${n['k'] ?? 'movie'}' == 'movie';
        final pyear = isMovie ? _posterYear(ptitle, psub, (n['yr'] as num?)?.toInt() ?? 0) : 0;
        // Watched marks are the app's job, not the plugin's: the tick follows Watch History and repaints when it changes.
        return ValueListenableBuilder<int>(
          valueListenable: Store.changed,
          builder: (context, _, __) => _PluginPoster(
            title: ptitle,
            sub: psub,
            image: img.isNotEmpty && PluginHosts.allows(_hosts, img) ? img : '',
            landscape: landscape,
            badge: '${n['badge'] ?? ''}',
            watched: isMovie && _posterWatched(ptitle, pyear),
            autofocus: _af(n),
            onTap: on.isEmpty ? null : () => _send(on),
            onLongPress: isMovie ? () => _togglePosterWatched(ptitle, pyear) : null,
          ),
        );
      case 'episode':
        final eimg = '${n['img'] ?? ''}';
        return _PluginEpisode(
          title: '${n['s'] ?? ''}',
          meta: '${n['meta'] ?? ''}',
          text: '${n['text'] ?? ''}',
          image: eimg.isNotEmpty && PluginHosts.allows(_hosts, eimg) ? eimg : '',
          dim: n['dim'] == true,
          autofocus: _af(n),
          onTap: on.isEmpty ? null : () => _send(on),
        );
      case 'tabs':
        final active = '${n['active']}';
        return _SegmentedTabs(
          items: [for (final it in ((n['items'] as List?) ?? const []).whereType<Map<String, dynamic>>()) ('${it['id']}', '${it['label']}')],
          active: active,
          onPick: (id) => _send(on, value: id),
        );
      case 'input':
        final st = _inputs['${n['key']}'];
        if (st == null) return const SizedBox.shrink();
        final submit = '${n['submit'] ?? ''}';
        if ('${n['s'] ?? ''}'.isEmpty) {
          return _DpadEscape(controller: st.controller, child: _SearchBar(
            controller: st.controller,
            hint: '${n['ph'] ?? ''}'.isEmpty ? 'Search' : '${n['ph']}',
            onSubmit: submit.isEmpty ? null : () => _send(submit, value: st.controller.text),
          ));
        }
        return _DpadEscape(controller: st.controller, child: PekField(
          label: '${n['s'] ?? ''}',
          controller: st.controller,
          hint: '${n['ph'] ?? ''}',
          obscure: n['secret'] == true,
          onSubmitted: submit.isEmpty ? null : () => _send(submit, value: st.controller.text),
        ));
      case 'toggle':
        final checked = n['on_'] == true;
        return ToggleRow(title: '${n['s'] ?? ''}', on: checked, onTap: () => _send(on, value: !checked));
      case 'color':
        final hex = '${n['hex'] ?? '#000000'}';
        final col = SkinJson.parseColor(hex) ?? const Color(0xFF000000);
        final withAlpha = n['alpha'] == true;
        return ListRow(
          title: '${n['s'] ?? ''}',
          subtitle: '${n['sub'] ?? ''}  \u00b7  $hex',
          autofocus: _af(n),
          onTap: on.isEmpty
              ? null
              : () async {
                  final c = await pickColor(context, title: '${n['s'] ?? ''}', initial: col, alpha: withAlpha);
                  if (c != null && mounted) _send(on, value: SkinJson.hex(c, alpha: withAlpha));
                },
          trailing: Container(
            width: 2.4 * rem,
            height: 2.4 * rem,
            decoration: BoxDecoration(color: col, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.text.withAlpha(90), width: 1.5)),
          ),
        );
      case 'slider':
        return _PluginSlider(
          label: '${n['s'] ?? ''}',
          value: ((n['v'] as num?) ?? 0).toDouble(),
          min: ((n['min'] as num?) ?? 0).toDouble(),
          max: ((n['max'] as num?) ?? 100).toDouble(),
          unit: '${n['unit'] ?? ''}',
          onDone: on.isEmpty ? null : (v) => _send(on, value: v),
        );
      case 'skinpreview':
        final tk = SkinJson.tokensFrom((n['tokens'] is Map ? Map<String, dynamic>.from(n['tokens'] as Map) : const <String, dynamic>{}));
        return tk == null ? const SizedBox.shrink() : SkinPreview(tokens: tk);
      case 'provider':
        final logo = '${n['logo'] ?? ''}';
        final logoOk = logo.isNotEmpty && PluginHosts.allows(_hosts, logo);
        return PekFocusable(
          onTap: on.isEmpty ? null : () => _send(on),
          radius: 999,
          background: t.surface,
          minHeight: 2.75 * rem,
          padding: EdgeInsets.symmetric(horizontal: 0.8 * rem, vertical: 0.45 * rem),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            if (logoOk)
              Padding(
                padding: EdgeInsets.only(right: 0.55 * rem),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: ArtImage(logo, width: 2 * rem, height: 2 * rem, fit: BoxFit.cover, errorBuilder: (_, __, ___) => SizedBox(width: 2 * rem, height: 2 * rem)),
                ),
              ),
            Flexible(child: Text('${n['s'] ?? ''}', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.95 * rem, fontWeight: FontWeight.w600, color: t.text))),
          ]),
        );
    }
    return const SizedBox.shrink();
  }

  /// `ui.grid`: a wrapping grid, or one sideways-scrolling row of tiles.
  Widget _grid(Map<String, dynamic> n) {
    final p = context.pek;
    final rem = p.rem;
    final kids = _kids(n);
    final gap = (p.compact ? 0.6 : 0.9) * rem;
    if (kids.isEmpty) return const SizedBox.shrink();
    // A grid of landscape cards (TV) is wider per tile and its pictures are 16:9.
    final wide = p.isTv && kids.first['t'] == 'poster' && kids.first['wide'] == true;
    // Landscape cards on a TV are a medium size: 8.5 rem wide (about 6 per row on a 1080p screen). A lone card (the
    // featured one) keeps the size the plugin asked for.
    final minW = wide && kids.length > 1 ? 8.5 * rem : ((n['min'] as num?) ?? 150).toDouble() * rem / 16;
    if (n['scroll'] == true) {
      // Row height = poster (2:3) + caption (title + sub line, scaled with the system text size) + list padding + slack,
      // so the card never overflows by a fraction of a pixel (the yellow/black "BOTTOM OVERFLOWED" stripes).
      final textScale = MediaQuery.textScalerOf(context).scale(1.0);
      return SizedBox(
        height: minW / (wide ? 16 / 9 : 2 / 3) + (0.45 + 0.85 * 1.2 + 0.1 + 0.75 * 1.4 + 0.8 + 0.6) * rem * math.max(1.0, textScale) + 6,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          padding: EdgeInsets.symmetric(vertical: 0.4 * rem, horizontal: 0.3 * rem),
          itemCount: kids.length,
          separatorBuilder: (_, __) => SizedBox(width: gap),
          itemBuilder: (_, i) => Align(alignment: Alignment.topCenter, child: SizedBox(width: minW, child: _node(kids[i]))),
        ),
      );
    }
    return LayoutBuilder(builder: (context, box) {
      var cols = math.max(1, ((box.maxWidth + gap) / (minW + gap)).floor());
      if (wide) cols = cols.clamp(5, 7); // 5 to 7 landscape cards per row
      final w = (box.maxWidth - gap * (cols - 1)) / cols;
      return Wrap(spacing: gap, runSpacing: gap, children: [for (final k in kids) SizedBox(width: w, child: _node(k))]);
    });
  }
}

/// `ui.video`: a YouTube trailer in a web view that can only show www.youtube-nocookie.com (any other address, such
/// as the YouTube logo's link, is refused). It starts by itself when the plugin says so; otherwise the person presses
/// play. On a TV the web view is skipped by the D-pad, so the remote keeps moving through the page.
class _PluginTrailer extends StatefulWidget {
  const _PluginTrailer({super.key, required this.id, required this.autoplay, required this.muted});
  final String id;
  final bool autoplay;
  final bool muted;

  @override
  State<_PluginTrailer> createState() => _PluginTrailerState();
}

class _PluginTrailerState extends State<_PluginTrailer> {
  WebViewController? _controller;

  @override
  void initState() {
    super.initState();
    if (widget.autoplay) _start(play: true);
  }

  void _start({required bool play}) {
    final c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(Colors.black)
      ..setNavigationDelegate(NavigationDelegate(onNavigationRequest: (req) {
        final u = Uri.tryParse(req.url);
        final ok = u != null && u.scheme == 'https' && u.host == 'www.youtube-nocookie.com';
        return ok ? NavigationDecision.navigate : NavigationDecision.prevent;
      }));
    final platform = c.platform;
    if (platform is AndroidWebViewController) {
      unawaited(platform.setMediaPlaybackRequiresUserGesture(false)); // let the trailer start by itself
    }
    // "Error 153 / Video player configuration error" is YouTube refusing an embed that has no referrer. A page loaded from
    // a bare URL sends none, so the player sits in an iframe of a page whose base address is YouTube's own host (the only
    // one the navigation filter above allows) and says where it is embedded from.
    //
    // The trailer plays like a native video: no YouTube controls, title bar, logo, play button or pause / end screens.
    //  - controls=0 / disablekb / fs=0 / iv_load_policy=3 / cc_load_policy=0 switch the player's own UI off.
    //  - The iframe is scaled up 20 % and centred ("cover"), so whatever chrome is left (title strip, logo) falls outside
    //    the clipped area, and it takes no touches (pointer-events:none).
    //  - It stays invisible until the player reports "playing" (so the big play button and thumbnail never show), hides
    //    again if it pauses or ends, and loops.
    const origin = 'https://www.youtube-nocookie.com';
    final id = Uri.encodeComponent(widget.id);
    final q = 'autoplay=${play ? 1 : 0}&mute=${widget.muted ? 1 : 0}&controls=0&disablekb=1&fs=0&iv_load_policy=3&cc_load_policy=0'
        '&playsinline=1&rel=0&modestbranding=1&loop=1&playlist=$id&enablejsapi=1&origin=${Uri.encodeComponent(origin)}';
    const css = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}'
        'iframe{position:absolute;left:50%;top:50%;border:0;pointer-events:none;opacity:0;transition:opacity .4s;'
        'width:calc(max(100vw,177.78vh)*1.2);height:calc(max(56.25vw,100vh)*1.2);transform:translate(-50%,-50%)}'
        'iframe.on{opacity:1}';
    const js = "var f=document.getElementById('f'),got=false;"
        "function post(o){try{f.contentWindow.postMessage(JSON.stringify(o),'*')}catch(e){}}"
        "function listen(){post({event:'listening',id:1,channel:'widget'});"
        "post({event:'command',func:'addEventListener',args:['onStateChange'],id:1,channel:'widget'})}"
        "f.addEventListener('load',function(){var n=0;(function t(){if(got||n++>40)return;listen();setTimeout(t,500)})()});"
        "window.addEventListener('message',function(e){var d;"
        "try{d=typeof e.data==='string'?JSON.parse(e.data):e.data}catch(x){return}"
        "if(!d)return;got=true;var s=d.event==='onStateChange'?d.info:(d.info&&d.info.playerState);"
        "if(s===undefined||s===null)return;"
        "if(s===1)f.className='on';"
        "else if(s===2||s===5||s===-1)f.className='';"
        "else if(s===0){f.className='';post({event:'command',func:'seekTo',args:[0,true]});"
        "post({event:'command',func:'playVideo',args:[]})}});"
        "setTimeout(function(){if(!got)f.className='on'},9000);";
    final html = '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="referrer" content="strict-origin-when-cross-origin">'
        '<style>$css</style></head>'
        '<body><iframe id="f" src="$origin/embed/$id?$q" title="Trailer" referrerpolicy="strict-origin-when-cross-origin" '
        'allow="autoplay; encrypted-media; picture-in-picture" tabindex="-1"></iframe><script>$js</script></body></html>';
    unawaited(c.loadHtmlString(html, baseUrl: '$origin/'));
    _controller = c;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final c = _controller;
    return ClipRect(
      child: ColoredBox(
        color: Colors.black,
        child: c == null
            ? Center(child: PekButton(shrink: true, label: 'Play trailer', primary: true, onTap: () => setState(() => _start(play: true))))
            : ExcludeFocus(excluding: p.tvDevice, child: WebViewWidget(controller: c)),
      ),
    );
  }
}

/// `ui.episodeRow`: the episode's picture (16:9) beside its title, facts and description. An episode that has not aired
/// is dimmed. Without a picture (none on TMDb, or a host the plugin did not list) a plain block stands in for it.
class _PluginEpisode extends StatelessWidget {
  const _PluginEpisode({required this.title, required this.meta, required this.text, required this.image, required this.dim, required this.autofocus, required this.onTap});
  final String title, meta, text, image;
  final bool dim, autofocus;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    Widget blank() => ColoredBox(color: t.bg, child: Center(child: Icon(Icons.play_arrow_rounded, color: t.textMuted, size: 2 * rem)));
    return Opacity(
      opacity: dim ? 0.55 : 1,
      child: PekFocusable(
        autofocus: autofocus,
        onTap: onTap,
        radius: 14,
        background: t.surface,
        padding: EdgeInsets.all(0.6 * rem),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(10),
            child: SizedBox(
              width: (p.compact ? 9.5 : 13) * rem,
              child: AspectRatio(
                aspectRatio: 16 / 9,
                child: image.isEmpty ? blank() : ArtImage(image, fit: BoxFit.cover, cacheWidth: 400, placeholder: (_) => blank(), errorBuilder: (_, __, ___) => blank()),
              ),
            ),
          ),
          SizedBox(width: 0.8 * rem),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, maxLines: p.compact ? null : 2, overflow: p.compact ? TextOverflow.visible : TextOverflow.ellipsis, style: TextStyle(fontSize: 0.95 * rem, fontWeight: FontWeight.w600, height: 1.25, color: t.text)),
              if (meta.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.15 * rem), child: Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.8 * rem, color: t.textMuted))),
              if (text.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.3 * rem), child: Text(text, maxLines: p.compact ? null : 3, overflow: p.compact ? TextOverflow.visible : TextOverflow.ellipsis, style: TextStyle(fontSize: 0.82 * rem, height: 1.35, color: t.textMuted))),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// `ui.posterCard`: a rounded picture with the title and facts underneath, like the library grid. The picture only
/// loads from a host the plugin listed under permissions.network; without one (or when it fails) the tile shows the
/// title on a plain surface.
class _PluginPoster extends StatelessWidget {
  const _PluginPoster({required this.title, required this.sub, required this.image, required this.badge, required this.autofocus, required this.onTap, this.watched = false, this.landscape = false, this.onLongPress});
  final String title, sub, image, badge;
  final bool autofocus;
  final bool watched; // in Watch History: a tick in the corner
  final bool landscape; // TV: 16:9 backdrop card instead of a 2:3 poster
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    Widget plain() => Center(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Text(title, textAlign: TextAlign.center, maxLines: 5, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontWeight: FontWeight.w600, fontSize: 0.9 * rem)),
          ),
        );
    // While the picture is still downloading: a quiet empty tile, so a slow connection does not look like a title with no artwork.
    Widget loading() => Center(child: Icon(Icons.image_outlined, color: t.textMuted.withAlpha(90), size: 2 * rem));
    return PekFocusable(
      autofocus: autofocus,
      onTap: onTap,
      onLongPress: onLongPress,
      focusScale: p.isTv ? 1.07 : 1.03,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AspectRatio(
            aspectRatio: landscape ? 16 / 9 : 2 / 3,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(p.compact ? 12 : 14),
              child: ColoredBox(
                color: t.surface,
                child: Stack(fit: StackFit.expand, children: [
                  if (image.isEmpty)
                    plain()
                  else
                    ArtImage(image, fit: BoxFit.cover, cacheWidth: landscape ? 640 : 400, placeholder: (_) => loading(), errorBuilder: (_, __, ___) => plain()),
                  if (watched)
                    Positioned(
                      top: 6,
                      right: 6,
                      child: Container(
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(color: t.accent, shape: BoxShape.circle),
                        child: Icon(Icons.check, size: 0.95 * rem, color: t.bg),
                      ),
                    ),
                  if (badge.isNotEmpty)
                    Positioned(
                      top: 6,
                      left: 6,
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999)),
                        child: Text(badge, style: TextStyle(fontSize: 0.7 * rem, fontWeight: FontWeight.w700, color: t.bg)),
                      ),
                    ),
                ]),
              ),
            ),
          ),
          SizedBox(height: 0.45 * rem),
          Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.85 * rem, fontWeight: FontWeight.w500, height: 1.2, color: t.text)),
          if (sub.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.1 * rem), child: Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.75 * rem, color: t.textMuted))),
        ],
      ),
    );
  }
}

/// "Saved from plugins" on the Favorites page: titles a plugin screen saved (pek_ui.favorite_add). Pressing one
/// opens the plugin on that title; Remove takes it out. They sync to PEK Cloud with the library favorites.
class PluginFavoritesSection extends StatelessWidget {
  const PluginFavoritesSection({super.key});

  @override
  Widget build(BuildContext context) {
    final favs = Store.pluginFavorites();
    if (favs.isEmpty) return const SizedBox.shrink();
    final p = context.pek;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      SizedBox(height: 1.5 * p.rem),
      Text('Saved from plugins', style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700, color: p.tokens.text)),
      SizedBox(height: 0.6 * p.rem),
      for (final f in favs)
        ListRow(
          title: (f['year'] as num?) != null && (f['year'] as num) > 0 ? '${f['title']} (${f['year']})' : '${f['title']}',
          subtitle: '${f['type'] == 'tv' ? 'TV show' : 'Movie'} \u00b7 opens in ${f['plugin']}',
          onTap: () => openPluginScreen(context, pluginId: '${f['plugin']}', title: '${f['plugin']}', launch: {'type': f['type'], 'id': f['id'], 'title': f['title'], 'year': f['year']}),
          trailing: PekButton(compact: true, label: 'Remove', onTap: () => Store.removePluginFavorite('${f['key']}')),
        ),
    ]);
  }
}


/// `ui.tabs`: a single rounded strip, the chosen tab filled with the accent. It scrolls sideways when there are many
/// (a season list), instead of stacking one full-width button per tab.
class _SegmentedTabs extends StatelessWidget {
  const _SegmentedTabs({required this.items, required this.active, required this.onPick});
  final List<(String, String)> items;
  final String active;
  final void Function(String id) onPick;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      clipBehavior: Clip.none,
      child: Container(
        padding: EdgeInsets.all(0.25 * rem),
        decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(999)),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          for (final it in items)
            PekFocusable(
              onTap: () => onPick(it.$1),
              radius: 999,
              background: it.$1 == active ? t.accent : Colors.transparent,
              focusBackground: it.$1 == active ? t.accent : null,
              padding: EdgeInsets.symmetric(horizontal: (p.isTv ? 1.4 : 1.0) * rem, vertical: (p.isTv ? 0.7 : 0.5) * rem),
              child: Text(it.$2, maxLines: 1, style: TextStyle(fontSize: 0.88 * rem, fontWeight: FontWeight.w600, height: 1.2, color: it.$1 == active ? t.bg : t.text)),
            ),
        ]),
      ),
    );
  }
}

/// A text box with no label is a search bar: one rounded pill, magnifier at the left, clear and search at the right, and
/// the keyboard's search key submits. (A box with a label stays a normal field.)
class _SearchBar extends StatefulWidget {
  const _SearchBar({required this.controller, required this.hint, required this.onSubmit});
  final TextEditingController controller;
  final String hint;
  final VoidCallback? onSubmit;

  @override
  State<_SearchBar> createState() => _SearchBarState();
}

class _SearchBarState extends State<_SearchBar> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_changed);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final empty = widget.controller.text.isEmpty;
    return Container(
      constraints: BoxConstraints(minHeight: (p.isTv ? 3.2 : 2.9) * rem),
      padding: EdgeInsets.only(left: 1.0 * rem, right: 0.35 * rem),
      decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(999)),
      child: Row(children: [
        Icon(Icons.search_rounded, size: 1.3 * rem, color: t.textMuted),
        SizedBox(width: 0.6 * rem),
        Expanded(
          child: TextField(
            controller: widget.controller,
            autocorrect: false,
            enableSuggestions: false,
            textInputAction: TextInputAction.search,
            onSubmitted: widget.onSubmit == null ? null : (_) => widget.onSubmit!(),
            style: TextStyle(color: t.text, fontSize: 0.95 * rem),
            cursorColor: t.accent,
            decoration: InputDecoration(
              isDense: true,
              border: InputBorder.none,
              enabledBorder: InputBorder.none,
              focusedBorder: InputBorder.none,
              filled: false,
              contentPadding: EdgeInsets.symmetric(vertical: 0.7 * rem),
              hintText: widget.hint,
              hintStyle: TextStyle(color: t.textMuted.withAlpha(190), fontSize: 0.95 * rem),
            ),
          ),
        ),
        if (!empty)
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'Clear',
            onPressed: widget.controller.clear,
            icon: Icon(Icons.close_rounded, size: 1.15 * rem, color: t.textMuted),
          ),
        if (widget.onSubmit != null)
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: 'Search',
            onPressed: widget.onSubmit,
            style: IconButton.styleFrom(backgroundColor: t.accent, foregroundColor: t.bg),
            icon: Icon(Icons.arrow_forward_rounded, size: 1.1 * rem),
          ),
      ]),
    );
  }
}


/// `ui.slider`: a number slider. It moves smoothly on its own and tells the plugin once, when the finger lifts.
class _PluginSlider extends StatefulWidget {
  const _PluginSlider({required this.label, required this.value, required this.min, required this.max, required this.unit, this.onDone});
  final String label, unit;
  final double value, min, max;
  final ValueChanged<double>? onDone;

  @override
  State<_PluginSlider> createState() => _PluginSliderState();
}

class _PluginSliderState extends State<_PluginSlider> {
  late double _v = widget.value;

  @override
  void didUpdateWidget(covariant _PluginSlider old) {
    super.didUpdateWidget(old);
    if (old.value != widget.value) _v = widget.value;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final lo = widget.min, hi = widget.max <= widget.min ? widget.min + 1 : widget.max;
    return Row(children: [
      SizedBox(width: 6 * p.rem, child: Text(widget.label, style: TextStyle(color: t.textMuted, fontSize: 0.9 * p.rem))),
      Expanded(
        child: Slider(
          value: _v.clamp(lo, hi).toDouble(),
          min: lo,
          max: hi,
          divisions: (hi - lo).round().clamp(1, 200),
          activeColor: t.accent,
          inactiveColor: t.border,
          label: '${_v.round()}${widget.unit}',
          onChanged: (v) => setState(() => _v = v.roundToDouble()),
          onChangeEnd: widget.onDone == null ? null : (v) => widget.onDone!(v.roundToDouble()),
        ),
      ),
      SizedBox(width: 3.5 * p.rem, child: Text('${_v.round()}${widget.unit}', style: TextStyle(color: t.textMuted))),
    ]);
  }
}


/// A text box takes the arrow keys for its caret, so on a remote the focus got stuck in it. Up and Down always leave the
/// box; Left leaves it when the caret is at the start (or the box is empty) and Right when it is at the end. The move is a
/// normal focus move, so it lands on whatever is next to the box.
class _DpadEscape extends StatelessWidget {
  const _DpadEscape({required this.controller, required this.child});
  final TextEditingController controller;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onKeyEvent: (node, KeyEvent e) {
        if (e is KeyUpEvent) return KeyEventResult.ignored;
        final k = e.logicalKey;
        final sel = controller.selection;
        final atStart = !sel.isValid || (sel.isCollapsed && sel.baseOffset <= 0);
        final atEnd = !sel.isValid || (sel.isCollapsed && sel.baseOffset >= controller.text.length);
        TraversalDirection? d;
        if (k == LogicalKeyboardKey.arrowDown) {
          d = TraversalDirection.down;
        } else if (k == LogicalKeyboardKey.arrowUp) {
          d = TraversalDirection.up;
        } else if (k == LogicalKeyboardKey.arrowLeft && atStart) {
          d = TraversalDirection.left;
        } else if (k == LogicalKeyboardKey.arrowRight && atEnd) {
          d = TraversalDirection.right;
        }
        if (d == null) return KeyEventResult.ignored;
        if (e is KeyDownEvent) FocusManager.instance.primaryFocus?.focusInDirection(d);
        return KeyEventResult.handled;
      },
      child: child,
    );
  }
}
