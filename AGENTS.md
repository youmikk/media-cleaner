# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project

MediaCleaner — an offline iOS/Android photo & video cleaner. React Native 0.81 + Expo SDK 54 (managed workflow, but with one **local native module** in `modules/photo-move/`). Plain JavaScript, no TypeScript. Function components + hooks only.

## Commands

```bash
npm install
npx expo start          # then i / a, or scan with Expo Go
npm run android         # expo start --android
npm run ios             # expo start --ios

npx eas build -p android --profile preview      # APK (internal distribution)
npx eas build -p ios --profile production
npx expo install <pkg>                          # ALWAYS use this, not npm install, for expo-* deps
```

There is **no test suite, linter, or type checker** configured — don't invent `npm test`/`npm run lint`. Verification is manual on device. The GitHub Actions workflow `build-ios-unsigned.yml` (manual dispatch) produces an unsigned IPA via `expo prebuild` + `xcodebuild`.

Emulators/simulators have crippled media libraries; anything touching MediaLibrary, native decoding, video playback, or deletion **must be verified on a real device**.

## Runtime tiers — the single most important constraint

Code runs in three environments and must degrade gracefully in all of them:

1. **Expo Go** — no local native module, no `react-native-bottom-tabs`, no `expo-glass-effect`, no notifications on Android 13+, no video compression.
2. **Dev/EAS build** — everything present.
3. **Older installed binaries** — built before a module existed.

The established pattern is a guarded `require` at module scope with a `null` fallback and an `isAvailable()`-style check at every call site. See `modules/photo-move/index.js`, `src/components/GlassSurface.js`, `src/navigation/index.js`, `src/utils/updateChecker.js`, `src/screens/VideoCleaningScreen.js` (expo-sharing). **Never import an optional native module with a bare `import`.**

Also: use `expo-file-system/legacy` (the SDK 54 stable API — `getInfoAsync`, `readAsStringAsync`), not the new `expo-file-system` entry point.

## Architecture

**Provider stack** (`App.js`): GestureHandlerRootView → SafeAreaProvider → SettingsProvider → AppProvider → PermissionGate → NavigationContainer. `installLogger()` runs before anything else so first-frame crashes are captured.

- `SettingsContext` — persisted user settings + derived `colors` / `isDark` / `t()` / `recycleBinActive`. Everything themable and translated reads from here.
- `AppContext` — reducer over stats, favorites, and the Android recycle bin.

**Navigation** (`src/navigation/index.js`): three tabs. On iOS with the native module present it uses `react-native-bottom-tabs` (SwiftUI TabView → real iOS 26 Liquid Glass); otherwise the custom `LiquidTabBar`. The native tab bar can't be hidden per-route, so `CleaningScreen` is presented as `fullScreenModal` in that branch.

**Persistence** is all AsyncStorage, two key conventions:
- `@mediacleaner/*` — settings, sessions, favorites, tutorial flag, reviewed sets.
- bare prefixes — analyzer caches: `analysis_v3_<albumId>`, `analysis_metrics_v2` (global), `album_summary_<id>`, `asset_list_v1_<type>_<id>`.

Android AsyncStorage silently rejects values over ~2 MB, which loses the *whole* entry. Every large writer caps each value (`MAX_METRIC_ENTRIES = 6000`, asset-list payloads skipped above 1.8 MB, `reviewedStore` shards capped at 20000 ids). Preserve these per-value caps when touching those files.

### Analysis engine (`src/utils/chunkedAnalyzer.js` + `imageHashing.js`)

Singleton with a FIFO job queue. One decode per photo produces dHash + Laplacian sharpness + exposure histogram (`analyzePixels`), preferring the native subsampled 64×64 grayscale decode and falling back to expo-image-manipulator → jpeg-js.

