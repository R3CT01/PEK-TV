import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' show FontFeature, ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'api.dart';
import 'common.dart' show formatTime;
import 'lyrics.dart';
import 'music.dart' show Art;
import 'music_controller.dart';
import 'playlist_ui.dart';
import 'playlists.dart';
import 'store.dart';
import 'tokens.dart';

/// The full-screen music player: a port of www/music_fullscreen.js.
///
///  * the song's cover fills the background (blurred while the lyrics are on),
///  * the big cover + title on the LEFT, time-synced lyrics (toggle) on the RIGHT,
///  * a Browse button in the top-right opens a side panel (Queue / Albums / Artists / Songs) to pick something else
///    without leaving the screen,
///  * on a phone it opens upright; the rotate button in the top bar turns it sideways and back.
///
/// Touch, and D-pad / keyboard: arrows move the focus, OK presses, Back closes the Browse panel (or steps out of an
/// album / artist inside it) and then the screen. "L" toggles the lyrics. Left / Right on the seek bar skips.
final _mc = MusicController.instance;

const _bgColor = Color(0xFF07070A);
const _glass = Color(0x1FFFFFFF); // rgba(255,255,255,.12)

/// Opens the full-screen player (a fade + a small slide up, like `.pmfs.open`).
Future<void> openNowPlaying(BuildContext context) {
  if (_mc.current.value == null) return Future<void>.value();
  return Navigator.of(context).push(PageRouteBuilder<void>(
    opaque: true,
    transitionDuration: const Duration(milliseconds: 280),
    reverseTransitionDuration: const Duration(milliseconds: 240),
    pageBuilder: (_, __, ___) => const MusicFullScreen(),
    transitionsBuilder: (_, anim, __, child) {
      final c = CurvedAnimation(parent: anim, curve: Curves.easeOut);
      return FadeTransition(
        opacity: c,
        child: SlideTransition(position: Tween<Offset>(begin: const Offset(0, 0.025), end: Offset.zero).animate(c), child: child),
      );
    },
  ));
}

/// The skin's accent when it is light enough to read on the dark picture, else the web player's fallback orange.
Color _accentOn(PekTokens t) => t.accent.computeLuminance() > 0.25 ? t.accent : const Color(0xFFFF8A3D);

/// Plays [tracks] from [index]; [shuffle] turns shuffle on first (the Shuffle buttons).
void _play(List<Track> tracks, int index, {bool shuffle = false}) {
  if (tracks.isEmpty) return;
  if (shuffle && !_mc.shuffle.value) _mc.toggleShuffle();
  _mc.playList(tracks, index.clamp(0, tracks.length - 1).toInt());
}

// ============================================================================================ the screen

class MusicFullScreen extends StatefulWidget {
  const MusicFullScreen({super.key});

  @override
  State<MusicFullScreen> createState() => _MusicFullScreenState();
}

class _MusicFullScreenState extends State<MusicFullScreen> {
  final _panelKey = GlobalKey<_BrowsePanelState>();
  final _mainScope = FocusScopeNode(debugLabel: 'music-fullscreen');
  final _panelScope = FocusScopeNode(debugLabel: 'music-browse');
  bool _lyrics = Store.musicLyrics;
  bool _panel = false;
  bool _everOpened = false;
  bool _chromeSet = false;
  bool _phone = false; // a phone: opens upright, the rotate button turns it sideways
  bool _sideways = false;

