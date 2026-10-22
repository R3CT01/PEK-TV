import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart' show PluginInfo;
import 'plugin_pins.dart';
import 'plugin_store_ui.dart' show PluginPicture;
import 'tokens.dart';

/// Pin board helpers for the More page. The pin slots are ordinary More tiles (same size and look as the others):
/// a pinned plugin shows its icon, name and description; an empty slot shows a faint plus. Tap / D-pad centre on an
/// empty slot lists the installed plugins to pin; on a pinned one it opens it. Press and hold (long press, held centre
/// button, or Menu key) on a pinned plugin for Open / Remove from pins.
class PinActions {
  static String name(PluginInfo pl) => pl.navTab.isEmpty ? pl.name : pl.navTab;

  static Future<void> pick(BuildContext context, List<PluginInfo> available) async {
    final p = context.pek;
    final free = [for (final pl in available) if (!PluginPins.isPinned(pl.folder)) pl];
    final chosen = await showDialog<PluginInfo>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => SimpleDialog(
        backgroundColor: p.tokens.glassStrong,
        title: const Text('Pin a plugin'),
        children: [
          if (free.isEmpty)
            Padding(
              padding: EdgeInsets.symmetric(horizontal: 1.5 * p.rem, vertical: p.rem),
              child: Text(
                available.isEmpty ? 'No plugins installed yet. Install one from the Plugins page first.' : 'Every installed plugin is already pinned.',
                style: TextStyle(color: p.tokens.textMuted),
              ),
            ),
          for (var i = 0; i < free.length; i++)
            ListTile(
              autofocus: i == 0,
              onTap: () => Navigator.pop(c, free[i]),
              leading: free[i].icon.isEmpty
                  ? SizedBox(width: 2.4 * p.rem, height: 2.4 * p.rem, child: Icon(Icons.extension_outlined, color: p.tokens.textMuted))
                  : PluginPicture(url: free[i].icon, size: 2.4 * p.rem),
              title: Text(name(free[i]), maxLines: 1, overflow: TextOverflow.ellipsis),
            ),
        ],
      ),
    );
    if (chosen == null || !context.mounted) return;
    final ok = await PluginPins.toggle(chosen.folder);
    if (!ok && context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('You can pin up to ${PluginPins.max} plugins.')));
    }
  }

  static Future<void> menu(BuildContext context, PluginInfo pl, void Function(PluginInfo pl) onOpen) async {
    final p = context.pek;
    final what = await showDialog<String>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => SimpleDialog(
        backgroundColor: p.tokens.glassStrong,
        title: Text(name(pl), maxLines: 1, overflow: TextOverflow.ellipsis),
        children: [
          ListTile(autofocus: true, onTap: () => Navigator.pop(c, 'open'), leading: const Icon(Icons.open_in_new), title: const Text('Open')),
          ListTile(onTap: () => Navigator.pop(c, 'remove'), leading: const Icon(Icons.remove_circle_outline), title: const Text('Remove from pins')),
        ],
      ),
    );
    if (what == 'open') {
      onOpen(pl);
    } else if (what == 'remove') {
      await PluginPins.toggle(pl.folder); // only un-pins; the plugin stays installed
    }
  }
}

/// A More tile for one pin slot. Same size, padding and look as [PekCard]; the empty look is translucent with a plus.
class PinTile extends StatefulWidget {
  const PinTile({super.key, required this.onTap, this.onLongPress, this.title, this.subtitle, this.leading, this.fill});
  final VoidCallback onTap;
  final VoidCallback? onLongPress; // null = empty slot
  final String? title;
  final String? subtitle;
  final Widget? leading;
  final Widget? fill; // full-bleed picture: fills the whole tile, the name sits on a dark strip along the bottom

  @override
  State<PinTile> createState() => _PinTileState();
}

class _PinTileState extends State<PinTile> {
  bool _focus = false;
  Timer? _hold;
  bool _heldFired = false;

  static bool _isSelect(LogicalKeyboardKey k) =>
      k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter || k == LogicalKeyboardKey.numpadEnter || k == LogicalKeyboardKey.gameButtonA;

  @override
  void dispose() {
    _hold?.cancel();
    super.dispose();
  }

  KeyEventResult _key(FocusNode node, KeyEvent e) {
    final long = widget.onLongPress;
    if (long != null && (e.logicalKey == LogicalKeyboardKey.contextMenu || e.logicalKey == LogicalKeyboardKey.gameButtonX)) {
      if (e is KeyDownEvent) long();
      return KeyEventResult.handled;
    }
    if (!_isSelect(e.logicalKey)) return KeyEventResult.ignored;
    if (long == null) {
      if (e is KeyDownEvent) widget.onTap();
      return KeyEventResult.handled;
    }
    if (e is KeyDownEvent) {
      _heldFired = false;
      _hold?.cancel();
      _hold = Timer(const Duration(milliseconds: 500), () {
        _heldFired = true;
        long();
      });
    } else if (e is KeyUpEvent) {
      final waiting = _hold?.isActive ?? false;
      _hold?.cancel();
      if (waiting && !_heldFired) widget.onTap();
    }
    return KeyEventResult.handled;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final empty = widget.title == null;
    final base = empty ? t.surface.withAlpha(110) : t.surface;
    final pad = (p.compact ? 0.75 : 1.5) * rem;
    final shadow = p.isTv ? [BoxShadow(color: t.borderFocus, spreadRadius: 0.2 * rem)] : [BoxShadow(color: t.accentGlow, blurRadius: 10)];
    return Focus(
      onKeyEvent: _key,
      onFocusChange: (f) => setState(() => _focus = f),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onTap,
        onLongPress: widget.onLongPress,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 100),
          clipBehavior: Clip.antiAlias,
          padding: widget.fill != null && !empty ? EdgeInsets.zero : EdgeInsets.all(pad),
          decoration: BoxDecoration(
            color: _focus ? Color.alphaBlend(t.surfaceFocused, base) : base,
            borderRadius: BorderRadius.circular(t.radius),
            boxShadow: _focus ? shadow : null,
          ),
          child: empty
              ? Center(child: Icon(Icons.add, size: 3 * rem, color: t.textMuted.withAlpha(110)))
              : widget.fill != null
              ? Stack(
                  fit: StackFit.expand,
                  children: [
                    widget.fill!,
                    Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      child: DecoratedBox(
                        decoration: const BoxDecoration(
                          gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x00000000), Color(0xCC000000)]),
                        ),
                        child: Padding(
                          padding: EdgeInsets.fromLTRB(0.75 * rem, 1.5 * rem, 0.75 * rem, 0.6 * rem),
                          child: Text(widget.title!, maxLines: 1, overflow: TextOverflow.ellipsis,
                              style: TextStyle(fontSize: 1.0 * rem, fontWeight: FontWeight.w600, color: Colors.white, letterSpacing: -0.2)),
                        ),
                      ),
                    ),
                  ],
                )
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (widget.leading != null) Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: widget.leading!),
                    Text(widget.title!, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.1 * rem, fontWeight: FontWeight.w600, letterSpacing: -0.2)),
                    if (widget.subtitle != null && widget.subtitle!.isNotEmpty) ...[
                      SizedBox(height: 0.5 * rem),
                      Text(widget.subtitle!, maxLines: 3, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.92 * rem, color: t.textMuted, height: 1.35)),
                    ],
                  ],
                ),
        ),
      ),
    );
  }
}
