import { analyzePixels } from './imageHashing';

/**
 * Estimate image sharpness (Laplacian variance on a 64x64 grayscale
 * downscale — one shared decode with hashing/exposure via analyzePixels).
 * Higher = sharper. Returns 0 on failure.
 */
export async function laplacianVariance(uri) {
  try {
    const { sharpness } = await analyzePixels(uri);
    return sharpness;
  } catch (e) {
    return 0;
  }
}
