import 'deep_link.dart';
import 'pin_grid.dart';
import 'plugin_pins.dart';
import 'plugin_updates.dart';
import 'dart:async';

import 'package:flutter/material.dart';

import 'activity.dart';
import 'api.dart' show Api, PluginInfo;
import 'cloud.dart';
import 'common.dart';
import 'dashboard.dart';
import 'library.dart';
import 'layouts.dart';
import 'library_pages.dart';
import 'mpv.dart';
import 'music.dart';
import 'music_mode.dart';
import 'news.dart';
import 'pages.dart';
import 'plugin_backup.dart';
import 'plugin_hooks.dart';
import 'plugin_host.dart' show PluginBack, PluginHost;
import 'plugin_store_ui.dart' show PluginPicture;
import 'plugin_ui.dart';
import 'store.dart';
import 'tokens.dart';
import 'weather.dart' show Weather;
import 'widgets.dart';

/// NAV_ITEMS in app_config.js. Watch History also holds what Resume Watching used to; Updates is the news feed.
const _navItems = <(String, String)>[
  ('dashboard', 'Dashboard'),
  ('movies', 'Movies'),
  ('shows', 'TV Shows'),
  ('music', 'Music'),
  ('updates', 'Updates'),
  ('search', 'Search'),
  ('history', 'Watch History'),
  ('favorites', 'Favorites'),
  ('duplicates', 'Duplicates'),
  ('unknown', 'Unknown'),
  ('plugins', 'Plugins'),
  ('settings', 'Settings'),
];

/// The pages you swipe between on a phone, in order. "More" is a page of its own (not a pop-up sheet): it holds every
/// other screen as a tile, and a tap opens that screen on top.
const _swipePages = ['dashboard', 'movies', 'shows', 'music', 'updates', 'more'];

/// Music mode (Settings > Mode): the same shell with four music pages instead.
const _musicPages = ['mhome', 'msearch', 'mlibrary', 'msettings'];
const _musicNav = <(String, String)>[('mhome', 'Home'), ('msearch', 'Search'), ('mlibrary', 'Your Library'), ('msettings', 'Settings')];
const _swipeIcon = {'dashboard': Icons.home_outlined, 'movies': Icons.movie_outlined, 'shows': Icons.tv_outlined, 'music': Icons.music_note_outlined, 'updates': Icons.campaign_outlined, 'more': Icons.more_horiz, 'mhome': Icons.home_outlined, 'msearch': Icons.search, 'mlibrary': Icons.library_music_outlined, 'msettings': Icons.settings_outlined};
const _swipeLabel = {'dashboard': 'Home', 'movies': 'Movies', 'shows': 'Shows', 'music': 'Music', 'updates': 'Updates', 'more': 'More', 'mhome': 'Home', 'msearch': 'Search', 'mlibrary': 'Your Library', 'msettings': 'Settings'};

/// Everything that is not a swipe page.
const _moreIds = ['search', 'history', 'favorites', 'duplicates', 'unknown', 'plugins', 'settings'];

String _titleOf(String id) => _navItems.firstWhere((e) => e.$1 == id, orElse: () => ('', 'PEK TV')).$2;

/// `.pek-shell`: on phones and tablets the pages sit side by side in a PageView (swipe left / right, or tap the bottom
/// bar); on a TV the left sidebar switches the content, because a remote has no swipe.
class AppShell extends StatefulWidget {
  const AppShell({super.key});
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  final PageController _pager = PageController();
  int _page = 0; // phone: index into _swipePages
  final ValueNotifier<int> _pageN = ValueNotifier(0); // only the tab bar listens, so a swipe does not rebuild every page
  // Music mode is read once: switching it rebuilds the whole shell (main.dart keys it on the mode).
  final bool _music = Store.musicMode;
  String get _home => _music ? 'mhome' : 'dashboard';
  List<String> get _pages => _music ? _musicPages : _swipePages;
  late String _tab = _home; // TV: sidebar selection
  Timer? _syncTimer;
  Timer? _backupTimer;

  // A plugin was installed, updated or removed: back up a moment later (lets a removal reach the cloud first).
  void _backupSoon() {
    _backupTimer?.cancel();
    _backupTimer = Timer(const Duration(seconds: 4), () {
      if (Cloud.linked) unawaited(PluginBackup.run());
    });
  }
  List<PluginInfo> _pluginScreens = const []; // installed plugins that have a Python screen for this UI

