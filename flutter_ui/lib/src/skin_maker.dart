import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'common.dart';
import 'fields.dart';
import 'settings_extra.dart' show ToggleRow;
import 'skins.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The Skin maker: pick a starting look, change the colours and the corner size with a live preview, name it, save it.
/// A saved skin shows up under Settings > Appearance next to the built-in ones and can be copied as a skin.json (the same
/// file the web build installs). The Flutter twin of the web UI's theme panel, with every colour of a skin and not only four.
///
/// The four main colours (accent, background, cards, text) work out the rest; a colour that was set by hand is left alone
/// when a main colour changes later. Like the web theme, a change that would make the text unreadable on the background,
/// the cards or the bars is refused.
Future<void> openSkinMaker(BuildContext context, {Skin? edit, Skin? from}) => Navigator.push<void>(
      context,
      MaterialPageRoute<void>(builder: (_) => SkinMakerScreen(edit: edit, from: from)),
    );

class _Slot {
  const _Slot(this.key, this.label, this.hint, {this.alpha = false});
  final String key;
  final String label;
  final String hint;
  final bool alpha; // the colour may be see-through
}

const _main = [
  _Slot('accent', 'Accent', 'Buttons, the focus ring and highlights'),
  _Slot('bg', 'Background', 'Behind everything'),
  _Slot('surface', 'Cards and rows', 'Posters, list rows, buttons'),
  _Slot('text', 'Text', 'Titles and body text'),
];

const _more = [
  _Slot('bgElevated', 'Bars and sidebar', 'The menu strip and bottom bar'),
  _Slot('surfaceFocused', 'Highlight', 'The row or tile that is selected', alpha: true),
  _Slot('border', 'Lines', 'Thin outlines and dividers', alpha: true),
  _Slot('borderFocus', 'Focus ring', 'The outline around the selected item'),
  _Slot('textMuted', 'Muted text', 'Small print and descriptions'),
  _Slot('accentGlow', 'Accent glow', 'Soft light around the accent', alpha: true),
  _Slot('overlay', 'Dim behind dialogs', 'The veil over the page when a window is open', alpha: true),
  _Slot('shadow', 'Shadow', 'Under cards and windows', alpha: true),
  _Slot('glassStrong', 'Windows and panels', 'Dialogs and the music browse panel', alpha: true),
];

class SkinMakerScreen extends StatefulWidget {
  const SkinMakerScreen({super.key, this.edit, this.from});

  /// A skin made here that is being changed (Save replaces it).
  final Skin? edit;

  /// A skin to start from without changing it (a built-in one, or a pasted skin.json).
  final Skin? from;

  @override
  State<SkinMakerScreen> createState() => _SkinMakerScreenState();
}

class _SkinMakerScreenState extends State<SkinMakerScreen> {
  late final TextEditingController _name;
  late final TextEditingController _desc;
  late final String _id;
  late PekTokens _t;
  final Set<String> _touched = {}; // colours set by hand: a main colour no longer overwrites them
  bool _showMore = false;
  bool _dirty = false;

  @override
  void initState() {
    super.initState();
    final base = widget.edit ?? widget.from;
    _id = widget.edit?.id ?? Skins.newId();
    _t = base?.tokens ?? Skins.current.tokens;
    _name = TextEditingController(text: widget.edit?.name ?? (widget.from != null ? '${widget.from!.name} copy' : 'My skin'));
    _desc = TextEditingController(text: widget.edit?.description ?? (widget.from?.custom == true ? widget.from!.description : ''));
    // Editing or importing: every colour is already chosen, so the main colours must not rewrite them.
    if (base != null) _touched.addAll(_more.map((s) => s.key));
    _dirty = widget.edit == null && widget.from?.custom == true; // a pasted skin is not saved until Save
  }

  @override
  void dispose() {
    _name.dispose();
    _desc.dispose();
    super.dispose();
  }

  Color _get(String key) => _read(_t, key);

  static Color _read(PekTokens t, String key) {
    switch (key) {
      case 'bg':
        return t.bg;
      case 'bgElevated':
        return t.bgElevated;
      case 'surface':
        return t.surface;
      case 'surfaceFocused':
        return t.surfaceFocused;
      case 'border':
        return t.border;
      case 'borderFocus':
        return t.borderFocus;
      case 'text':
        return t.text;
      case 'textMuted':
        return t.textMuted;
      case 'accent':
        return t.accent;
      case 'accentGlow':
        return t.accentGlow;
      case 'overlay':
        return t.overlay;
      case 'shadow':
        return t.shadow;
      default:
        return t.glassStrong;
    }
  }

