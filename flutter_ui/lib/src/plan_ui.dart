import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'cloud.dart';
import 'common.dart';
import 'plugin_host.dart';
import 'tokens.dart';
import 'widgets.dart';

/// The PEK Cloud prices, shown in the app. The real prices live on the website (Stripe); keep these in step with it.
class PlanPrices {
  static const monthly = 5.99;
  static const yearly = 48.0;
  static const lifetime = 199.0;

  /// What twelve monthly payments cost minus the yearly price.
  static double get yearlySaving => monthly * 12 - yearly; // 23.88
  static int get yearlySavingPercent => (yearlySaving / (monthly * 12) * 100).round(); // 33
  static String get yearlyPerMonth => (yearly / 12).toStringAsFixed(2); // 4.00
}

/// "Free" or "Paid" for the Account page, with the plan's name and, for monthly / yearly, when the period ends.
class PlanBadge extends StatelessWidget {
  const PlanBadge({super.key});

  static String _date(int ms) {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    final d = DateTime.fromMillisecondsSinceEpoch(ms);
    return '${m[d.month - 1]} ${d.day}, ${d.year}';
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final paid = Cloud.entitled;
    final detail = !paid
        ? 'No cloud backup \u00b7 1 profile'
        : switch (Cloud.plan) {
            'monthly' || 'yearly' => Cloud.planUntil > 0 ? '${Cloud.planLabel} \u00b7 active until ${_date(Cloud.planUntil)}' : Cloud.planLabel,
            _ => Cloud.planLabel,
          };
    return Row(children: [
      Container(
        padding: EdgeInsets.symmetric(horizontal: 0.7 * rem, vertical: 0.25 * rem),
        decoration: BoxDecoration(
          color: paid ? t.accent : t.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: paid ? t.accent : t.border),
        ),
        child: Text(paid ? 'PAID' : 'FREE', style: TextStyle(fontSize: 0.8 * rem, fontWeight: FontWeight.w800, letterSpacing: 1.0, color: paid ? Colors.white : t.text)),
      ),
      SizedBox(width: 0.75 * rem),
      Expanded(child: Text(detail, style: TextStyle(color: t.textMuted))),
    ]);
  }
}

/// How to get PEK Cloud: the prices (with what the yearly plan saves), a QR code that opens the website on a phone, and the
/// address in writing for people who would rather type it into a browser. Payment only ever happens on the website.
///
/// While it is on screen it asks the cloud which plan the account has every few seconds (and the moment the app comes back
/// from the browser), so the moment a payment goes through the app notices: [Cloud.changes] fires, every screen that shows
/// the plan repaints, and [onPaid] is called once.
class SubscribeBox extends StatefulWidget {
  const SubscribeBox({super.key, this.onPaid, this.why, this.autofocus = false, this.extraButtons = const []});
  final VoidCallback? onPaid;

  /// Focus "Open the website" at once (the dialog does; on the Account page it would steal the focus).
  final bool autofocus;
  final String? why;

  /// More buttons after "Open the website" / "I have subscribed" (the dialog adds "Not now").
  final List<Widget> extraButtons;

  @override
  State<SubscribeBox> createState() => _SubscribeBoxState();
}