  /// Plugin screens the person pinned (Plugins page > Pin), in pin order. The rest are reached through Plugins.
  List<PluginInfo> get _pinnedScreens {
    final pins = PluginPins.all;
    final out = <PluginInfo>[];
    for (final f in pins) {
      final pl = _pluginScreens.where((e) => e.folder == f).firstOrNull;
      if (pl != null) out.add(pl);
    }
    return out;
  }

  /// The menu with one entry per pinned plugin screen, just above Plugins (a plugin's own plugin.json ui.navTab names it).
  List<(String, String)> get _nav {
    if (_music) return _musicNav;
    final i = _navItems.indexWhere((e) => e.$1 == 'plugins');
    return [
      ..._navItems.sublist(0, i),
      for (final pl in _pinnedScreens) ('plugin:${pl.folder}', pl.navTab.isEmpty ? pl.name : pl.navTab),
      ..._navItems.sublist(i),
    ];
  }

  /// Same for the More page (phones): the fixed screens with the Plugins button, then the pinned plugins, then Settings.
  /// Same for the More page (phones): the fixed screens, then the 10 pin slots as tiles of the same size
  /// ('plugin:<folder>' for a pinned plugin, 'pin+:<n>' for an empty slot).
  List<String> get _more {
    final pins = _pinnedScreens;
    return [
      ..._moreIds,
      for (final pl in pins) 'plugin:${pl.folder}',
      for (var i = pins.length; i < PluginPins.max; i++) 'pin+:$i',
    ];
  }

  String _title(String id) {
    if (id.startsWith('plugin:')) {
      final pl = _pluginScreens.where((e) => 'plugin:${e.folder}' == id).firstOrNull;
      if (pl != null) return pl.navTab.isEmpty ? pl.name : pl.navTab;
    }
    return _titleOf(id);
  }

  /// Plugins that have a Python screen: one menu entry each. Reloaded when the store installs or removes one.
  void _loadPluginScreens() {
    Activity.begin('plugins', 'Loading plugins\u2026', detail: true);
    Api.plugins().then((l) {
      Activity.end('plugins', 'Loaded ${l.length} plugins');
      PluginHost.streamers = [for (final e in l) if (e.flutterScreen && (e.streamer || e.liveProvider)) {'id': e.folder, 'name': e.name, 'stream': e.streamer ? 'true' : 'false', 'live': e.liveProvider ? 'true' : 'false'}];
      if (mounted) setState(() => _pluginScreens = l.where((e) => e.flutterScreen).toList());
    }).catchError((_) {
      Activity.end('plugins');
    });
  }

  void _pinsChanged() {
    if (mounted) setState(() {});
  }

  Timer? _weatherTimer;
  void _weatherSoon() {
    if (!Cloud.linked) return;
    _weatherTimer?.cancel();
    _weatherTimer = Timer(const Duration(seconds: 2), () => unawaited(Cloud.sync(light: true)));
  }

  @override
  void initState() {
    super.initState();
    if (!_music) {
      // Music mode shows no plugin screens and starts no video plugin hooks (Trakt import and the like).
      _loadPluginScreens();
      PluginUpdates.checkOnStartup(); // built-in plugins update from the PEK Store, GitHub ones are offered an update
      Future<void>.delayed(const Duration(seconds: 6), PluginHooks.appStart); // plugins with hooks (Trakt import); once per run
    }
    PluginHost.changed.addListener(_loadPluginScreens);
    PluginPins.changed.addListener(_pinsChanged);
    Store.profile.addListener(_pinsChanged);
    if (!_music) {
      News.loadCache();
      unawaited(News.refresh()); // the unread dot on Updates
    }
    unawaited(DeepLink.start()); // the website's "back to the app" link after creating an account
    // Cloud sync: once at the start, then every 5 minutes when something changed on this device.
    if (Cloud.linked) {
      unawaited(Cloud.sync());
      unawaited(PluginBackup.run());
    }
    _syncTimer = Timer.periodic(const Duration(minutes: 5), (_) {
      if (Cloud.linked) {
        unawaited(Cloud.sync(light: !Cloud.hasLocalChanges()));
        unawaited(PluginBackup.run()); // cheap when nothing changed: file sizes and times only
      }
    });
    PluginHost.changed.addListener(_backupSoon); // installed / updated here: back it up
    Weather.edited.addListener(_weatherSoon); // a new city / unit: send it to the profile
    Layouts.edited.addListener(_weatherSoon); // a new layout / poster size: same
    Store.dashEdited.addListener(_weatherSoon); // a changed dashboard: same
    Cloud.changes.addListener(_backupSoon); // just signed in: back up what is installed
  }