  PekTokens _with(PekTokens t, String key, Color c) => PekTokens(
        bg: key == 'bg' ? c : t.bg,
        bgElevated: key == 'bgElevated' ? c : t.bgElevated,
        surface: key == 'surface' ? c : t.surface,
        surfaceFocused: key == 'surfaceFocused' ? c : t.surfaceFocused,
        border: key == 'border' ? c : t.border,
        borderFocus: key == 'borderFocus' ? c : t.borderFocus,
        text: key == 'text' ? c : t.text,
        textMuted: key == 'textMuted' ? c : t.textMuted,
        accent: key == 'accent' ? c : t.accent,
        accentGlow: key == 'accentGlow' ? c : t.accentGlow,
        overlay: key == 'overlay' ? c : t.overlay,
        shadow: key == 'shadow' ? c : t.shadow,
        glassStrong: key == 'glassStrong' ? c : t.glassStrong,
        radius: t.radius,
      );

  /// The tokens after [key] became [c]: a main colour also re-derives the colours nobody set by hand.
  PekTokens _after(String key, Color c) {
    final isMain = _main.any((s) => s.key == key);
    if (!isMain) return _with(_t, key, c);
    final next = _with(_t, key, c);
    final d = SkinJson.derive(bg: next.bg, surface: next.surface, text: next.text, accent: next.accent, radius: next.radius);
    var out = next;
    for (final s in _more) {
      if (!_touched.contains(s.key)) out = _with(out, s.key, _read(d, s.key));
    }
    return out;
  }

  /// null = fine; otherwise why the change is refused.
  String? _check(PekTokens t) => SkinJson.unreadable(t) ? 'The text would be hard to read on that. Pick a colour with more difference.' : null;

  Future<void> _pick(_Slot s) async {
    final c = await pickColor(
      context,
      title: s.label,
      initial: _get(s.key),
      alpha: s.alpha,
      validate: (c) => _check(_after(s.key, c)),
    );
    if (c == null || !mounted) return;
    setState(() {
      _t = _after(s.key, c);
      if (!_main.any((m) => m.key == s.key)) _touched.add(s.key);
      _dirty = true;
    });
  }

  void _start(Skin s) {
    setState(() {
      _t = s.tokens;
      _touched.clear();
      _dirty = true;
    });
  }

  Skin _skin() {
    final name = _name.text.trim();
    return Skin(_id, name.isEmpty ? 'My skin' : name, _desc.text.trim(), _t, custom: true, author: widget.edit?.author ?? '');
  }