  @override
  void initState() {
    super.initState();
    _mc.current.addListener(_closeWhenStopped);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_chromeSet) return;
    _chromeSet = true;
    // A phone opens the player upright, like Spotify's; the rotate button in the top bar turns it sideways (and back).
    // A TV already is landscape. The system bars are already hidden by the host activity, so only the orientation is handled.
    _phone = !context.pek.tvDevice;
    if (_phone) SystemChrome.setPreferredOrientations(const [DeviceOrientation.portraitUp]);
  }

  @override
  void dispose() {
    _mc.current.removeListener(_closeWhenStopped);
    if (_phone) SystemChrome.setPreferredOrientations(const []);
    _mainScope.dispose();
    _panelScope.dispose();
    super.dispose();
  }

  void _rotate() {
    setState(() => _sideways = !_sideways);
    SystemChrome.setPreferredOrientations(_sideways ? const [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight] : const [DeviceOrientation.portraitUp]);
  }

  void _closeWhenStopped() {
    if (_mc.current.value == null && mounted) Navigator.of(context).maybePop();
  }

  void _setLyrics(bool on) {
    setState(() => _lyrics = on);
    Store.setMusicLyrics(on);
  }

  void _setPanel(bool on) {
    if (on == _panel) return;
    final wasBuilt = _everOpened;
    setState(() {
      _panel = on;
      if (on) _everOpened = true;
    });
    // the web panel looks at the library afresh each time it is opened
    if (on && wasBuilt) _panelKey.currentState?.reset();
    // TV remote: the focus moves into the panel when it opens, and back to the button it was on when it closes
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      (on ? _panelScope : _mainScope).requestFocus();
    });
  }

  /// Back: first the folder inside the Browse panel, then the panel, then the screen.
  void _back() {
    if (_panel) {
      if (!(_panelKey.currentState?.back() ?? false)) _setPanel(false);
      return;
    }
    Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (_panel) {
          _back();
        } else {
          Navigator.of(context).pop();
        }
      },
      child: CallbackShortcuts(
        bindings: {const SingleActivator(LogicalKeyboardKey.keyL): () => _setLyrics(!_lyrics)},
        child: Scaffold(
          backgroundColor: _bgColor,
          body: ValueListenableBuilder<Track?>(
            valueListenable: _mc.current,
            builder: (context, cur, _) {
              if (cur == null) return const SizedBox.shrink();
              return Stack(fit: StackFit.expand, children: [
                _Backdrop(url: cur.art || cur.albumId.isNotEmpty ? Api.trackArt(cur) : '', blur: _lyrics && !p.tvDevice, dim: _lyrics ? 0.54 : 0.38),
                IgnorePointer(child: DecoratedBox(decoration: BoxDecoration(gradient: _lyrics ? _scrimLyrics : _scrimPlain))),
                ExcludeFocus(
                  excluding: _panel,
                  child: FocusScope(node: _mainScope, child: _Screen(track: cur, lyrics: _lyrics, panelOpen: _panel, onClose: () => Navigator.of(context).maybePop(), onLyrics: () => _setLyrics(!_lyrics), onBrowse: () => _setPanel(!_panel), onRotate: _phone ? _rotate : null)),
                ),
                _shade(),
                if (_everOpened) _panelLayer(p),
              ]);
            },
          ),
        ),
      ),
    );
  }

  static const _scrimPlain = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x8C000000), Color(0x00000000), Color(0x00000000), Color(0xD1000000)], stops: [0, 0.22, 0.52, 1]);
  static const _scrimLyrics = LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x59000000), Color(0x1A000000), Color(0xB3000000)], stops: [0, 0.3, 1]);

  Widget _shade() => Positioned.fill(
        child: IgnorePointer(
          ignoring: !_panel,
          child: GestureDetector(
            onTap: () => _setPanel(false),
            child: AnimatedOpacity(opacity: _panel ? 1 : 0, duration: const Duration(milliseconds: 250), child: const ColoredBox(color: Color(0x73000000))),
          ),
        ),
      );

  Widget _panelLayer(PekScope p) {
    final w = p.size.width;
    final landscape = w > p.size.height;
    // width: min(30rem, 88vw, 46vw) but never narrower than min(88vw, 22rem); the whole screen in portrait
    final panelW = landscape ? math.max(math.min(480.0, 0.46 * w), math.min(0.88 * w, 352.0)) : w;
    return Positioned(
      top: 0,
      bottom: 0,
      right: 0,
      width: panelW,
      child: ExcludeFocus(
        excluding: !_panel,
        child: IgnorePointer(
          ignoring: !_panel,
          child: AnimatedSlide(
            offset: _panel ? Offset.zero : const Offset(1.04, 0),
            duration: const Duration(milliseconds: 280),
            curve: Curves.easeOutCubic,
            child: FocusScope(
              node: _panelScope,
              child: _BrowsePanel(key: _panelKey, onClose: () => _setPanel(false)),
            ),
          ),
        ),
      ),
    );
  }
}

// ============================================================================================ backdrop

/// The cover, big and dimmed, behind everything. A new cover fades in over the old one.
/// While the server is still fetching an online picture it answers 503; that is asked again a few seconds later.
class _Backdrop extends StatefulWidget {
  const _Backdrop({required this.url, required this.blur, required this.dim});
  final String url;
  final bool blur; // weak TV boxes skip the blur and are only darkened (html.pek-lite)
  final double dim;

  @override
  State<_Backdrop> createState() => _BackdropState();
}

class _BackdropState extends State<_Backdrop> {
  static const _maxTries = 6;
  int _tries = 0;
  Timer? _retry;

  @override
  void didUpdateWidget(_Backdrop old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) {
      _retry?.cancel();
      _tries = 0;
    }
  }

  @override
  void dispose() {
    _retry?.cancel();
    super.dispose();
  }

  void _askAgain() {
    if (_tries >= _maxTries || (_retry?.isActive ?? false)) return;
    _retry = Timer(Duration(seconds: 3 + 2 * _tries), () {
      if (mounted) setState(() => _tries++);
    });
  }

  @override
  Widget build(BuildContext context) {
    Widget img = Image.network(
      widget.url,
      key: ValueKey('${widget.url}#$_tries'),
      fit: BoxFit.cover,
      cacheWidth: 640,
      gaplessPlayback: true,
      errorBuilder: (_, error, __) {
        if (error is NetworkImageLoadException && error.statusCode == 503) _askAgain();
        return const SizedBox.expand();
      },
    );
    if (widget.blur) {
      img = Transform.scale(scale: 1.15, child: ImageFiltered(imageFilter: ImageFilter.blur(sigmaX: 40, sigmaY: 40), child: img));
    }
    return RepaintBoundary(
      child: Stack(fit: StackFit.expand, children: [
        const DecoratedBox(
          decoration: BoxDecoration(gradient: RadialGradient(center: Alignment(-0.6, -0.8), radius: 1.4, colors: [Color(0xFF3A2A20), Color(0xFF0D0B0B)], stops: [0, 0.7])),
        ),
        if (widget.url.isNotEmpty)
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 800),
            child: SizedBox.expand(key: ValueKey(widget.url), child: img),
          ),
        ColoredBox(color: Colors.black.withAlpha((widget.dim * 255).round())),
      ]),
    );
  }
}

// ============================================================================================ small pieces

/// A focusable button for the dark player: a white ring when the D-pad / keyboard is on it (never after a tap).
class _Fb extends StatefulWidget {
  const _Fb({required this.label, required this.onTap, required this.child, this.onLongPress, this.autofocus = false, this.background = _glass, this.radius = 999, this.padding, this.width, this.height});
  final String label;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final Widget child;
  final bool autofocus;
  final Color background;
  final double radius;
  final EdgeInsetsGeometry? padding;
  final double? width;
  final double? height;

  @override
  State<_Fb> createState() => _FbState();
}

