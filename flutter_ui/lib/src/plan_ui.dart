import 'package:flutter/material.dart';

import 'cloud.dart';
import 'common.dart';
import 'plugin_host.dart';
import 'tokens.dart';
import 'widgets.dart';

/// "Get PEK Cloud": cloud backup and up to 5 profiles. Payment only ever happens on the website (Stripe), never in the app;
/// this dialog sends the person there and picks the new plan up afterwards.
Future<void> showUpgradeDialog(BuildContext context, {String? why}) async {
  final p = context.pek;
  var note = '';
  var busy = false;
  await showDialog<void>(
    context: context,
    barrierColor: p.tokens.overlay,
    builder: (c) => StatefulBuilder(
      builder: (c, setS) => Dialog(
        backgroundColor: p.tokens.glassStrong,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(p.tokens.radius), side: BorderSide(color: p.tokens.border)),
        child: Padding(
          padding: EdgeInsets.all(1.5 * p.rem),
          child: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('PEK Cloud', style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
              SizedBox(height: 0.6 * p.rem),
              if (why != null) Padding(padding: EdgeInsets.only(bottom: 0.5 * p.rem), child: Text(why, style: TextStyle(color: p.tokens.textMuted))),
              Text('Cloud backup of your watch history, resume points and plugins, and up to 5 profiles.', style: TextStyle(color: p.tokens.textMuted)),
              SizedBox(height: 0.5 * p.rem),
              Text('\$5.99 a month  \u00b7  \$48 a year  \u00b7  \$199 once (lifetime)', style: const TextStyle(fontWeight: FontWeight.w600)),
              SizedBox(height: 0.5 * p.rem),
              Text('You subscribe on the website, signed in with this same account:\n${Cloud.accountPage}', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.9 * p.rem)),
              if (note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.5 * p.rem), child: Text(note, style: TextStyle(color: p.tokens.textMuted))),
              SizedBox(height: 1.1 * p.rem),
              Wrap(spacing: 0.75 * p.rem, runSpacing: 0.75 * p.rem, children: [
                PekButton(
                  label: 'Open the website',
                  primary: true,
                  autofocus: true,
                  onTap: () async {
                    final ok = await PluginHost.openUrl(Cloud.accountPage);
                    if (!ok) setS(() => note = 'Could not open a browser here. Go to ${Cloud.accountPage} on your phone or computer.');
                  },
                ),
                PekButton(
                  label: busy ? 'Checking\u2026' : 'I have subscribed',
                  onTap: busy
                      ? null
                      : () async {
                          setS(() => busy = true);
                          final ok = await Cloud.refreshPlan(force: true);
                          if (!c.mounted) return;
                          if (ok) {
                            Navigator.pop(c);
                            Cloud.sync(light: false);
                          } else {
                            setS(() {
                              busy = false;
                              note = 'No active plan on this account yet. It can take a minute after paying.';
                            });
                          }
                        },
                ),
                PekButton(label: 'Not now', onTap: () => Navigator.pop(c)),
              ]),
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
