import 'package:flutter/material.dart';

import 'tokens.dart';

/// A text box in the app's look (the web UI's `ui.textInput`).
class PekField extends StatelessWidget {
  const PekField({super.key, required this.label, required this.controller, this.hint, this.obscure = false, this.onSubmitted, this.autofocus = false, this.keyboardType});
  final String label;
  final TextEditingController controller;
  final String? hint;
  final bool obscure;
  final VoidCallback? onSubmitted;
  final bool autofocus;
  final TextInputType? keyboardType;

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