  @override
  void dispose() {
    PluginHost.changed.removeListener(_loadPluginScreens);
    PluginPins.changed.removeListener(_pinsChanged);
    Store.profile.removeListener(_pinsChanged);
    PluginHost.changed.removeListener(_backupSoon);
    Weather.edited.removeListener(_weatherSoon);
    Layouts.edited.removeListener(_weatherSoon);
    Store.dashEdited.removeListener(_weatherSoon);
    _weatherTimer?.cancel();
    Cloud.changes.removeListener(_backupSoon);
    _backupTimer?.cancel();
    _syncTimer?.cancel();
    _pageN.dispose();
    _pager.dispose();
    super.dispose();
  }

  /// Opens a screen: on a TV it replaces the content, on a phone swipe pages scroll to it and the rest open on top.
  void _open(String id) {
    final p = context.pek;
    if (p.sidebar) {
      setState(() => _tab = id);
      return;
    }
    final i = _pages.indexOf(id);
    if (i >= 0) {
      _goTo(i);
      return;
    }
    Navigator.push(context, MaterialPageRoute<void>(builder: (c) => SubScreen(title: _title(id), body: _body(c, id))));
  }

  void _goTo(int i) {
    if (_pager.hasClients) {
      _pager.animateToPage(i, duration: const Duration(milliseconds: 260), curve: Curves.easeOutCubic);
    }
  }

