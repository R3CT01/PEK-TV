import 'dart:async';

import 'package:flutter/material.dart';

import 'cloud.dart';
import 'common.dart';
import 'dashboard.dart';
import 'library.dart';
import 'layouts.dart';
import 'library_pages.dart';
import 'mpv.dart';
import 'music.dart';
import 'pages.dart';
import 'tokens.dart';
import 'torrent.dart';
import 'widgets.dart';

/// NAV_ITEMS in app_config.js, plus Resume Watching (the web UI only inserts it once there is something to resume).
const _navItems = <(String, String)>[
  ('dashboard', 'Dashboard'),
  ('movies', 'Movies'),
  ('shows', 'TV Shows'),
  ('music', 'Music'),
  ('search', 'Search'),
  ('resume', 'Resume Watching'),
  ('history', 'Watch History'),
  ('favorites', 'Favorites'),
  ('duplicates', 'Duplicates'),
  ('unknown', 'Unknown'),
  ('torrents', 'Torrents'),
  ('plugins', 'Plugins'),
  ('settings', 'Settings'),
];

/// The pages you swipe between on a phone, in order. "More" is a page of its own (not a pop-up sheet): it holds every
/// other screen as a tile, and a tap opens that screen on top.
const _swipePages = ['dashboard', 'movies', 'shows', 'music', 'more'];
const _swipeLabel = {'dashboard': 'Home', 'movies': 'Movies', 'shows': 'Shows', 'music': 'Music', 'more': 'More'};

