import 'package:flutter/material.dart';

import 'music.dart' show MiniPlayer;
import 'music_controller.dart';
import 'tokens.dart';
import 'weather.dart' show WeatherBadge, weatherActions;
import 'widgets.dart';

extension PekPad on PekScope {
  /// `.pek-content` padding: 2.5rem; 1rem on phones; the TV adds the safe margins.
  EdgeInsets get pagePad => narrow
      ? EdgeInsets.fromLTRB(1.25 * rem, rem, 1.25 * rem, rem)
      : isTv
          ? EdgeInsets.fromLTRB(2.5 * rem, 2 * rem + safeY, 2.5 * rem + safeX, 2 * rem + safeY)
          : EdgeInsets.all(2.5 * rem);
}

/// `h1.content-title`.
class Heading extends StatelessWidget {
  const Heading(this.title, {super.key, this.trailing, this.weather = false});
  final String title;
  final Widget? trailing;

  /// The weather pill, pinned to the top right of the header (main pages only).
  final bool weather;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return Padding(
      padding: EdgeInsets.only(bottom: (p.isTv ? 2 : 1.5) * p.rem),
      child: Row(children: [
        // One line, shrunk to fit beside the buttons (a long title used to break mid-word: "Dashboar / d").
        Expanded(
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(title, maxLines: 1, softWrap: false, style: TextStyle(fontSize: (p.narrow ? 1.6 : 2.2) * p.rem, fontWeight: FontWeight.w700, letterSpacing: -0.6, height: 1.1)),
          ),
        ),
        if (trailing != null) ...[SizedBox(width: 0.75 * p.rem), trailing!],
        if (weather && !_InSubScreen.of(context)) ...[SizedBox(width: 0.75 * p.rem), const WeatherBadge()], // a SubScreen already has it in its bar
      ]),
    );
  }
}

/// Marks everything under a [SubScreen]: its app bar carries the weather pill, so a [Heading] inside must not add a second one.
class _InSubScreen extends InheritedWidget {
  const _InSubScreen({required super.child});
  static bool of(BuildContext context) => context.getInheritedWidgetOfExactType<_InSubScreen>() != null;
  @override
  bool updateShouldNotify(_InSubScreen o) => false;
}

/// The mini player under a pushed screen. Takes the bottom safe area only while a song is loaded, so nothing is added when
/// no music plays.
class _SubMiniPlayer extends StatelessWidget {
  const _SubMiniPlayer();

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<Object?>(
        valueListenable: MusicController.instance.current,
        builder: (context, cur, _) => cur == null ? const SizedBox.shrink() : const SafeArea(top: false, child: MiniPlayer()),
      );
}

/// A page pushed from the More page (or opened from the sidebar on wide screens): back arrow + scrolling body.
class SubScreen extends StatelessWidget {
  const SubScreen({super.key, required this.title, required this.body});
  final String title;
  final Widget body;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return PekBackdrop(
      tokens: p.tokens,
      child: _InSubScreen(child: Scaffold(
      backgroundColor: Colors.transparent,
      appBar: p.isTv
          // 10-foot look: a taller bar that starts inside the safe margins (like .plugin-window-bar).
          ? PreferredSize(
              preferredSize: Size.fromHeight(3.5 * p.rem + p.safeY),
              child: Padding(
                padding: EdgeInsets.only(top: p.safeY, left: p.safeX, right: p.safeX),
                child: AppBar(
                  backgroundColor: Colors.transparent,
                  elevation: 0,
                  foregroundColor: p.tokens.text,
                  toolbarHeight: 3.5 * p.rem,
                  title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.1 * p.rem, fontWeight: FontWeight.w600)),
                  actions: weatherActions(context),
                ),
              ),
            )
          : AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: p.tokens.text, title: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.1 * p.rem, fontWeight: FontWeight.w600)), actions: weatherActions(context)),
      body: body,
      // The music player stays up on every screen pushed over the tabs (a plugin's screen, an album ...).
      bottomNavigationBar: const _SubMiniPlayer(),
    )));
  }
}

/// `ui.listRow(title, subtitle, onTap)`.
class ListRow extends StatelessWidget {
  const ListRow({super.key, required this.title, this.subtitle = '', this.onTap, this.onLongPress, this.trailing, this.leading, this.autofocus = false, this.highlight = false, this.trailingBelow = false});
  final VoidCallback? onLongPress;
  /// Put [trailing] on its own line under the text instead of beside it. For rows with several buttons on a phone,
  /// where a side-by-side layout leaves the text a sliver and the buttons overflow.
  final bool trailingBelow;
  final bool highlight;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;
  final Widget? leading; // a picture at the left
  final bool autofocus;

