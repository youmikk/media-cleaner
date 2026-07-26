# MediaCleaner 🧹

An open-source **photo & video cleaner** for iOS and Android, built with **React Native + Expo (managed workflow)**. Swipe through your gallery in small groups, soft-delete with a 10-second undo window, detect similar and burst photos on-device, and watch how much space you reclaim — all fully offline. Nothing ever leaves your device.

**License:** MIT · **Version:** v1.0.0

## Features

**Cleaning flows.** The Photos tab groups an album into chunks of X (2–20, default 5). Swipe left/right to browse a group, swipe **up** to soft-delete (10 s undo, then platform-appropriate permanent deletion), swipe **down** to move the photo to another album. A floating glass info bar shows the date (tap for full EXIF), a favorite heart and an undo button with a pending count. At the end of every group a confirmation sheet lets you review marks, batch-delete or batch-move. The Videos tab is a vertical, auto-playing feed with floating delete/like buttons and the same group confirmation and undo semantics.

**Heavy analysis without jank.** A chunked analyzer (`src/utils/chunkedAnalyzer.js`) runs similarity hashing (8×8 aHash via `expo-image-manipulator` + `jpeg-js`), burst grouping and sharpness scoring in batches of 50 per frame, yielding to the UI through `InteractionManager`. It is a FIFO queue — one album at a time; picking another album pauses the current job and reprioritizes. Progress shows in a cancellable, non-blocking overlay. Results are cached in AsyncStorage under `analysis_${albumId}` together with `assetCount` and the newest `modificationTime`; when those drift the app asks "Album content has changed. Re-analyze?" and lets you keep using stale data. In low-power mode (via `expo-battery`) the batch size drops to 10 and a subtle indicator appears; iOS memory warnings pause analysis entirely for a cool-down.

**Sessions that survive restarts.** Entering a cleaning screen captures a "before" snapshot (count + sampled size) persisted with a session id. If the app dies mid-clean, the next launch offers **Resume or discard**; resuming reopens the flow at the last group. Finishing computes the "after" snapshot and feeds the storage comparison chart and usage statistics on the Profile tab.

**Smart suggestions.** Largest files (top 10 by size), burst photos (EXIF burst id or shots within 2 s, with Laplacian-variance sharpness scoring — everything except the sharpest of each burst is pre-selected for deletion), and screenshots untouched for 90+ days. All three reuse the chunked/cached analysis system.

**Recycle bin (Android).** With the recycle bin enabled, deletions are copied to an internal `trash/` folder for 30 days before auto-purge. The bin screen supports select-all, restore and permanent delete; items with fewer than 7 days left show in red. On iOS the system's own "Recently Deleted" is used instead.

**Settings.** Cleaning order (random / by date), similar-photo detection toggle, recycle bin toggle (Android only), a daily reminder scheduled at a random time between 8 AM and 8 PM (`expo-notifications`), theme (system / light / dark, applied instantly) and language (English / 中文).

## Project structure

```
MediaCleaner/
├── App.js                     # Providers, permission gate, session-resume prompt
├── app.json                   # Expo config + permission plugins
├── src/
│   ├── navigation/index.js    # Bottom tabs (liquid glass) + three stacks
│   ├── theme/index.js         # Light/dark palettes
│   ├── i18n/index.js          # EN/ZH strings + translate()
│   ├── context/
│   │   ├── SettingsContext.js # Settings, theme, i18n
│   │   └── AppContext.js      # Stats, favorites, trash (useReducer)
│   ├── screens/
│   │   ├── AlbumSelectScreen.js / VideoAlbumSelectScreen.js (+ AlbumSelectBase)
│   │   ├── CleaningScreen.js / VideoCleaningScreen.js
│   │   ├── ProfileScreen.js / RecycleBinScreen.js / BurstCleanScreen.js
│   ├── components/            # PhotoCard, VideoCard, BottomInfoBar, SimilarModal,
│   │                          # EXIFModal, AlbumPicker, MoveSheet, GroupConfirmSheet,
│   │                          # UndoButton, PageIndicator, StorageChart, SuggestionCard,
│   │                          # AnalysisProgress, CacheStalePrompt, LiquidTabBar
│   └── utils/                 # chunkedAnalyzer, imageHashing, sharpness, burstDetection,
│                              # batteryUtils, deletionManager, trashManager, sessionManager,
│                              # statsManager, notificationScheduler, permissions, albumHelpers
```

## Setup

Prerequisites: Node 18+, npm, and the Expo Go app (or Xcode / Android Studio for simulators).

```bash
git clone https://github.com/youmikk/media-cleaner.git
cd media-cleaner
npm install
npx expo start
```

Scan the QR code with Expo Go, or press `i` / `a` for the iOS simulator / Android emulator. Note that media-library access on simulators is limited — a physical device gives the real experience. For store builds use EAS: `npx eas build --platform all`.

> Some capabilities (notification scheduling on Android 13+, full media access) behave best in a development build: `npx expo run:ios` / `npx expo run:android`.

## Implementation notes & known trade-offs

Album sizes are computed from a sampled subset (first 300 assets, extrapolated) to keep snapshots fast on huge libraries, and per-photo hashing is capped at 3 000 assets per album. Similarity uses a 64-bit average hash with a Hamming-distance threshold of 10 — tune `SIMILAR_THRESHOLD` in `chunkedAnalyzer.js` for stricter or looser matching. "Move to album" uses `addAssetsToAlbumAsync`; on iOS this adds the asset to the target album (iOS albums are non-exclusive), and the photo simply leaves the current cleaning scope. Deleting assets always goes through the OS confirmation dialog — that's a platform requirement, not a bug. In the burst cleaner the pre-selected set is what gets deleted on confirm; the starred (sharpest) photo is kept.

## Contributing

Issues and PRs are welcome. Fork, create a feature branch (`git checkout -b feat/my-feature`), keep the code style (functional components, hooks, no class components outside utils), test on both platforms where possible, and open a PR with a clear description. Good first areas: pHash/dHash upgrades, video thumbnails in grids, iCloud-offloaded asset handling, more languages in `src/i18n`.

## License

[MIT](./LICENSE) — do whatever you like, attribution appreciated.