class _FbState extends State<_Fb> {
  bool _hl = false;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final ring = p.isTv ? 0.2 * p.rem : 2.5;
    return Semantics(
      button: true,
      label: widget.label,
      child: FocusableActionDetector(
        autofocus: widget.autofocus,
        enabled: widget.onTap != null,
        onShowFocusHighlight: (v) => setState(() => _hl = v),
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
            widget.onTap?.call();
            return null;
          }),
        },
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: widget.onTap,
          onLongPress: widget.onLongPress,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 120),
            width: widget.width,
            height: widget.height,
            padding: widget.padding,
            alignment: widget.width != null || widget.height != null ? Alignment.center : null,
            decoration: BoxDecoration(
              color: widget.background,
              borderRadius: BorderRadius.circular(widget.radius),
              border: Border.all(color: _hl ? Colors.white : Colors.transparent, width: ring),
            ),
            child: widget.child,
          ),
        ),
      ),
    );
  }
}

// ============================================================================================ the player layer

class _Screen extends StatelessWidget {
  const _Screen({required this.track, required this.lyrics, required this.panelOpen, required this.onClose, required this.onLyrics, required this.onBrowse, this.onRotate});
  final Track track;
  final bool lyrics, panelOpen;
  final VoidCallback onClose, onLyrics, onBrowse;
  final VoidCallback? onRotate;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final size = p.size;
    final vh = size.height / 100, vw = size.width / 100;
    final pad = MediaQuery.paddingOf(context);
    final padding = EdgeInsets.fromLTRB(
      math.max(3 * vw + p.safeX, pad.left),
      math.max(2.4 * vh + p.safeY, pad.top),
      math.max(3 * vw + p.safeX, pad.right),
      math.max(2.6 * vh + p.safeY, pad.bottom),
    );
    return Padding(
      padding: padding,
      child: Column(children: [
        _TopBar(track: track, lyrics: lyrics, panelOpen: panelOpen, onClose: onClose, onLyrics: onLyrics, onBrowse: onBrowse, onRotate: onRotate),
        Expanded(child: LayoutBuilder(builder: (context, c) => _Main(track: track, lyrics: lyrics, box: c))),
        SizedBox(height: 1.2 * vh),
        const _Bottom(),
      ]),
    );
  }
}

class _TopBar extends StatelessWidget {
  const _TopBar({required this.track, required this.lyrics, required this.panelOpen, required this.onClose, required this.onLyrics, required this.onBrowse, this.onRotate});
  final Track track;
  final bool lyrics, panelOpen;
  final VoidCallback onClose, onLyrics, onBrowse;
  final VoidCallback? onRotate;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final vh = p.size.height / 100;
    final h = math.max(2.6 * rem, 6.4 * vh);
    final icon = math.max(1.2 * rem, 3 * vh);
    final short = p.size.height < 430; // @media (max-height: 430px): icons only
    final iconsOnly = short || p.size.width < 520; // an upright phone has no room for the words
    Widget pill(String label, IconData ic, bool on, VoidCallback tap) => _Fb(
          label: label,
          onTap: tap,
          background: on ? Colors.white : _glass,
          height: h,
          padding: EdgeInsets.symmetric(horizontal: 1.1 * vh + (iconsOnly ? 0 : 0.5 * rem)),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(ic, size: icon, color: on ? const Color(0xFF111111) : Colors.white),
            if (!iconsOnly) ...[SizedBox(width: 0.5 * rem), Text(label, style: TextStyle(fontSize: math.max(0.8 * rem, 2 * vh), fontWeight: FontWeight.w700, color: on ? const Color(0xFF111111) : Colors.white))],
          ]),
        );
    return Row(children: [
      _Fb(label: 'Close full screen', onTap: onClose, width: h, height: h, child: Icon(Icons.keyboard_arrow_down, size: icon * 1.2, color: Colors.white)),
      Expanded(
        child: track.album.isEmpty
            ? const SizedBox.shrink()
            : Column(mainAxisSize: MainAxisSize.min, children: [
                if (!short) Text('PLAYING FROM', style: TextStyle(fontSize: math.max(0.62 * rem, 1.5 * vh), letterSpacing: 2.2, color: Colors.white.withAlpha(166))),
                Text(track.album, maxLines: 1, overflow: TextOverflow.ellipsis, textAlign: TextAlign.center, style: TextStyle(fontSize: math.max(0.9 * rem, 2.3 * vh), fontWeight: FontWeight.w700, color: Colors.white)),
              ]),
      ),
      _Fb(label: 'Add to playlist', onTap: () => addToPlaylistSheet(context, [track]), width: h, height: h, child: Icon(Icons.playlist_add, size: icon * 1.1, color: Colors.white)),
      SizedBox(width: 0.6 * p.size.width / 100 + 4),
      if (onRotate != null) ...[
        _Fb(label: 'Rotate screen', onTap: onRotate!, width: h, height: h, child: Icon(Icons.screen_rotation, size: icon * 1.05, color: Colors.white)),
        SizedBox(width: 0.6 * p.size.width / 100 + 4),
      ],
      pill('Lyrics', Icons.lyrics_outlined, lyrics, onLyrics),
      SizedBox(width: 0.6 * p.size.width / 100 + 4),
      pill('Browse', Icons.queue_music, panelOpen, onBrowse),
    ]);
  }
}

class _Main extends StatelessWidget {
  const _Main({required this.track, required this.lyrics, required this.box});
  final Track track;
  final bool lyrics;
  final BoxConstraints box;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final size = p.size;
    final vh = size.height / 100, vw = size.width / 100;
    final landscape = size.width > size.height;
    final maxH = box.maxHeight.isFinite ? box.maxHeight : size.height;
    final cover = Api.trackArt(track);
    final hasArt = track.art || track.albumId.isNotEmpty;

