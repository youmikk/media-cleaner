import Foundation
import Photos

enum NativeMediaKind: String, Codable, Hashable { case photo, video
    var assetType: PHAssetMediaType { self == .photo ? .image : .video }
}
enum LibraryAccess: Equatable { case denied, limited, full }

struct NativeMediaAsset: Identifiable, Codable, Hashable {
    let id: String
    let kind: NativeMediaKind
    let created: Date
    let duration: Double

    init(_ asset: PHAsset) {
        id = asset.localIdentifier
        kind = asset.mediaType == .video ? .video : .photo
        created = asset.creationDate ?? .distantPast
        duration = asset.duration
    }
}

struct NativeMediaAlbum: Identifiable, Hashable {
    let id: String
    let title: String
    let count: Int
    let cover: NativeMediaAsset?
}

protocol MediaLibraryClient {
    func access() -> LibraryAccess
    func requestAccess() async
    func albums(kind: NativeMediaKind) async throws -> [NativeMediaAlbum]
    func assets(kind: NativeMediaKind, albumID: String, offset: Int, limit: Int) async throws -> [NativeMediaAsset]
    func delete(_ ids: [String]) async throws -> Bool
}

struct PhotoKitLibrary: MediaLibraryClient {
    func access() -> LibraryAccess {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return .full
        case .limited: return .limited
        default: return .denied
        }
    }
    func requestAccess() async { _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite) }

    private static func options(_ kind: NativeMediaKind) -> PHFetchOptions {
        let value = PHFetchOptions()
        value.predicate = NSPredicate(format: "mediaType == %d", kind.assetType.rawValue)
        value.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        value.includeHiddenAssets = false
        return value
    }

    func albums(kind: NativeMediaKind) async throws -> [NativeMediaAlbum] {
        try await Task.detached(priority: .userInitiated) {
            let options = Self.options(kind)
            let all = PHAsset.fetchAssets(with: options)
            var albums = [NativeMediaAlbum(id: "all", title: "", count: all.count, cover: all.firstObject.map(NativeMediaAsset.init))]
            var seen = Set<String>()
            for type in [PHAssetCollectionType.album, .smartAlbum] {
                let collections = PHAssetCollection.fetchAssetCollections(with: type, subtype: .any, options: nil)
                for index in 0..<collections.count {
                    try Task.checkCancellation()
                    let collection = collections.object(at: index)
                    guard collection.assetCollectionSubtype != .smartAlbumAllHidden,
                          collection.assetCollectionSubtype != .smartAlbumUserLibrary,
                          seen.insert(collection.localIdentifier).inserted else { continue }
                    let assets = PHAsset.fetchAssets(in: collection, options: options)
                    if assets.count > 0 {
                        albums.append(NativeMediaAlbum(id: collection.localIdentifier, title: collection.localizedTitle ?? "",
                            count: assets.count, cover: assets.firstObject.map(NativeMediaAsset.init)))
                    }
                }
            }
            return albums
        }.value
    }

    func assets(kind: NativeMediaKind, albumID: String, offset: Int, limit: Int) async throws -> [NativeMediaAsset] {
        try await Task.detached(priority: .userInitiated) {
            let fetch: PHFetchResult<PHAsset>
            if albumID == "all" { fetch = PHAsset.fetchAssets(with: Self.options(kind)) }
            else if let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumID], options: nil).firstObject {
                fetch = PHAsset.fetchAssets(in: collection, options: Self.options(kind))
            } else { return [] }
            guard offset < fetch.count else { return [] }
            return (max(0, offset)..<min(fetch.count, offset + min(limit, 200))).map { NativeMediaAsset(fetch.object(at: $0)) }
        }.value
    }

    func delete(_ ids: [String]) async throws -> Bool {
        guard access() != .denied else { throw CocoaError(.fileReadNoPermission) }
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: ids, options: nil)
        if assets.count == 0 { return true }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
            PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest.deleteAssets(assets) }) { success, error in
                if success { continuation.resume(returning: true) }
                else if let error = error as NSError?, error.domain == PHPhotosErrorDomain,
                        error.code == PHPhotosError.Code.userCancelled.rawValue {
                    continuation.resume(returning: false)
                }
                else { continuation.resume(throwing: error ?? CocoaError(.fileWriteUnknown)) }
            }
        }
    }
}
