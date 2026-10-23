# assets

Branding artwork for PEK TV, kept in one place.

```
assets/
├── android/res/            Android resources (Gradle adds this folder to the app's res/ dirs, see android/app/build.gradle)
│   ├── raw/                pek_splash.mp4 (landscape: TVs, tablets), pek_splash_portrait.mp4 (phones)
│   ├── drawable-nodpi/     launcher icon: ic_launcher_foreground.png, ic_launcher_bg_silk.png
│   ├── drawable-xhdpi/     tv_banner.png (Android TV home screen)
│   └── mipmap-anydpi-v26/  ic_launcher.xml, ic_launcher_round.xml (adaptive icon)
├── screenshots/            the images the main README shows
└── favicon.png
```

To change the icon, banner or splash, replace the file here and keep the same name. Colours and themes
(`pek_splash_bg`, `ic_launcher_background`) stay in `android/app/src/main/res/values/`.
