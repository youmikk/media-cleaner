import * as FileSystem from 'expo-file-system/legacy';
import * as base64js from 'base64-js';

/**
 * Minimal pure-JS EXIF reader. expo-media-library only returns `exif` on
 * iOS, so on Android (and as an iOS fallback) we read the first chunk of
 * the image file and parse the TIFF/EXIF block ourselves.
 *
 * Strategy: scan for the "Exif\0\0" signature (works for JPEG APP1 and for
 * most HEIC files, where the EXIF payload is embedded verbatim), then walk
 * IFD0 + the EXIF sub-IFD for the handful of tags we display.
 */

const READ_BYTES = 512 * 1024; // EXIF lives near the start of the file

// tag id -> output key
const IFD0_TAGS = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0132: 'DateTime',
  0x8769: '_exifIFD', // pointer
};
const EXIF_TAGS = {
  0x829a: 'ExposureTime',
  0x829d: 'FNumber',
  0x8827: 'ISOSpeedRatings',
  0x9003: 'DateTimeOriginal',
  0x920a: 'FocalLength',
  0xa405: 'FocalLengthIn35mmFilm',
  0xa434: 'LensModel',
};

function findExifStart(bytes) {
  // "Exif\0\0" = 45 78 69 66 00 00
  const limit = bytes.length - 10;
  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x78 &&
      bytes[i + 2] === 0x69 &&
      bytes[i + 3] === 0x66 &&
      bytes[i + 4] === 0x00 &&
      bytes[i + 5] === 0x00
    ) {
      return i + 6; // TIFF header starts right after
    }
  }
  return -1;
}

function parseTiff(bytes, tiffStart) {
  const b0 = bytes[tiffStart];
  const b1 = bytes[tiffStart + 1];
  let little;
  if (b0 === 0x49 && b1 === 0x49) little = true;
  else if (b0 === 0x4d && b1 === 0x4d) little = false;
  else return null;

  const u16 = (off) => {
    const a = bytes[tiffStart + off];
    const b = bytes[tiffStart + off + 1];
    return little ? a | (b << 8) : (a << 8) | b;
  };
  const u32 = (off) => {
    const a = bytes[tiffStart + off];
    const b = bytes[tiffStart + off + 1];
    const c = bytes[tiffStart + off + 2];
    const d = bytes[tiffStart + off + 3];
    return little
      ? (a | (b << 8) | (c << 16) | (d << 24)) >>> 0
      : ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  };

  if (u16(2) !== 42) return null;

  const readAscii = (off, count) => {
    let s = '';
    for (let i = 0; i < count; i++) {
      const ch = bytes[tiffStart + off + i];
      if (!ch) break;
      s += String.fromCharCode(ch);
    }
    return s.trim();
  };

  const readTag = (entryOff) => {
    const type = u16(entryOff + 2);
    const count = u32(entryOff + 4);
    const valueOff = entryOff + 8;
    switch (type) {
      case 2: {
        // ASCII
        const off = count > 4 ? u32(valueOff) : valueOff;
        return readAscii(off, count);
      }
      case 3: {
        // SHORT
        const off = count > 2 ? u32(valueOff) : valueOff;
        return u16(off);
      }
      case 4:
        return count > 1 ? u32(u32(valueOff)) : u32(valueOff);
      case 5: {
        // RATIONAL
        const off = u32(valueOff);
        const num = u32(off);
        const den = u32(off + 4);
        return den ? num / den : null;
      }
      default:
        return null;
    }
  };

  const walkIFD = (ifdOff, tagMap, out) => {
    if (ifdOff <= 0 || tiffStart + ifdOff + 2 > bytes.length) return;
    const n = u16(ifdOff);
    if (n > 200) return; // sanity
    for (let i = 0; i < n; i++) {
      const entry = ifdOff + 2 + i * 12;
      if (tiffStart + entry + 12 > bytes.length) return;
      const tag = u16(entry);
      const key = tagMap[tag];
      if (!key) continue;
      const val = readTag(entry);
      if (val !== null && val !== '') out[key] = val;
    }
  };

  const out = {};
  walkIFD(u32(4), IFD0_TAGS, out);
  if (out._exifIFD) {
    walkIFD(out._exifIFD, EXIF_TAGS, out);
    delete out._exifIFD;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Parse EXIF from an image file. Returns a flat object
 * ({Make, Model, LensModel, FNumber, ExposureTime, ISOSpeedRatings,
 *   FocalLength, FocalLengthIn35mmFilm, ...}) or null.
 */
export async function parseExif(uri) {
  if (!uri) return null;
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, {
      encoding: 'base64',
      position: 0,
      length: READ_BYTES,
    });
    const bytes = base64js.toByteArray(b64);
    const start = findExifStart(bytes);
    if (start < 0) return null;
    return parseTiff(bytes, start);
  } catch (e) {
    return null;
  }
}
