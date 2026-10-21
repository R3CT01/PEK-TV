import 'package:flutter/material.dart';

import 'activity.dart';
import 'api.dart';
import 'common.dart';
import 'mpv.dart';
import 'skins.dart';
import 'store.dart';
import 'subtitles.dart';
import 'tokens.dart';
import 'widgets.dart';

/// A row with an on / off switch (the web UI's `ui.toggle` / `ui.listRow` with a status dot).
class ToggleRow extends StatelessWidget {
  const ToggleRow({super.key, required this.title, this.subtitle = '', required this.on, required this.onTap});
  final String title;
  final String subtitle;
  final bool on;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    return ListRow(
      title: title,
      subtitle: subtitle,
      onTap: onTap,
      trailing: Icon(on ? Icons.toggle_on : Icons.toggle_off, size: 40, color: on ? t.accent : t.textMuted),
    );
  }
}

// ====================================================================== Settings > Video output

class VideoOutputSection extends StatefulWidget {
  const VideoOutputSection({super.key});
  @override
  State<VideoOutputSection> createState() => _VideoOutputSectionState();
}

class _VideoOutputSectionState extends State<VideoOutputSection> {
  VideoOutput? _v;
  bool _missing = false; // the host has no native player (older build): hide the section, like the web UI did

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final v = await PekOutput.video();
      if (mounted) setState(() => _v = v);
    } catch (_) {
      if (mounted) setState(() => _missing = true);
    }
  }

  Future<void> _flip(Future<void> Function(bool) set, bool now) async {
    try {
      await set(!now);
    } catch (_) {}
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final v = _v;
    if (_missing || v == null) return const SizedBox.shrink();
    return Section(
      title: 'Video output',
      hint: 'Smoother motion and true HDR. Applies to the next video you start. Matching switches the screen to the video\u2019s frame rate '
          '(it may blink for a moment). HDR sends HDR10 / HLG video straight to an HDR screen.',
      children: [
        ToggleRow(title: 'Match refresh rate', subtitle: v.matchRate ? 'On' : 'Off', on: v.matchRate, onTap: () => _flip(PekOutput.setMatchRate, v.matchRate)),
        ToggleRow(
          title: 'HDR output',
          subtitle: '${v.hdr ? 'On' : 'Off'}${v.displayHdr ? '' : ' \u2013 screen reports no HDR'}',
          on: v.hdr,
          onTap: () => _flip(PekOutput.setHdr, v.hdr),
        ),
      ],
    );
  }
}

// ====================================================================== Settings > Audio output

class AudioOutputSection extends StatefulWidget {
  const AudioOutputSection({super.key});
  @override
  State<AudioOutputSection> createState() => _AudioOutputSectionState();
}

class _AudioOutputSectionState extends State<AudioOutputSection> {
  static const _codecs = <(String, String, String)>[
    ('ac3', 'Dolby Digital (AC-3)', '5.1 sound from DVDs, broadcasts and most streams'),
    ('eac3', 'Dolby Digital Plus (E-AC-3)', 'Also carries Dolby Atmos from streaming services'),
    ('truehd', 'Dolby TrueHD (Atmos)', 'Lossless sound from Blu-ray rips; needs HDMI eARC or a direct HDMI receiver'),
    ('dts', 'DTS', '5.1 sound from DVDs and Blu-ray'),
    ('dts-hd', 'DTS-HD', 'Lossless DTS from Blu-ray rips'),
  ];