  Future<void> _askExit() async {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final yes = await showDialog<bool>(
      context: context,
      barrierColor: t.overlay,
      builder: (c) => Dialog(
        backgroundColor: t.glassStrong,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius), side: BorderSide(color: t.border)),
        child: Padding(
          padding: EdgeInsets.all(1.5 * rem),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Are you sure you want to exit?', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
              SizedBox(height: 0.75 * rem),
              Text('PEK TV will stop running and its temporary cache will be cleared.', style: TextStyle(color: t.textMuted)),
              SizedBox(height: 1.25 * rem),
              Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
                PekButton(label: 'Yes, exit', primary: true, onTap: () => Navigator.pop(c, true)),
                PekButton(label: 'Close', autofocus: true, onTap: () => Navigator.pop(c, false)),
              ]),
            ],
          ),
        ),
      ),
    );
    if (yes == true) await PekPlayer.exitApp();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (PluginBack.handle()) return; // a plugin screen on the TV that is inside one of its own pages
        // Back: leave a secondary screen / any other page for the first page, then ask before exiting.
        if (p.sidebar ? _tab != _home : _page != 0) {
          if (p.sidebar) {
            setState(() => _tab = _home);
          } else {
            _goTo(0);
          }
        } else {
          _askExit();
        }
      },
      child: Material(color: p.tokens.bg, child: p.sidebar ? _tv(context) : _phone(context)),
    );
  }

  // ---------------------------------------------------------------- the content of one screen

  Widget _body(BuildContext context, String id) {
    final pad = context.pek.pagePad;
    if (id.startsWith('plugin:')) {
      return PluginView(key: ValueKey(id), pluginId: id.substring(7), padding: pad, embedded: context.pek.sidebar, onExit: () => setState(() => _tab = 'dashboard'));
    }
    switch (id) {
      case 'mhome':
        return MusicHomePage(padding: pad, onOpenLibrary: () => _open('mlibrary'));
      case 'msearch':
        return MusicPage(padding: pad, title: 'Search', view: MusicView.search);
      case 'mlibrary':
        return MusicPage(padding: pad, title: 'Your Library', view: MusicView.library);
      case 'msettings':
        return SettingsPage(padding: pad);
      case 'dashboard':
        return DashboardPage(padding: pad, onOpenResume: () => _open('history'), onOpenFavorites: () => _open('favorites'), onOpenMusic: () => _open('music'));
      case 'movies':
      case 'shows':
        return LibraryPage(key: ValueKey(id), tab: id, title: _titleOf(id), padding: pad);
      case 'music':
        return MusicPage(padding: pad);
      case 'more':
        return _MorePage(
          padding: pad,
          onOpen: _open,
          ids: _more,
          pinned: _pinnedScreens,
          available: _pluginScreens,
          titleOf: _title,
          icons: {for (final pl in _pluginScreens) if (pl.icon.isNotEmpty) 'plugin:${pl.folder}': pl.icon},
          hints: {for (final pl in _pluginScreens) 'plugin:${pl.folder}': pl.description},
        );
      case 'search':
        return SearchPage(padding: pad);
      case 'history':
        return HistoryPage(padding: pad);
      case 'updates':
        return UpdatesPage(padding: pad, markSeen: context.pek.sidebar);
      case 'favorites':
        return FavoritesPage(padding: pad);
      case 'duplicates':
        return DuplicatesPage(padding: pad);
      case 'unknown':
        return UnknownPage(padding: pad);
      case 'plugins':
        return PluginsPage(padding: pad);
      case 'settings':
        return SettingsPage(padding: pad);
    }
    return const SizedBox.shrink();
  }

  // ---------------------------------------------------------------- phone / tablet: swipe pages + bottom bar

  Widget _phone(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final bottom = MediaQuery.paddingOf(context).bottom;
    final bar = Container(
      padding: EdgeInsets.only(bottom: bottom),
      decoration: BoxDecoration(color: t.bgElevated, border: Border(top: BorderSide(color: t.border))),
      child: IntrinsicHeight(
        child: ValueListenableBuilder<int>(
          valueListenable: _pageN,
          builder: (context, page, _) => Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var i = 0; i < _pages.length; i++)
                Expanded(child: _BarItem(label: _swipeLabel[_pages[i]]!, icon: _swipeIcon[_pages[i]]!, active: i == page, badge: _pages[i] == 'updates', onTap: () => _goTo(i))),
            ],
          ),
        ),
      ),
    );
    return Column(
      children: [
        Expanded(
          child: PageView(
            controller: _pager,
            // The neighbouring pages are built while the current one is idle, so a swipe only has to slide them in.
            allowImplicitScrolling: true,
            onPageChanged: (i) {
              _page = i;
              _pageN.value = i;
              if (_pages[i] == 'updates') unawaited(News.markAllSeen()); // swiped to Updates: everything counts as read
            },
            children: [for (final id in _pages) RepaintBoundary(child: _KeepAlive(child: _body(context, id)))],
          ),
        ),
        const MiniPlayer(),
        bar,
      ],
    );
  }

  // ---------------------------------------------------------------- TV: sidebar + content

  Widget _tv(BuildContext context) => ListenableBuilder(listenable: Layouts.changes, builder: (context, _) => _tvLayout(context));

  Widget _tvLayout(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final content = Expanded(child: Column(children: [Expanded(child: KeyedSubtree(key: ValueKey(_tab), child: _body(context, _tab))), const MiniPlayer()]));
    if (Layouts.id == 'topbar') {
      // Menu across the top, like Arctic.
      final bar = Container(
        padding: EdgeInsets.fromLTRB(rem + p.safeX, 0.75 * rem + p.safeY, rem + p.safeX, 0.75 * rem),
        decoration: BoxDecoration(color: t.bgElevated, border: Border(bottom: BorderSide(color: t.border))),
        child: Row(children: [
          Padding(padding: EdgeInsets.only(right: 1.5 * rem), child: Text(_music ? 'PEK Music' : 'PEK TV', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700, color: t.accent))),
          Expanded(
            child: SizedBox(
              height: 3 * rem,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _nav.length,
                separatorBuilder: (_, __) => SizedBox(width: 0.5 * rem),
                itemBuilder: (_, i) => _NavItem(
                  label: _nav[i].$2,
                  active: _nav[i].$1 == _tab,
                  autofocus: _nav[i].$1 == _tab,
                  onTap: () => setState(() => _tab = _nav[i].$1),
                ),
              ),
            ),
          ),
        ]),
      );
      return Column(children: [bar, content]);
    }
    final slim = Layouts.id == 'wall' || Layouts.id == 'compact';
    final sidebar = Container(
      width: (slim ? 11 : 14) * rem,
      padding: EdgeInsets.fromLTRB(rem + p.safeX, 1.5 * rem + p.safeY, rem, 1.5 * rem + p.safeY),
      decoration: BoxDecoration(color: t.bgElevated, border: Border(right: BorderSide(color: t.border))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: EdgeInsets.only(left: 0.5 * rem, bottom: 2 * rem),
            child: Text(_music ? 'PEK Music' : 'PEK TV', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700, color: t.accent)),
          ),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.all(4),
              itemCount: _nav.length,
              separatorBuilder: (_, __) => SizedBox(height: (Layouts.id == 'compact' ? 0.3 : 0.5) * rem),
              itemBuilder: (_, i) => _NavItem(
                label: _nav[i].$2,
                active: _nav[i].$1 == _tab,
                autofocus: _nav[i].$1 == _tab,
                onTap: () => setState(() => _tab = _nav[i].$1),
              ),
            ),
          ),
          Container(
            padding: EdgeInsets.only(top: rem),
            decoration: BoxDecoration(border: Border(top: BorderSide(color: t.border))),
            child: Text('System Online', style: TextStyle(fontSize: 0.85 * rem, color: t.textMuted)),
          ),
        ],
      ),
    );
    return Row(children: [sidebar, content]);
  }
}

