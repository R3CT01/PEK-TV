import 'dart:async';

import 'package:flutter/material.dart';

import 'cloud.dart';
import 'common.dart';
import 'fields.dart';
import 'profiles.dart';
import 'tokens.dart';
import 'widgets.dart';

/// A round picture: the profile's own photo, a built-in picture, or its first letter, on the profile's colour.
class ProfileAvatar extends StatelessWidget {
  const ProfileAvatar({super.key, required this.name, required this.color, this.avatar = '', this.size = 96, this.locked = false});
  final String name;
  final String color;
  final String avatar;
  final double size;
  final bool locked;

  @override
  Widget build(BuildContext context) {
    final photo = Profiles.photoBytes(avatar);
    final emoji = avatar.startsWith('b:') ? Profiles.builtIn[avatar.substring(2)] : null;
    Widget face;
    if (photo != null) {
      face = ClipOval(child: Image.memory(photo, width: size, height: size, fit: BoxFit.cover, gaplessPlayback: true));
    } else {
      face = Container(
        width: size,
        height: size,
        alignment: Alignment.center,
        decoration: BoxDecoration(color: Profiles.parseColor(color), shape: BoxShape.circle),
        child: Text(
          emoji ?? (name.isEmpty ? '?' : String.fromCharCode(name.runes.first).toUpperCase()),
          style: TextStyle(fontSize: size * (emoji != null ? 0.5 : 0.45), fontWeight: FontWeight.w700, color: Colors.white),
        ),
      );
    }
    if (!locked) return face;
    return Stack(clipBehavior: Clip.none, children: [
      face,
      Positioned(right: -2, bottom: -2, child: Icon(Icons.lock, size: size * 0.28, color: Colors.white, shadows: const [Shadow(blurRadius: 4)])),
    ]);
  }
}

// ====================================================================== passcode pad

const _forgot = '\u0000forgot';

/// Four digits on a pad that works with a remote. Returns the digits, [_forgot], or null when cancelled.
Future<String?> pinDialog(BuildContext context, {required String title, String sub = '', bool showForgot = false}) {
  return showDialog<String>(
    context: context,
    barrierColor: context.pek.tokens.overlay,
    builder: (c) => _PinPad(title: title, sub: sub, showForgot: showForgot),
  );
}

class _PinPad extends StatefulWidget {
  const _PinPad({required this.title, required this.sub, required this.showForgot});
  final String title;
  final String sub;
  final bool showForgot;
  @override
  State<_PinPad> createState() => _PinPadState();
}

class _PinPadState extends State<_PinPad> {
  String _digits = '';

  void _press(String d) {
    if (_digits.length >= 4) return;
    setState(() => _digits += d);
    if (_digits.length == 4) {
      final v = _digits;
      Future<void>.delayed(const Duration(milliseconds: 120), () {
        if (mounted) Navigator.pop(context, v);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    Widget key(String label, VoidCallback onTap, {bool autofocus = false}) => SizedBox(
          width: 4.2 * rem,
          child: PekButton(label: label, onTap: onTap, autofocus: autofocus),
        );
    return Dialog(
      backgroundColor: t.glassStrong,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(t.radius), side: BorderSide(color: t.border)),
      child: Padding(
        padding: EdgeInsets.all(1.5 * rem),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Text(widget.title, textAlign: TextAlign.center, style: TextStyle(fontSize: 1.25 * rem, fontWeight: FontWeight.w700)),
          if (widget.sub.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.4 * rem), child: Text(widget.sub, textAlign: TextAlign.center, style: TextStyle(color: t.textMuted))),
          SizedBox(height: rem),
          Row(mainAxisSize: MainAxisSize.min, children: [
            for (var i = 0; i < 4; i++)
              Container(
                margin: EdgeInsets.symmetric(horizontal: 0.4 * rem),
                width: 0.9 * rem,
                height: 0.9 * rem,
                decoration: BoxDecoration(shape: BoxShape.circle, color: i < _digits.length ? t.accent : Colors.transparent, border: Border.all(color: t.borderFocus, width: 2)),
              ),
          ]),
          SizedBox(height: rem),
          for (final row in const [
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
          ])
            Padding(
              padding: EdgeInsets.only(bottom: 0.5 * rem),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                for (final d in row) Padding(padding: EdgeInsets.symmetric(horizontal: 0.25 * rem), child: key(d, () => _press(d), autofocus: d == '5')),
              ]),
            ),
          Row(mainAxisSize: MainAxisSize.min, children: [
            Padding(padding: EdgeInsets.symmetric(horizontal: 0.25 * rem), child: key('\u232B', () => setState(() => _digits = _digits.isEmpty ? '' : _digits.substring(0, _digits.length - 1)))),
            Padding(padding: EdgeInsets.symmetric(horizontal: 0.25 * rem), child: key('0', () => _press('0'))),
            Padding(padding: EdgeInsets.symmetric(horizontal: 0.25 * rem), child: key('Back', () => Navigator.pop(context))),
          ]),
          if (widget.showForgot) ...[
            SizedBox(height: 0.75 * rem),
            PekButton(compact: true, label: 'Forgot passcode?', onTap: () => Navigator.pop(context, _forgot)),
          ],
        ]),
      ),
    );
  }
}

