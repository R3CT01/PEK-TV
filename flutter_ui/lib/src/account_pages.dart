import 'dart:async';

import 'package:flutter/material.dart';

import 'cloud.dart';
import 'common.dart';
import 'fields.dart';
import 'profile_pages.dart';
import 'plugin_backup_ui.dart';
import 'profiles.dart';
import 'tokens.dart';
import 'widgets.dart';

String _ago(int ms) {
  if (ms <= 0) return 'never';
  final d = DateTime.now().difference(DateTime.fromMillisecondsSinceEpoch(ms));
  if (d.inSeconds < 60) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

/// Settings > Account and Profiles.
class AccountSection extends StatefulWidget {
  const AccountSection({super.key});
  @override
  State<AccountSection> createState() => _AccountSectionState();
}

class _AccountSectionState extends State<AccountSection> {
  bool _busy = false;
  String _note = '';

  Future<void> _syncNow() async {
    setState(() {
      _busy = true;
      _note = 'Syncing\u2026';
    });
    final r = await Cloud.sync();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _note = r.ok ? (r.changed ? 'Synced. New items came in from your other devices.' : 'Synced.') : Cloud.errorText(r.error);
    });
  }

  Future<bool> _confirm(String title, String body, String yes) async {
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
            Text(title, style: TextStyle(fontSize: 1.25 * p.rem, fontWeight: FontWeight.w700)),
            SizedBox(height: 0.6 * p.rem),
            Text(body, style: TextStyle(color: p.tokens.textMuted)),
            SizedBox(height: 1.1 * p.rem),
            Wrap(spacing: 0.75 * p.rem, runSpacing: 0.75 * p.rem, children: [
              PekButton(label: yes, primary: true, onTap: () => Navigator.pop(c, true)),
              PekButton(label: 'Cancel', autofocus: true, onTap: () => Navigator.pop(c, false)),
            ]),
          ]),
        ),
      ),
    );
    return r == true;
  }

  Future<void> _signOut() async {
    final ok = await _confirm('Are you sure you want to sign out?', 'Watch history and resume points of every profile leave this device (the cloud keeps them). You can sign in again any time.', 'Yes, sign out');
    if (!ok) return;
    await Cloud.signOut();
    if (mounted) Navigator.of(context).popUntil((r) => r.isFirst);
  }

  Future<void> _delete() async {
    final ok = await _confirm('Delete the account?', 'This permanently deletes the cloud account with every profile\u2019s history and resume points. It cannot be undone.', 'Delete account');
    if (!ok) return;
    final r = await Cloud.deleteAccount();
    if (!mounted) return;
    if (r.ok) {
      Navigator.of(context).popUntil((r) => r.isFirst);
    } else {
      setState(() => _note = Cloud.errorText(r.error));
    }
  }

  void _open(AccountMode m) => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => AccountScreen(mode: m)));

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return ListenableBuilder(
      listenable: Listenable.merge([Cloud.changes, Profiles.changes]),
      builder: (context, _) {
        if (!Cloud.linked) {
          return Section(
            title: 'Account',
            hint: 'One account for the household. Each profile keeps its own watch history and resume points, and they follow you to your other devices. Profiles need an account.',
            children: [
              Wrap(spacing: 8, runSpacing: 8, children: [
                PekButton(label: 'Sign in', primary: true, onTap: () => _open(AccountMode.signIn)),
                PekButton(label: 'Create account', onTap: () => _open(AccountMode.signUp)),
              ]),
            ],
          );
        }
        final cur = Profiles.current;
        return Section(
          title: 'Account',
          hint: Cloud.username.isEmpty ? Cloud.email : '${Cloud.username} \u00b7 ${Cloud.email}',
          children: [
            Row(children: [
              ProfileAvatar(name: cur.name, color: cur.color, avatar: cur.avatar, size: 3 * rem, locked: cur.locked),
              SizedBox(width: rem),
              Expanded(child: Text('Watching as ${cur.name}', style: TextStyle(fontSize: 1.05 * rem, fontWeight: FontWeight.w600))),
            ]),
            SizedBox(height: 0.75 * rem),
            Text('Last synced: ${_ago(Cloud.lastSync)}', style: TextStyle(color: p.tokens.textMuted)),
            if (_note.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.4 * rem), child: Text(_note, style: TextStyle(color: p.tokens.textMuted))),
            SizedBox(height: 0.75 * rem),
            Wrap(spacing: 8, runSpacing: 8, children: [
              PekButton(label: _busy ? 'Syncing\u2026' : 'Sync now', primary: true, onTap: _busy ? null : _syncNow),
              PekButton(label: 'Switch profile', onTap: () {
                Navigator.of(context).popUntil((r) => r.isFirst);
                Profiles.openPicker();
              }),
              PekButton(label: 'Manage profiles', onTap: () => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const ManageProfilesScreen()))),
              PekButton(label: 'Sign out', onTap: _signOut),
              PekButton(label: 'Delete account', onTap: _delete),
            ]),
            SizedBox(height: 0.5 * rem),
            Text('Library favorites stay on this device. The cloud keeps watch history and resume points.', style: TextStyle(color: p.tokens.textMuted, fontSize: 0.85 * rem)),
            const PluginBackupSettings(),
          ],
        );
      },
    );
  }
}

