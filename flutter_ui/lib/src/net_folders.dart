import 'dart:async';

import 'package:flutter/material.dart';

import 'api.dart';
import 'common.dart';
import 'fields.dart';
import 'mpv.dart';
import 'tokens.dart';
import 'widgets.dart';

/// Add Network Folder (SMB, NFS, FTP, WebDAV and DLNA found on the local network): `openNetPicker` in app_sources.js.
/// Pops with `true` once a folder was added.
class NetFolderPage extends StatefulWidget {
  const NetFolderPage({super.key});
  @override
  State<NetFolderPage> createState() => _NetFolderPageState();
}

enum _Stage { hosts, login, share, browse }

class _NetFolderPageState extends State<NetFolderPage> {
  _Stage _stage = _Stage.hosts;
  bool _busy = false;
  String? _error;

  // hosts
  NetDiscovery _found = const NetDiscovery(scanning: true, unsupported: [], hosts: []);
  final _typed = TextEditingController();
  bool _disposed = false;

  // login / share / browse
  String _url = '';
  bool _triedLogin = false;
  final _user = TextEditingController();
  final _pass = TextEditingController();
  final _share = TextEditingController();
  Map<String, dynamic> _listing = const {};

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _disposed = true;
    PekPlayer.setMulticast(false);
    _typed.dispose();
    _user.dispose();
    _pass.dispose();
    _share.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    setState(() {
      _stage = _Stage.hosts;
      _error = null;
      _found = NetDiscovery(scanning: true, unsupported: _found.unsupported, hosts: _found.hosts);
    });
    await PekPlayer.setMulticast(true);
    await Api.discoverStart();
    for (var n = 0; n < 20 && !_disposed; n++) {
      try {
        final d = await Api.discoverPoll();
        if (_disposed) return;
        setState(() => _found = d);
        if (!d.scanning) break;
      } catch (_) {
        break;
      }
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    await PekPlayer.setMulticast(false);
    if (!_disposed) setState(() => _found = NetDiscovery(scanning: false, unsupported: _found.unsupported, hosts: _found.hosts));
  }

  /// A full URL (ftp://nas, dav://nas:8080/files, nfs://nas ...) is used as it is; a bare name or IP means an SMB share.
  String _typedUrl() {
    final t = _typed.text.trim();
    if (t.isEmpty) return '';
    return RegExp(r'^[a-z]+://', caseSensitive: false).hasMatch(t) ? t : 'smb://$t';
  }

  void _openTyped() {
    final url = _typedUrl();
    if (url.isEmpty) {
      setState(() => _error = 'Enter the address of the device first.');
      return;
    }
    _user.clear();
    _pass.clear();
    _triedLogin = false;
    _browse(url, creds: false);
  }

  void _openHost(NetHost h) {
    _user.clear();
    _pass.clear();
    _triedLogin = false;
    _browse(h.url, creds: false);
  }