/// Asks for the profile's passcode until it is right. Forgetting it is solved with the account password.
Future<bool> verifyPin(BuildContext context, Profile p) async {
  var sub = p.name;
  for (;;) {
    final v = await pinDialog(context, title: 'Enter passcode', sub: sub, showForgot: true);
    if (v == null || !context.mounted) return false;
    if (v == _forgot) return _resetPinWithPassword(context, p);
    if (Profiles.checkPin(p.pin, v)) return true;
    sub = 'Wrong passcode. Try again.';
  }
}

Future<bool> _resetPinWithPassword(BuildContext context, Profile p) async {
  final c = TextEditingController();
  String? error;
  final ok = await showDialog<bool>(
    context: context,
    barrierColor: context.pek.tokens.overlay,
    builder: (dc) => StatefulBuilder(builder: (dc, setS) {
      final pk = dc.pek;
      return Dialog(
        backgroundColor: pk.tokens.glassStrong,
        child: Padding(
          padding: EdgeInsets.all(1.5 * pk.rem),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Remove the passcode', style: TextStyle(fontSize: 1.25 * pk.rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.5 * pk.rem),
            Text('Type the password of the account (${Cloud.email}) to remove this profile\u2019s passcode.', style: TextStyle(color: pk.tokens.textMuted)),
            SizedBox(height: pk.rem),
            PekField(label: 'Account password', controller: c, obscure: true, autofocus: true),
            if (error != null) Padding(padding: EdgeInsets.only(bottom: 0.5 * pk.rem), child: Text(error!, style: const TextStyle(color: Colors.redAccent))),
            Wrap(spacing: 0.75 * pk.rem, runSpacing: 0.75 * pk.rem, children: [
              PekButton(
                label: 'Remove passcode',
                primary: true,
                onTap: () async {
                  final r = await Cloud.confirmPassword(c.text);
                  if (!dc.mounted) return;
                  if (r.ok) {
                    Navigator.pop(dc, true);
                  } else {
                    setS(() => error = r.error == 'not_found' ? 'Update the cloud service to use this.' : Cloud.errorText(r.error));
                  }
                },
              ),
              PekButton(label: 'Cancel', onTap: () => Navigator.pop(dc, false)),
            ]),
          ]),
        ),
      );
    }),
  );
  c.dispose();
  if (ok == true) {
    Profiles.update(p.id, name: p.name, pin: '');
    unawaited(Cloud.sync(light: false));
    return true;
  }
  return false;
}

// ====================================================================== Who's watching?

/// Shown once per run of the app while an account is signed in (and for the first-time setup). Nothing else starts until a
/// profile is picked.
class ProfileGate extends StatefulWidget {
  const ProfileGate({super.key});
  @override
  State<ProfileGate> createState() => _ProfileGateState();
}

