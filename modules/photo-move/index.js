/**
 * JS wrapper for the local PhotoMove native module (Android, photoo-style
 * in-place moves). Guarded: Expo Go and binaries built before the module
 * existed simply report unavailable, and callers fall back to the
 * copy-then-delete flow.
 */
let native = null;
try {
  // eslint-disable-next-line global-require
  const { requireNativeModule } = require('expo-modules-core');
  native = requireNativeModule('PhotoMove');
} catch (e) {
  native = null;
}

export function isAvailable() {
  return !!native;
}

/** Number of CPU cores (0 when unavailable). */
export function cpuCores() {
  try {
    return native ? native.cpuCores() : 0;
  } catch (e) {
    return 0;
  }
}

export function hasAllFilesPermission() {
  try {
    return !!(native && native.hasAllFilesPermission());
  } catch (e) {
    return false;
  }
}

export function requestAllFilesPermission() {
  try {
    if (native) native.requestAllFilesPermission();
  } catch (e) {
    // settings screen unavailable
  }
}

/**
 * Move assets into Pictures/<albumName>/ in place.
 *
 * `destDir` is an absolute directory path that overrides the album-name
 * derived destination — pass the original folder when UNDOING a move, or a
 * camera-roll photo comes back into Pictures/Camera instead of DCIM/Camera.
 *
 * Returns [{id, ok, newPath?, oldPath?, oldDir?, error?}].
 */
export async function moveToAlbum(assetIds, albumName, destDir = null) {
  if (!native || !native.moveToAlbum) throw new Error('unavailable');
  return native.moveToAlbum(assetIds, albumName, destDir);
}

/** True when this build can do in-place moves (Android only). */
export function hasNativeMove() {
  return !!(native && native.moveToAlbum);
}

/** True when batched MediaStore size lookups are available (Android only). */
export function hasNativeSizes() {
  return !!(native && native.getSizes);
}

/**
 * photoo-style subsampled decode: base64 of size*size grayscale bytes.
 * Much faster and lighter than a full-resolution decode.
 */
export async function decodeGray(uri, size) {
  if (!native || !native.decodeGray) throw new Error('unavailable');
  return native.decodeGray(uri, size);
}

/** Batch file sizes via ONE MediaStore query: {id: bytes}. */
export async function getSizes(assetIds) {
  if (!native || !native.getSizes) throw new Error('unavailable');
  return native.getSizes(assetIds);
}

/**
 * Full EXIF via androidx ExifInterface (JPEG/HEIF/DNG/WebP):
 * {Make, Model, LensModel, FNumber, ExposureTime, ISOSpeedRatings,
 *  FocalLength, FocalLengthIn35mmFilm, DateTimeOriginal}
 */
export async function readExif(uri) {
  if (!native || !native.readExif) throw new Error('unavailable');
  return native.readExif(uri);
}