class _SubscribeBoxState extends State<SubscribeBox> with WidgetsBindingObserver {
  Timer? _timer;
  int _ticks = 0;
  bool _checking = false;
  bool _done = false;
  String _note = '';

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _schedule();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _timer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) unawaited(_check()); // back from the browser: look now
  }

  /// Every 5 seconds for the first 10 minutes, then every 30 seconds.
  void _schedule() {
    _timer?.cancel();
    if (_done) return;
    _timer = Timer(Duration(seconds: _ticks < 120 ? 5 : 30), () async {
      _ticks++;
      await _check();
      if (mounted) _schedule();
    });
  }

  Future<bool> _check({bool manual = false}) async {
    if (_done || _checking || !Cloud.linked) return false;
    _checking = true;
    if (manual && mounted) setState(() => _note = '');
    final ok = await Cloud.refreshPlan(force: true);
    _checking = false;
    if (ok && !_done) {
      _done = true;
      _timer?.cancel();
      unawaited(Cloud.sync(light: false)); // the first backup, now that it is unlocked
      widget.onPaid?.call();
    } else if (manual && mounted && !ok) {
      setState(() => _note = 'No active plan on this account yet. It can take a minute after paying.');
    }
    return ok;
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final url = Cloud.accountPage;
    final shown = url.replaceFirst('https://', '');
    final price = TextStyle(fontWeight: FontWeight.w600, fontSize: 1.0 * rem);
    final muted = TextStyle(color: t.textMuted, fontSize: 0.9 * rem);

    final info = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (widget.why != null) Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: Text(widget.why!, style: TextStyle(color: t.textMuted))),
      Text('PEK Cloud backs up your watch history, resume points and plugins, and adds up to 5 profiles.', style: TextStyle(color: t.textMuted)),
      SizedBox(height: 0.6 * rem),
      Text('\$${PlanPrices.monthly} a month', style: price),
      SizedBox(height: 0.15 * rem),
      Text('\$${PlanPrices.yearly.toStringAsFixed(0)} a year \u00b7 just \$${PlanPrices.yearlyPerMonth} a month', style: price),
      Text('Save \$${PlanPrices.yearlySaving.toStringAsFixed(2)} a year (${PlanPrices.yearlySavingPercent}% off) compared with paying monthly', style: TextStyle(color: t.accent, fontWeight: FontWeight.w600, fontSize: 0.9 * rem)),
      SizedBox(height: 0.15 * rem),
      Text('\$${PlanPrices.lifetime.toStringAsFixed(0)} once (lifetime)', style: price),
      SizedBox(height: 0.8 * rem),
      Text('Scan the QR code with your phone, or type this into a browser:', style: muted),
      SizedBox(height: 0.2 * rem),
      Text(shown, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 1.05 * rem)),
      SizedBox(height: 0.2 * rem),
      Text('Sign in with this same account, choose a plan and pay with Stripe. This screen updates by itself when the payment goes through.', style: muted),
    ]);

    return LayoutBuilder(builder: (context, box) {
      final wide = box.maxWidth >= 30 * rem;
      final qrSize = math.min(wide ? 10.0 * rem : 11.0 * rem, math.max(7.0 * rem, box.maxWidth - 2 * rem));
      // White with a quiet border: a phone camera reads it even on a dark theme.
      final qr = QrImageView(data: url, size: qrSize, backgroundColor: Colors.white, padding: EdgeInsets.all(0.6 * rem));
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (wide)
          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            qr,
            SizedBox(width: 1.5 * rem),
            Expanded(child: info),
          ])
        else ...[
          info,
          SizedBox(height: 0.8 * rem),
          Center(child: qr),
        ],
        if (_note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.6 * rem), child: Text(_note, style: muted)),
        SizedBox(height: 0.9 * rem),
        Wrap(spacing: 0.75 * rem, runSpacing: 0.75 * rem, children: [
          PekButton(
            label: 'Open the website',
            primary: true,
            autofocus: widget.autofocus,
            onTap: () async {
              final ok = await PluginHost.openUrl(url);
              if (!ok && mounted) setState(() => _note = 'Could not open a browser here. Use the QR code, or go to $shown on your phone or computer.');
            },
          ),
          PekButton(label: 'I have subscribed', onTap: () => _check(manual: true)),
          ...widget.extraButtons,
        ]),
      ]);
    });
  }
}

/// "Get PEK Cloud": cloud backup and up to 5 profiles. Payment only ever happens on the website (Stripe), never in the app;
/// this dialog shows how to get there (button, QR code, address) and closes itself when the new plan arrives.
Future<void> showUpgradeDialog(BuildContext context, {String? why}) async {
  final p = context.pek;
  await showDialog<void>(
    context: context,
    barrierColor: p.tokens.overlay,
    builder: (c) => Dialog(
      backgroundColor: p.tokens.glassStrong,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(p.tokens.radius), side: BorderSide(color: p.tokens.border)),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 40 * p.rem),
        child: Padding(
          padding: EdgeInsets.all(1.5 * p.rem),
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('PEK Cloud', style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
              SizedBox(height: 0.6 * p.rem),
              SubscribeBox(
                why: why,
                autofocus: true,
                onPaid: () {
                  if (c.mounted) Navigator.pop(c);
                },
                extraButtons: [PekButton(label: 'Not now', onTap: () => Navigator.pop(c))],
              ),
            ]),
          ),
        ),
      ),
    ),
  );
}

/// Opens a page of the website in the browser; on a device with no browser it says where to go instead.
Future<void> openSitePage(BuildContext context, String url) async {
  final ok = await PluginHost.openUrl(url);
  if (!ok && context.mounted) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text('Could not open a browser here. Go to $url on your phone or computer.')));
  }
}

/// Accounts are only created on the website (with an invite code). The app just signs in.
Future<void> openSignUpPage(BuildContext context) => openSitePage(context, Cloud.signUpPage);