class _ProfileGateState extends State<ProfileGate> {
  bool _manage = false;

  Future<void> _pick(Profile p) async {
    if (_manage) {
      await _edit(p);
      return;
    }
    if (p.locked) {
      final ok = await verifyPin(context, p);
      if (!ok || !mounted) return;
    }
    Profiles.enter(p.id);
    unawaited(Cloud.sync(light: false)); // bring this profile's history and resume points up to date
  }

  Future<void> _edit(Profile? p) async {
    await Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => ProfileEditor(existing: p)));
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    return ListenableBuilder(
      listenable: Profiles.changes,
      builder: (context, _) {
        if (Profiles.needsSetup) return const _FirstSetup();
        final size = (p.narrow ? 5.5 : 7) * rem;
        return Scaffold(
          backgroundColor: t.bg,
          body: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: EdgeInsets.all(1.5 * rem),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Text(_manage ? 'Manage profiles' : 'Who\u2019s watching?', style: TextStyle(fontSize: (p.narrow ? 1.8 : 2.4) * rem, fontWeight: FontWeight.w700)),
                  SizedBox(height: 2 * rem),
                  Wrap(alignment: WrapAlignment.center, spacing: 1.5 * rem, runSpacing: 1.5 * rem, children: [
                    for (var i = 0; i < Profiles.list.length; i++) _tile(context, Profiles.list[i], size, autofocus: i == 0),
                    if (Profiles.canAdd) _addTile(context, size),
                  ]),
                  SizedBox(height: 2.5 * rem),
                  Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, alignment: WrapAlignment.center, children: [
                    PekButton(label: _manage ? 'Done' : 'Manage profiles', onTap: () => setState(() => _manage = !_manage)),
                  ]),
                ]),
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _tile(BuildContext context, Profile pr, double size, {bool autofocus = false}) {
    final p = context.pek;
    final rem = p.rem;
    return PekFocusable(
      autofocus: autofocus,
      onTap: () => _pick(pr),
      radius: p.tokens.radius,
      padding: EdgeInsets.all(0.6 * rem),
      child: SizedBox(
        width: size + 1 * rem,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Stack(alignment: Alignment.center, children: [
            ProfileAvatar(name: pr.name, color: pr.color, avatar: pr.avatar, size: size, locked: pr.locked),
            if (_manage) Container(width: size, height: size, decoration: const BoxDecoration(shape: BoxShape.circle, color: Color(0x88000000)), child: const Icon(Icons.edit, color: Colors.white)),
          ]),
          SizedBox(height: 0.6 * rem),
          Text(pr.name, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600)),
        ]),
      ),
    );
  }

  Widget _addTile(BuildContext context, double size) {
    final p = context.pek;
    final rem = p.rem;
    return PekFocusable(
      onTap: () => _edit(null),
      radius: p.tokens.radius,
      padding: EdgeInsets.all(0.6 * rem),
      child: SizedBox(
        width: size + 1 * rem,
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: size,
            height: size,
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: p.tokens.textMuted, width: 2)),
            child: Icon(Icons.add, size: size * 0.5, color: p.tokens.textMuted),
          ),
          SizedBox(height: 0.6 * rem),
          Text('Add profile', style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600, color: p.tokens.textMuted)),
        ]),
      ),
    );
  }
}

/// The mandatory first-time screen: name + picture turn the profile that already holds everything watched into the main one.
class _FirstSetup extends StatefulWidget {
  const _FirstSetup();
  @override
  State<_FirstSetup> createState() => _FirstSetupState();
}

