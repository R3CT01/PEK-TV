import 'package:flutter/material.dart';

import 'tokens.dart';
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
  const Heading(this.title, {super.key, this.trailing});
  final String title;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return Padding(
      padding: EdgeInsets.only(bottom: (p.isTv ? 2 : 1.5) * p.rem),
      child: Row(children: [
        Expanded(child: Text(title, style: TextStyle(fontSize: (p.narrow ? 1.9 : 2.2) * p.rem, fontWeight: FontWeight.w700, letterSpacing: -0.6, height: 1.1))),
        if (trailing != null) trailing!,
      ]),
    );
  }
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
      child: Scaffold(
      backgroundColor: Colors.transparent,
      appBar: p.isTv
          // 10-foot look: a taller bar that starts inside the safe margins (like .plugin-window-bar).
          ? PreferredSize(
              preferredSize: Size.fromHeight(3.5 * p.rem + p.safeY),
              child: Padding(
                padding: EdgeInsets.only(top: p.safeY, left: p.safeX),
                child: AppBar(
                  backgroundColor: Colors.transparent,
                  elevation: 0,
                  foregroundColor: p.tokens.text,
                  toolbarHeight: 3.5 * p.rem,
                  title: Text(title, style: TextStyle(fontSize: 1.1 * p.rem, fontWeight: FontWeight.w600)),
                ),
              ),
            )
          : AppBar(backgroundColor: Colors.transparent, elevation: 0, foregroundColor: p.tokens.text, title: Text(title, style: TextStyle(fontSize: 1.1 * p.rem, fontWeight: FontWeight.w600))),
      body: body,
    ));
  }
}

/// `ui.listRow(title, subtitle, onTap)`.
class ListRow extends StatelessWidget {
  const ListRow({super.key, required this.title, this.subtitle = '', this.onTap, this.onLongPress, this.trailing, this.autofocus = false, this.highlight = false});
  final VoidCallback? onLongPress;
  final bool highlight;
  final String title;
  final String subtitle;
  final VoidCallback? onTap;
  final Widget? trailing;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return Padding(
      padding: EdgeInsets.only(bottom: 0.1 * rem),
      child: PekFocusable(
        autofocus: autofocus,
        radius: 14,
        minHeight: p.isTv ? 3 * rem : null,
        padding: EdgeInsets.symmetric(horizontal: 0.5 * rem, vertical: 0.7 * rem),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: highlight ? FontWeight.w700 : FontWeight.w500, fontSize: rem, color: highlight ? t.accent : null)),
              if (subtitle.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.15 * rem), child: Text(subtitle, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.textMuted, fontSize: 0.82 * rem))),
            ]),
          ),
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
