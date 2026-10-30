import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show FontFeature;

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'account_pages.dart';
import 'cloud.dart';
import 'common.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Sign in without typing: this screen shows a 6-digit code and a QR code. On the website's verify page (the QR code opens it
/// with the code already filled in) the person signs in, checks the name of this device and taps Approve. This screen asks the
/// cloud every few seconds and signs in as soon as the code is approved. A code lasts 10 minutes; a new one appears by itself.
class LinkScreen extends StatefulWidget {
  const LinkScreen({super.key});
  @override
  State<LinkScreen> createState() => _LinkScreenState();
}

class _LinkScreenState extends State<LinkScreen> {
  String _code = '';
  String _poll = '';
  String _error = '';
  int _expiresAt = 0; // ms since epoch
  bool _starting = false;
  bool _polling = false;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    if (_starting) return;
    _starting = true;
    _timer?.cancel();
    if (mounted) setState(() => _error = '');
    final r = await Cloud.deviceStart();
    _starting = false;
    if (!mounted) return;
    final code = '${r.body['code'] ?? ''}';
    final poll = '${r.body['poll'] ?? ''}';
    if (!r.ok || code.length != 6 || poll.isEmpty) {
      setState(() {
        _code = '';
        _poll = '';
        _error = r.ok ? Cloud.errorText('server') : Cloud.errorText(r.error);
      });
      return;
    }
    final life = ((r.body['expiresIn'] as num?)?.toInt() ?? 600).clamp(60, 3600).toInt();
    final every = ((r.body['interval'] as num?)?.toInt() ?? 3).clamp(2, 10).toInt();
    setState(() {
      _code = code;
      _poll = poll;
      _expiresAt = DateTime.now().millisecondsSinceEpoch + life * 1000;
    });
    _timer = Timer.periodic(Duration(seconds: every), (_) => _tick());
  }

  Future<void> _tick() async {
    if (!mounted || _poll.isEmpty || _starting) return;
    if (DateTime.now().millisecondsSinceEpoch >= _expiresAt) {
      await _start(); // the code ran out: show a fresh one
      return;
    }
    if (_polling) return;
    _polling = true;
    final r = await Cloud.devicePoll(_poll);
    _polling = false;
    if (!mounted) return;
    if (r.ok && !r.pending) {
      // Signed in. The profile picker (or the first-time setup) is what comes next; it sits under every pushed screen.
      Navigator.of(context).popUntil((route) => route.isFirst);
      return;
    }
    if (!r.ok && r.error == 'expired') {
      await _start();
      return;
    }
    if (mounted) setState(() {}); // refreshes the countdown; a network hiccup just tries again next time
  }

  String _left() {
    final s = math.max(0, ((_expiresAt - DateTime.now().millisecondsSinceEpoch) / 1000).ceil());
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final shown = _code.length == 6 ? '${_code.substring(0, 3)} ${_code.substring(3)}' : '';
    final site = Cloud.verifyPage.replaceFirst('https://', '');

    final steps = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('1. Scan the QR code with your phone, or open', style: TextStyle(color: t.textMuted, fontSize: 1.0 * rem)),
      Text(site, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 1.05 * rem)),
      SizedBox(height: 0.5 * rem),
      Text('2. Sign in if it asks, then enter this code:', style: TextStyle(color: t.textMuted, fontSize: 1.0 * rem)),
      SizedBox(height: 0.4 * rem),
      Text(
        shown.isEmpty ? '\u2022\u2022\u2022 \u2022\u2022\u2022' : shown,
        style: TextStyle(fontSize: 3.2 * rem, fontWeight: FontWeight.w800, letterSpacing: 0.3 * rem, color: t.accent, fontFeatures: const [FontFeature.tabularFigures()]),
      ),
      SizedBox(height: 0.4 * rem),
      Text('3. Check that this device is the one shown, then tap Approve.', style: TextStyle(color: t.textMuted, fontSize: 1.0 * rem)),
    ]);

    return SubScreen(
      title: 'Sign in with your phone',
      body: LayoutBuilder(builder: (context, box) {
        final wide = box.maxWidth >= 46 * rem;
        final qrSize = math.min(wide ? 15.0 * rem : 13.0 * rem, math.max(8.0 * rem, box.maxWidth - 2 * rem));
        final qr = _code.isEmpty
            ? SizedBox(width: qrSize, height: qrSize, child: Center(child: _error.isEmpty ? const CircularProgressIndicator() : Icon(Icons.qr_code_2, size: 4 * rem, color: t.textMuted)))
            : QrImageView(
                // White with a quiet border: a phone camera reads it even on a dark theme.
                data: '${Cloud.verifyPage}?code=$_code',
                size: qrSize,
                backgroundColor: Colors.white,
                padding: EdgeInsets.all(0.7 * rem),
              );
        return ListView(padding: p.pagePad, children: [
          if (wide)
            Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
              qr,
              SizedBox(width: 2.5 * rem),
              Expanded(child: steps),
            ])
          else ...[
            Center(child: qr),
            SizedBox(height: 1.2 * rem),
            steps,
          ],
          SizedBox(height: 1.2 * rem),
          if (_error.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Text(_error, style: const TextStyle(color: Colors.redAccent))),
          if (_code.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Text('This code works for ${_left()} more. A new one appears by itself. This screen signs in as soon as you approve.', style: TextStyle(color: t.textMuted, fontSize: 0.9 * rem))),
          Wrap(spacing: 8, runSpacing: 8, children: [
            PekButton(label: _code.isEmpty && _error.isNotEmpty ? 'Try again' : 'New code', autofocus: true, onTap: _starting ? null : _start),
            PekButton(
              label: 'Use email and password',
              onTap: () => Navigator.pushReplacement<void, void>(context, MaterialPageRoute<void>(builder: (_) => const AccountScreen(mode: AccountMode.signIn))),
            ),
          ]),
        ]);
      }),
    );
  }
}