  void _toast(String msg) => ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(msg)));

  Future<void> _save({required bool use}) async {
    final skin = _skin();
    await Skins.saveCustom(skin);
    if (use) await Skins.set(skin.id);
    if (!mounted) return;
    _dirty = false;
    _toast(use ? '${skin.name} saved and in use.' : '${skin.name} saved. Pick it under Appearance to use it.');
    Navigator.pop(context);
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: SkinJson.toText(_skin())));
    if (mounted) _toast('skin.json copied. Put it in a folder with a skin.json file, zip it and install it in the web build.');
  }

  Future<bool> _leave() async {
    if (!_dirty) return true;
    final p = context.pek;
    final r = await showDialog<bool>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => Dialog(
        backgroundColor: p.tokens.glassStrong,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(p.tokens.radius), side: BorderSide(color: p.tokens.border)),
        child: Padding(
          padding: EdgeInsets.all(1.5 * p.rem),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Leave without saving?', style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.6 * p.rem),
            Text('Your changes to this skin will be lost.', style: TextStyle(color: p.tokens.textMuted)),
            SizedBox(height: 1.1 * p.rem),
            Wrap(spacing: 0.75 * p.rem, runSpacing: 0.75 * p.rem, children: [
              PekButton(label: 'Leave', primary: true, onTap: () => Navigator.pop(c, true)),
              PekButton(label: 'Keep editing', autofocus: true, onTap: () => Navigator.pop(c, false)),
            ]),
          ]),
        ),
      ),
    );
    return r == true;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final t = p.tokens;
    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        final nav = Navigator.of(context);
        if (await _leave()) nav.pop();
      },
      child: SubScreen(
        title: widget.edit == null ? 'Skin maker' : 'Edit skin',
        body: ListView(padding: p.pagePad, children: [
          _Preview(tokens: _t),
          SizedBox(height: 1.25 * rem),
          Section(
            title: 'Start from',
            hint: 'Load a look, then change what you like.',
            children: [
              Wrap(spacing: 0.6 * rem, runSpacing: 0.6 * rem, children: [
                for (final s in Skins.all) PekButton(label: s.name, compact: true, shrink: true, onTap: () => _start(s)),
              ]),
            ],
          ),
          Section(title: 'Name', children: [
            PekField(label: 'Skin name', controller: _name, onChanged: (_) => setState(() => _dirty = true)),
            PekField(label: 'Description (optional)', controller: _desc, onChanged: (_) => setState(() => _dirty = true)),
          ]),
          Section(
            title: 'Colours',
            hint: 'Tap a colour to change it.',
            children: [for (final s in _main) _ColorRow(slot: s, color: _get(s.key), onTap: () => _pick(s))],
          ),
          Section(title: 'Corners', children: [
            Row(children: [
              Expanded(
                child: Slider(
                  value: _t.radius.clamp(0.0, 32.0).toDouble(),
                  min: 0,
                  max: 32,
                  divisions: 32,
                  activeColor: t.accent,
                  inactiveColor: t.border,
                  label: '${_t.radius.round()}',
                  onChanged: (v) => setState(() {
                    _t = PekTokens(
                      bg: _t.bg, bgElevated: _t.bgElevated, surface: _t.surface, surfaceFocused: _t.surfaceFocused, border: _t.border,
                      borderFocus: _t.borderFocus, text: _t.text, textMuted: _t.textMuted, accent: _t.accent, accentGlow: _t.accentGlow,
                      overlay: _t.overlay, shadow: _t.shadow, glassStrong: _t.glassStrong, radius: v.roundToDouble(),
                    );
                    _dirty = true;
                  }),
                ),
              ),
              SizedBox(width: rem),
              SizedBox(width: 3.5 * rem, child: Text('${_t.radius.round()} px', style: TextStyle(color: t.textMuted))),
            ]),
          ]),
          ToggleRow(title: 'More colours', subtitle: 'Lines, focus ring, muted text, dialogs and the rest', on: _showMore, onTap: () => setState(() => _showMore = !_showMore)),
          if (_showMore) ...[
            SizedBox(height: 0.5 * rem),
            for (final s in _more) _ColorRow(slot: s, color: _get(s.key), onTap: () => _pick(s)),
          ],
          SizedBox(height: 1.5 * rem),
          Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
            PekButton(label: 'Save and use', primary: true, shrink: true, onTap: () => _save(use: true)),
            PekButton(label: 'Save', shrink: true, onTap: () => _save(use: false)),
            PekButton(label: 'Copy skin.json', shrink: true, onTap: _copy),
          ]),
          SizedBox(height: 4 * rem),
        ]),
      ),
    );
  }
}

/// One colour: a swatch, its name and its code.
class _ColorRow extends StatelessWidget {
  const _ColorRow({required this.slot, required this.color, required this.onTap});
  final _Slot slot;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ListRow(
      title: slot.label,
      subtitle: '${slot.hint}  \u00b7  ${SkinJson.hex(color)}',
      onTap: onTap,
      trailing: Container(
        width: 2.4 * rem,
        height: 2.4 * rem,
        decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(10), border: Border.all(color: t.text.withAlpha(90), width: 1.5)),
      ),
    );
  }
}

/// A small copy of the app drawn with the draft colours, so every change shows at once.
class _Preview extends StatelessWidget {
  const _Preview({required this.tokens});
  final PekTokens tokens;

