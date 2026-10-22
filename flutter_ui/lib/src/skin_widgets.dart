import 'package:flutter/material.dart';

import 'skins.dart';
import 'tokens.dart';
import 'widgets.dart';

// Drawing helpers the "Skin maker" plugin (plugins/skin-maker) asks the app for. The plugin only *describes* a colour row,
// a slider and a preview as data (pek_ui.color_row / slider / skin_preview); these widgets are what the app draws for them.
// The maker's own logic (the colours, the checks, saving) lives in the plugin's screen.py, not here.

/// A small copy of the app drawn with the draft colours, so every change shows at once.
class SkinPreview extends StatelessWidget {
  const SkinPreview({super.key, required this.tokens});
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
