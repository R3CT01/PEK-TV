import 'package:flutter/material.dart';

import 'library.dart';
import 'mpv.dart';
import 'tokens.dart';
import 'widgets.dart';

/// NAV_ITEMS in app_config.js. "Resume Watching" and "Watch History" are inserted by the web UI once there is something to show;
/// they come with those screens.
const _navItems = <(String, String)>[
  ('dashboard', 'Dashboard'),
  ('movies', 'Movies'),
  ('shows', 'TV Shows'),
  ('music', 'Music'),
  ('favorites', 'Favorites'),
  ('duplicates', 'Duplicates'),
  ('unknown', 'Unknown'),
  ('plugins', 'Plugins'),
  ('settings', 'Settings'),
];

/// PHONE_PRIMARY_TABS and BB_LABEL in app.js / app_config.js.
const _phonePrimary = ['dashboard', 'movies', 'shows', 'music'];
const _bbLabel = {'dashboard': 'Home', 'shows': 'Shows'};

/// `.pek-shell`: sidebar + content on wide screens (TVs, tablets), content + bottom tab bar on phones (width <= 720).
class AppShell extends StatefulWidget {
  const AppShell({super.key});
  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  String _tab = 'dashboard';
  bool _moreOpen = false;

  void _select(String id) => setState(() {
        _tab = id;
        _moreOpen = false;
      });

  String get _label => _navItems.firstWhere((e) => e.$1 == _tab, orElse: () => ('', 'PEK TV')).$2;

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
        if (_moreOpen) {
          setState(() => _moreOpen = false);
        } else if (_tab != 'dashboard') {
          _select('dashboard');
        } else {
          _askExit();
        }
      },
      child: Material(
        color: p.tokens.bg,
        child: p.narrow ? _phone(context) : _wide(context),
      ),
    );
  }

  // ---------------------------------------------------------------- wide: sidebar + content

  Widget _wide(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    // style.css: .pek-sidebar 260px / 14rem on TV, padding 1.5rem 1rem; the TV adds the safe margins.
    final sidebar = Container(
      width: p.isTv ? 14 * rem : 260,
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
              separatorBuilder: (_, __) => SizedBox(height: 0.5 * rem),
              itemBuilder: (_, i) => _NavItem(
                label: _navItems[i].$2,
                active: _navItems[i].$1 == _tab,
                autofocus: p.isTv && _navItems[i].$1 == _tab,
                onTap: () => _select(_navItems[i].$1),
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
    return Row(children: [sidebar, Expanded(child: _content(context))]);
  }

  // ---------------------------------------------------------------- phone: content + bottom bar

  Widget _phone(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final bottom = MediaQuery.paddingOf(context).bottom;
    final more = _navItems.where((e) => !_phonePrimary.contains(e.$1)).toList();
    final moreActive = more.any((e) => e.$1 == _tab);
    final bar = Container(
      padding: EdgeInsets.only(bottom: bottom),
      decoration: BoxDecoration(color: t.bgElevated, border: Border(top: BorderSide(color: t.border))),
      child: IntrinsicHeight(
       child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final id in _phonePrimary)
            Expanded(
              child: _BarItem(
                label: _bbLabel[id] ?? _navItems.firstWhere((e) => e.$1 == id).$2,
                active: id == _tab && !_moreOpen,
                onTap: () => _select(id),
              ),
            ),
          Expanded(
            child: _BarItem(label: 'More', active: moreActive || _moreOpen, onTap: () => setState(() => _moreOpen = !_moreOpen)),
          ),
        ],
       ),
      ),
    );
    return Stack(
      children: [
        Column(children: [Expanded(child: _content(context)), bar]),
        if (_moreOpen) ...[
          Positioned.fill(
            child: GestureDetector(behavior: HitTestBehavior.opaque, onTap: () => setState(() => _moreOpen = false), child: ColoredBox(color: t.overlay)),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 56 + bottom,
            child: Container(
              padding: EdgeInsets.all(0.75 * p.rem),
              decoration: BoxDecoration(
                color: t.bgElevated,
                border: Border(top: BorderSide(color: t.border)),
                borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
              ),
              child: Wrap(
                spacing: 0.5 * p.rem,
                runSpacing: 0.5 * p.rem,
                children: [
                  for (final e in more)
                    SizedBox(
                      width: (p.size.width - 1.5 * p.rem - 0.5 * p.rem) / 2,
                      child: _NavItem(label: e.$2, active: e.$1 == _tab, center: true, onTap: () => _select(e.$1)),
                    ),
                ],
              ),
            ),
          ),
        ],
      ],
    );
  }

  // ---------------------------------------------------------------- content pane

  Widget _content(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    // .pek-content: padding 2.5rem; 1rem on phones; the TV adds the safe margins (top/bottom 2rem + safe-y, right 2.5rem + safe-x).
    final EdgeInsets pad = p.narrow
        ? EdgeInsets.all(rem)
        : p.isTv
            ? EdgeInsets.fromLTRB(2.5 * rem, 2 * rem + p.safeY, 2.5 * rem + p.safeX, 2 * rem + p.safeY)
            : EdgeInsets.all(2.5 * rem);
    if (_tab == 'movies' || _tab == 'shows') {
      return LibraryPage(key: ValueKey(_tab), tab: _tab, title: _label, padding: pad);
    }
    return _Placeholder(key: ValueKey(_tab), title: _label, padding: pad);
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

/// Screens that are not in the Flutter UI yet. The web UI still has them: one tap opens it for this session.
class _Placeholder extends StatelessWidget {
  const _Placeholder({super.key, required this.title, required this.padding});
  final String title;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    return SingleChildScrollView(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PageTitle(title),
          const PekCard(title: 'Not in the Flutter UI yet', subtitle: 'This screen is still in the classic UI.'),
          SizedBox(height: 1.25 * rem),
          PekButton(label: 'Open classic UI', primary: true, onTap: PekPlayer.classicUi),
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
