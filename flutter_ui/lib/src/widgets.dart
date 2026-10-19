import 'package:flutter/material.dart';

import 'api.dart' show Details;
import 'layouts.dart';
import 'tokens.dart';

/// The `.focusable` of the web UI. On a remote / keyboard (focus highlight on) it gets `.focused`:
/// border-focus colour, background surface-focused, and a glow (10px accent-glow) or, in TV mode, a 0.2rem ring.
/// A tap or Enter / Select / A (centre button) activates it.
class PekFocusable extends StatefulWidget {
  const PekFocusable({
    super.key,
    required this.child,
    this.onTap,
    this.onLongPress,
    this.autofocus = false,
    this.enabled = true,
    this.background,
    this.focusBackground,
    this.borderColor,
    this.radius = 0,
    this.focusScale = 1.0,
    this.padding,
    this.minHeight,
    this.alignment,
  });

  final Widget child;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool autofocus;
  final bool enabled;
  final Color? background;
  final Color? focusBackground; // default: surface-focused
  final Color? borderColor; // null = no border (poster cards)
  final double radius;
  final double focusScale;
  final EdgeInsetsGeometry? padding;
  final double? minHeight;
  final AlignmentGeometry? alignment;

  @override
  State<PekFocusable> createState() => _PekFocusableState();
}

class _PekFocusableState extends State<PekFocusable> {
  bool _focus = false;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final focused = _focus && widget.enabled;
    final shadow = p.isTv
        ? [BoxShadow(color: t.borderFocus, spreadRadius: 0.2 * p.rem)]
        : [BoxShadow(color: t.accentGlow, blurRadius: 10)];
    final box = AnimatedContainer(
      duration: const Duration(milliseconds: 100),
      padding: widget.padding,
      alignment: widget.alignment,
      constraints: widget.minHeight == null ? null : BoxConstraints(minHeight: widget.minHeight!),
      clipBehavior: widget.radius > 0 ? Clip.antiAlias : Clip.none,
      decoration: BoxDecoration(
        color: focused ? (widget.focusBackground ?? t.surfaceFocused) : widget.background,
        borderRadius: BorderRadius.circular(widget.radius),
        border: widget.borderColor == null ? null : Border.all(color: focused ? t.borderFocus : widget.borderColor!),
        boxShadow: focused ? shadow : null,
      ),
      child: widget.child,
    );
    return FocusableActionDetector(
      autofocus: widget.autofocus,
      enabled: widget.enabled,
      onShowFocusHighlight: (v) => setState(() => _focus = v),
      actions: {
        ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
          widget.onTap?.call();
          return null;
        }),
      },
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.enabled ? widget.onTap : null,
        onLongPress: widget.enabled ? widget.onLongPress : null,
        child: AnimatedScale(
          scale: focused ? widget.focusScale : 1.0,
          duration: const Duration(milliseconds: 120),
          child: box,
        ),
      ),
    );
  }
}

/// `.theme-launch-btn` / `.refresh-btn` / `.sx-btn` (primary = filled with the accent).
class PekButton extends StatelessWidget {
  const PekButton({super.key, required this.label, this.onTap, this.leading, this.primary = false, this.compact = false, this.autofocus = false});
  final String label;
  final VoidCallback? onTap; // null = disabled
  final Widget? leading;
  final bool primary;
  final bool compact; // the Refresh button: 2.5rem high, 1rem padding
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final fg = primary ? t.bg : t.text;
    final bg = primary ? t.accent : t.surface;
    return Opacity(
      opacity: onTap == null ? 0.5 : 1,
      child: PekFocusable(
        autofocus: autofocus,
        enabled: onTap != null,
        onTap: onTap,
        radius: 12,
        background: bg,
        focusBackground: primary ? t.accent : null,
        borderColor: primary ? Colors.transparent : t.border,
        minHeight: (compact ? 2.5 : 2.75) * rem,
        alignment: Alignment.center,
        padding: EdgeInsets.symmetric(horizontal: (compact ? 1.0 : 1.25) * rem, vertical: (compact ? 0.45 : 0.6) * rem),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (leading != null) ...[leading!, SizedBox(width: 0.5 * rem)],
            Flexible(
              child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.95 * rem, fontWeight: FontWeight.w600, color: fg, letterSpacing: 0.15, height: 1.2)),
            ),
          ],
        ),
      ),
    );
  }
}

/// `ui.card(title, subtitle)`: `.empty-state.focusable.sx-card`.
class PekCard extends StatelessWidget {
  const PekCard({super.key, required this.title, this.subtitle, this.onTap, this.autofocus = false});
  final String title;
  final String? subtitle;
  final VoidCallback? onTap;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    // `.sx-poster-grid .sx-card { padding: 0.75rem }` on small screens
    final pad = (p.compact ? 0.75 : 1.5) * rem;
    return PekFocusable(
      autofocus: autofocus,
      onTap: onTap,
      radius: t.radius,
      background: t.surface,
      borderColor: t.border,
      padding: EdgeInsets.all(pad),
      child: SizedBox(
        width: double.infinity,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title, style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
            if (subtitle != null && subtitle!.isNotEmpty) ...[
              SizedBox(height: 1.25 * rem),
              Text(subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: rem, color: t.textMuted)),
            ],
          ],
        ),
      ),
    );
  }
}