    Widget coverBox(double side) => DecoratedBox(
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(1.2 * vh), boxShadow: const [BoxShadow(color: Color(0x8C000000), blurRadius: 40, offset: Offset(0, 16))]),
          child: Art(url: hasArt ? cover : '', size: side, radius: 1.2 * vh),
        );

    Widget meta({required double title, required double artist, required double album, required TextAlign align, int lines = 3}) {
      final cross = align == TextAlign.center ? CrossAxisAlignment.center : CrossAxisAlignment.start;
      return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: cross, children: [
        Text(track.title.isEmpty ? 'Unknown song' : track.title, maxLines: lines, overflow: TextOverflow.ellipsis, textAlign: align, style: TextStyle(fontSize: title, fontWeight: FontWeight.w800, height: 1.1, color: Colors.white)),
        SizedBox(height: 1.2 * vh),
        Text(track.artist, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: align, style: TextStyle(fontSize: artist, fontWeight: FontWeight.w600, height: 1.3, color: Colors.white.withAlpha(235))),
        if (track.album.isNotEmpty) Padding(padding: EdgeInsets.only(top: 0.8 * vh), child: Text(track.album, maxLines: 2, overflow: TextOverflow.ellipsis, textAlign: align, style: TextStyle(fontSize: album, color: Colors.white.withAlpha(153)))),
      ]);
    }

    Widget lyricsView(double fs) => LyricsPanel(trackId: track.id, position: _mc.position, onSeek: _mc.seek, onDark: true, fontSize: fs, align: TextAlign.start);

    if (landscape) {
      if (!lyrics) {
        // the big cover and the words beside it, centred
        final side = math.min(math.min(58 * vh, 34 * vw), maxH);
        return Center(
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            coverBox(side),
            SizedBox(width: 3.2 * vw),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 34 * vw),
              child: meta(title: math.max(1.4 * rem, 5.6 * vh), artist: math.max(rem, 3 * vh), album: math.max(0.85 * rem, 2.2 * vh), align: TextAlign.start),
            ),
          ]),
        );
      }
      // lyrics on: the cover shrinks to a column on the LEFT, the lyrics take the RIGHT
      final leftW = math.min(36 * vh, 24 * vw);
      final side = math.min(leftW, maxH * 0.62);
      return Row(crossAxisAlignment: CrossAxisAlignment.center, children: [
        SizedBox(
          width: leftW,
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
            coverBox(side),
            SizedBox(height: 2.2 * vh),
            meta(title: math.max(1.15 * rem, 3.6 * vh), artist: math.max(0.9 * rem, 2.4 * vh), album: math.max(0.8 * rem, 2 * vh), align: TextAlign.start, lines: 2),
          ]),
        ),
        SizedBox(width: 4 * vw),
        Expanded(child: lyricsView(math.max(1.25 * rem, 4.4 * vh))),
      ]);
    }

    // portrait fallback: everything stacked
    if (!lyrics) {
      final side = math.min(math.min(70 * vw, 38 * vh), maxH * 0.7);
      return Center(
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            coverBox(side),
            SizedBox(height: 2.4 * vh),
            SizedBox(width: 88 * vw, child: meta(title: math.max(1.4 * rem, 3.4 * vh), artist: math.max(rem, 2.2 * vh), album: math.max(0.85 * rem, 1.8 * vh), align: TextAlign.center)),
          ]),
        ),
      );
    }
    final small = math.min(16 * vh, 22 * vw);
    return Column(children: [
      Row(children: [
        coverBox(small),
        SizedBox(width: 3 * vw),
        Expanded(child: meta(title: math.max(1.1 * rem, 2.6 * vh), artist: math.max(0.9 * rem, 1.8 * vh), album: math.max(0.8 * rem, 1.5 * vh), align: TextAlign.start, lines: 2)),
      ]),
      SizedBox(height: 1.5 * vh),
      Expanded(child: lyricsView(math.max(1.2 * rem, 3 * vh))),
    ]);
  }
}

// ============================================================================================ seek + controls

class _Bottom extends StatelessWidget {
  const _Bottom();

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final vh = p.size.height / 100, vw = p.size.width / 100;
    final accent = _accentOn(p.tokens);
    final small0 = math.max(2.8 * rem, 7.4 * vh);
    final main0 = math.max(3.6 * rem, 10 * vh);
    final ic0 = math.max(1.5 * rem, 3.8 * vh);
    final gap0 = 2.2 * vw;

    return LayoutBuilder(builder: (context, box) {
      // Five small buttons, the big Play button and six gaps must fit the width: on a narrow phone everything shrinks together
      // instead of the row running off the edge (it used to overflow by a few dozen pixels).
      final natural = 5 * small0 + main0 + 6 * gap0;
      final avail = box.maxWidth.isFinite ? box.maxWidth : natural;
      final k = natural > avail && natural > 0 ? avail / natural : 1.0;
      final small = small0 * k, main = main0 * k, ic = ic0 * k, gap = gap0 * k;

      Widget toggle(String label, IconData i, ValueNotifier<bool> on, VoidCallback tap) => ValueListenableBuilder<bool>(
            valueListenable: on,
            builder: (_, v, __) => _Fb(label: label, onTap: tap, width: small, height: small, background: v ? _glass : Colors.transparent, child: Icon(i, size: ic, color: v ? accent : Colors.white)),
          );
      Widget plain(String label, IconData i, VoidCallback tap) => _Fb(label: label, onTap: tap, width: small, height: small, background: Colors.transparent, child: Icon(i, size: ic, color: Colors.white));

      return Column(mainAxisSize: MainAxisSize.min, children: [
        const _SeekBar(),
        SizedBox(height: 1.2 * vh),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          toggle('Shuffle', Icons.shuffle, _mc.shuffle, _mc.toggleShuffle),
          SizedBox(width: gap),
          plain('Previous', Icons.skip_previous, _mc.prev),
          SizedBox(width: gap),
          ValueListenableBuilder<bool>(
            valueListenable: _mc.playing,
            builder: (_, on, __) => _Fb(
              label: on ? 'Pause' : 'Play',
              onTap: _mc.toggle,
              autofocus: true,
              width: main,
              height: main,
              background: Colors.white,
              child: Icon(on ? Icons.pause : Icons.play_arrow, size: math.max(1.9 * rem * k, 5 * vh * k), color: const Color(0xFF111111)),
            ),
          ),
          SizedBox(width: gap),
          plain('Next', Icons.skip_next, () => _mc.next()),
          SizedBox(width: gap),
          toggle('Repeat', Icons.repeat, _mc.repeat, _mc.toggleRepeat),
          SizedBox(width: gap),
          plain('Stop', Icons.stop, _mc.stop),
        ]),
      ]);
    });
  }
}