/// Keeps a swipe page built while it is off screen, so scroll position and loaded posters survive a swipe away and back.
class _KeepAlive extends StatefulWidget {
  const _KeepAlive({required this.child});
  final Widget child;
  @override
  State<_KeepAlive> createState() => _KeepAliveState();
}

class _KeepAliveState extends State<_KeepAlive> with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return widget.child;
  }
}

/// The "More" page: every screen that is not a swipe page, as tiles.
class _MorePage extends StatelessWidget {
  const _MorePage({required this.padding, required this.onOpen, required this.ids, required this.titleOf, this.pinned = const [], this.available = const [], this.hints = const {}, this.icons = const {}});
  final EdgeInsets padding;
  final void Function(String id) onOpen;
  final List<String> ids;
  final List<PluginInfo> pinned; // plugin screens on the pin board
  final List<PluginInfo> available; // every installed plugin screen (what the board's + slots offer)
  final String Function(String id) titleOf;
  final Map<String, String> hints; // plugin screens: their description
  final Map<String, String> icons; // plugin screens: the address of their picture (plugin.json "icon")

  static const _hint = {
    'search': 'Titles, actors, genres, years',
    'history': 'Pick up where you stopped, and everything you finished',
    'favorites': 'Your saved movies and shows',
    'duplicates': 'Files that appear twice',
    'unknown': 'Files PEK TV could not sort',
    'plugins': 'Installed plugins',
    'settings': 'Sources and app options',
  };