class _FirstSetupState extends State<_FirstSetup> {
  final _name = TextEditingController();
  String _color = Profiles.colors[0];
  String _avatar = '';
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  void _go() {
    final n = Profiles.cleanName(_name.text);
    if (n.isEmpty) {
      setState(() => _error = 'Type a name.');
      return;
    }
    Profiles.finishSetup(n, _color, _avatar);
    Profiles.enter('p1');
    unawaited(Cloud.sync(light: false));
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return Scaffold(
      backgroundColor: p.tokens.bg,
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: EdgeInsets.all(1.5 * rem),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 28 * rem),
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Text('Set up your profile', textAlign: TextAlign.center, style: TextStyle(fontSize: 1.8 * rem, fontWeight: FontWeight.w700)),
                SizedBox(height: 0.5 * rem),
                Text('Everything you watched so far belongs to this profile. You can add more people afterwards.', textAlign: TextAlign.center, style: TextStyle(color: p.tokens.textMuted)),
                SizedBox(height: 1.5 * rem),
                Center(child: ProfileAvatar(name: _name.text, color: _color, avatar: _avatar, size: 6 * rem)),
                SizedBox(height: 1.25 * rem),
                PekField(label: 'Name', controller: _name, autofocus: true, onSubmitted: _go),
                AvatarPicker(color: _color, avatar: _avatar, onColor: (c) => setState(() => _color = c), onAvatar: (a) => setState(() => _avatar = a)),
                if (_error != null) Padding(padding: EdgeInsets.only(top: 0.5 * rem), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
                SizedBox(height: 1.25 * rem),
                PekButton(label: 'Continue', primary: true, onTap: _go),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// A row of colours and a row of built-in pictures.
class AvatarPicker extends StatelessWidget {
  const AvatarPicker({super.key, required this.color, required this.avatar, required this.onColor, required this.onAvatar});
  final String color;
  final String avatar;
  final ValueChanged<String> onColor;
  final ValueChanged<String> onAvatar;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final t = p.tokens;
    final dot = 2.2 * rem;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Colour', style: TextStyle(color: t.textMuted)),
      SizedBox(height: 0.4 * rem),
      Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
        for (final c in Profiles.colors)
          PekFocusable(
            onTap: () => onColor(c),
            radius: 100,
            background: Profiles.parseColor(c),
            borderColor: c == color ? t.borderFocus : Colors.transparent,
            child: SizedBox(width: dot, height: dot, child: c == color ? const Icon(Icons.check, color: Colors.white) : null),
          ),
      ]),
      SizedBox(height: 0.9 * rem),
      Text('Picture', style: TextStyle(color: t.textMuted)),
      SizedBox(height: 0.4 * rem),
      Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
        PekFocusable(
          onTap: () => onAvatar(''),
          radius: 100,
          background: t.surface,
          borderColor: avatar.isEmpty ? t.borderFocus : t.border,
          child: SizedBox(width: dot, height: dot, child: Center(child: Text('Aa', style: TextStyle(fontSize: 0.9 * rem, fontWeight: FontWeight.w700)))),
        ),
        for (final e in Profiles.builtIn.entries)
          PekFocusable(
            onTap: () => onAvatar('b:${e.key}'),
            radius: 100,
            background: t.surface,
            borderColor: avatar == 'b:${e.key}' ? t.borderFocus : t.border,
            child: SizedBox(width: dot, height: dot, child: Center(child: Text(e.value, style: TextStyle(fontSize: 1.15 * rem)))),
          ),
      ]),
    ]);
  }
}

// ====================================================================== add / edit a profile

class ProfileEditor extends StatefulWidget {
  const ProfileEditor({super.key, this.existing});
  final Profile? existing;
  @override
  State<ProfileEditor> createState() => _ProfileEditorState();
}

class _ProfileEditorState extends State<ProfileEditor> {
  late final TextEditingController _name = TextEditingController(text: widget.existing?.name ?? '');
  late String _color = widget.existing?.color ?? Profiles.nextColor();
  late String _avatar = widget.existing?.avatar ?? '';
  late String _pin = widget.existing?.pin ?? '';
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _setPin() async {
    final a = await pinDialog(context, title: 'New passcode', sub: 'Four digits');
    if (a == null || a == _forgot || !mounted) return;
    final b = await pinDialog(context, title: 'Enter it again');
    if (b == null || !mounted) return;
    if (a != b) {
      setState(() => _error = 'The two passcodes did not match.');
      return;
    }
    setState(() {
      _pin = Profiles.makePin(a);
      _error = null;
    });
  }