class _SeekBar extends StatefulWidget {
  const _SeekBar();

  @override
  State<_SeekBar> createState() => _SeekBarState();
}

class _SeekBarState extends State<_SeekBar> {
  double? _drag;
  bool _pointer = false; // touched / dragged (the seek happens when the finger lifts) vs. keys (the seek happens at once)

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final vh = p.size.height / 100;
    final timeStyle = TextStyle(color: Colors.white.withAlpha(191), fontSize: math.max(0.75 * rem, 1.9 * vh), fontFeatures: const [FontFeature.tabularFigures()]);
    final cur = _mc.current.value;
    return ValueListenableBuilder<double>(
      valueListenable: _mc.duration,
      builder: (_, dur, __) => ValueListenableBuilder<double>(
        valueListenable: _mc.position,
        builder: (_, pos, __) {
          final max = dur > 0 ? dur : ((cur?.duration ?? 0) > 0 ? cur!.duration : 1.0);
          final v = (_drag ?? pos).clamp(0.0, max).toDouble();
          return Row(children: [
            SizedBox(width: 3.2 * math.max(0.75 * rem, 1.9 * vh), child: Text(formatTime(v), style: timeStyle)),
            Expanded(
              child: SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: math.max(4.0, 0.5 * vh),
                  activeTrackColor: Colors.white,
                  inactiveTrackColor: Colors.white.withAlpha(71),
                  thumbColor: Colors.white,
                  overlayColor: Colors.white.withAlpha(40),
                  thumbShape: RoundSliderThumbShape(enabledThumbRadius: math.max(7.0, 1.1 * vh)),
                  overlayShape: const RoundSliderOverlayShape(overlayRadius: 18),
                ),
                child: Slider(
                  value: v,
                  max: max,
                  onChangeStart: (_) => _pointer = true,
                  onChanged: (x) {
                    if (_pointer) {
                      setState(() => _drag = x);
                    } else {
                      _mc.seek(x); // arrow keys on a remote: skip right away
                    }
                  },
                  onChangeEnd: (x) {
                    _mc.seek(x);
                    setState(() {
                      _drag = null;
                      _pointer = false;
                    });
                  },
                ),
              ),
            ),
            SizedBox(width: 3.2 * math.max(0.75 * rem, 1.9 * vh), child: Text(formatTime(max), textAlign: TextAlign.end, style: timeStyle)),
          ]);
        },
      ),
    );
  }
}

// ============================================================================================ Browse panel

class _View {
  const _View(this.title, this.body);
  final String title;
  final Widget body;
}

class _BrowsePanel extends StatefulWidget {
  const _BrowsePanel({super.key, required this.onClose});
  final VoidCallback onClose;

  @override
  State<_BrowsePanel> createState() => _BrowsePanelState();
}

class _BrowsePanelState extends State<_BrowsePanel> {
  static const _tabs = ['Queue', 'Playlists', 'Albums', 'Artists', 'Songs'];
  late int _tab = _mc.playOrder.value.length > 1 ? 0 : 2; // the queue when there is one, else the albums
  final List<_View> _stack = [];
  Future<MusicLibrary>? _lib; // Albums and Artists share one request
  int _gen = 0; // bumped by reset(): every list starts again

  Future<MusicLibrary> get _library => _lib ??= Api.musicLibrary();

  /// Opened again: back to the first tab, the library is asked for again.
  void reset() => setState(() {
        _gen++;
        _stack.clear();
        _lib = null;
        _tab = _mc.playOrder.value.length > 1 ? 0 : 2;
      });

  /// Steps out of an album / artist; false when already at the tabs.
  bool back() {
    if (_stack.isEmpty) return false;
    setState(_stack.removeLast);
    return true;
  }

  void _push(String title, Widget body) => setState(() => _stack.add(_View(title, body)));

