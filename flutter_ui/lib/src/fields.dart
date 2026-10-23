import 'package:flutter/material.dart';

import 'tokens.dart';
import 'widgets.dart' show PekFocusable;

/// A text box in the app's look (the web UI's `ui.textInput`).
class PekField extends StatelessWidget {
  const PekField({super.key, required this.label, required this.controller, this.hint, this.obscure = false, this.onSubmitted, this.autofocus = false, this.keyboardType, this.onChanged});
  final String label;
  final TextEditingController controller;
  final String? hint;
  final bool obscure;
  final VoidCallback? onSubmitted;
  final bool autofocus;
  final TextInputType? keyboardType;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    OutlineInputBorder border(Color c) => OutlineInputBorder(borderRadius: BorderRadius.circular(14), borderSide: c == Colors.transparent ? BorderSide.none : BorderSide(color: c));
    return Padding(
      padding: EdgeInsets.only(bottom: 0.75 * p.rem),
      child: TextField(
        controller: controller,
        obscureText: obscure,
        autofocus: autofocus,
        autocorrect: false,
        enableSuggestions: false,
        keyboardType: keyboardType,
        onChanged: onChanged,
        onSubmitted: onSubmitted == null ? null : (_) => onSubmitted!(),
        style: TextStyle(color: t.text),
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          labelStyle: TextStyle(color: t.textMuted),
          hintStyle: TextStyle(color: t.textMuted.withAlpha(180)),
          filled: true,
          fillColor: t.surface,
          enabledBorder: border(Colors.transparent),
          focusedBorder: border(t.text.withAlpha(70)),
          border: border(Colors.transparent),
        ),
      ),
    );
  }
}

/// A drop-down list in the app's look: a field that shows the current choice and opens a menu right under it.
/// Works with the D-pad (the menu's rows take focus) and a long list scrolls inside the menu.
class PekDropdown<T> extends StatelessWidget {
  const PekDropdown({super.key, required this.value, required this.items, required this.onChanged, this.label});

  /// The current choice (must be one of [items], otherwise the field shows nothing).
  final T value;

  /// (value, text shown) in the order they are listed.
  final List<(T, String)> items;
  final ValueChanged<T> onChanged;
  final String? label;

  Future<void> _open(BuildContext context) async {
    final box = context.findRenderObject() as RenderBox?;
    final overlay = Overlay.of(context).context.findRenderObject() as RenderBox?;
    if (box == null || overlay == null) return;
    final topLeft = box.localToGlobal(Offset.zero, ancestor: overlay);
    final rect = RelativeRect.fromLTRB(topLeft.dx, topLeft.dy + box.size.height + 4, overlay.size.width - topLeft.dx - box.size.width, 0);
    final p = context.pek;
    final picked = await showMenu<int>(
      context: context,
      position: rect,
      color: p.tokens.glassStrong,
      surfaceTintColor: Colors.transparent,
      constraints: BoxConstraints(minWidth: box.size.width, maxWidth: box.size.width, maxHeight: (overlay.size.height * 0.5).clamp(160.0, 420.0)),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14), side: BorderSide(color: p.tokens.border)),
      items: [
        for (var i = 0; i < items.length; i++)
          PopupMenuItem<int>(
            value: i,
            height: p.isTv ? 3 * p.rem : 2.75 * p.rem,
            child: Row(children: [
              Expanded(child: Text(items[i].$2, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: p.rem, fontWeight: items[i].$1 == value ? FontWeight.w700 : FontWeight.w500, color: items[i].$1 == value ? p.tokens.accent : p.tokens.text))),
              if (items[i].$1 == value) Icon(Icons.check, size: 1.1 * p.rem, color: p.tokens.accent),
            ]),
          ),
      ],
    );
    if (picked != null && items[picked].$1 != value) onChanged(items[picked].$1);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    var shown = '';
    for (final e in items) {
      if (e.$1 == value) shown = e.$2;
    }
    return Semantics(
      button: true,
      label: label == null ? shown : '$label: $shown',
      child: PekFocusable(
        onTap: () => _open(context),
        radius: 14,
        background: t.surface,
        borderColor: t.border,
        minHeight: p.isTv ? 3 * rem : 2.75 * rem,
        alignment: Alignment.centerLeft,
        padding: EdgeInsets.symmetric(horizontal: 1.1 * rem, vertical: 0.5 * rem),
        child: Row(children: [
          Expanded(child: Text(shown, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: rem, color: t.text))),
          Icon(Icons.arrow_drop_down, color: t.textMuted),
        ]),
      ),
    );
  }
}