  AudioOutput? _a;
  bool _missing = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final a = await PekOutput.audio();
      if (mounted) setState(() => _a = a);
    } catch (_) {
      if (mounted) setState(() => _missing = true);
    }
  }

  Future<void> _set(Iterable<String> codecs, bool on) async {
    try {
      for (final c in codecs) {
        await PekOutput.setPassthrough(c, on);
      }
    } catch (_) {}
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    final a = _a;
    if (_missing || a == null) return const SizedBox.shrink();
    final missing = a.formats.where((f) => !a.on.contains(f)).toList();
    return Section(
      title: 'Audio output',
      hint: 'Passthrough sends the sound untouched to your TV, soundbar or receiver so it can play Dolby or DTS itself. Applies to the next video you start. '
          'Leave a format off if your receiver cannot play it. While passthrough is in use, set the volume on the receiver or TV. '
          'If a format is not accepted, PEK TV plays it as normal sound instead.',
      children: [
        for (final (codec, label, hint) in _codecs)
          ToggleRow(
            title: label,
            subtitle: '${a.on.contains(codec) ? 'On' : 'Off'}'
                '${a.known ? (a.formats.contains(codec) ? ' \u2013 your TV / receiver supports this' : ' \u2013 your TV / receiver does not report this') : ''}'
                '  \u00b7  $hint',
            on: a.on.contains(codec),
            onTap: () => _set([codec], !a.on.contains(codec)),
          ),
        if (a.known && missing.isNotEmpty)
          ListRow(
            title: 'Turn on everything my device supports',
            subtitle: '${a.formats.length} format${a.formats.length == 1 ? '' : 's'} reported',
            onTap: () => _set(missing, true),
          ),
      ],
    );
  }
}

// ====================================================================== Settings > Subtitles

class SubtitleSection extends StatefulWidget {
  const SubtitleSection({super.key});
  @override
  State<SubtitleSection> createState() => _SubtitleSectionState();
}

class _SubtitleSectionState extends State<SubtitleSection> {
  bool _testing = false;
  String _msg = '';

  Future<void> _test() async {
    if (_testing) return;
    setState(() {
      _testing = true;
      _msg = '';
    });
    String msg;
    try {
      final list = await Subs.test();
      msg = list.isNotEmpty ? 'Subtitle service is working.' : 'Connected, but the test search found nothing.';
    } catch (e) {
      msg = e is ApiError ? e.message : 'The test failed.';
    }
    if (mounted) {
      setState(() {
        _testing = false;
        _msg = msg;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final t = p.tokens;
    final rem = p.rem;
    final current = Store.subsLang.split(',').first.trim().toLowerCase();
    return Section(
      title: 'Subtitles',
      hint: 'Finds subtitles online for anything that plays without its own. Nothing to set up. Pick the language you want.',
      children: [
        ToggleRow(
          title: 'Find subtitles automatically',
          on: Store.subsAuto,
          onTap: () async {
            await Store.setSubsAuto(!Store.subsAuto);
            if (mounted) setState(() {});
          },
        ),
        Padding(padding: EdgeInsets.symmetric(vertical: 0.5 * rem), child: Text('Language', style: TextStyle(color: t.textMuted))),
        Wrap(spacing: 0.5 * rem, runSpacing: 0.5 * rem, children: [
          for (final (code, name) in Subs.languages)
            PekButton(
              label: name,
              compact: true,
              primary: current == code,
              onTap: () async {
                await Store.setSubsLang(code);
                if (mounted) setState(() {});
              },
            ),
        ]),
        SizedBox(height: 0.75 * rem),
        Align(alignment: Alignment.centerLeft, child: PekButton(label: _testing ? 'Testing\u2026' : 'Test', onTap: _testing ? null : _test)),
        if (_msg.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.5 * rem), child: Text(_msg, style: TextStyle(color: t.textMuted))),
      ],
    );
  }
}

// ====================================================================== Settings > Skip intro / recap

class SkipSection extends StatelessWidget {
  const SkipSection({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) => Section(
        title: 'Skip intro and recap',
        hint: 'A Skip button appears during intros and recaps. They are found from the file\u2019s chapters and, for TV episodes, from an online database.',
        children: [
          ToggleRow(title: 'Skip automatically', subtitle: Store.skipAuto ? 'On' : 'Off', on: Store.skipAuto, onTap: () => Store.setSkipAuto(!Store.skipAuto)),
          ToggleRow(title: 'Look up intro/recap online', subtitle: Store.skipOnline ? 'On' : 'Off', on: Store.skipOnline, onTap: () => Store.setSkipOnline(!Store.skipOnline)),
        ],
      ),
    );
  }
}

// ====================================================================== Settings > Background activity

/// The corner status line (activity.dart): Off / Basic / Detailed (Detailed adds plugin loading and similar chatter).
class ActivitySection extends StatelessWidget {
  const ActivitySection({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) => Section(
        title: 'Background activity',
        hint: 'A small line in the corner says what PEK TV is doing quietly (scanning, syncing, loading). It never takes a tap and hides while a video plays.',
        children: [
          for (final (id, name, desc) in const [
            ('off', 'Off', 'Show nothing'),
            ('basic', 'Basic', 'Scans, sync, library loading, installs'),
            ('detailed', 'Detailed', 'Also plugins loading and starting'),
          ])
            ListRow(
              title: name,
              subtitle: desc,
              onTap: () => Activity.setLevel(id),
              trailing: Icon(Activity.level == id ? Icons.check_circle : Icons.circle_outlined, color: Activity.level == id ? t.accent : t.textMuted),
            ),
        ],
      ),
    );
  }
}