/// Everything that is not a swipe page.
const _moreIds = ['search', 'resume', 'history', 'favorites', 'duplicates', 'unknown', 'torrents', 'plugins', 'settings'];

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
  String _tab = 'dashboard'; // TV: sidebar selection
  Timer? _syncTimer;

  @override
  void initState() {
    super.initState();
    // Cloud sync: once at the start, then every 5 minutes when something changed on this device.
    if (Cloud.linked) unawaited(Cloud.sync());
    _syncTimer = Timer.periodic(const Duration(minutes: 5), (_) {
      if (Cloud.linked) unawaited(Cloud.sync(light: !Cloud.hasLocalChanges()));
    });
  }

  @override
  void dispose() {
    _syncTimer?.cancel();
    _pager.dispose();
    super.dispose();
  }

  /// Opens a screen: on a TV it replaces the content, on a phone swipe pages scroll to it and the rest open on top.
  void _open(String id) {
    final p = context.pek;
    if (p.isTv) {
      setState(() => _tab = id);
      return;
    }
    final i = _swipePages.indexOf(id);
    if (i >= 0) {
      _goTo(i);
      return;
    }
    Navigator.push(context, MaterialPageRoute<void>(builder: (c) => SubScreen(title: _titleOf(id), body: _body(c, id))));
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
        // Back: leave a secondary screen / any other page for the first page, then ask before exiting.
        if (p.isTv ? _tab != 'dashboard' : _page != 0) {
          if (p.isTv) {
            setState(() => _tab = 'dashboard');
          } else {
            _goTo(0);
          }
        } else {
          _askExit();
        }
      },
      child: Material(color: p.tokens.bg, child: p.isTv ? _tv(context) : _phone(context)),
    );
  }

  // ---------------------------------------------------------------- the content of one screen

  Widget _body(BuildContext context, String id) {
    final pad = context.pek.pagePad;
    switch (id) {
      case 'dashboard':
        return DashboardPage(padding: pad, onOpenResume: () => _open('resume'), onOpenFavorites: () => _open('favorites'));
      case 'movies':
      case 'shows':
        return LibraryPage(key: ValueKey(id), tab: id, title: _titleOf(id), padding: pad);
      case 'music':
        return MusicPage(padding: pad);
      case 'more':
        return _MorePage(padding: pad, onOpen: _open);
      case 'search':
        return SearchPage(padding: pad);
      case 'history':
        return HistoryPage(padding: pad);
      case 'resume':
        return ResumePage(padding: pad);
      case 'favorites':
        return FavoritesPage(padding: pad);
      case 'duplicates':
        return DuplicatesPage(padding: pad);
      case 'unknown':
        return UnknownPage(padding: pad);
      case 'torrents':
        return TorrentsPage(padding: pad);
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
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (var i = 0; i < _swipePages.length; i++)
              Expanded(child: _BarItem(label: _swipeLabel[_swipePages[i]]!, active: i == _page, onTap: () => _goTo(i))),
          ],
        ),
      ),
    );
    return Column(
      children: [
        Expanded(
          child: PageView(
            controller: _pager,
            onPageChanged: (i) => setState(() => _page = i),
            children: [for (final id in _swipePages) _KeepAlive(child: _body(context, id))],
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
          Padding(padding: EdgeInsets.only(right: 1.5 * rem), child: Text('PEK TV', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700, color: t.accent))),
          Expanded(
            child: SizedBox(
              height: 3 * rem,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                itemCount: _navItems.length,
                separatorBuilder: (_, __) => SizedBox(width: 0.5 * rem),
                itemBuilder: (_, i) => _NavItem(
                  label: _navItems[i].$2,
                  active: _navItems[i].$1 == _tab,
                  autofocus: _navItems[i].$1 == _tab,
                  onTap: () => setState(() => _tab = _navItems[i].$1),
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
            child: Text('PEK TV', style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700, color: t.accent)),
          ),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.all(4),
              itemCount: _navItems.length,
              separatorBuilder: (_, __) => SizedBox(height: (Layouts.id == 'compact' ? 0.3 : 0.5) * rem),
              itemBuilder: (_, i) => _NavItem(
                label: _navItems[i].$2,
                active: _navItems[i].$1 == _tab,
                autofocus: _navItems[i].$1 == _tab,
                onTap: () => setState(() => _tab = _navItems[i].$1),
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
  const _MorePage({required this.padding, required this.onOpen});
  final EdgeInsets padding;
  final void Function(String id) onOpen;

  static const _hint = {
    'search': 'Titles, actors, genres, years',
    'history': 'Everything you finished watching',
    'resume': 'Pick up where you stopped',
    'favorites': 'Your saved movies and shows',
    'duplicates': 'Files that appear twice',
    'unknown': 'Files PEK TV could not sort',
    'torrents': 'Play a magnet or .torrent link',
    'plugins': 'Installed plugins',
    'settings': 'Sources and app options',
  };

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final cols = p.size.width >= 600 ? 3 : 2;
    final gap = 0.75 * rem;
    final rows = (_moreIds.length / cols).ceil();
    return ListView(
      padding: padding,
      children: [
        const Heading('More'),
        for (var r = 0; r < rows; r++)
          Padding(
            padding: EdgeInsets.only(bottom: gap),
            child: IntrinsicHeight(
              child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (var c = 0; c < cols; c++) ...[
                  if (c > 0) SizedBox(width: gap),
                  Expanded(
                    child: r * cols + c < _moreIds.length
                        ? PekCard(title: _titleOf(_moreIds[r * cols + c]), subtitle: _hint[_moreIds[r * cols + c]], onTap: () => onOpen(_moreIds[r * cols + c]))
                        : const SizedBox.shrink(),
                  ),
                ],
              ]),
            ),
          ),
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
      borderColor: active ? t.border : Colors.transparent,
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

/// `.bb-item` in the phone tab bar: an accent tab on top of the active item.
class _BarItem extends StatelessWidget {
  const _BarItem({required this.label, required this.active, required this.onTap});
  final String label;
  final bool active;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    return PekFocusable(
      onTap: onTap,
      minHeight: 56,
      child: Stack(
        alignment: Alignment.topCenter,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: active ? 2 * p.rem : 0,
            height: 3,
            decoration: BoxDecoration(color: t.accent, borderRadius: const BorderRadius.vertical(bottom: Radius.circular(3))),
          ),
          Positioned.fill(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2.4),
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 0.72 * p.rem, fontWeight: active ? FontWeight.w600 : FontWeight.w500, color: active ? t.accent : t.textMuted, letterSpacing: 0.01 * 0.72 * p.rem),
                ),
              ),
            ),
          ),
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
      child: Text(title, style: TextStyle(fontSize: 2 * p.rem, fontWeight: FontWeight.w700)),
    );
  }
}
