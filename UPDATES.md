# In-app updates

PEK TV checks GitHub for a newer release every time it starts. If there is one, an "A new version is available"
screen comes up before the app. **Update now** downloads the apk and hands it to Android to install.
**Not now** opens the app; nothing is remembered, so the screen is back at the next start until the app is updated.

## Publishing a release (what the app looks for)

1. In `android/app/build.gradle` raise `pekBaseCode` by 1 (18 -> 19). Android refuses an install whose versionCode is not higher.
2. Push a tag: `git tag v2.2.0 && git push origin v2.2.0`.
3. `build_android.yml` builds a signed release and publishes a GitHub release with
   `PEK-TV-<version>-release-arm64-v8a.apk` and `PEK-TV-<version>-release-armeabi-v7a.apk`.
   The tag (without the `v`) becomes the app's versionName and is what installed apps compare against.

Rules the app follows:

- It reads the release list, so pre-releases count. The newest tag with a matching apk wins.
- The CPU type is taken from the installed versionCode (ends in 1 = 32-bit, 2 = 64-bit), so a 64-bit install stays 64-bit.
- Debug builds, `-dev.N` builds and local builds never show the screen.
- The apk is checked against GitHub's sha256 for the asset when GitHub provides one. Android additionally refuses any apk
  signed with a different key than the installed app, so release builds must always use the same keystore.
- Needs a public repository (`R3CT01/PEK-TV`, set in `flutter_ui/lib/src/app_update.dart`).

## What Android allows

Android never lets a normal app update itself with no prompt at all. The person turns on "Install unknown apps" for PEK TV once
(the screen sends them there), and Android shows its own confirmation. On Android 12+ Android may skip that confirmation for
updates of an app it already installed this way.
