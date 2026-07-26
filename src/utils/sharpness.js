import { decodePixels, toGrayscale } from './imageHashing';

/**
 * Estimate image sharpness using the variance of the Laplacian on a
 * 100x100 grayscale downscale. Higher = sharper. Returns 0 on failure.
 */
export async function laplacianVariance(uri) {
  try {
    const decoded = await decodePixels(uri, 100, 100);
    const { gray, width, height } = toGrayscale(decoded);
    const lap = new Float32Array(width * height);
    let count = 0;
    let sum = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const v =
          gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
        lap[i] = v;
        sum += v;
        count++;
      }
    }
    if (count === 0) return 0;
    const mean = sum / count;
    let variance = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const d = lap[y * width + x] - mean;
        variance += d * d;
      }
    }
    return variance / count;
  } catch (e) {
    return 0;
  }
}