  void _openAlbum(Album a) => _push(a.title, _AlbumView(album: a));
  void _openPlaylist(Playlist pl) => _push(pl.name, _PlaylistView(id: pl.id));
  void _openArtist(Artist a) => _push(a.name, _ArtistView(artist: a, openAlbum: _openAlbum));

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    final top = _stack.isEmpty ? null : _stack.last;
    final iconSz = 1.3 * rem;
    final body = top != null
        ? top.body
        : switch (_tab) {
            0 => const _QueueList(),
            1 => _PlaylistsList(onOpen: _openPlaylist),
            2 => _AlbumsList(library: _library, onOpen: _openAlbum),
            3 => _ArtistsList(library: _library, onOpen: _openArtist),
            _ => const _SongsList(),
          };
    return Material(
      color: const Color(0xF0121216),
      elevation: 16,
      child: SafeArea(
        child: KeyedSubtree(
          key: ValueKey<int>(_gen),
          child: Column(children: [
          Padding(
            padding: EdgeInsets.fromLTRB(rem, rem, rem, 0.5 * rem),
            child: Row(children: [
              if (top != null) ...[
                _Fb(label: 'Back', onTap: back, autofocus: true, width: 2.4 * rem, height: 2.4 * rem, child: Icon(Icons.chevron_left, size: iconSz * 1.2, color: Colors.white)),
                SizedBox(width: 0.6 * rem),
              ],
              Expanded(child: Text(top?.title ?? 'Browse', maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 1.15 * rem, fontWeight: FontWeight.w800, color: Colors.white))),
              _Fb(label: 'Close browse window', onTap: widget.onClose, width: 2.4 * rem, height: 2.4 * rem, child: Icon(Icons.close, size: iconSz, color: Colors.white)),
            ]),
          ),
          if (top == null)
            SizedBox(
              height: 3.4 * rem,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: EdgeInsets.fromLTRB(rem, 0.3 * rem, rem, 0.6 * rem),
                children: [
                  for (var i = 0; i < _tabs.length; i++)
                    Padding(
                      padding: EdgeInsets.only(right: 0.45 * rem),
                      child: _Fb(
                        label: _tabs[i],
                        onTap: () => setState(() => _tab = i),
                        autofocus: i == _tab,
                        background: i == _tab ? Colors.white : _glass,
                        padding: EdgeInsets.symmetric(horizontal: 0.95 * rem),
                        child: Center(child: Text(_tabs[i], style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.88 * rem, color: i == _tab ? const Color(0xFF111111) : Colors.white))),
                      ),
                    ),
                ],
              ),
            ),
          Expanded(child: body),
        ]),
        ),
      ),
    );
  }
}

/// One row of the panel: a number or a picture, a title and a line under it. The playing song is in the accent colour.
class _Row extends StatelessWidget {
  const _Row({required this.title, required this.onTap, this.onLongPress, this.sub = '', this.leading, this.number, this.current = false});
  final String title, sub;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final Widget? leading;
  final int? number;
  final bool current;

  @override
  Widget build(BuildContext context) {
    final p = context.pek;
    final rem = p.rem;
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 0.55 * rem, vertical: 0.1 * rem),
      child: _Fb(
        label: title,
        onTap: onTap,
        onLongPress: onLongPress,
        radius: 0.7 * rem,
        background: current ? const Color(0x1FFFFFFF) : Colors.transparent,
        padding: EdgeInsets.symmetric(horizontal: 0.55 * rem),
        child: Center(
          child: Row(children: [
          if (number != null) SizedBox(width: 1.6 * rem, child: Text('$number', textAlign: TextAlign.center, style: TextStyle(fontSize: 0.85 * rem, color: Colors.white.withAlpha(140)))),
          if (leading != null) ...[leading!, SizedBox(width: 0.8 * rem)],
          if (number != null) SizedBox(width: 0.4 * rem),
          Expanded(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.98 * rem, color: current ? _accentOn(p.tokens) : Colors.white)),
              if (sub.isNotEmpty) Text(sub, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 0.8 * rem, color: Colors.white.withAlpha(153))),
            ]),
          ),
          ]),
        ),
      ),
    );
  }
}

/// Every list row is the same height, so ListView.builder only builds what is on screen (500+ songs stay smooth).
double _rowH(BuildContext c) => 4.4 * c.pek.rem;

Widget _msg(BuildContext c, String text) => Padding(padding: EdgeInsets.all(2 * c.pek.rem), child: Center(child: Text(text, textAlign: TextAlign.center, style: TextStyle(color: Colors.white.withAlpha(166), fontSize: 0.95 * c.pek.rem))));

Widget _pic(BuildContext c, String url, {bool round = false}) => Art(url: url, size: 3.1 * c.pek.rem, radius: 0.45 * c.pek.rem, round: round);

String _plural(int n, String one, String many) => '$n ${n == 1 ? one : many}';

Widget _trackRow(BuildContext c, List<Track> list, int i, {bool numbers = false, VoidCallback? onTap, List<SheetAction> extra = const []}) {
  final t = list[i];
  return ValueListenableBuilder<Track?>(
    valueListenable: _mc.current,
    builder: (_, cur, __) => _Row(
      title: t.title.isEmpty ? 'Unknown song' : t.title,
      sub: t.artist,
      number: numbers ? i + 1 : null,
      leading: numbers ? null : _pic(c, t.art || t.albumId.isNotEmpty ? Api.trackArt(t) : ''),
      current: cur?.id == t.id,
      onTap: onTap ?? () => _play(list, i),
      onLongPress: () => showTrackMenu(c, t, extra: extra),
    ),
  );
}

// ---- Queue: the songs in play order; tapping one jumps to it

class _QueueList extends StatefulWidget {
  const _QueueList();

  @override
  State<_QueueList> createState() => _QueueListState();
}

class _QueueListState extends State<_QueueList> {
  ScrollController? _scroll;
  double _h = 0;

  int _currentIndex() {
    final cur = _mc.current.value;
    return cur == null ? 0 : math.max(0, _mc.playOrder.value.indexWhere((t) => t.id == cur.id));
  }

  @override
  void initState() {
    super.initState();
    _mc.current.addListener(_followCurrent);
  }

  @override
  void dispose() {
    _mc.current.removeListener(_followCurrent);
    _scroll?.dispose();
    super.dispose();
  }