/// `ui.posterCard`: shows a plain card until the poster is known (and if it fails to load), then the 2:3 poster with the
/// title over a dark gradient at the bottom.
class PosterCard extends StatefulWidget {
  const PosterCard({super.key, required this.title, required this.subtitle, required this.poster, required this.onTap, this.onLongPress, this.autofocus = false});
  final String title;
  final String subtitle;
  final Future<Details> poster;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final bool autofocus;

  @override
  State<PosterCard> createState() => _PosterCardState();
}

class _PosterCardState extends State<PosterCard> {
  bool _failed = false;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Details>(
      future: widget.poster,
      builder: (context, snap) {
        final url = snap.data?.poster ?? '';
        if (url.isEmpty || _failed) {
          return PekCard(title: widget.title, subtitle: widget.subtitle, onTap: widget.onTap, autofocus: widget.autofocus);
        }
        final p = context.pek;
        final t = p.tokens;
        final rem = p.rem;
        return PekFocusable(
          autofocus: widget.autofocus,
          onTap: widget.onTap,
          onLongPress: widget.onLongPress,
          radius: p.compact ? 10 : 0,
          background: t.surface,
          focusScale: p.isTv ? 1.07 : 1.04,
          child: AspectRatio(
            aspectRatio: 2 / 3,
            child: Stack(
              fit: StackFit.expand,
              children: [
                Image.network(
                  url,
                  fit: BoxFit.cover,
                  cacheWidth: 400, // decode small: weak TV boxes run out of memory on full-size posters
                  gaplessPlayback: true,
                  errorBuilder: (_, __, ___) {
                    WidgetsBinding.instance.addPostFrameCallback((_) {
                      if (mounted && !_failed) setState(() => _failed = true);
                    });
                    return const SizedBox.shrink();
                  },
                ),
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: Container(
                    padding: const EdgeInsets.fromLTRB(10, 30, 10, 10),
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [Color.fromRGBO(5, 8, 14, 0.92), Color.fromRGBO(5, 8, 14, 0)]),
                    ),
                    child: Text(
                      widget.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 0.9 * rem,
                        fontWeight: FontWeight.w600,
                        height: 1.25,
                        color: const Color(0xFFF7F3EE),
                        shadows: const [Shadow(color: Color.fromRGBO(0, 0, 0, 0.6), offset: Offset(0, 1), blurRadius: 3)],
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

/// Poster picture only (detail pages): same source as the grid, no card.
class PosterImage extends StatelessWidget {
  const PosterImage({super.key, required this.poster, required this.title, this.width = 320});
  final Future<Details> poster;
  final String title;
  final int width;

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    Widget placeholder() => Center(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Text(title, textAlign: TextAlign.center, style: TextStyle(color: t.textMuted)),
          ),
        );
    return FutureBuilder<Details>(
      future: poster,
      builder: (context, snap) {
        final url = snap.data?.poster ?? '';
        if (url.isEmpty) return placeholder();
        return Image.network(url, fit: BoxFit.cover, cacheWidth: width, gaplessPlayback: true, errorBuilder: (_, __, ___) => placeholder());
      },
    );
  }
}

/// `.sx-grid` with `grid-template-columns: repeat(auto-fill, minmax(min, 1fr))`, as a sliver so the page scrolls as one.
/// Cells in a row stretch to the tallest one, like CSS grid.
class PekGridSliver extends StatelessWidget {
  const PekGridSliver({super.key, required this.count, required this.minWidth, required this.gap, required this.builder});
  final int count;
  final double minWidth;
  final double gap;
  final Widget Function(BuildContext context, int index) builder;

  @override
  Widget build(BuildContext context) {
    // The poster size from Settings > Layout scales every grid; a change repaints it.
    return ListenableBuilder(listenable: Layouts.changes, builder: (context, _) => _grid(context));
  }

  Widget _grid(BuildContext context) {
    final minW = minWidth * Layouts.posterScale;
    return SliverLayoutBuilder(
      builder: (context, c) {
        final w = c.crossAxisExtent;
        final cols = ((w + gap) / (minW + gap)).floor().clamp(1, 1000);
        final rows = (count / cols).ceil();
        return SliverList(
          delegate: SliverChildBuilderDelegate(
            childCount: rows,
            (context, r) {
              final cells = <Widget>[];
              for (var i = 0; i < cols; i++) {
                final idx = r * cols + i;
                if (i > 0) cells.add(SizedBox(width: gap));
                cells.add(Expanded(child: idx < count ? builder(context, idx) : const SizedBox.shrink()));
              }
              return Padding(
                padding: EdgeInsets.only(bottom: gap),
                child: IntrinsicHeight(child: Row(crossAxisAlignment: CrossAxisAlignment.stretch, children: cells)),
              );
            },
          ),
        );
      },
    );
  }
}

/// A spinner for `.refresh-icon.spinning`.
class Spin extends StatefulWidget {
  const Spin({super.key, required this.child, required this.spinning});
  final Widget child;
  final bool spinning;
  @override
  State<Spin> createState() => _SpinState();
}

class _SpinState extends State<Spin> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 900));

  @override
  void initState() {
    super.initState();
    if (widget.spinning) _c.repeat();
  }

  @override
  void didUpdateWidget(Spin old) {
    super.didUpdateWidget(old);
    if (widget.spinning && !_c.isAnimating) _c.repeat();
    if (!widget.spinning && _c.isAnimating) _c.stop();
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RotationTransition(turns: _c, child: widget.child);
}