  Widget _text(dynamic t, double rem) => Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: highlight ? FontWeight.w700 : FontWeight.w500, fontSize: rem, color: highlight ? t.accent : null)),
        if (subtitle.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.15 * rem), child: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.82 * rem))),
      ]);

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 0.1 * rem),
      child: PekFocusable(
        autofocus: autofocus,
        // A row whose only controls are buttons in [trailing] (the Plugins list) must not take the focus itself: it would
        // light up as a whole, do nothing on OK and hide the buttons from the D-pad.
        enabled: onTap != null || onLongPress != null,
        radius: 14,
        minHeight: p.isTv ? 3 * rem : null,
        padding: EdgeInsets.symmetric(horizontal: 0.5 * rem, vertical: 0.7 * rem),
        onTap: onTap,
        onLongPress: onLongPress,
        child: trailingBelow && trailing != null
            ? Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  if (leading != null) ...[leading!, SizedBox(width: 0.8 * rem)],
                  Expanded(child: _text(t, rem)),
                ]),
                SizedBox(height: 0.6 * rem),
                Align(alignment: Alignment.centerLeft, child: trailing!),
              ])
            : Row(children: [
                if (leading != null) ...[leading!, SizedBox(width: 0.8 * rem)],
                Expanded(child: _text(t, rem)),
                if (trailing != null) ...[SizedBox(width: rem), trailing!],
              ]),
      ),
    );
  }
}

/// `.settings-section`: a heading + a hint, then the content.
class Section extends StatelessWidget {
  const Section({super.key, required this.title, this.hint, required this.children});
  final String title;
  final String? hint;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 1.5 * rem),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w600, letterSpacing: -0.2)),
        if (hint != null) Padding(padding: EdgeInsets.only(top: 0.25 * rem), child: Text(hint!, style: TextStyle(color: p.tokens.textMuted, fontSize: 0.9 * rem))),
        SizedBox(height: 0.75 * rem),
        ...children,
      ]),
    );
  }
}

/// Loading / error / data for one Future.
class Async<T> extends StatelessWidget {
  const Async({super.key, required this.future, required this.builder, this.errorTitle = 'Could not load'});
  final Future<T> future;
  final Widget Function(BuildContext, T) builder;
  final String errorTitle;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return FutureBuilder<T>(
      future: future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return Padding(padding: EdgeInsets.all(2 * p.rem), child: Text('Loading\u2026', style: TextStyle(color: p.tokens.textMuted)));
        }
        if (snap.hasError) return PekCard(title: errorTitle, subtitle: 'The backend did not respond. Is the server running?');
        return builder(context, snap.data as T);
      },
    );
  }
}

String formatBytes(num n) {
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  var v = n.toDouble();
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v >= 100 || i == 0 ? v.round() : v.toStringAsFixed(1)} ${units[i]}';
}

String formatTime(double s) {
  final t = s.isNaN || s < 0 ? 0 : s.floor();
  final h = t ~/ 3600, m = (t % 3600) ~/ 60, sec = t % 60;
  String two(int n) => n.toString().padLeft(2, '0');
  return h > 0 ? '$h:${two(m)}:${two(sec)}' : '$m:${two(sec)}';
}


/// A thin line between two settings (or two buttons): same colour as muted text, very light.
class ThinDivider extends StatelessWidget {
  const ThinDivider({super.key, this.vertical});
  final double? vertical; // space above and below, default half a rem

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return Padding(
      padding: EdgeInsets.symmetric(vertical: vertical ?? 0.5 * p.rem),
      child: SizedBox(height: 1, width: double.infinity, child: ColoredBox(color: p.tokens.textMuted.withAlpha(60))),
    );
  }
}

/// A category of settings: its name as a header, then its sections with a thin line between each.
class SettingsGroup extends StatelessWidget {
  const SettingsGroup({super.key, required this.title, this.hint, required this.children});
  final String title;
  final String? hint;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return Padding(
      padding: EdgeInsets.only(top: 0.75 * rem, bottom: rem),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title.toUpperCase(), style: TextStyle(fontSize: 0.8 * rem, fontWeight: FontWeight.w700, letterSpacing: 1.2, color: p.tokens.accent)),
        if (hint != null) Padding(padding: EdgeInsets.only(top: 0.2 * rem), child: Text(hint!, style: TextStyle(color: p.tokens.textMuted, fontSize: 0.85 * rem))),
        SizedBox(height: 0.6 * rem),
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const ThinDivider(),
          children[i],
        ],
      ]),
    );
  }
}