  // the playing song stays in view when the song changes
  void _followCurrent() {
    final s = _scroll;
    if (s == null || !s.hasClients || _h == 0) return;
    final target = (_currentIndex() * _h - s.position.viewportDimension / 2 + _h / 2).clamp(0.0, s.position.maxScrollExtent).toDouble();
    s.animateTo(target, duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
  }

  @override
  Widget build(BuildContext context) {
    _h = _rowH(context);
    _scroll ??= ScrollController(initialScrollOffset: math.max(0, _currentIndex() - 2) * _h);
    return ValueListenableBuilder<List<Track>>(
      valueListenable: _mc.playOrder,
      builder: (context, order, _) {
        if (order.isEmpty) return _msg(context, 'The queue is empty.');
        final rem = context.pek.rem;
        return Column(children: [
          Padding(
            padding: EdgeInsets.fromLTRB(1.1 * rem, 0.2 * rem, 0.55 * rem, 0.4 * rem),
            child: Align(
              alignment: Alignment.centerLeft,
              child: _Fb(
                label: 'Save queue as playlist',
                height: 2.3 * rem,
                padding: EdgeInsets.symmetric(horizontal: 1.0 * rem),
                onTap: () async {
                  final messenger = ScaffoldMessenger.maybeOf(context);
                  final p = await newPlaylist(context, order);
                  if (p != null) messenger?.showSnackBar(SnackBar(content: Text('Saved \u201c${p.name}\u201d'), duration: const Duration(seconds: 2)));
                },
                child: Text('Save as playlist', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.85 * rem, color: Colors.white)),
              ),
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              itemExtent: _h,
              itemCount: order.length,
              itemBuilder: (_, i) => _trackRow(context, order, i, onTap: () => _mc.jump(i)),
            ),
          ),
        ]);
      },
    );
  }
}

// ---- Albums / Artists (one request for both)

class _AlbumsList extends StatelessWidget {
  const _AlbumsList({required this.library, required this.onOpen});
  final Future<MusicLibrary> library;
  final void Function(Album) onOpen;

  @override
  Widget build(BuildContext context) => FutureBuilder<MusicLibrary>(
        future: library,
        builder: (context, snap) {
          if (snap.hasError) return _msg(context, 'Couldn\u2019t load albums.');
          if (!snap.hasData) return _msg(context, 'Loading\u2026');
          final list = snap.data!.albums;
          if (list.isEmpty) return _msg(context, 'No albums found.');
          return ListView.builder(
            itemExtent: _rowH(context),
            itemCount: list.length,
            itemBuilder: (_, i) {
              final a = list[i];
              return _Row(
                title: a.title,
                sub: '${a.artist}${a.year > 0 ? ' \u00B7 ${a.year}' : ''} \u00B7 ${_plural(a.tracks, 'song', 'songs')}',
                leading: _pic(context, a.art ? Api.albumArt(a.id) : ''),
                onTap: () => onOpen(a),
              );
            },
          );
        },
      );
}

class _ArtistsList extends StatelessWidget {
  const _ArtistsList({required this.library, required this.onOpen});
  final Future<MusicLibrary> library;
  final void Function(Artist) onOpen;

  @override
  Widget build(BuildContext context) => FutureBuilder<MusicLibrary>(
        future: library,
        builder: (context, snap) {
          if (snap.hasError) return _msg(context, 'Couldn\u2019t load artists.');
          if (!snap.hasData) return _msg(context, 'Loading\u2026');
          final list = snap.data!.artists;
          if (list.isEmpty) return _msg(context, 'No artists found.');
          return ListView.builder(
            itemExtent: _rowH(context),
            itemCount: list.length,
            itemBuilder: (_, i) {
              final a = list[i];
              return _Row(
                title: a.name,
                sub: '${_plural(a.albums, 'album', 'albums')} \u00B7 ${_plural(a.tracks, 'song', 'songs')}',
                leading: _pic(context, a.art ? Api.artistArt(a.id) : '', round: true),
                onTap: () => onOpen(a),
              );
            },
          );
        },
      );
}

// ---- Songs: loaded 200 at a time while you scroll

class _SongsList extends StatefulWidget {
  const _SongsList();

  @override
  State<_SongsList> createState() => _SongsListState();
}

class _SongsListState extends State<_SongsList> {
  static const _page = 200;
  final List<Track> _items = [];
  int _total = 0;
  bool _loading = false, _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final (total, songs) = await Api.musicSongs(offset: _items.length, limit: _page);
      if (!mounted) return;
      setState(() {
        _items.addAll(songs);
        _total = total;
        _loading = false;
      });
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _failed = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty) return _msg(context, _failed ? 'Couldn\u2019t load songs.' : (_loading ? 'Loading\u2026' : 'No songs found.'));
    final more = _items.length < _total;
    return ListView.builder(
      itemExtent: _rowH(context),
      itemCount: _items.length + (more ? 1 : 0),
      itemBuilder: (context, i) {
        if (i >= _items.length) {
          // the end of what is loaded: ask for the next page as soon as this row is built
          if (!_loading && !_failed) WidgetsBinding.instance.addPostFrameCallback((_) => mounted ? _load() : null);
          return _msg(context, _failed ? 'Couldn\u2019t load more.' : 'Loading\u2026');
        }
        return _trackRow(context, _items, i);
      },
    );
  }
}

// ---- Album and artist pages inside the panel

Widget _actions(BuildContext c, Future<List<Track>> Function() tracks, {bool addTo = false}) {
  final rem = c.pek.rem;
  Widget pill(String label, bool primary, VoidCallback tap) => _Fb(
        label: label,
        onTap: tap,
        background: primary ? Colors.white : _glass,
        height: 2.5 * rem,
        padding: EdgeInsets.symmetric(horizontal: 1.2 * rem),
        child: Text(label, style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.9 * rem, color: primary ? const Color(0xFF111111) : Colors.white)),
      );
  return Padding(
    padding: EdgeInsets.fromLTRB(0.55 * rem + 0.55 * rem, 0.3 * rem, 0.55 * rem, 0.6 * rem),
    child: Row(children: [
      pill('Play', true, () => tracks().then((l) => _play(l, 0)).catchError((_) {})),
      SizedBox(width: 0.5 * rem),
      pill('Shuffle', false, () => tracks().then((l) => _play(l, l.isEmpty ? 0 : math.Random().nextInt(l.length), shuffle: true)).catchError((_) {})),
      if (addTo) ...[
        SizedBox(width: 0.5 * rem),
        pill('Add to playlist', false, () => tracks().then((l) => c.mounted ? addToPlaylistSheet(c, l) : null).catchError((_) {})),
      ],
    ]),
  );
}

