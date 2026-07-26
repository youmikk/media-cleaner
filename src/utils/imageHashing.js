import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import * as base64js from 'base64-js';
import * as PhotoMove from '../../modules/photo-move';

/**
 * Decode an image at `uri` downscaled to (w x h) into raw RGBA pixels.
 * Pure-JS pipeline: expo-image-manipulator -> base64 JPEG -> jpeg-js.
 */
export async function decodePixels(uri, width, height) {
  const result = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width, height } }],
    { base64: true, compress: 0.9, format: ImageManipulator.SaveFormat.JPEG }
  );
  const bytes = base64js.toByteArray(result.base64);
  const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
  return decoded; // { width, height, data: Uint8Array (RGBA) }
}

/**
 * Convert RGBA buffer to grayscale array of luma values.
 */
export function toGrayscale(decoded) {
  const { data, width, height } = decoded;
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { gray, width, height };
}

const ANALYZE_SIZE = 64;

/**
 * ONE decode, every metric. Downscales to 64x64 and computes:
 * - hash: 64-bit DIFFERENCE hash (dHash, 8 rows × 9 cols gradient) —
 *   robust to brightness shifts, far fewer false "similar" matches than aHash
 * - sharpness: Laplacian variance — blur detection
 * - brightness: { mean, underRatio, overRatio, stdDev } — exposure and
 *   blank/pocket-shot detection
 */
export async function analyzePixels(uri) {
  let gray;
  let width = ANALYZE_SIZE;
  let height = ANALYZE_SIZE;
  // Native SUBSAMPLED decode (photoo-style) when the module is present:
  // the image is decoded small from the start instead of full-res-then-
  // shrink — several times faster, a fraction of the memory.
  if (PhotoMove.isAvailable()) {
    try {
      const b64 = await PhotoMove.decodeGray(uri, ANALYZE_SIZE);
      const bytes = base64js.toByteArray(b64);
      gray = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) gray[i] = bytes[i];
    } catch (e) {
      gray = null; // fall through to the JS pipeline
    }
  }
  if (!gray) {
    const decoded = await decodePixels(uri, ANALYZE_SIZE, ANALYZE_SIZE);
    const g = toGrayscale(decoded);
    gray = g.gray;
    width = g.width;
    height = g.height;
  }

  // --- dHash: 8 rows × 9 columns of block means, compare neighbours ---
  const ROWS = 8;
  const COLS = 9;
  const means = new Float32Array(ROWS * COLS);
  for (let r = 0; r < ROWS; r++) {
    const y0 = Math.floor((r * height) / ROWS);
    const y1 = Math.floor(((r + 1) * height) / ROWS);
    for (let c = 0; c < COLS; c++) {
      const x0 = Math.floor((c * width) / COLS);
      const x1 = Math.floor(((c + 1) * width) / COLS);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += gray[y * width + x];
          n++;
        }
      }
      means[r * COLS + c] = n ? sum / n : 0;
    }
  }
  const bits = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      bits.push(means[r * COLS + c] > means[r * COLS + c + 1] ? 1 : 0);
    }
  }
  let hex = '';
  for (let n = 0; n < 64; n += 4) {
    const nibble = (bits[n] << 3) | (bits[n + 1] << 2) | (bits[n + 2] << 1) | bits[n + 3];
    hex += nibble.toString(16);
  }

  // --- Laplacian variance (sharpness) ---
  let lapSum = 0;
  let lapCount = 0;
  const lap = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const v =
        gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      lap[i] = v;
      lapSum += v;
      lapCount++;
    }
  }
  const lapMean = lapCount ? lapSum / lapCount : 0;
  let variance = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const d = lap[y * width + x] - lapMean;
      variance += d * d;
    }
  }
  const sharpness = lapCount ? variance / lapCount : 0;

  // --- Brightness / exposure / uniformity ---
  let sum = 0;
  let under = 0;
  let over = 0;
  const total = width * height;
  for (let i = 0; i < total; i++) {
    const v = gray[i];
    sum += v;
    if (v < 30) under++;
    else if (v > 225) over++;
  }
  const mean = sum / total;
  let varSum = 0;
  for (let i = 0; i < total; i++) {
    const d = gray[i] - mean;
    varSum += d * d;
  }
  const brightness = {
    mean,
    underRatio: under / total,
    overRatio: over / total,
    stdDev: Math.sqrt(varSum / total), // near-zero => blank / pocket shot
  };

  return { hash: hex, sharpness, brightness };
}

/** 64-bit average hash (compat wrapper around analyzePixels). */
export async function aHash(uri) {
  const { hash } = await analyzePixels(uri);
  return hash;
}

/** Laplacian-variance sharpness (compat wrapper around analyzePixels). */
export async function sharpnessOf(uri) {
  const { sharpness } = await analyzePixels(uri);
  return sharpness;
}

const POPCOUNT = (() => {
  const table = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    table[i] = (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1);
  }
  return table;
})();

/**
 * Hamming distance between two 16-char hex hashes (0..64).
 */
export function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const xa = parseInt(a[i], 16);
    const xb = parseInt(b[i], 16);
    dist += POPCOUNT[xa ^ xb];
  }
  return dist;
}