  @override
  Widget build(BuildContext context) {
    final rem = context.pek.rem;
    final t = tokens;
    final r = t.radius;
    Widget poster(String title) => Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            AspectRatio(
              aspectRatio: 2 / 3,
              child: DecoratedBox(
                decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(r * 0.7), border: Border.all(color: t.border)),
                child: Center(child: Icon(Icons.movie_outlined, color: t.textMuted, size: 1.6 * rem)),
              ),
            ),
            SizedBox(height: 0.3 * rem),
            Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: t.text, fontSize: 0.8 * rem, fontWeight: FontWeight.w500)),
            Text('2024', style: TextStyle(color: t.textMuted, fontSize: 0.7 * rem)),
          ]),
        );
    return Container(
      decoration: BoxDecoration(color: t.bg, borderRadius: BorderRadius.circular(_clamp(r, 6, 28)), border: Border.all(color: t.border)),
      clipBehavior: Clip.antiAlias,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          color: t.bgElevated,
          padding: EdgeInsets.symmetric(horizontal: rem, vertical: 0.6 * rem),
          child: Row(children: [
            Text('PEK TV', style: TextStyle(color: t.accent, fontWeight: FontWeight.w700, fontSize: rem)),
            SizedBox(width: rem),
            Container(
              padding: EdgeInsets.symmetric(horizontal: 0.7 * rem, vertical: 0.25 * rem),
              decoration: BoxDecoration(color: t.surfaceFocused, borderRadius: BorderRadius.circular(r * 0.6), border: Border.all(color: t.borderFocus, width: 1.5)),
              child: Text('Movies', style: TextStyle(color: t.text, fontSize: 0.8 * rem, fontWeight: FontWeight.w600)),
            ),
            SizedBox(width: 0.5 * rem),
            Text('Shows', style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
            SizedBox(width: 0.5 * rem),
            Text('Music', style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
          ]),
        ),
        Padding(
          padding: EdgeInsets.all(rem),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Continue watching', style: TextStyle(color: t.text, fontSize: 1.1 * rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.2 * rem),
            Text('Pick up where you stopped', style: TextStyle(color: t.textMuted, fontSize: 0.8 * rem)),
            SizedBox(height: 0.7 * rem),
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [poster('Night Train'), SizedBox(width: 0.6 * rem), poster('Harbour'), SizedBox(width: 0.6 * rem), poster('The Long Way'), SizedBox(width: 0.6 * rem), poster('Orbit')]),
            SizedBox(height: 0.9 * rem),
            Row(children: [
              Container(
                padding: EdgeInsets.symmetric(horizontal: 1.1 * rem, vertical: 0.55 * rem),
                decoration: BoxDecoration(color: t.accent, borderRadius: BorderRadius.circular(999), boxShadow: [BoxShadow(color: t.accentGlow, blurRadius: 12)]),
                child: Text('Play', style: TextStyle(color: t.bg, fontWeight: FontWeight.w700, fontSize: 0.9 * rem)),
              ),
              SizedBox(width: 0.6 * rem),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 1.1 * rem, vertical: 0.55 * rem),
                decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(999), border: Border.all(color: t.border)),
                child: Text('Details', style: TextStyle(color: t.text, fontSize: 0.9 * rem)),
              ),
              const Spacer(),
              Container(
                padding: EdgeInsets.symmetric(horizontal: 0.8 * rem, vertical: 0.4 * rem),
                decoration: BoxDecoration(color: t.glassStrong, borderRadius: BorderRadius.circular(r * 0.6), border: Border.all(color: t.border), boxShadow: [BoxShadow(color: t.shadow, blurRadius: 10)]),
                child: Text('Window', style: TextStyle(color: t.text, fontSize: 0.8 * rem)),
              ),
            ]),
          ]),
        ),
      ]),
    );
  }

  static double _clamp(double v, double lo, double hi) => v < lo ? lo : (v > hi ? hi : v);
}

// ====================================================================== the colour picker

/// A colour window: hue, saturation, brightness (and see-through) sliders, or type a code like #ff8a3d.
/// [validate] returns why a colour is refused (shown in red, and Use stays off), or null when it is fine.
/// Returns the colour, or null when it was closed.
Future<Color?> pickColor(BuildContext context, {required String title, required Color initial, bool alpha = false, String? Function(Color)? validate}) {
  final p = context.pek;
  return showDialog<Color>(
    context: context,
    barrierColor: p.tokens.overlay,
    builder: (c) => Dialog(
      backgroundColor: p.tokens.glassStrong,
      insetPadding: EdgeInsets.symmetric(horizontal: 1.2 * p.rem, vertical: 1.2 * p.rem),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(p.tokens.radius), side: BorderSide(color: p.tokens.border)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 26 * p.rem),
        child: _ColorPicker(title: title, initial: initial, alpha: alpha, validate: validate),
      ),
    ),
  );
}

class _ColorPicker extends StatefulWidget {
  const _ColorPicker({required this.title, required this.initial, required this.alpha, this.validate});
  final String title;
  final Color initial;
  final bool alpha;
  final String? Function(Color)? validate;

  @override
  State<_ColorPicker> createState() => _ColorPickerState();
}

class _ColorPickerState extends State<_ColorPicker> {
  late HSVColor _hsv = HSVColor.fromColor(widget.initial);
  late final TextEditingController _hex = TextEditingController(text: SkinJson.hex(widget.initial, alpha: widget.alpha));
  String? _error;

  Color get _color => _hsv.toColor();

  @override
  void dispose() {
    _hex.dispose();
    super.dispose();
  }

  void _set(HSVColor v) {
    setState(() {
      _hsv = v;
      _hex.text = SkinJson.hex(_color, alpha: widget.alpha);
      _error = widget.validate?.call(_color);
    });
  }