  Future<void> _removePin() async {
    final ex = widget.existing;
    if (ex != null && ex.locked) {
      final ok = await verifyPin(context, ex);
      if (!ok || !mounted) return;
    }
    setState(() => _pin = '');
  }

  void _save() {
    final n = Profiles.cleanName(_name.text);
    final ex = widget.existing;
    if (n.isEmpty) {
      setState(() => _error = 'Type a name.');
      return;
    }
    if (Profiles.nameTaken(n, exceptId: ex?.id)) {
      setState(() => _error = 'Someone already has that name.');
      return;
    }
    if (ex == null) {
      Profiles.add(n, color: _color, avatar: _avatar, pin: _pin);
    } else {
      Profiles.update(ex.id, name: n, color: _color, avatar: _avatar, pin: _pin);
    }
    unawaited(Cloud.sync(light: false)); // the profile list reaches the other devices
    Navigator.pop(context);
  }

  Future<void> _delete() async {
    final ex = widget.existing;
    if (ex == null) return;
    final p = context.pek;
    final yes = await showDialog<bool>(
      context: context,
      barrierColor: p.tokens.overlay,
      builder: (c) => Dialog(
        backgroundColor: p.tokens.glassStrong,
        child: Padding(
          padding: EdgeInsets.all(1.5 * p.rem),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('Delete ${ex.name}?', style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.5 * p.rem),
            Text('Its watch history, resume points and favorites are removed from this device and the cloud.', style: TextStyle(color: p.tokens.textMuted)),
            SizedBox(height: p.rem),
            Wrap(spacing: 0.75 * p.rem, runSpacing: 0.75 * p.rem, children: [
              PekButton(label: 'Delete', primary: true, onTap: () => Navigator.pop(c, true)),
              PekButton(label: 'Keep it', autofocus: true, onTap: () => Navigator.pop(c, false)),
            ]),
          ]),
        ),
      ),
    );
    if (yes != true || !mounted) return;
    if (ex.locked) {
      final ok = await verifyPin(context, ex);
      if (!ok || !mounted) return;
    }
    final done = await Profiles.remove(ex.id);
    if (!mounted) return;
    if (!done) {
      setState(() => _error = 'At least one profile has to stay.');
      return;
    }
    unawaited(Cloud.sync(light: false));
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final ex = widget.existing;
    return SubScreen(
      title: ex == null ? 'Add profile' : 'Edit profile',
      body: ListView(padding: p.pagePad, children: [
        Center(child: ProfileAvatar(name: _name.text, color: _color, avatar: _avatar, size: 6 * rem, locked: _pin.isNotEmpty)),
        SizedBox(height: rem),
        PekField(label: 'Name', controller: _name, autofocus: ex == null, onSubmitted: _save),
        AvatarPicker(color: _color, avatar: _avatar, onColor: (c) => setState(() => _color = c), onAvatar: (a) => setState(() => _avatar = a)),
        SizedBox(height: 1.25 * rem),
        Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
          PekButton(label: _pin.isEmpty ? 'Set a passcode' : 'Change passcode', onTap: _setPin),
          if (_pin.isNotEmpty) PekButton(label: 'Remove passcode', onTap: _removePin),
        ]),
        if (_error != null) Padding(padding: EdgeInsets.only(top: 0.75 * rem), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        SizedBox(height: 1.5 * rem),
        Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
          PekButton(label: 'Save', primary: true, onTap: _save),
          PekButton(label: 'Cancel', onTap: () => Navigator.pop(context)),
          if (ex != null && Profiles.list.length > 1) PekButton(label: 'Delete profile', onTap: _delete),
        ]),
      ]),
    );
  }
}
