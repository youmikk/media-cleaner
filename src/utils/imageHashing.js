import * as ImageManipulator from 'expo-image-manipulator';
import jpeg from 'jpeg-js';
import * as base64js from 'base64-js';

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

/**
 * 64-bit average hash (aHash) of the image at `uri`.
 * Returns a 16-char hex string.
 */
export async function aHash(uri) {
  const decoded = await decodePixels(uri, 8, 8);
  const { gray } = toGrayscale(decoded);
  const n = Math.min(64, gray.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const avg = sum / n;
  let hex = '';
  for (let nibbleStart = 0; nibbleStart < 64; nibbleStart += 4) {
    let nibble = 0;
    for (let b = 0; b < 4; b++) {
      const idx = nibbleStart + b;
      const bit = idx < n && gray[idx] >= avg ? 1 : 0;
      nibble = (nibble << 1) | bit;
    }
    hex += nibble.toString(16);
  }
  return hex;
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