class _AlbumView extends StatefulWidget {
  const _AlbumView({required this.album});
  final Album album;

  @override
  State<_AlbumView> createState() => _AlbumViewState();
}

class _AlbumViewState extends State<_AlbumView> {
  late final Future<(Album, List<Track>)> _f = Api.musicAlbum(widget.album.id); // once, not again when the screen turns

  @override
  Widget build(BuildContext context) => FutureBuilder<(Album, List<Track>)>(
        future: _f,
        builder: (context, snap) {
          if (snap.hasError) return _msg(context, 'Couldn\u2019t open that album.');
          if (!snap.hasData) return _msg(context, 'Loading\u2026');
          final tracks = snap.data!.$2;
          return Column(children: [
            _actions(context, () async => tracks, addTo: true),
            Expanded(
              child: tracks.isEmpty
                  ? _msg(context, 'No songs.')
                  : ListView.builder(itemExtent: _rowH(context) * 0.82, itemCount: tracks.length, itemBuilder: (_, i) => _trackRow(context, tracks, i, numbers: true)),
            ),
          ]);
        },
      );
}

class _ArtistView extends StatefulWidget {
  const _ArtistView({required this.artist, required this.openAlbum});
  final Artist artist;
  final void Function(Album) openAlbum;

  @override
  State<_ArtistView> createState() => _ArtistViewState();
}

class _ArtistViewState extends State<_ArtistView> {
  late final Future<(Artist, List<Album>)> _f = Api.musicArtist(widget.artist.id);

  @override
  Widget build(BuildContext context) => FutureBuilder<(Artist, List<Album>)>(
        future: _f,
        builder: (context, snap) {
          if (snap.hasError) return _msg(context, 'Couldn\u2019t open that artist.');
          if (!snap.hasData) return _msg(context, 'Loading\u2026');
          final albums = snap.data!.$2;
          return Column(children: [
            // Play / Shuffle use every song of the artist (one request per album, only when pressed)
            _actions(context, () async => [for (final r in await Future.wait(albums.map((a) => Api.musicAlbum(a.id)))) ...r.$2]),
            Expanded(
              child: albums.isEmpty
                  ? _msg(context, 'No albums.')
                  : ListView.builder(
                      itemExtent: _rowH(context),
                      itemCount: albums.length,
                      itemBuilder: (_, i) {
                        final a = albums[i];
                        return _Row(
                          title: a.title,
                          sub: '${a.artist}${a.year > 0 ? ' \u00B7 ${a.year}' : ''} \u00B7 ${_plural(a.tracks, 'song', 'songs')}',
                          leading: _pic(context, a.art ? Api.albumArt(a.id) : ''),
                          onTap: () => widget.openAlbum(a),
                        );
                      },
                    ),
            ),
          ]);
        },
      );
}

// ---- Playlists inside the panel

class _PlaylistsList extends StatelessWidget {
  const _PlaylistsList({required this.onOpen});
  final void Function(Playlist) onOpen;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Playlists.instance,
        builder: (context, _) {
          final rem = context.pek.rem;
          final lists = Playlists.instance.all;
          return Column(children: [
            Padding(
              padding: EdgeInsets.fromLTRB(1.1 * rem, 0.2 * rem, 0.55 * rem, 0.4 * rem),
              child: Align(
                alignment: Alignment.centerLeft,
                child: _Fb(
                  label: 'New playlist',
                  height: 2.3 * rem,
                  background: Colors.white,
                  padding: EdgeInsets.symmetric(horizontal: 1.0 * rem),
                  onTap: () async {
                    final p = await newPlaylist(context);
                    if (p != null) onOpen(p);
                  },
                  child: Text('+ New playlist', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 0.85 * rem, color: const Color(0xFF111111))),
                ),
              ),
            ),
            Expanded(
              child: lists.isEmpty
                  ? _msg(context, 'No playlists yet. Make one, or add songs with the playlist button at the top.')
                  : ListView.builder(
                      itemExtent: _rowH(context),
                      itemCount: lists.length,
                      itemBuilder: (_, i) {
                        final p = lists[i];
                        return _Row(
                          title: p.name,
                          sub: _plural(p.tracks.length, 'song', 'songs'),
                          leading: _pic(context, playlistArt(p)),
                          onTap: () => onOpen(p),
                          onLongPress: () => showPlaylistMenu(context, p),
                        );
                      },
                    ),
            ),
          ]);
        },
      );
}

class _PlaylistView extends StatelessWidget {
  const _PlaylistView({required this.id});
  final String id;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
        listenable: Playlists.instance,
        builder: (context, _) {
          final pl = Playlists.instance.byId(id);
          if (pl == null) return _msg(context, 'This playlist was deleted.');
          final tracks = pl.tracks;
          if (tracks.isEmpty) return _msg(context, 'This playlist is empty.');
          return Column(children: [
            _actions(context, () async => tracks),
            Expanded(
              child: ListView.builder(
                itemExtent: _rowH(context),
                itemCount: tracks.length,
                itemBuilder: (_, i) => _trackRow(context, tracks, i, extra: [
                  if (i > 0) SheetAction('Move up', Icons.arrow_upward, () => Playlists.instance.move(id, i, i - 1)),
                  if (i < tracks.length - 1) SheetAction('Move down', Icons.arrow_downward, () => Playlists.instance.move(id, i, i + 1)),
                  SheetAction('Remove from playlist', Icons.remove_circle_outline, () => Playlists.instance.removeAt(id, i)),
                ]),
              ),
            ),
          ]);
        },
      );
}