// ====================================================================== Settings > Plugin posters

/// Plugin posters get a watched tick from Watch History without the plugin doing anything. A poster that names no year can only be
/// matched by its title; this switch turns that looser match off (an exact year match always stays on).
class PluginPostersSection extends StatelessWidget {
  const PluginPostersSection({super.key});

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: Store.changed,
      builder: (context, _, __) => Section(
        title: 'Plugin posters',
        hint: 'Movies you have watched get a tick in every plugin, and pressing and holding a poster marks or un-marks it. Plugins are never told which titles you watched.',
        children: [
          ToggleRow(
            title: 'Match by title when a poster has no year',
            subtitle: Store.pluginWatchedLoose ? 'On' : 'Off',
            on: Store.pluginWatchedLoose,
            onTap: () => Store.setPluginWatchedLoose(!Store.pluginWatchedLoose),
          ),
        ],
      ),
    );
  }
}

// ====================================================================== Settings > Music: online art and lyrics

class MusicOnlineSection extends StatefulWidget {
  const MusicOnlineSection({super.key});
  @override
  State<MusicOnlineSection> createState() => _MusicOnlineSectionState();
}

class _MusicOnlineSectionState extends State<MusicOnlineSection> {
  bool? _available;
  bool _on = false;

  @override
  void initState() {
    super.initState();
    Api.musicOnline().then((r) {
      if (mounted) {
        setState(() {
          _available = r.available;
          _on = r.enabled;
        });
      }
    }).catchError((_) {});
  }

  Future<void> _flip() async {
    final want = !_on;
    setState(() => _on = want);
    try {
      await Api.setMusicOnline(want);
    } catch (_) {
      if (mounted) setState(() => _on = !want);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_available != true) return const SizedBox.shrink();
    return Section(
      title: 'Music',
      hint: 'Artist, album and song names are sent to Deezer, Apple and LRCLIB to find pictures and lyrics; they are kept until the next rescan.',
      children: [ToggleRow(title: 'Online art & lyrics', subtitle: _on ? 'On' : 'Off', on: _on, onTap: _flip)],
    );
  }
}

// ====================================================================== Settings > Appearance (skins)

class AppearanceSection extends StatelessWidget {
  const AppearanceSection({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.pek.tokens;
    return ListenableBuilder(
      listenable: Skins.changes,
      builder: (context, _) => Section(
        title: 'Appearance',
        hint: 'The look of the app. Each profile keeps its own.',
        children: [
          for (final s in Skins.all)
            ListRow(
              title: s.name,
              subtitle: s.description,
              onTap: () => Skins.set(s.id),
              trailing: Icon(s.id == Skins.currentId ? Icons.check_circle : Icons.circle_outlined, color: s.id == Skins.currentId ? t.accent : t.textMuted),
            ),
        ],
      ),
    );
  }
}
