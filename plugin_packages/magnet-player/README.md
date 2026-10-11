# Magnet Player

Paste a magnet link and PEK TV streams it while it downloads. This used to be the
"Play a magnet link" button in Settings > Torrents; it is now a separate plugin.

## Install

Settings -> Plugins -> Install plugin from .zip, pick `magnet-player.zip`, check the
permissions (`torrent`, `storage`), and confirm. A **Magnet** tab appears in the sidebar.

## Needs

A PEK TV build that includes the torrent engine. Without it the plugin shows a notice
and cannot start a stream. No search provider is needed.

## Notes

- The last 10 links are kept in the plugin's private storage; **Clear recent** wipes them.
- Torrents upload from your connection and expose your IP address to other peers.
