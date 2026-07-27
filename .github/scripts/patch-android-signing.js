/**
 * Point the release build at a real keystore.
 *
 * Expo's Android template signs `release` with the bundled debug key, which
 * is fine for sideloading but not for Play. This runs in CI only when the
 * ANDROID_KEYSTORE_BASE64 secret is set; the matching MC_* properties are
 * appended to android/gradle.properties by the workflow step first.
 *
 * Idempotent, and a no-op if the template's shape ever changes enough that
 * the anchors stop matching — the build then falls back to debug signing
 * rather than failing in a confusing way.
 */
const fs = require('fs');

const GRADLE = 'android/app/build.gradle';

function main() {
  let src;
  try {
    src = fs.readFileSync(GRADLE, 'utf8');
  } catch (e) {
    console.log(`::warning::${GRADLE} not found — skipping signing patch`);
    return;
  }

  if (src.includes('MC_STORE_FILE')) {
    console.log('release signing already configured');
    return;
  }

  const configBlock = `signingConfigs {
        release {
            storeFile file(MC_STORE_FILE)
            storePassword MC_STORE_PASSWORD
            keyAlias MC_KEY_ALIAS
            keyPassword MC_KEY_PASSWORD
        }`;

  let out = src.replace(/signingConfigs\s*\{/, configBlock);
  if (out === src) {
    console.log('::warning::no signingConfigs block found — keeping defaults');
    return;
  }

  // Repoint only the release build type; the debug one keeps the debug key.
  const before = out;
  out = out.replace(
    /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
    '$1signingConfig signingConfigs.release'
  );
  if (out === before) {
    console.log('::warning::release buildType not repointed — keeping defaults');
    return;
  }

  fs.writeFileSync(GRADLE, out);
  console.log('release signing configured');
}

main();