/// A list of the household's profiles with add / edit, for people who do not want to go through the picker.
class ManageProfilesScreen extends StatelessWidget {
  const ManageProfilesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return SubScreen(
      title: 'Manage profiles',
      body: ListenableBuilder(
        listenable: Profiles.changes,
        builder: (context, _) => ListView(padding: p.pagePad, children: [
          for (final pr in Profiles.list)
            ListRow(
              title: pr.name,
              subtitle: pr.id == Profiles.currentId ? 'Active now${pr.locked ? ' \u00b7 passcode' : ''}' : (pr.locked ? 'Passcode' : ''),
              trailing: ProfileAvatar(name: pr.name, color: pr.color, avatar: pr.avatar, size: 2.4 * p.rem, locked: pr.locked),
              onTap: () => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => ProfileEditor(existing: pr))),
            ),
          if (Profiles.canAdd) ListRow(title: 'Add profile', subtitle: 'Up to ${Profiles.max} people', onTap: () => Navigator.push<void>(context, MaterialPageRoute<void>(builder: (_) => const ProfileEditor()))),
        ]),
      ),
    );
  }
}

enum AccountMode { signIn, signUp, verify, forgot, reset }

/// Sign in, create an account, enter the emailed 6-digit code, or reset a forgotten password.
class AccountScreen extends StatefulWidget {
  const AccountScreen({super.key, required this.mode});
  final AccountMode mode;
  @override
  State<AccountScreen> createState() => _AccountScreenState();
}

class _AccountScreenState extends State<AccountScreen> {
  late AccountMode _mode = widget.mode;
  final _email = TextEditingController();
  final _pass = TextEditingController();
  final _invite = TextEditingController();
  final _name = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  bool _created = false; // the code finishes a brand-new account
  String _error = '';
  String _info = '';

  @override
  void dispose() {
    _email.dispose();
    _pass.dispose();
    _invite.dispose();
    _name.dispose();
    _code.dispose();
    super.dispose();
  }

  void _go(AccountMode m, {String info = ''}) => setState(() {
        _mode = m;
        _error = '';
        _info = info;
      });