  Widget _pinTile(BuildContext context, String id, double rem, PekScope p) {
    final pl = pinned.firstWhere((e) => 'plugin:${e.folder}' == id);
    return PinTile(
      title: titleOf(id),
      subtitle: pl.description,
      fill: pl.icon.isEmpty ? null : PluginPicture(url: pl.icon, expand: true),
      leading: pl.icon.isEmpty ? SizedBox(width: 3.4 * rem, height: 3.4 * rem, child: Icon(Icons.extension_outlined, size: 2.2 * rem, color: p.tokens.textMuted)) : null,
      onTap: () => onOpen(id),
      onLongPress: () => PinActions.menu(context, pl, (_) => onOpen(id)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final cols = p.size.width >= 600 ? 3 : 2;
    final gap = 0.75 * rem;
    // Every tile is the same height: a title of up to 2 lines + a description of up to 3 lines (longer text is cut with "...").
    final tileH = (p.compact ? 0.75 : 1.5) * 2 * rem + 1.1 * rem * 1.3 * 2 + 0.5 * rem + 0.92 * rem * 1.35 * 3 + 2;

    Widget grid(List<String> list) {
      final rows = (list.length / cols).ceil();
      return Column(children: [
        for (var r = 0; r < rows; r++) ...[
          // A thin line between rows and between the two columns, so each button reads as its own.
          if (r > 0) ThinDivider(vertical: gap / 2),
          SizedBox(
              height: tileH,
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (var c = 0; c < cols; c++) ...[
                  if (c > 0) Padding(padding: EdgeInsets.symmetric(horizontal: gap / 2), child: SizedBox(width: 1, child: ColoredBox(color: p.tokens.textMuted.withAlpha(60)))),
                  Expanded(
                    child: r * cols + c < list.length && list[r * cols + c].startsWith('pin+:')
                        ? PinTile(onTap: () => PinActions.pick(context, available))
                        : r * cols + c < list.length && pinned.any((e) => 'plugin:${e.folder}' == list[r * cols + c])
                            ? _pinTile(context, list[r * cols + c], rem, p)
                            : r * cols + c < list.length
                        ? PekCard(
                            title: titleOf(list[r * cols + c]),
                            leading: list[r * cols + c].startsWith('plugin:')
                                ? (icons[list[r * cols + c]] == null
                                    ? SizedBox(width: 3.4 * rem, height: 3.4 * rem, child: Icon(Icons.extension_outlined, size: 2.2 * rem, color: p.tokens.textMuted))
                                    : PluginPicture(url: icons[list[r * cols + c]]!, size: 3.4 * rem))
                                : null,
                            subtitle: _hint[list[r * cols + c]] ?? hints[list[r * cols + c]],
                            titleMaxLines: 2,
                            subtitleMaxLines: 3,
                            onTap: () => onOpen(list[r * cols + c]),
                          )
                        : const SizedBox.shrink(),
                  ),
                ],
              ]),
            ),
        ],
      ]);
    }

    return ListView(
      padding: padding,
      children: [
        const Heading('More', weather: true),
        grid(ids),
      ],
    );
  }
}

/// `.nav-item` in the sidebar (and in the phone "More" sheet).
class _NavItem extends StatelessWidget {
  const _NavItem({required this.label, required this.active, required this.onTap, this.autofocus = false, this.center = false});
  final String label;
  final bool active;
  final bool autofocus;
  final bool center;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return PekFocusable(
      autofocus: autofocus,
      onTap: onTap,
      radius: 12,
      background: active ? t.surfaceFocused : null,
      child: Stack(
        children: [
          Padding(
            padding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.7 * rem),
            child: SizedBox(
              width: double.infinity,
              child: Text(
                label,
                textAlign: center ? TextAlign.center : TextAlign.start,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: rem, fontWeight: active ? FontWeight.w600 : FontWeight.w500, color: active ? t.text : t.textMuted),
              ),
            ),
          ),
          if (active)
            Positioned.fill(
              child: Align(
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  heightFactor: 0.52,
                  child: Container(
                    width: 3,
                    decoration: BoxDecoration(color: t.accent, borderRadius: const BorderRadius.horizontal(right: Radius.circular(3))),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// `.bb-item` in the phone tab bar: an icon over a small label; the active item is bright, the rest are muted.
class _BarItem extends StatelessWidget {
  const _BarItem({required this.label, required this.icon, required this.active, required this.onTap, this.badge = false});
  final bool badge; // shows a dot while there are unread Updates
  final String label;
  final IconData icon;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final c = active ? t.text : t.textMuted;
    return PekFocusable(
      onTap: onTap,
      minHeight: 58,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (badge)
            ValueListenableBuilder<int>(
              valueListenable: News.unread,
              builder: (context, n, _) => Stack(clipBehavior: Clip.none, children: [
                Icon(icon, size: 22, color: c),
                if (n > 0) Positioned(right: -3, top: -1, child: Container(width: 9, height: 9, decoration: BoxDecoration(color: t.accent, shape: BoxShape.circle))),
              ]),
            )
          else
            Icon(icon, size: 22, color: c),
          const SizedBox(height: 3),
          Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.68 * p.rem, fontWeight: active ? FontWeight.w600 : FontWeight.w500, color: c)),
        ],
      ),
    );
  }
}

/// `h1.content-title`: 2rem.
class PageTitle extends StatelessWidget {
  const PageTitle(this.title, {super.key});
  final String title;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return Padding(
      padding: EdgeInsets.only(bottom: (p.isTv ? 2 : 1.5) * p.rem),
      child: Text(title, style: TextStyle(fontSize: 2.1 * p.rem, fontWeight: FontWeight.w700, letterSpacing: -0.6, height: 1.1)),
    );
  }
}
