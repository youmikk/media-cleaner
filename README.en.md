# MediaCleaner

[中文](./README.md) · **English**

MediaCleaner is an open-source, fully offline photo and video cleaner for iOS and Android. It breaks large libraries into reviewable groups, supports album and time filters, and detects similar, duplicate, burst, and low-quality photos on-device. Cleaning progress, analysis caches, and favorites stay local; photos and videos are never uploaded.

The app uses React Native 0.81 and Expo SDK 54 (managed workflow), with one local native module for batched media queries, low-resolution grayscale decoding, and in-place album moves on Android.

**License:** MIT · **Version:** v1.22.0

## Features

**Cleaning flows.** Both Photos and Videos let you choose an album, time range, and group size (2–20), then use the same **card-stack** interaction. Swipe left/right to browse, **up to mark for deletion**, and **down to move** to another album. Marks are only a pre-selection: actual deletion happens once per group in the confirmation sheet, so the **system dialog appears once per batch**. Skip keeps the group and exiting deletes nothing. Exactly one video player is alive at a time, with buffering capped at 6 seconds / 12 MB. First launch requests permissions, then teaches browsing, marking, and the bottom category chips with local demo data that never reads or changes the real library.

**Time-scoped cleaning.** Time pickers on both Photos and Videos scope cleaning to a **year or a specific month** ("2023" / "Jun 2023") — big libraries become bite-sized tasks.

**Smart suggestions.** Six cards on the Profile tab: Largest Files (size badge on every photo in the flow), Burst Photos (timestamp + perceptual-hash double check, sharpest kept automatically), Old Screenshots (90+ days), **Exact Duplicates** (hash + resolution + file size triple match, one copy kept per group), **Duplicate Videos** (duration + resolution + size match, generated thumbnails), and **Low-Quality Photos** (blurry / under- / over-exposed / blank pocket shots). Suggestion cleanings run as **ephemeral sessions** — they never disturb the main album's paused progress or the home-screen preview.

**Analysis engine.** ONE decode per photo yields a dHash difference hash, Laplacian sharpness and an exposure histogram; native downsampled decoding (Kotlin/Swift) produces the 64×64 grayscale directly, and metrics live in a global per-asset store persisted **incrementally** — interruptible, shared across albums, never re-analyzed. Similarity clustering only compares shots taken within a **2-minute window** (photoo's strategy); concurrency adapts to the CPU core count; the cancellable progress overlay shows a live time-remaining estimate. Caches carry an `assetCount` + `modificationTime` fingerprint with a re-analyze prompt on drift; iOS memory warnings pause the loop.

**Sessions that survive restarts.** Exiting pauses the exact shuffled order, group, position, and marks. Photo and video sessions are **stored independently**. Confirmed groups, including kept items, never re-enter the queue: a completed category remains at 100%, and only genuinely new asset IDs appear on the next visit.

**Info surfaces.** The floating glass info bar shows the capture date and a **reverse-geocoded address** (cached); tapping opens fully localized EXIF details (camera / lens / aperture / shutter / ISO / focal length). EXIF is merged **per field from three sources** — system API → native ExifInterface (Android) / ImageIO (iOS) → a JS parser fallback — so a field missing from one source is filled by another; the modal loads progressively, showing coordinates instantly and upgrading to an address when geocoding completes. All images render through `expo-image` native caching with next-photo prefetch.

**Tools.** My Favorites collects every hearted photo and video with grid/list views. Photography Profile shows capture trends, and the Compressor batch re-encodes large files with an optional delete-original step.

**Recycle bin (Android).** Deletions are copied into an internal `trash/` folder for 30 days with select-all / restore / purge; items under 7 days left show in red. iOS uses the system "Recently Deleted".

**Platform UI.** On iOS 26+, the tab bar and info bars use **native Liquid Glass** (`expo-glass-effect`); older iOS versions use `expo-blur`. Android renders app-owned navigation, pickers, switches, dialogs, and bottom sheets, so the interface stays consistent across Xiaomi, vivo, and other OEM skins. Permission prompts, media-deletion confirmation, and share sheets remain system UI.

**Settings.** Cleaning order (random / by date), similarity detection, Android recycle bin, reminders, theme, language, and diagnostic log export. Photo and video group sizes are adjusted at their respective cleaning entries and saved independently.

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