  void _typed(String text) {
    final c = SkinJson.parseColor(text.startsWith('#') ? text : '#$text');
    if (c == null) return;
    setState(() {
      _hsv = HSVColor.fromColor(widget.alpha ? c : c.withAlpha(255));
      _error = widget.validate?.call(_color);
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    Widget slider(String label, double value, double max, ValueChanged<double> on, {List<Color>? track}) => Row(children: [
          SizedBox(width: 6 * rem, child: Text(label, style: TextStyle(color: t.textMuted, fontSize: 0.9 * rem))),
          Expanded(
            child: SliderTheme(
              data: SliderTheme.of(context).copyWith(
                trackHeight: 0.9 * rem,
                activeTrackColor: track == null ? t.accent : Colors.transparent,
                inactiveTrackColor: track == null ? t.border : Colors.transparent,
                thumbColor: Colors.white,
                overlayColor: t.accent.withAlpha(40),
                trackShape: track == null ? null : _GradientTrack(track),
              ),
              child: Slider(value: value.clamp(0.0, max).toDouble(), min: 0, max: max, onChanged: on),
            ),
          ),
        ]);
    final hueColors = [for (var i = 0; i <= 6; i++) HSVColor.fromAHSV(1, i * 60.0 % 360, 1, 1).toColor()];
    final ok = _error == null && SkinJson.parseColor(_hex.text.startsWith('#') ? _hex.text : '#${_hex.text}') != null;
    return SingleChildScrollView(
      padding: EdgeInsets.all(1.4 * rem),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(widget.title, style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
        SizedBox(height: 0.9 * rem),
        Container(
          height: 4 * rem,
          decoration: BoxDecoration(
            color: _color,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: t.text.withAlpha(90), width: 1.5),
          ),
        ),
        SizedBox(height: 0.6 * rem),
        slider('Hue', _hsv.hue, 360, (v) => _set(_hsv.withHue(v >= 360 ? 359.9 : v)), track: hueColors),
        slider('Strength', _hsv.saturation, 1, (v) => _set(_hsv.withSaturation(v)), track: [HSVColor.fromAHSV(1, _hsv.hue, 0, _hsv.value).toColor(), HSVColor.fromAHSV(1, _hsv.hue, 1, _hsv.value).toColor()]),
        slider('Light', _hsv.value, 1, (v) => _set(_hsv.withValue(v)), track: [Colors.black, HSVColor.fromAHSV(1, _hsv.hue, _hsv.saturation, 1).toColor()]),
        if (widget.alpha) slider('Opacity', _hsv.alpha, 1, (v) => _set(_hsv.withAlpha(v))),
        SizedBox(height: 0.4 * rem),
        TextField(
          controller: _hex,
          autocorrect: false,
          enableSuggestions: false,
          maxLength: widget.alpha ? 9 : 7,
          onChanged: _typed,
          style: TextStyle(color: t.text),
          decoration: InputDecoration(labelText: 'Code', counterText: '', labelStyle: TextStyle(color: t.textMuted), hintText: widget.alpha ? '#rrggbbaa' : '#rrggbb'),
        ),
        if (_error != null) Padding(padding: EdgeInsets.only(top: 0.5 * rem), child: Text(_error!, style: const TextStyle(color: Color(0xFFFF6B6B)))),
        SizedBox(height: 1.1 * rem),
        Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
          PekButton(label: 'Use this colour', primary: true, shrink: true, onTap: ok ? () => Navigator.pop(context, _color) : null),
          PekButton(label: 'Cancel', shrink: true, autofocus: true, onTap: () => Navigator.pop(context)),
        ]),
      ]),
    );
  }
}

/// A slider track painted as a colour gradient.
class _GradientTrack extends SliderTrackShape {
  const _GradientTrack(this.colors);
  final List<Color> colors;

  @override
  Rect getPreferredRect({required RenderBox parentBox, Offset offset = Offset.zero, required SliderThemeData sliderTheme, bool isEnabled = false, bool isDiscrete = false}) {
    final h = sliderTheme.trackHeight ?? 8;
    final top = offset.dy + (parentBox.size.height - h) / 2;
    return Rect.fromLTWH(offset.dx + 12, top, parentBox.size.width - 24, h);
  }

  @override
  void paint(PaintingContext context, Offset offset, {required RenderBox parentBox, required SliderThemeData sliderTheme, required Animation<double> enableAnimation, required TextDirection textDirection, required Offset thumbCenter, Offset? secondaryOffset, bool isDiscrete = false, bool isEnabled = false}) {
    final r = getPreferredRect(parentBox: parentBox, offset: offset, sliderTheme: sliderTheme);
    final paint = Paint()..shader = LinearGradient(colors: colors).createShader(r);
    context.canvas.drawRRect(RRect.fromRectAndRadius(r, Radius.circular(r.height / 2)), paint);
  }
}