  Future<void> _run(Future<CloudResult> Function() job, void Function(CloudResult r) onOk) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = '';
      _info = '';
    });
    final r = await job();
    if (!mounted) return;
    setState(() => _busy = false);
    if (r.ok) {
      onOk(r);
    } else {
      setState(() => _error = Cloud.errorText(r.error));
    }
  }

  void _done() {
    // The profile picker (or the first-time setup) is what comes next; it sits under every pushed screen.
    Navigator.of(context).popUntil((r) => r.isFirst);
  }

  void _submit() {
    switch (_mode) {
      case AccountMode.signIn:
        _run(() => Cloud.signIn(_email.text, _pass.text), (r) {
          if (r.needsVerify) {
            _created = false;
            _go(AccountMode.verify, info: 'We emailed a 6-digit code to ${Cloud.cleanEmail(_email.text)}.');
          } else {
            _done();
          }
        });
      case AccountMode.signUp:
        _run(() => Cloud.signUp(_email.text, _pass.text, invite: _invite.text, name: _name.text), (r) {
          if (r.needsVerify) {
            _created = true;
            _go(AccountMode.verify, info: 'We emailed a 6-digit code to ${Cloud.cleanEmail(_email.text)}.');
          } else {
            _done();
          }
        });
      case AccountMode.verify:
        _run(() => Cloud.verifyEmail(_email.text, _code.text, created: _created), (r) => _done());
      case AccountMode.forgot:
        _run(() => Cloud.forgotPassword(_email.text), (r) => _go(AccountMode.reset, info: 'If that address has an account, a 6-digit code is on its way.'));
      case AccountMode.reset:
        _run(() => Cloud.resetPassword(_email.text, _code.text, _pass.text), (r) => _done());
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final title = switch (_mode) {
      AccountMode.signIn => 'Sign in',
      AccountMode.signUp => 'Create account',
      AccountMode.verify => 'Enter the code',
      AccountMode.forgot => 'Forgot password',
      AccountMode.reset => 'Choose a new password',
    };
    final primary = switch (_mode) {
      AccountMode.signIn => 'Sign in',
      AccountMode.signUp => 'Create account',
      AccountMode.verify => 'Verify',
      AccountMode.forgot => 'Email me a code',
      AccountMode.reset => 'Set password',
    };
    return SubScreen(
      title: title,
      body: ListView(padding: p.pagePad, children: [
        ConstrainedBox(
          constraints: BoxConstraints(maxWidth: 32 * rem),
          child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            if (_info.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Text(_info, style: TextStyle(color: t.textMuted))),
            PekField(label: 'Email', controller: _email, keyboardType: TextInputType.emailAddress, autofocus: true, onSubmitted: _mode == AccountMode.forgot ? _submit : null),
            if (_mode == AccountMode.signIn || _mode == AccountMode.signUp || _mode == AccountMode.reset)
              PekField(label: _mode == AccountMode.reset ? 'New password (8 or more characters)' : 'Password', controller: _pass, obscure: true, onSubmitted: _mode == AccountMode.signIn ? _submit : null),
            if (_mode == AccountMode.signUp) ...[
              PekField(label: 'Invite code (while the cloud is invite-only)', controller: _invite),
              PekField(label: 'Display name (optional)', controller: _name),
            ],
            if (_mode == AccountMode.verify || _mode == AccountMode.reset) PekField(label: '6-digit code', controller: _code, keyboardType: TextInputType.number, onSubmitted: _mode == AccountMode.verify ? _submit : null),
            if (_error.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Text(_error, style: const TextStyle(color: Colors.redAccent))),
            Align(alignment: Alignment.centerLeft, child: PekButton(label: _busy ? 'Please wait\u2026' : primary, primary: true, onTap: _busy ? null : _submit)),
            SizedBox(height: 1.25 * rem),
            Wrap(spacing: 8, runSpacing: 8, children: [
              if (_mode == AccountMode.signIn) ...[
                PekButton(compact: true, label: 'Create account', onTap: () => _go(AccountMode.signUp)),
                PekButton(compact: true, label: 'Forgot password?', onTap: () => _go(AccountMode.forgot)),
              ],
              if (_mode == AccountMode.signUp) PekButton(compact: true, label: 'I have an account', onTap: () => _go(AccountMode.signIn)),
              if (_mode == AccountMode.verify)
                PekButton(
                  compact: true,
                  label: 'Send a new code',
                  onTap: _busy
                      ? null
                      : () => _run(() => Cloud.resendCode(_email.text), (r) => _go(AccountMode.verify, info: 'A new code is on its way.')),
                ),
              if (_mode == AccountMode.forgot || _mode == AccountMode.reset) PekButton(compact: true, label: 'Back to sign in', onTap: () => _go(AccountMode.signIn)),
            ]),
          ]),
        ),
      ]),
    );
  }
}
