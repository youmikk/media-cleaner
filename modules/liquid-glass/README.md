# Android Liquid Glass adapter

This local Expo module embeds the unmodified AGSL shader from
[AndroidLiquidGlassView](https://github.com/QmDeve/AndroidLiquidGlassView),
by QmDeve, licensed under MIT. This is not Kyant0/AndroidLiquidGlass
(a separate Apache-2.0 project). The complete upstream notice is kept in
`LICENSE-AndroidLiquidGlassView.txt` and at the top of
`android/src/main/res/raw/mediacleaner_liquidglass.agsl`. The referenced raw
resource, including its notice, is packaged with the Android application.

The adapter intentionally does not depend on the upstream AAR. The current
1.0.4/1.0.5 artifacts require compile SDK 37; this app uses SDK 36. The
shader is hosted in a small app-owned bounded `RenderNode`, without adding
an AAR dependency or changing the Expo/RN toolchain.
Explicit sources cover the floating navigation, recycle-bin actions, Favorites
header, analysis overlay, and Android album/time picker headers. The adapter
does not capture screenshots, write media files, or run a timer/bitmap loop.

Support and fallback behavior:

- Android 13 / API 33 and newer, hardware-accelerated, non-low-RAM devices:
  AGSL refraction is enabled when the shared app effect policy allows it and
  `settings.androidLiquidGlass` is not false (enabled by default). The Android
  Appearance switch persists the preference; disabling it releases the effect
  without replacing the navigation controls. Unsupported builds show a disabled
  switch without overwriting that preference. There is no corresponding iOS
  switch; native material support and system accessibility settings apply there.
- Android below API 33, Expo Go, and older binaries without this module use
  an `expo-blur` fallback for bounded surfaces with explicit sources, with no
  AGSL refraction. Both Android materials respect the glass preference,
  low-power mode, reduced motion and memory warnings. Disabled effects and
  native rendering failures keep the existing solid surface visible.
- A new dev/EAS build is required after changing this native module; JavaScript
  updates alone cannot add it to an installed binary.

The shader source currently corresponds to `res/raw/liquidglass_effect.agsl`
in the verified upstream `com.qmdeve.liquidglass:core:1.0.5` AAR
(SHA-256 of the AAR:
`F8234A19E1DB41CB11D21DCDF1CA4B6D1A395A3EBE00BC870339AAD80601B2D7`).

## Runtime limits

The output RenderNode is the size of the bar, at most 200dp tall and
1,048,576 physical pixels. These are rendering bounds, not a measured limit
on total GPU memory. The source scene is drawn through that clipped region
using existing native views; no media decoding or MediaStore writes are
performed by this module. Keep the source subtree separate from the glass
subtree so it cannot sample itself.

Recording follows existing view-tree frames, with no repeating timer or
continuous self-invalidation. Detaching, hiding or defocusing the window, disabling effects,
or a rendering failure releases the RenderNode. A failed renderer is not
retried on every frame. Scene references are weak and unregister on detach.

`GlassEffectsProvider` shares accessibility, foreground and power-state
subscriptions across surfaces. It refreshes power and accessibility settings
on foreground and ignores outdated async results. On iOS, the existing
`expo-glass-effect` material is guarded by both availability APIs; reduced
transparency uses a solid surface. Reduced motion disables selection springs.
Both platforms keep their controls in a stable sibling of the material.
Screen-level overlays also disable effects when their route loses focus.
Android Modal pickers have their own source; while they are focused, native
window-focus handling pauses rendering in the covered application window.

## Additional surface audit

These are the deliberately bounded Android glass surfaces; media cards and
playback layers remain solid for performance.
Each additional glass instance records its own source region, even when it
shares a source key. Do not treat a shared source as a shared render pass.

| Surface | Status | Implementation |
| --- | --- | --- |
| Recycle-bin batch actions | Added | The list is the source and one sibling glass action bar floats above it. Restore/delete keep explicit colors and labels; safe-area-aware placement and measured bottom clearance keep rows reachable. |
| Favorites header | Added | The header overlays the list, with measured top inset and one common material; individual media and heart controls remain ordinary surfaces. |
| Analysis progress overlay | Added | The home content is isolated from the overlay, so it cannot sample itself. The overlay remains bounded and shares the tab-bar clearance. |
| Picker-sheet header | Added for Android | `AppBottomSheet` exposes explicit `glassHeader` + `renderContent` props. Album and time pickers use a unique source inside their Modal; the header is a measured sibling and the virtualized list receives top/indicator insets. |
| Suggestion cards | Keep solid | Several concurrent surfaces over mostly solid backgrounds add rendering work and reduce small-text readability. |
| Android video player and cleaning information bar | Keep solid | Avoid additional sampling over the live TextureView/player. iOS continues to use the existing system material policy. |

Implementation points: `src/screens/RecycleBinScreen.js`,
`src/screens/FavoritesScreen.js`, `src/components/AnalysisProgress.js`,
`src/components/AppBottomSheet.js`, `src/components/AlbumPicker.js`,
`src/components/TimePicker.js`, `src/components/SuggestionCard.js`,
`src/components/BottomInfoBar.js`, and `src/components/VideoCard.js`.
Every candidate must stay within the same-window, non-recursive source and
surface-size limits above, respect the Android switch and shared effect
policy, and pass light/dark contrast, large-text and physical-device frame
timing checks before rollout.

Short Android settings/confirmation sheets (`DeletionModePicker`, `OptionPicker`,
`AppDialog`) and individual settings buttons/switches remain solid. They have no scrolling content behind
them, so a separate glass surface would add sampling and visual noise without
providing useful refraction. `AppSwitch` and `ReminderTimeRangePicker` keep
explicit state/value contrast instead of per-control sampling. App switches
and the shared sheet also respect reduced motion. Existing iOS native menus
and switches retain their platform behavior; its album/time Modal paths are
unchanged. A glass header does not imply a glass surface for every list item.

## Verification

JavaScript exports for Android and iOS, autolinking, shader provenance,
theme-token contrast, layout bounds and mocked fallback/lifecycle checks can
run without compiling Android. Mocked checks do not verify native rendering.

Run the focused component contracts from the repository root after installing
dependencies:

```sh
node --test modules/liquid-glass/tests/ui-contracts.test.cjs
```

The script uses Node's built-in test runner and existing Babel dependencies.
Shallow hook and native-view mocks check stable fallback structure, selection
and dismiss callbacks, source separation, measured list padding, safe-area
properties, bounded labels, and reduced-motion behavior. They do not execute
Yoga layout or native rendering and cannot establish actual text bounds, frame
timing, GPU usage, or media behavior.

Before release, use a new installed build on real devices:

1. Android 13+ on both Adreno and Mali where available: switch the three
   tabs, scroll Profile, change theme, and check the glass tracks the current
   scene without self-sampling, stale content, black frames or frozen taps.
2. Open photo/video cleaning and return. The main glass bar should unmount
   during cleaning; playback must remain responsive with one active player.
3. Toggle system power saving and reduced motion, then background/foreground
   the app. Check fallback and recovery without resetting controls or scroll.
   A live power event must win over a late startup query, and callbacks from
   a removed power subscription must not change the current effect policy.
4. Test Android 12 or older, Expo Go, and an older binary without the module:
   the blur fallback must still navigate and become solid when effects are
   disabled. Check 320/375pt widths, large text and
   resized windows for content clearance and tap targets.
5. On iOS 26, check light/dark overrides, Reduce Transparency, Reduce Motion
   and VoiceOver. Check blur fallback on older iOS. Native tint composition
   and actual text bounds need visual inspection beyond token calculations.
6. Compare frame timing and GPU memory on the same device, scene and scroll
   action with effects enabled and disabled. No FPS or speedup is claimed
   until those measurements exist. Native `glass` logs report status changes,
   not individual frames or media information.
7. Scroll Favorites and select items in the recycle bin in both layouts. The
   header/action material must follow the thumbnails; large text, notches,
   and gesture bars must not hide rows or batch buttons. Only the compact
   Favorites title stays fixed; its count/column toolbar scrolls with the list.
8. Open album and time pickers, scroll and select an album/year/month, then
   close by the close button, backdrop, or Android back. Background surfaces
   pause and resume; the picker keeps its virtualized list and source in one
   Modal window. Change the Android glass preference and repeat.
