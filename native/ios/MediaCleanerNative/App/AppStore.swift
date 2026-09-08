import Foundation
import Combine

enum RootTab: String, Hashable { case photos, videos, profile }

@MainActor
final class AppStore: ObservableObject {
    @Published var selectedTab: RootTab = .photos
    @Published var theme = UserDefaults.standard.string(forKey: "native.theme") ?? "system" {
        didSet { UserDefaults.standard.set(theme, forKey: "native.theme") }
    }
    @Published var groupSize = UserDefaults.standard.object(forKey: "native.groupSize") as? Int ?? 5 {
        didSet { UserDefaults.standard.set(groupSize, forKey: "native.groupSize") }
    }
    let reviews = ReviewStore()
    let updates = UpdateStore()
}

@MainActor
final class LibraryModel: ObservableObject {
    let kind: NativeMediaKind
    let library: any MediaLibraryClient
    private let reviews: ReviewStore
    @Published var access: LibraryAccess = .denied
    @Published var albums = [NativeMediaAlbum]()
    @Published var assets = [NativeMediaAsset]()
    @Published private(set) var albumsLoading = false
    @Published private(set) var assetsLoading = false
    var loading: Bool { albumsLoading || assetsLoading }
    @Published var busy = false
    @Published var error = false
    @Published var hasMore = false
    @Published var pending: ReviewSession?
    @Published var review: ReviewSession?
    private var generation = 0
    private var assetGeneration = 0
    private var activeAlbumID: String?
    private var nextAssetOffset = 0

    init(kind: NativeMediaKind, reviews: ReviewStore, library: any MediaLibraryClient = PhotoKitLibrary()) {
        self.kind = kind; self.reviews = reviews; self.library = library
        access = library.access()
    }
    func requestAccess() async { await library.requestAccess(); await refresh() }
    func refresh() async {
        access = library.access()
        guard review == nil, !busy else { return }
        generation += 1
        let request = generation
        guard access != .denied else {
            assetGeneration += 1
            albums = []; assets = []; pending = nil; hasMore = false
            albumsLoading = false; assetsLoading = false
            return
        }
        albumsLoading = true
        defer { if generation == request { albumsLoading = false } }
        do {
            let saved = try await reviews.load(kind)
            let result = try await library.albums(kind: kind)
            guard request == generation, !Task.isCancelled else { return }
            pending = saved; albums = result
        } catch {
            if request == generation, !Task.isCancelled { self.error = true }
        }
    }
    func load(_ album: NativeMediaAlbum, more: Bool = false) async {
        guard review == nil, !busy else { return }
        if library.access() == .denied { await refresh(); return }
        if more && (assetsLoading || !hasMore || activeAlbumID != album.id) { return }
        assetGeneration += 1
        let request = assetGeneration
        assetsLoading = true
        if !more { assets = []; hasMore = false; nextAssetOffset = 0; activeAlbumID = album.id }
        let offset = nextAssetOffset
        defer { if request == assetGeneration { assetsLoading = false } }
        do {
            let page = try await library.assets(kind: kind, albumID: album.id, offset: offset, limit: 90)
            guard assetGeneration == request, !Task.isCancelled else { return }
            let seen = Set(assets.map(\.id))
            assets += page.filter { !seen.contains($0.id) }
            nextAssetOffset = offset + page.count
            hasMore = page.count == 90
        } catch {
            if request == assetGeneration, !Task.isCancelled { self.error = true }
        }
    }
    func start(_ album: NativeMediaAlbum?, groupSize: Int) async {
        await mutate {
            if let saved = try await self.reviews.load(self.kind) { self.review = saved; self.pending = saved; return }
            let groupSize = max(5, min(20, groupSize))
            var group = [NativeMediaAsset]()
            var offset = 0
            while group.count < groupSize {
                let page = try await self.library.assets(kind: self.kind, albumID: album?.id ?? "all", offset: offset, limit: 200)
                let seen = try await self.reviews.reviewed(self.kind, ids: page.map(\.id))
                group += page.filter { !seen.contains($0.id) }.prefix(groupSize - group.count)
                if page.count < 200 { break }
                offset += page.count
            }
            let title = album?.title.isEmpty == false ? album!.title : String(localized: self.kind == .photo ? "all.photos" : "all.videos")
            let session = ReviewSession(kind: self.kind, albumID: album?.id ?? "all", albumTitle: title, assets: group)
            if !group.isEmpty { try await self.reviews.save(session); self.pending = session }
            self.review = session
        }
    }
    func decide(delete: Bool) async {
        await mutate {
            guard var session = self.review, session.index < session.assets.count else { return }
            let id = session.assets[session.index].id
            if delete { session.marked.insert(id) } else { session.marked.remove(id) }
            session.index += 1
            try await self.reviews.save(session)
            self.review = session; self.pending = session
        }
    }
    func undo() async {
        await mutate {
            guard var session = self.review, session.index > 0 else { return }
            session.index -= 1; session.marked.remove(session.assets[session.index].id)
            try await self.reviews.save(session)
            self.review = session; self.pending = session
        }
    }
    func confirm() async {
        await mutate {
            guard var session = self.review, session.index == session.assets.count else { return }
            if !session.marked.isEmpty {
                session.awaitingDeletion = true
                try await self.reviews.save(session)
                self.review = session; self.pending = session
                guard try await self.library.delete(Array(session.marked)) else {
                    session.awaitingDeletion = false
                    try await self.reviews.save(session)
                    self.review = session; self.pending = session
                    return
                }
            }
            try await self.reviews.complete(session)
            self.pending = nil; self.review = nil
        }
        if review == nil { await refresh() }
    }
    private func mutate(_ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do { try await operation() }
        catch { NSLog("Native review failed: %@", String(describing: error)); self.error = true }
    }
}
