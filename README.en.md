# MediaCleaner 🧹

[中文](./README.md) · **English**

An open-source **photo & video cleaner** for iOS and Android, built with **React Native + Expo SDK 54** (managed workflow). Swipe through your gallery in small groups, batch-delete per group, detect similar / duplicate / burst / low-quality shots on-device, and watch how much space you reclaim — fully offline; nothing ever leaves your device.

**License:** MIT · **Version:** v1.0.0

## Features

**Cleaning flows.** The Photos tab splits an album into groups of the global group size (5/10/15/20). Photos switch as a **card stack** — the next photo is pre-rendered underneath, so transitions are flicker-free and never show a stale frame. Swipe left/right to browse; **swipe up to mark for deletion** — a glowing red trash bar slides down with the gesture and past ~40% of screen height the photo is marked with haptic feedback; **swipe down to move** to another album. Marks are only a pre-selection: actual deletion happens ONCE per group in the confirmation sheet, so the **system dialog appears once per batch**. Skip keeps the whole group; exiting deletes nothing. The Videos tab opens a vertical auto-playing feed directly (album filter top-right) with floating delete/like/share buttons and the same per-group batch confirmation; **only the current video holds a player instance** (neighbours show poster frames) and pre-buffering is capped, so even low-end devices never run out of memory. A 3-step gesture tutorial shows on first launch.

**Time-scoped cleaning.** A time picker on the Photos home screen scopes cleaning to a **year or a specific month** ("2023" / "Jun 2023") — big libraries become bite-sized tasks.

**Smart suggestions.** Six cards on the Profile tab: Largest Files (size badge on every photo in the flow), Burst Photos (timestamp + perceptual-hash double check, sharpest kept automatically), Old Screenshots (90+ days), **Exact Duplicates** (hash + resolution + file size triple match, one copy kept per group), **Duplicate Videos** (duration + resolution + size match, generated thumbnails), and **Low-Quality Photos** (blurry / under- / over-exposed / blank pocket shots). Suggestion cleanings run as **ephemeral sessions** — they never disturb the main album's paused progress or the home-screen preview.

**Analysis engine.** ONE decode per photo yields a dHash difference hash, Laplacian sharpness and an exposure histogram; native downsampled decoding (Kotlin/Swift) produces the 64×64 grayscale directly, and metrics live in a global per-asset store persisted **incrementally** — interruptible, shared across albums, never re-analyzed. Similarity clustering only compares shots taken within a **2-minute window** (photoo's strategy); concurrency adapts to the CPU core count; the cancellable progress overlay shows a live time-remaining estimate. Caches carry an `assetCount` + `modificationTime` fingerprint with a re-analyze prompt on drift; iOS memory warnings pause the loop.

**Sessions that survive restarts.** Entering a cleaning flow captures a "before" snapshot; exiting simply pauses — the shuffled order, current group, position and marks all persist, and the home cards keep showing that exact group for one-tap resume. Photo and video sessions are **stored independently** and never overwrite each other; **confirmed groups (kept or deleted) are removed from the order entirely**, so deletions in earlier groups can't shift later group boundaries; photos taken while paused surface as the very next group. Once every photo has been reviewed, the pool resets for a new round. Finishing computes the "after" snapshot for the storage chart and usage stats.

**Info surfaces.** The floating glass info bar shows the capture date and a **reverse-geocoded address** (cached); tapping opens fully localized EXIF details (camera / lens / aperture / shutter / ISO / focal length). EXIF is merged **per field from three sources** — system API → native ExifInterface (Android) / ImageIO (iOS) → a JS parser fallback — so a field missing from one source is filled by another; the modal loads progressively, showing coordinates instantly and upgrading to an address when geocoding completes. All images render through `expo-image` native caching with next-photo prefetch.

**Tools.** Photography Profile (hour-of-day distribution, busiest weekday/month, daily average) and a Compressor (pick the biggest files, batch re-encode at high/medium/low quality — images via expo-image-manipulator, videos via react-native-compressor — optionally deleting originals).

**Recycle bin (Android).** Deletions are copied into an internal `trash/` folder for 30 days with select-all / restore / purge; items under 7 days left show in red. iOS uses the system "Recently Deleted".

**Liquid Glass.** On iOS 26+ the tab bar and info bars are **native Liquid Glass** (`expo-glass-effect`); older iOS and Android fall back to an `expo-blur` frosted look via the shared `GlassSurface` component.

**Settings.** Global group size, cleaning order (random / by date, default random), similarity toggle, recycle bin toggle (Android only), daily reminder at a random 8AM–8PM time, theme (system / light / dark, instant), language (**中文 by default**, English available), and **diagnostic log export** — a built-in ring-buffer logger flushes to disk continuously (crash context survives) and shares via the system sheet, which is how remote user issues get debugged.

## Project structure

See the tree in the [Chinese README](./README.md#项目结构) — identical layout: `src/{navigation, theme, i18n, context, screens, components, utils}` plus `assets/` for the icon and splash.

## Getting started

Prerequisites: Node 20+, npm, and Expo Go (or Xcode / Android Studio).

```bash
git clone https://github.com/youmikk/media-cleaner.git
cd media-cleaner
npm install
npx expo start
```

Scan the QR with Expo Go, or press `i` / `a` for a simulator. Media-library access is limited on simulators — a physical device gives the real experience. Store builds via EAS: `npx eas build -p android --profile preview` (APK) / `npx eas build -p ios --profile production` (needs an Apple Developer account). A GitHub Actions workflow is included that produces an unsigned IPA on the free macOS runners for sideload testing.

> Some capabilities (Android 13+ notifications, video compression, native Liquid Glass) need an installed (EAS / dev) build and degrade gracefully in Expo Go.

## Implementation notes & trade-offs

Album counts and sizes come from a single native **MediaStore batch query** (per-file stat returns 0 under Android scoped storage); scanning caps at 20,000 assets and the metric store at 6,000 entries (LRU). Similarity uses a 64-bit dHash with a Hamming threshold of 8, clustered **only within a 2-minute time window** (`SIMILAR_THRESHOLD` / `SIMILAR_TIME_WINDOW_MS` in `chunkedAnalyzer.js`); exact duplicates require identical hash, resolution AND file size. On Android, **"Move to album" is an in-place move** (photoo-style same-volume rename + MediaScanner rescan — no copy, no metadata change), enabled by the "All files access" permission requested on first launch; on iOS it adds to the target album (albums are non-exclusive). Deletion always goes through the OS confirmation dialog — a platform requirement; this app batches it to **once per group**. In the burst cleaner the pre-selected set is deleted and the starred (sharpest) photo is kept. The video feed keeps a single player instance alive (neighbours are poster frames) with buffering capped at 6s / 12MB.

## Contributing

Issues and PRs welcome. Fork, branch (`git checkout -b feat/xxx`), keep the style (function components + hooks), test on both platforms where possible. Good first areas: pHash/DCT hashing, more languages, iCloud-offloaded assets, unit tests.

## License

[MIT](./LICENSE) — do whatever you like, attribution appreciated.
