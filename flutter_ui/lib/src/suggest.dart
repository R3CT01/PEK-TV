import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'art_cache.dart';
import 'tokens.dart';
import 'widgets.dart' show PekFocusable;

/// One row of a search box's drop-down list: a small picture at the side, a title and a line of facts.
///
/// The picture is either known now ([image], an https address) or arrives later ([imageLater], e.g. a library title's poster
/// look-up). With neither, a plain film icon stands in.
class SuggestItem {
  const SuggestItem({required this.title, this.sub = '', this.image = '', this.imageLater, required this.onTap});
  final String title;
  final String sub;
  final String image;
  final Future<String>? imageLater;
  final VoidCallback onTap;
}

/// A search box with a suggestions list under it (used by PEK TV's Search page and by plugin screens).
///
/// The list is drawn right under the box, in the page itself, so the D-pad works the way it does everywhere else: Down from
/// the box lands on the first suggestion, Down again walks the list, Up goes back, and OK opens the one that is highlighted.
/// It is open while the box OR one of its suggestions has the focus and there is something typed, and closes when the focus
/// goes anywhere else.
class SuggestAnchor extends StatefulWidget {
  const SuggestAnchor({super.key, required this.field, required this.controller, required this.items, this.max = 6});

  /// The text box itself (it must use [controller]).
  final Widget field;
  final TextEditingController controller;
  final List<SuggestItem> items;
  final int max;

  /// Called by the text box when Down is pressed: puts the focus on the first suggestion. Geometry-based focus search from a
  /// text box was not reliable on a TV (it could skip the list), so this goes straight there. false = no list is showing,
  /// so the caller falls back to the normal "move down".
  static bool focusFirst(BuildContext context) => context.findAncestorStateOfType<_SuggestAnchorState>()?._focusFirst() ?? false;

  @override
  State<SuggestAnchor> createState() => _SuggestAnchorState();
}

class _SuggestAnchorState extends State<SuggestAnchor> {
  bool _focused = false;

  /// Watches the list: Focus() with canRequestFocus: false never takes the focus itself, but sees the keys of its rows.
  final FocusNode _listNode = FocusNode(debugLabel: 'SuggestList', canRequestFocus: false, skipTraversal: true);
  FocusNode? _back; // the text box's focus, so Up from the first row can return to it

  @override
  void dispose() {
    _listNode.dispose();
    super.dispose();
  }

  List<FocusNode> _rows() => _listNode.traversalDescendants.where((n) => n.canRequestFocus).toList();

  bool _focusFirst() {
    final rows = _rows();
    if (rows.isEmpty) return false;
    _back = FocusManager.instance.primaryFocus;
    rows.first.requestFocus();
    return true;
  }

  KeyEventResult _listKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent || e.logicalKey != LogicalKeyboardKey.arrowUp) return KeyEventResult.ignored;
    final rows = _rows();
    final back = _back;
    // Up from the FIRST suggestion goes back into the text box (the others move up the list as usual).
    if (rows.isNotEmpty && rows.first.hasPrimaryFocus && back != null && back.canRequestFocus) {
      back.requestFocus();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    // Focus() with canRequestFocus: false only watches: it is "focused" while the text box OR a suggestion has the focus.
    return Focus(
      canRequestFocus: false,
      skipTraversal: true,
      onFocusChange: (has) {
        if (has != _focused) setState(() => _focused = has);
      },
      child: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) {
          final q = widget.controller.text.trim();
          final items = widget.items.take(widget.max).toList();
          final open = _focused && q.isNotEmpty && items.isNotEmpty;
          final p = context.pek;
          final t = p.tokens;
          return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            widget.field,
            if (open)
              Focus(
                focusNode: _listNode,
                onKeyEvent: _listKey,
                child: Container(
                  margin: EdgeInsets.only(top: 0.1 * p.rem, bottom: 0.4 * p.rem),
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: t.glassStrong,
                    borderRadius: BorderRadius.circular(16),
                    border: Border.all(color: t.border),
                    boxShadow: [BoxShadow(color: t.shadow, blurRadius: 18, offset: const Offset(0, 6))],
                  ),
                  child: Column(children: [
                    for (var i = 0; i < items.length; i++) ...[
                      if (i > 0) Container(height: 1, color: t.border),
                      _SuggestRow(item: items[i], query: q),
                    ],
                  ]),
                ),
              ),
          ]);
        },
      ),
    );
  }
}

class _SuggestRow extends StatelessWidget {
  const _SuggestRow({required this.item, required this.query});
  final SuggestItem item;
  final String query;

  /// [text] with the part the person typed in bold.
  Widget _marked(BuildContext context) {
    final p = context.pek;
    final base = TextStyle(fontSize: p.rem, color: p.tokens.text, fontWeight: FontWeight.w500);
    final q = query.toLowerCase();
    final text = item.title;
    var at = q.isEmpty ? -1 : text.toLowerCase().indexOf(q);
    if (at + q.length > text.length) at = -1; // lower-casing changed the length (rare letters): skip the bold part
    if (at < 0) return Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: base);
    return Text.rich(
      TextSpan(style: base, children: [
        TextSpan(text: text.substring(0, at)),
        TextSpan(text: text.substring(at, at + q.length), style: TextStyle(fontWeight: FontWeight.w800, color: p.tokens.accent)),
        TextSpan(text: text.substring(at + q.length)),
      ]),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final w = 2.6 * rem, h = 3.9 * rem; // a small 2:3 poster
    Widget blank() => ColoredBox(color: t.surface, child: Center(child: Icon(Icons.movie_outlined, size: 1.3 * rem, color: t.textMuted)));
    Widget pic(String url) => url.isEmpty ? blank() : ArtImage(url, fit: BoxFit.cover, cacheWidth: 160, placeholder: (_) => blank(), errorBuilder: (_, __, ___) => blank());
    final later = item.imageLater;
    final thumb = ClipRRect(
      borderRadius: BorderRadius.circular(6),
      child: SizedBox(
        width: w,
        height: h,
        child: later == null
            ? pic(item.image)
            : FutureBuilder<String>(future: later, builder: (_, snap) => pic(snap.data?.isNotEmpty == true ? snap.data! : item.image)),
      ),
    );
    return PekFocusable(
      onTap: item.onTap,
      padding: EdgeInsets.symmetric(horizontal: 0.9 * rem, vertical: 0.4 * rem),
      minHeight: h + 0.8 * rem,
      alignment: Alignment.centerLeft,
      child: Row(children: [
        thumb,
        SizedBox(width: 0.9 * rem),
        Expanded(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            _marked(context),
            if (item.sub.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.1 * rem), child: Text(item.sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.78 * rem, color: t.textMuted))),
          ]),
        ),
      ]),
    );
  }
}