  Future<void> _browse(String url, {required bool creds}) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    Map<String, dynamic> d;
    try {
      d = await Api.netBrowse(url, user: creds ? _user.text : null, pass: creds ? _pass.text : null);
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Could not reach the PEK TV server.';
      });
      return;
    }
    if (!mounted) return;
    if (d['ok'] != true) {
      setState(() {
        _busy = false;
        if (d['auth'] == true) {
          _stage = _Stage.login;
          _url = url;
          _error = _triedLogin ? 'Wrong user name or password.' : null;
        } else if (d['canTypeShare'] == true) {
          _stage = _Stage.share;
          _url = url;
          _error = '${d['error'] ?? ''}';
        } else {
          _error = '${d['error'] ?? 'Could not open that location.'}';
        }
      });
      return;
    }
    setState(() {
      _busy = false;
      _stage = _Stage.browse;
      _listing = d;
    });
  }

  void _back() {
    if (_stage == _Stage.browse && '${_listing['parent'] ?? ''}'.isNotEmpty) {
      _browse('${_listing['parent']}', creds: false);
    } else if (_stage != _Stage.hosts) {
      setState(() {
        _stage = _Stage.hosts;
        _error = null;
      });
    } else {
      Navigator.pop(context, false);
    }
  }

  Future<void> _add() async {
    final url = '${_listing['path'] ?? ''}';
    setState(() {
      _busy = true;
      _error = null;
    });
    final err = await Api.addNetSource(url, user: _user.text, pass: _pass.text);
    if (!mounted) return;
    if (err == null) {
      Navigator.pop(context, true);
      return;
    }
    setState(() {
      _busy = false;
      _error = err;
    });
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    Widget sub(String s) => Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: Text(s, style: TextStyle(color: t.textMuted)));
    Widget err() => _error == null || _error!.isEmpty ? const SizedBox.shrink() : Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: Text(_error!, style: const TextStyle(color: Color(0xFFFF6B5E))));

    final List<Widget> body;
    switch (_stage) {
      case _Stage.hosts:
        final missing = _found.unsupported.map((e) => e.toUpperCase()).join(' / ');
        body = [
          if (missing.isNotEmpty) Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: Text('This build can find $missing devices but cannot open them (no $missing support).', style: const TextStyle(color: Color(0xFFFF6B5E)))),
          sub('Devices sharing files on your network:'),
          for (final h in _found.hosts) ListRow(title: h.name, subtitle: '${h.label}${h.name == h.address ? '' : ' \u00b7 ${h.address}'}', onTap: () => _openHost(h)),
          if (_found.hosts.isEmpty) sub(_found.scanning ? 'Searching your network\u2026' : 'Nothing found. Check that this device and the share are on the same Wi-Fi, or type the address below.')
          else if (_found.scanning) sub('Still searching\u2026'),
          err(),
          SizedBox(height: 0.5 * rem),
          PekField(label: 'Or type an address', controller: _typed, hint: 'my-nas   or   ftp://192.168.1.20   or   dav://nas:8080', onSubmitted: _openTyped, keyboardType: TextInputType.url),
          Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            PekButton(label: 'Open', primary: true, onTap: _openTyped),
            PekButton(label: _found.scanning ? 'Searching\u2026' : 'Search again', onTap: _found.scanning ? null : _search),
          ]),
        ];
      case _Stage.login:
        body = [
          sub('Sign in to $_url'),
          err(),
          PekField(label: 'User name', controller: _user, hint: 'user or DOMAIN\\user', autofocus: true),
          PekField(label: 'Password', controller: _pass, obscure: true, onSubmitted: () {
            _triedLogin = true;
            _browse(_url, creds: true);
          }),
          Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            PekButton(label: 'Sign in', primary: true, onTap: () {
              _triedLogin = true;
              _browse(_url, creds: true);
            }),
            PekButton(label: 'Back', onTap: _back),
          ]),
        ];
      case _Stage.share:
        final base = _url.replaceAll(RegExp(r'/+$'), '');
        void open() {
          final name = _share.text.trim().replaceFirst(RegExp(r'^/+'), '');
          if (name.isEmpty) return;
          // NFS exports are paths (/srv/media); the server expects them percent-encoded.
          final seg = base.startsWith('nfs://') ? Uri.encodeComponent(name.startsWith('/') ? name : '/$name') : name;
          _browse('$base/$seg', creds: false);
        }

        body = [
          sub('Could not list the shares on $base. Type the share name instead.'),
          err(),
          PekField(label: 'Share name', controller: _share, hint: 'Media', onSubmitted: open, autofocus: true),
          Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
            PekButton(label: 'Open', primary: true, onTap: open),
            PekButton(label: 'Back', onTap: _back),
          ]),
        ];
      case _Stage.browse:
        final addable = _listing['addable'] == true;
        final parent = '${_listing['parent'] ?? ''}';
        final shares = ((_listing['shares'] as List?) ?? const []).whereType<Map>().toList();
        final dirs = ((_listing['directories'] as List?) ?? const []).whereType<Map>().toList();
        body = [
          sub(addable ? 'Current folder:' : 'Choose a share:'),
          Padding(padding: EdgeInsets.only(bottom: 0.5 * rem), child: Text('${_listing['path'] ?? ''}', style: TextStyle(color: t.textMuted, fontSize: 0.85 * rem))),
          err(),
          if (addable) Padding(padding: EdgeInsets.only(bottom: 0.75 * rem), child: Align(alignment: Alignment.centerLeft, child: PekButton(label: 'Add this folder', primary: true, onTap: _busy ? null : _add))),
          ListRow(title: parent.isNotEmpty ? '.. (up one level)' : '.. (back to devices)', subtitle: parent, onTap: _back),
          for (final s in shares) ListRow(title: '${s['name']}', subtitle: 'Share', onTap: () => _browse('${s['path']}', creds: false)),
          for (final d in dirs) ListRow(title: '${d['name']}', onTap: () => _browse('${d['path']}', creds: false)),
          if (shares.isEmpty && dirs.isEmpty) sub(addable ? 'No subfolders here.' : 'No shares found on this device.'),
        ];
    }

    return PopScope(
      canPop: _stage == _Stage.hosts,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: SubScreen(
        title: 'Add network folder',
        body: Stack(children: [
          ListView(padding: p.pagePad, children: body),
          if (_busy) const Positioned.fill(child: ColoredBox(color: Color(0x66000000), child: Center(child: CircularProgressIndicator()))),
        ]),
      ),
    );
  }
}
