import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const applicationId = 'com.mediacleaner.app.nativepreview';
const repository = 'youmikk/media-cleaner';
const assets = { android: 'MediaCleaner-Native-Android.apk', ios: 'MediaCleaner-Native-iOS-unsigned.ipa' };

export function parseTag(tag) {
  const match = /^native-v(\d+\.\d+\.\d+)-(stable|preview)\.(\d+)$/.exec(tag);
  assert.ok(match, 'Invalid native release tag');
  const build = Number(match[3]);
  assert.ok(Number.isSafeInteger(build) && build > 0);
  assert.ok(match[1].split('.').every((part) => Number.isSafeInteger(Number(part))));
  return { version: match[1], channel: match[2], build };
}

export function compareVersions(left, right) {
  const a = parseTag(left.tag), b = parseTag(right.tag);
  const first = a.version.split('.').map(Number), second = b.version.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1;
  if (a.channel !== b.channel) return a.channel === 'stable' ? 1 : -1;
  return Math.sign(a.build - b.build);
}

export function mergeFeed(feed, release, platformEntries) {
  assert.equal(feed.schemaVersion, 1);
  assert.equal(feed.applicationId, applicationId);
  const meta = parseTag(release.tag_name);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, meta.channel === 'preview');
  assert.ok(feed.channels.stable && feed.channels.preview);
  const result = structuredClone(feed);
  for (const [platform, value] of Object.entries(platformEntries)) {
    assert.ok(Object.hasOwn(assets, platform));
    const expectedURL = `https://github.com/${repository}/releases/download/${release.tag_name}/${assets[platform]}`;
    assert.equal(value.downloadUrl, expectedURL);
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    const entry = {
      version: meta.version, build: meta.build, tag: release.tag_name,
      publishedAt: release.published_at, notes: String(release.body || '').slice(0, 16000), ...value,
    };
    const existing = result.channels[meta.channel][platform];
    if (!existing || compareVersions(entry, existing) >= 0) result.channels[meta.channel][platform] = entry;
  }
  return result;
}

async function publishFeed() {
  const { GH_TOKEN, GH_REPO, TAG, PLATFORM, SOURCE_SHA } = process.env;
  assert.equal(GH_REPO, repository);
  assert.ok(GH_TOKEN && SOURCE_SHA);
  parseTag(TAG);
  assert.ok(['both', 'android', 'ios'].includes(PLATFORM));
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' };
  const api = (suffix, options = {}) => fetch(`https://api.github.com/repos/${repository}/${suffix}`, {
    ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(20000),
  });
  const releaseResponse = await api(`releases/tags/${encodeURIComponent(TAG)}`);
  assert.equal(releaseResponse.status, 200, 'Published release is unavailable');
  const release = await releaseResponse.json();
  assert.equal(release.target_commitish, SOURCE_SHA);
  const entries = {};
  for (const platform of PLATFORM === 'both' ? ['android', 'ios'] : [PLATFORM]) {
    const asset = release.assets.find((asset) => asset.name === assets[platform] && asset.state === 'uploaded' && asset.size > 0);
    assert.ok(asset, `Missing uploaded ${platform} package`);
    const file = readFileSync(`artifacts/${assets[platform]}`);
    assert.equal(file.length, asset.size);
    entries[platform] = { downloadUrl: asset.browser_download_url, sha256: createHash('sha256').update(file).digest('hex') };
  }
  const path = 'contents/native/releases.json';
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await api(`${path}?ref=main`);
    assert.ok(response.ok || response.status === 404, `Cannot read update feed: HTTP ${response.status}`);
    const existing = response.ok ? await response.json() : null;
    const feed = existing ? JSON.parse(Buffer.from(existing.content, 'base64').toString('utf8')) : {
      schemaVersion: 1, applicationId, channels: { stable: {}, preview: {} },
    };
    const updated = mergeFeed(feed, release, entries);
    if (JSON.stringify(updated) === JSON.stringify(feed)) return;
    const owner = { name: 'youmikk', email: '2424729779+youmikk@users.noreply.github.com' };
    const write = await api(path, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `chore: update native ${TAG} downloads`, branch: 'main', sha: existing?.sha,
        content: Buffer.from(JSON.stringify(updated, null, 2) + '\n').toString('base64'), author: owner, committer: owner,
      }),
    });
    if (write.ok) { console.log(`Updated native download feed for ${TAG}.`); return; }
    if (![409, 422].includes(write.status)) throw new Error(`Cannot publish update feed: HTTP ${write.status}`);
  }
  throw new Error('Update feed changed concurrently; rerun the publish job.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await publishFeed();
}
