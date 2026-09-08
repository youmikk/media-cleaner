import assert from 'node:assert/strict';
import test from 'node:test';
import { compareVersions, mergeFeed, parseTag } from './update-release-feed.mjs';

const empty = () => ({ schemaVersion: 1, applicationId: 'com.mediacleaner.app.nativepreview', channels: { stable: {}, preview: {} } });
const release = (tag) => ({ tag_name: tag, draft: false, prerelease: tag.includes('-preview.'), published_at: '2026-09-08T00:00:00Z', body: 'Release notes' });
const entry = (tag, platform = 'android') => ({
  downloadUrl: `https://github.com/youmikk/media-cleaner/releases/download/${tag}/${platform === 'android' ? 'MediaCleaner-Native-Android.apk' : 'MediaCleaner-Native-iOS-unsigned.ipa'}`,
  sha256: 'a'.repeat(64),
});

test('numeric versions, same-version promotion, and rebuilds have consistent ordering', () => {
  assert.ok(compareVersions({ tag: 'native-v0.0.10-preview.4' }, { tag: 'native-v0.0.9-stable.20' }) > 0);
  assert.ok(compareVersions({ tag: 'native-v0.0.1-stable.4' }, { tag: 'native-v0.0.1-preview.20' }) > 0);
  assert.ok(compareVersions({ tag: 'native-v0.0.1-preview.21' }, { tag: 'native-v0.0.1-preview.20' }) > 0);
  assert.throws(() => parseTag('v1.30.0'));
  assert.throws(() => parseTag('native-v0.0.1-stable.0'));
});

test('publishing one platform preserves the other platform and preview channel', () => {
  const tag = 'native-v0.0.1-preview.2', stable = 'native-v0.0.1-stable.3';
  const first = mergeFeed(empty(), release(tag), { android: entry(tag), ios: entry(tag, 'ios') });
  const next = mergeFeed(first, release(stable), { android: entry(stable) });
  assert.deepEqual(next.channels.preview, first.channels.preview);
  assert.equal(next.channels.stable.android.version, '0.0.1');
  assert.equal(next.channels.stable.ios, undefined);
  assert.equal(first.channels.stable.android, undefined);
});

test('rerunning an older release never downgrades the download feed', () => {
  const newest = 'native-v0.0.2-stable.20', old = 'native-v0.0.1-stable.21';
  const feed = mergeFeed(empty(), release(newest), { android: entry(newest) });
  assert.deepEqual(mergeFeed(feed, release(old), { android: entry(old) }), feed);
});

test('rejects mismatched channels, drafts, and non-package mirror targets', () => {
  const tag = 'native-v0.0.1-preview.2';
  assert.throws(() => mergeFeed(empty(), { ...release(tag), prerelease: false }, { android: entry(tag) }));
  assert.throws(() => mergeFeed(empty(), { ...release(tag), draft: true }, { android: entry(tag) }));
  assert.throws(() => mergeFeed(empty(), release(tag), { android: { ...entry(tag), downloadUrl: 'https://github.com/youmikk/media-cleaner/releases' } }));
});
