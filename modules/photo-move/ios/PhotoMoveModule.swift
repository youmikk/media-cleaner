import ExpoModulesCore
import ImageIO
import Photos
import CoreGraphics

/**
 * iOS side of the PhotoMove module.
 * - readExif: full EXIF via ImageIO (HEIC/JPEG/DNG) — the iOS equivalent
 *   of Android's ExifInterface.
 * - decodeGray: fast grayscale thumbnails; ph:// assets use the Photos
 *   framework's SYSTEM-CACHED thumbnails (near-zero cost).
 * - Move-related functions are Android-only and report unavailable here
 *   (iOS albums are collections — nothing needs moving).
 */
public class PhotoMoveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PhotoMove")

    Function("cpuCores") { () -> Int in
      return ProcessInfo.processInfo.activeProcessorCount
    }

    // Android-only concepts — "false" keeps JS on the iOS collection path.
    Function("hasAllFilesPermission") { () -> Bool in
      return false
    }

    Function("requestAllFilesPermission") {}

    AsyncFunction("readExif") { (uri: String) -> [String: Any] in
      guard let source = PhotoMoveModule.imageSource(for: uri) else {
        throw NSError(domain: "PhotoMove", code: 1, userInfo: nil)
      }
      guard
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
          as? [CFString: Any]
      else {
        throw NSError(domain: "PhotoMove", code: 2, userInfo: nil)
      }
      var out: [String: Any] = [:]
      if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
        if let v = tiff[kCGImagePropertyTIFFMake] as? String { out["Make"] = v }
        if let v = tiff[kCGImagePropertyTIFFModel] as? String { out["Model"] = v }
      }
      if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
        if let v = exif[kCGImagePropertyExifLensModel] as? String {
          out["LensModel"] = v
        }
        if let v = exif[kCGImagePropertyExifDateTimeOriginal] as? String {
          out["DateTimeOriginal"] = v
        }
        if let v = exif[kCGImagePropertyExifFNumber] as? Double {
          out["FNumber"] = v
        }
        if let v = exif[kCGImagePropertyExifExposureTime] as? Double {
          out["ExposureTime"] = v
        }
        if let arr = exif[kCGImagePropertyExifISOSpeedRatings] as? [Any],
          let v = arr.first {
          out["ISOSpeedRatings"] = v
        }
        if let v = exif[kCGImagePropertyExifFocalLength] as? Double {
          out["FocalLength"] = v
        }
        if let v = exif[kCGImagePropertyExifFocalLenIn35mmFilm] {
          out["FocalLengthIn35mmFilm"] = v
        }
      }
      return out
    }

    AsyncFunction("decodeGray") { (uri: String, size: Int) -> String in
      var cg: CGImage? = nil
      if uri.hasPrefix("ph://") {
        cg = PhotoMoveModule.photosThumbnail(uri: uri, size: size)
      } else if let source = PhotoMoveModule.imageSource(for: uri) {
        let opts: [CFString: Any] = [
          kCGImageSourceCreateThumbnailFromImageAlways: true,
          kCGImageSourceThumbnailMaxPixelSize: size,
        ]
        cg = CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
      }
      guard let image = cg else {
        throw NSError(domain: "PhotoMove", code: 3, userInfo: nil)
      }
      var bytes = [UInt8](repeating: 0, count: size * size)
      let cs = CGColorSpaceCreateDeviceGray()
      let drawn: Bool = bytes.withUnsafeMutableBytes { buf in
        guard let ctx = CGContext(
          data: buf.baseAddress,
          width: size,
          height: size,
          bitsPerComponent: 8,
          bytesPerRow: size,
          space: cs,
          bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else { return false }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
        return true
      }
      if !drawn {
        throw NSError(domain: "PhotoMove", code: 4, userInfo: nil)
      }
      return Data(bytes).base64EncodedString()
    }
  }

  // ---- helpers ----

  private static func imageSource(for uri: String) -> CGImageSource? {
    if uri.hasPrefix("ph://") {
      guard let data = photosData(uri: uri) else { return nil }
      return CGImageSourceCreateWithData(data as CFData, nil)
    }
    let path = uri.hasPrefix("file://") ? String(uri.dropFirst(7)) : uri
    let clean = path.removingPercentEncoding ?? path
    let url = URL(fileURLWithPath: clean)
    return CGImageSourceCreateWithURL(url as CFURL, nil)
  }

  private static func fetchAsset(uri: String) -> PHAsset? {
    let raw = String(uri.dropFirst(5))
    var result = PHAsset.fetchAssets(withLocalIdentifiers: [raw], options: nil)
    if result.count == 0, let first = raw.components(separatedBy: "/").first {
      result = PHAsset.fetchAssets(withLocalIdentifiers: [first], options: nil)
    }
    return result.firstObject
  }

  private static func photosData(uri: String) -> Data? {
    guard let asset = fetchAsset(uri: uri) else { return nil }
    var data: Data? = nil
    let opts = PHImageRequestOptions()
    opts.isSynchronous = true
    opts.isNetworkAccessAllowed = true
    PHImageManager.default().requestImageDataAndOrientation(
      for: asset, options: opts
    ) { d, _, _, _ in
      data = d
    }
    return data
  }

  private static func photosThumbnail(uri: String, size: Int) -> CGImage? {
    guard let asset = fetchAsset(uri: uri) else { return nil }
    var image: CGImage? = nil
    let opts = PHImageRequestOptions()
    opts.isSynchronous = true
    opts.deliveryMode = .fastFormat
    opts.resizeMode = .fast
    opts.isNetworkAccessAllowed = true
    PHImageManager.default().requestImage(
      for: asset,
      targetSize: CGSize(width: size, height: size),
      contentMode: .aspectFill,
      options: opts
    ) { img, _ in
      image = img?.cgImage
    }
    return image
  }
}