Key invariants:
- Metrics live in **one global per-asset store**, persisted incrementally every ~50 photos. Assets shared across albums are never decoded twice; cancel/kill/resume never loses work. Per-album cache entries hold only *derived* results (clusters/bursts/lowQuality/duplicates) plus a freshness fingerprint (`assetCount` + `latestModificationTime`).
- Similarity = 64-bit dHash, Hamming ≤ `SIMILAR_THRESHOLD` (8), **only within `SIMILAR_TIME_WINDOW_MS` (2 min)**. Live Photo vs. its still frame within 2 s is explicitly not a duplicate. Exact duplicates additionally require identical dimensions *and* identical file size.
- `CONCURRENCY` is derived from native CPU cores, clamped to 1–3. Raising it OOM-kills the app on large libraries — each parallel decode holds a full-res bitmap. The loop also yields to the UI thread between every batch, pauses on memory warnings, shrinks chunks in low-power mode, and `suspend()`s while a cleaning session is active.

### Cleaning flow

`CleaningScreen` (photos, ~1300 lines) and `VideoCleaningScreen` (videos) share the model: assets split into groups of `groupSize`; swiping only **marks**; the actual `MediaLibrary.deleteAssetsAsync` happens **once per group** via `deletionManager.batchDelete` — one system dialog per batch, which is the whole point of the group design. Within a group, order is always newest-first even in random mode (`sortGroup`); random only shuffles group membership.

- `sessionManager` stores sessions **keyed by type** (`active_session_photo` / `active_session_video`). A video session must never overwrite a paused photo session — that bug wiped the saved shuffle order.
- Sessions from suggestion cards (largest files, low quality) set `ephemeral: true`: never persisted, and `finishSession` skips `discardSession` for them so the real paused session survives.
- `reviewedStore` records confirmed groups in one global set per media type (kept items included). Decisions are shared across overlapping categories, completed categories stay at 100%, and only genuinely new asset ids enter later cleaning sessions. Do not auto-reset the reviewed pool.
- Photo transitions are a **card stack** (next photo pre-rendered underneath) — not a swap — to avoid the "same photo after swipe" class of bug.

### Video memory discipline (`VideoCard.js`)

Exactly one live `expo-video` player at a time; neighbours render thumbnail frames. `bufferOptions` caps pre-buffer at 6 s / 12 MB (ExoPlayer's ~50 s default OOM-kills the feed). `surfaceType="textureView"` on Android. Never call `replace()` on a live/releasing player; on load error the parent remounts with an alternate URI. Every player call is wrapped in try/catch because a released player throws.

### Native module (`modules/photo-move/`, Kotlin + Swift)

`moveToAlbum` (Android in-place rename + MediaScanner rescan — needs "All files access", requested once on first launch), `decodeGray`, `getSizes` (one batched MediaStore query — per-file `stat` returns 0 under scoped storage), `readExif`, `cpuCores`. Editing the Kotlin/Swift requires a new dev/EAS build; JS-only changes don't.

EXIF is merged field-by-field from three sources: MediaLibrary → native ExifInterface/ImageIO → `exifParser.js` JS fallback.

### Diagnostics

`src/utils/logger.js` is a ring buffer flushed to `mediacleaner.log`, capturing global JS errors and `console.error`/`warn`, retaining the previous session's tail. Use `logSync()` immediately **before** dangerous native calls — a native crash kills the process instantly, but the flushed marker survives and pinpoints the step. Users export the log from Settings.

## Conventions

- i18n: every user-facing string goes through `t('key')` and needs entries in **both** `en` and `zh` in `src/i18n/index.js`. Chinese is the primary audience.
- Colors always come from `useSettings().colors` (`src/theme/index.js`), never hardcoded — except pure white on accent buttons.
- Best-effort I/O is swallowed with `catch (e) {}` plus a comment saying why; user-visible failures are not.
- Comments in this codebase explain *why* (usually a crash or bug that motivated the shape of the code). When changing such code, keep or update the rationale — several constants exist only to prevent OOM or data loss.
- `CHANGELOG.json` is user-facing release notes in Chinese, newest first; `README.md` (zh) and `README.en.md` are kept in sync. Version lives in three places that must match: `package.json`, `app.json`, and `APP_VERSION` in `src/utils/updateChecker.js`.
## Git 提交规则

- commit message 中禁止包含任何 `Co-Authored-By` 署名（包括但不限于 Codex、Anthropic、noreply@anthropic.com 等任何 AI 相关署名）

- 所有提交仅保留用户本人的 git 作者信息（`用户名 <邮箱>`）

- 创建 PR 时同样不添加任何 AI 合作者信息
