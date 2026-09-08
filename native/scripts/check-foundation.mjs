import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const { parseStringPromise } = require('xml2js');
const yaml = require('js-yaml');
const { parse } = require('@babel/parser');
const read = (name) => readFileSync(path.join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const walk = (directory) => readdirSync(path.join(root, directory), { withFileTypes: true })
  .flatMap((item) => item.isDirectory() ? walk(`${directory}/${item.name}`) : [`${directory}/${item.name}`]);
const equalKeys = (a, b) => assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());

const legacyVersion = json('release.json').version;
assert.equal(json('app.json').expo.version, legacyVersion);
assert.equal(json('package.json').version, legacyVersion);
assert.equal(json('package-lock.json').version, legacyVersion);
assert.equal(json('package-lock.json').packages[''].version, legacyVersion);
const updater = parse(read('src/utils/updateChecker.js'), { sourceType: 'module' });
const declaration = updater.program.body.flatMap((node) => node.declaration?.declarations || [])
  .find((node) => node.id?.name === 'APP_VERSION');
assert.equal(declaration?.init?.value, legacyVersion);
assert.equal(json('release.json').tag, `v${legacyVersion}`);

const version = json('native/version.json').version;
assert.match(version, /^\d+\.\d+\.\d+$/);

const android = 'native/android/app/src/main';
const ios = 'native/ios/MediaCleanerNative';
async function strings(name) {
  const xml = await parseStringPromise(read(name));
  const entries = xml.resources.string.map((node) => [node.$.name, node._ || '']);
  const map = new Map(entries);
  assert.equal(map.size, entries.length, `Duplicate resource in ${name}`);
  return map;
}
function localized(name) {
  const lines = read(name).trim().split(/\r?\n/);
  const entries = lines.map((line) => {
    const match = line.match(/^("(?:[^"\\]|\\.)*")\s*=\s*("(?:[^"\\]|\\.)*");$/);
    assert.ok(match, `Invalid .strings entry: ${name}: ${line}`);
    return [JSON.parse(match[1]), JSON.parse(match[2])];
  });
  const result = new Map(entries);
  assert.equal(result.size, entries.length, `Duplicate key in ${name}`);
  return result;
}
const en = await strings(`${android}/res/values/strings.xml`);
const zh = await strings(`${android}/res/values-zh/strings.xml`);
equalKeys(en, zh);
const swiftEn = localized(`${ios}/Resources/en.lproj/Localizable.strings`);
const swiftZh = localized(`${ios}/Resources/zh-Hans.lproj/Localizable.strings`);
equalKeys(swiftEn, swiftZh);
for (const file of walk(`${android}/java`).filter((name) => name.endsWith('.kt'))) {
  for (const match of read(file).matchAll(/R\.string\.([A-Za-z_0-9]+)/g)) {
    assert.ok(en.has(match[1]), `Missing Android string ${match[1]} in ${file}`);
  }
  assert.ok(!/expo\.modules|com\.facebook\.react/.test(read(file)), `Unexpected RN dependency in ${file}`);
}
for (const file of walk(ios).filter((name) => name.endsWith('.swift'))) {
  for (const match of read(file).matchAll(/(?:Text|Button|Label|ContentUnavailableView|LabeledContent|navigationTitle|alert)\(\s*"([a-z][A-Za-z.]+)"/g)) {
    assert.ok(swiftEn.has(match[1]), `Missing iOS string ${match[1]} in ${file}`);
  }
  assert.ok(!/import (Expo|React)/.test(read(file)), `Unexpected RN dependency in ${file}`);
}
for (const [key, value] of en) {
  assert.deepEqual(value.match(/%\d+\$[ds]/g) || [], zh.get(key).match(/%\d+\$[ds]/g) || [], `Format mismatch: ${key}`);
}
for (const [key, value] of swiftEn) {
  assert.deepEqual(value.match(/%[d@]/g) || [], swiftZh.get(key).match(/%[d@]/g) || [], `Format mismatch: ${key}`);
}

for (const file of walk(`${android}/res`).filter((name) => name.endsWith('.xml'))) await parseStringPromise(read(file));
const manifest = await parseStringPromise(read(`${android}/AndroidManifest.xml`));
assert.equal(manifest.manifest.application[0].activity[0].$['android:name'], '.MainActivity');
assert.ok(manifest.manifest['uses-permission'].some((node) => node.$['android:name'] === 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED'));
const gradle = read('native/android/app/build.gradle.kts');
assert.equal(gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1], version);
assert.equal(gradle.match(/applicationId\s*=\s*"([^"]+)"/)?.[1], 'com.mediacleaner.app.nativepreview');
assert.ok(gradle.includes('io.github.kyant0:backdrop:1.0.6'));
assert.ok(gradle.includes('jvmToolchain(21)'));
const spec = yaml.load(read('native/ios/project.yml'));
assert.equal(spec.settings.base.MARKETING_VERSION, version);
assert.equal(spec.targets.MediaCleanerNative.settings.base.PRODUCT_BUNDLE_IDENTIFIER, 'com.mediacleaner.app.nativepreview');
const plist = await parseStringPromise(read(`${ios}/Resources/Info.plist`), { explicitChildren: true, preserveChildrenOrder: true });
const pairs = plist.plist.dict[0].$$;
const info = new Map();
for (let i = 0; i < pairs.length; i += 2) info.set(pairs[i]._, pairs[i + 1]._ ?? pairs[i + 1]['#name']);
assert.equal(info.get('CFBundleShortVersionString'), '$(MARKETING_VERSION)');
assert.equal(info.get('CFBundleExecutable'), '$(EXECUTABLE_NAME)');
assert.equal(info.get('UIDesignRequiresCompatibility'), 'false');
assert.ok(info.has('NSPhotoLibraryUsageDescription'));
for (const file of ['native/android/gradlew', 'native/android/gradlew.bat', 'native/android/gradle/wrapper/gradle-wrapper.jar',
  `${android}/res/drawable/app_icon.png`, `${ios}/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`]) {
  assert.ok(existsSync(path.join(root, file)), `Missing file: ${file}`);
}
const workflow = yaml.load(read('.github/workflows/build-native-preview.yml'));
assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
assert.equal(workflow.permissions.contents, 'read');
assert.equal(workflow.on.workflow_dispatch.inputs.source_ref.default, 'native-foundation');
assert.equal(workflow.on.workflow_dispatch.inputs.prerelease.default, false);
for (const name of ['android', 'ios', 'prerelease']) {
  const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith('actions/checkout'));
  assert.equal(checkout.with.ref, '${{ needs.prepare.outputs.sha }}');
}
assert.equal(workflow.jobs.android.steps.find((step) => step.uses?.startsWith('actions/setup-java')).with['java-version'], '21');
const plan = json('native/shared/feature-matrix.json');
assert.deepEqual(plan.phases.map((phase) => phase.id), ['P0', 'P1', 'P2']);
console.log(`Native foundation metadata OK. Native version ${version}; legacy version ${legacyVersion}; Android ${en.size} strings; iOS ${swiftEn.size} strings.`);
console.log('Checked metadata/resources only. No native compiler, device or visual validation was run.');
