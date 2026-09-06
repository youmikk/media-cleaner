# Android Liquid Glass adapter

This Expo module uses the official lens and directional highlight AGSL from
[Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass/)
1.0.6, commit `896a94a3ade1cc1a940b92365f942a34971fecda`.
The source is [backdrop/Shaders.kt](https://github.com/Kyant0/AndroidLiquidGlass/blob/896a94a3ade1cc1a940b92365f942a34971fecda/backdrop/src/main/java/com/kyant/backdrop/Shaders.kt):
`RoundedRectSDF`, `RoundedRectRefractionShaderString`, and
`DefaultHighlightShaderString`. Kotlin interpolation is expanded into
`android/src/main/res/raw/kyant_refraction.agsl` and `kyant_highlight.agsl`;
the shader algorithms are unchanged. Both retain Kyant's copyright notice.
The full [Apache 2.0 license](android/src/main/assets/licenses/AndroidLiquidGlass.txt)
is packaged in the APK's assets.

This is a native View adaptation of those rendering primitives, not the
upstream Compose UI/AAR. Kyant's 1.0.6 Compose library requires Kotlin 2.3.10
and Compose 1.10.3. Reusing its AGSL avoids changing this Expo/RN toolchain.
React Native continues to own navigation, controls, layout and accessibility.
The previous QmDeve shader and its license have been removed.

## Rendering

`GlassRenderer` follows Kyant's bottom-tabs material order: saturation 1.5,
8dp blur, 24dp lens height/amount, 40% surface tint, and directional highlight.
Small surfaces clamp lens height to half their height. `LiquidGlassView`
clips its entire native drawing to a rounded path, including the fallback.
The highlight and subtle dark edge keep the shape visible over flat content.

Only an explicit sibling source in the same window can be sampled. The source
scene is recorded through a bounded RenderNode with a 24dp blur margin.
The visible surface is at most 200dp tall; the full capture, including its
margin, is capped at 1,048,576 sampled pixels. This is not a measured cap on
total GPU memory. No screenshots, media decoding, MediaStore calls or image
files are used. References are weak and unregister on detach.

Sources cover the navigation capsule, recycle-bin actions, Favorites title,
analysis progress, and Android album/time picker headers. Each instance
records its own region. Sources must never contain their own material.
Media cards, video playback, suggestion cards and short confirmation dialogs
keep their existing rendering.

## Low Power Mode

`PowerModeProvider` owns the system power subscription. The persisted
`settings.adaptiveLowPower` switch is enabled by default and controls the
application's adaptations on both platforms. It does not change the system's
Low Power Mode or override reduced transparency and memory safeguards.

- Android native glass: capture width and height are halved and sampling is
  limited to one update per 67ms, about 15 per second. Text, buttons, clipping
  and highlights remain at full resolution. A source invalidation schedules
  a final sample if scrolling stops inside the interval; no repeating timer
  runs over an unchanged source. Detach, hidden windows, lost focus and
  disabled effects cancel the pending callback and release the RenderNode.
- iOS: keep `expo-glass-effect` / `UIGlassEffect` and let UIKit manage its
  material. The app does not paint an opaque layer over it or claim to control
  its sampling. Default tint is left to the system.
- Both platforms: stop optional app springs and use the analyzer's existing
  smaller batches (50 to 10), preserving decode concurrency and memory caps.
  Turning adaptation off restores app behavior while system restrictions stay.
- A dismissible notice appears on entering system Low Power Mode, including
  startup while it is active. Foreground refreshes preserve state and do not
  repeat the notice. The notice still appears with adaptation switched off.

Apple documents [reduced CPU/GPU performance and app adaptation](https://developer.apple.com/documentation/foundation/processinfo/islowpowermodeenabled),
and [a 60Hz ProMotion ceiling and some disabled visual effects](https://support.apple.com/en-us/101604).
Neither statement requires replacing native glass with a solid app surface.
Actual UIKit appearance remains system-controlled.

The iOS shape overrides in `src/theme/shapes.js` follow Apple's
[rounded and concentric shape guidance](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass).
The tab capsule uses half its layout height, with its inner radius reduced
by the content inset. Controls and sheets use continuous curves; these are
app-selected dimensions, not claimed Apple system constants.

## Compatibility

AGSL requires Android 13 / API 33+, hardware acceleration and a non-low-RAM
device. `settings.androidLiquidGlass` independently enables the material.
Older Android versions and runtimes without this optional module use bounded
`expo-blur` surfaces. In power adaptation that fallback uses a lower blur
intensity. Reduced motion alone does not disable the static glass material.
Unavailable iOS glass APIs use blur; reduced transparency and memory warnings
use solid surfaces. Material changes preserve the content subtree.

## Verification

Run `node --test modules/liquid-glass/tests/ui-contracts.test.cjs` for the
focused JS contracts: material fallback, power transitions and settings,
notice dismissal, source separation, compact analysis and bounded controls.
These mocks do not execute Yoga or verify native pixels, FPS or GPU memory.
Real-device checks cover glass while scrolling and switching themes, rounded
corners in both power states, low-power entry/exit, the adaptation switch,
picker windows, and narrow screens with large fonts. Native builds and device
verification are performed by the maintainer; no performance gain is claimed
from the JS checks or from the reduced sample dimensions alone.
