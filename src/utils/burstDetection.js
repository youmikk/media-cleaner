const BURST_WINDOW_MS = 2000;
const MIN_GROUP = 3;

/**
 * Group burst shots. Prefers an explicit burst identifier (iOS EXIF
 * `burstIdentifier`, exposed on asset info when available); falls back to
 * consecutive shots taken within 2 seconds of each other.
 *
 * @param {Array} assets MediaLibrary assets (need id, creationTime)
 * @param {Object} exifById optional map id -> exif (may contain BurstUUID)
 * @returns {Array<{ids: string[], startTime: number}>}
 */
export function groupBursts(assets, exifById = {}) {
  const groups = [];

  // 1) Explicit burst identifiers
  const byBurstId = new Map();
  const remaining = [];
  for (const a of assets) {
    const exif = exifById[a.id];
    const burstId =
      (exif && (exif.BurstUUID || exif.burstIdentifier)) || a.burstIdentifier;
    if (burstId) {
      if (!byBurstId.has(burstId)) byBurstId.set(burstId, []);
      byBurstId.get(burstId).push(a);
    } else {
      remaining.push(a);
    }
  }
  for (const members of byBurstId.values()) {
    if (members.length >= 2) {
      groups.push({
        ids: members.map((m) => m.id),
        startTime: Math.min(...members.map((m) => m.creationTime || 0)),
      });
    }
  }

  // 2) Timestamp clustering fallback
  const sorted = [...remaining].sort(
    (x, y) => (x.creationTime || 0) - (y.creationTime || 0)
  );
  let current = [];
  const flush = () => {
    if (current.length >= MIN_GROUP) {
      groups.push({
        ids: current.map((m) => m.id),
        startTime: current[0].creationTime || 0,
      });
    }
    current = [];
  };
  for (const a of sorted) {
    if (
      current.length === 0 ||
      (a.creationTime || 0) -
        (current[current.length - 1].creationTime || 0) <=
        BURST_WINDOW_MS
    ) {
      current.push(a);
    } else {
      flush();
      current = [a];
    }
  }
  flush();

  return groups.sort((a, b) => b.startTime - a.startTime);
}
