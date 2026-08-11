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
 * - getSizes / librarySize: file sizes read straight out of the Photos
 *   database, the counterpart of Android's MediaStore queries.
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
          as? [String: Any]
      else {
        throw NSError(domain: "PhotoMove", code: 2, userInfo: nil)
      }
      var out: [String: Any] = [:]
      if let tiff = props[kCGImagePropertyTIFFDictionary as String] as? [String: Any] {
        if let v = tiff[kCGImagePropertyTIFFMake as String] as? String {
          out["Make"] = v
        }
        if let v = tiff[kCGImagePropertyTIFFModel as String] as? String {
          out["Model"] = v
        }
      }
      if let exif = props[kCGImagePropertyExifDictionary as String] as? [String: Any] {
        if let v = exif[kCGImagePropertyExifLensModel as String] as? String {
          out["LensModel"] = v
        }
        if let v = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String {
          out["DateTimeOriginal"] = v
        }
        if let v = exif[kCGImagePropertyExifFNumber as String] as? Double {
          out["FNumber"] = v
        }
        if let v = exif[kCGImagePropertyExifExposureTime as String] as? Double {
          out["ExposureTime"] = v
        }
        if let arr = exif[kCGImagePropertyExifISOSpeedRatings as String] as? [Any],
          let v = arr.first {
          out["ISOSpeedRatings"] = v
        }
        if let v = exif[kCGImagePropertyExifFocalLength as String] as? Double {
          out["FocalLength"] = v
        }
        if let v = exif[kCGImagePropertyExifFocalLenIn35mmFilm as String] {
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

    // Batch file sizes straight from the Photos database: ONE fetch for the
    // whole id list, then resource metadata per asset. Nothing decodes and
    // nothing is read off disk, so this replaces the per-asset
    // getAssetInfoAsync + file stat pair the JS side used to fall back to —
    // that pair cost two native round-trips PER PHOTO and is why "largest
    // files" and the storage numbers took tens of seconds on iOS.
    AsyncFunction("getSizes") { (assetIds: [String]) -> [String: Double] in
      // expo-media-library ids carry a "/L0/001" suffix; PhotoKit wants the
      // bare local identifier, and the JS side looks results up by that same
      // first path component.
      var identifiers: [String] = []
      var seen = Set<String>()
      for raw in assetIds {
        let key = raw.components(separatedBy: "/").first ?? raw
        if key.isEmpty || seen.contains(key) { continue }
        seen.insert(key)
        identifiers.append(key)
      }
      if identifiers.isEmpty { return [:] }

      let fetched = PHAsset.fetchAssets(
        withLocalIdentifiers: identifiers, options: nil
      )
      var assets: [PHAsset] = []
      assets.reserveCapacity(fetched.count)
      fetched.enumerateObjects { asset, _, _ in assets.append(asset) }
      if assets.isEmpty { return [:] }

      var out: [String: Double] = [:]
      let lock = NSLock()
      PhotoMoveModule.forEachChunk(assets) { slice in
        var local: [String: Double] = [:]
        for asset in slice {
          let bytes = PhotoMoveModule.assetBytes(asset)
          // 0 means "unknown" (iCloud-only original, revoked access). Leave
          // the id out so the JS caller can fall back for just that one
          // instead of reporting a photo as weightless.
          if bytes > 0 {
            let key =
              asset.localIdentifier.components(separatedBy: "/").first
              ?? asset.localIdentifier
            local[key] = bytes
          }
        }
        lock.lock()
        out.merge(local) { _, new in new }
        lock.unlock()
      }
      return out
    }

    // Exact size of the whole library. This is the only full-library walk in
    // the app, so it fans out across cores; the JS caller caches the result
    // against the library fingerprint and only recomputes when it changes.
    AsyncFunction("librarySize") { () -> [String: Double] in
      let photo = PhotoMoveModule.sumLibrary(.image)
      let video = PhotoMoveModule.sumLibrary(.video)
      return [
        "photoBytes": photo.bytes,
        "photoCount": photo.count,
        "videoBytes": video.bytes,
        "videoCount": video.count,
      ]
    }

    // ONE PhotoKit fetch for the whole library, carrying every field the app
    // needs — including the byte size, which expo-media-library does not
    // expose. That omission is the only reason a separate size query existed.
    //
    // Returned as PARALLEL ARRAYS, not an array of objects: a 15k-photo
    // library would otherwise put 15k dictionaries of nine keys each across
    // the bridge, and that crossing is the cost being removed here.
    AsyncFunction("scanLibrary") { (mediaType: String, limit: Int) -> [String: Any] in
      var assets: [PHAsset] = []
      let options = PHFetchOptions()
      options.includeHiddenAssets = false
      options.sortDescriptors = [
        NSSortDescriptor(key: "creationDate", ascending: false)
      ]
      for type in PhotoMoveModule.mediaTypes(for: mediaType) {
        let result = PHAsset.fetchAssets(with: type, options: options)
        assets.reserveCapacity(assets.count + result.count)
        result.enumerateObjects { asset, _, _ in assets.append(asset) }
      }
      // Two collections come back individually sorted; merge them.
      if PhotoMoveModule.mediaTypes(for: mediaType).count > 1 {
        assets.sort {
          ($0.creationDate?.timeIntervalSince1970 ?? 0)
            > ($1.creationDate?.timeIntervalSince1970 ?? 0)
        }
      }
      let total = assets.count
      if limit > 0 && total > limit { assets = Array(assets[0..<limit]) }

      let count = assets.count
      var ids = [String](repeating: "", count: count)
      var created = [Double](repeating: 0, count: count)
      var modified = [Double](repeating: 0, count: count)
      var widths = [Int](repeating: 0, count: count)
      var heights = [Int](repeating: 0, count: count)
      var sizes = [Double](repeating: 0, count: count)
      var durations = [Double](repeating: 0, count: count)
      var kinds = [Int](repeating: 0, count: count)

      for (i, asset) in assets.enumerated() {
        ids[i] = asset.localIdentifier.components(separatedBy: "/").first
          ?? asset.localIdentifier
        created[i] = (asset.creationDate?.timeIntervalSince1970 ?? 0) * 1000
        modified[i] = (asset.modificationDate?.timeIntervalSince1970 ?? 0) * 1000
        widths[i] = asset.pixelWidth
        heights[i] = asset.pixelHeight
        durations[i] = asset.duration
        kinds[i] = asset.mediaType == .video ? 1 : 0
      }
      // Resource metadata is the expensive half — fan it out.
      let lock = NSLock()
      PhotoMoveModule.forEachIndexChunk(count) { range in
        var local: [(Int, Double)] = []
        for i in range { local.append((i, PhotoMoveModule.assetBytes(assets[i]))) }
        lock.lock()
        for (i, b) in local { sizes[i] = b }
        lock.unlock()
      }

      return [
        "ids": ids,
        "creationTime": created,
        "modificationTime": modified,
        "width": widths,
        "height": heights,
        "size": sizes,
        "duration": durations,
        "albumId": [String](),  // iOS albums are collections, not a column
        "mediaType": kinds,
        "total": total,
      ]
    }
  }

  // ---- helpers ----

  private static func mediaTypes(for kind: String) -> [PHAssetMediaType] {
    switch kind {
    case "photo": return [.image]
    case "video": return [.video]
    default: return [.image, .video]
    }
  }

  /** Split an index range across cores and run every slice concurrently. */
  private static func forEachIndexChunk(
    _ count: Int,
    _ body: (Range<Int>) -> Void
  ) {
    if count == 0 { return }
    let cores = max(1, ProcessInfo.processInfo.activeProcessorCount)
    // Below this the thread hand-off costs more than the work itself.
    let chunkSize = max(64, (count + cores - 1) / cores)
    let starts = stride(from: 0, to: count, by: chunkSize).map { $0 }
    if starts.count == 1 {
      body(0..<count)
      return
    }
    DispatchQueue.concurrentPerform(iterations: starts.count) { i in
      let start = starts[i]
      body(start..<min(start + chunkSize, count))
    }
  }

  /**
   * Total bytes of an asset the way the Photos app counts it: every
   * resource added together (a Live Photo is a still PLUS a movie).
   *
   * `fileSize` is not a declared property on PHAssetResource, but the value
   * is there and KVC returns it from metadata alone. The public
   * alternatives — requestContentEditingInput, PHAssetResourceManager —
   * all do real per-asset I/O, which is exactly the cost this exists to
   * avoid. Returns 0 when the key is missing so the caller can fall back.
   */
  private static func assetBytes(_ asset: PHAsset) -> Double {
    var total: Int64 = 0
    for resource in PHAssetResource.assetResources(for: asset) {
      if let size = resource.value(forKey: "fileSize") as? NSNumber {
        total += size.int64Value
      }
    }
    return Double(total)
  }

  /** Split across cores and run every slice concurrently, then join. */
  private static func forEachChunk(
    _ assets: [PHAsset],
    _ body: (ArraySlice<PHAsset>) -> Void
  ) {
    let count = assets.count
    if count == 0 { return }
    let cores = max(1, ProcessInfo.processInfo.activeProcessorCount)
    // Below this the thread hand-off costs more than the work itself.
    let chunkSize = max(64, (count + cores - 1) / cores)
    let starts = stride(from: 0, to: count, by: chunkSize).map { $0 }
    if starts.count == 1 {
      body(assets[0..<count])
      return
    }
    DispatchQueue.concurrentPerform(iterations: starts.count) { i in
      let start = starts[i]
      body(assets[start..<min(start + chunkSize, count)])
    }
  }

  /** (totalBytes, count) for one media type across the whole library. */
  private static func sumLibrary(
    _ type: PHAssetMediaType
  ) -> (bytes: Double, count: Double) {
    let options = PHFetchOptions()
    options.includeHiddenAssets = false
    let result = PHAsset.fetchAssets(with: type, options: options)
    if result.count == 0 { return (0, 0) }
    var assets: [PHAsset] = []
    assets.reserveCapacity(result.count)
    result.enumerateObjects { asset, _, _ in assets.append(asset) }

    var total: Double = 0
    let lock = NSLock()
    forEachChunk(assets) { slice in
      var local: Double = 0
      for asset in slice { local += assetBytes(asset) }
      lock.lock()
      total += local
      lock.unlock()
    }
    return (total, Double(assets.count))
  }

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
