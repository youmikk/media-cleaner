# Native Applications

The user authorized independent SwiftUI and Kotlin/Compose apps under `native/`.
The root React Native/Expo conventions apply only to the legacy application.

- Work in the main agent; do not start sub-agents.
- Use purpose-based branch names without tool prefixes. Commit attribution must contain only the repository owner's identity, with no additional author trailers.
- Do not run Gradle, Xcode, EAS or local native builds unless the user asks.
- Public platform APIs only. Do not use PhotoKit resource KVC for file sizes.
- Keep preview identifiers separate from `com.mediacleaner.app` until the old-data import is implemented and verified.
- Native strings use Android resources and iOS `.strings`; both English and Simplified Chinese are required.
- Keep theme colors in platform theme files and match the shared design contract.
- Never delete on a swipe. Save the current group before native batch confirmation.
- Keep photo and video sessions separate. Persist reviewed assets as database rows.
- A static checker is not proof of compilation, pixel appearance or native media behavior.
- Keep the feature checklist honest: implemented source, pending device check and planned work are different states.

`node native/scripts/check-foundation.mjs` checks project metadata, resources and version consistency without starting a native toolchain.
