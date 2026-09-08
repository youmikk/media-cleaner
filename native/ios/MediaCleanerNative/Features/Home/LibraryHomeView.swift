import SwiftUI
import PhotosUI

@MainActor
struct LibraryHomeView: View {
    @ObservedObject var settings: AppStore
    @StateObject private var model: LibraryModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL

    init(kind: NativeMediaKind, settings: AppStore) {
        self.settings = settings
        _model = StateObject(wrappedValue: LibraryModel(kind: kind, reviews: settings.reviews))
    }

    var body: some View {
        NavigationStack {
            List {
                if model.access == .denied {
                    Section {
                        Text("permission.title").font(.headline)
                        Text("permission.detail").foregroundStyle(.secondary)
                        Button("grant.access") { Task { await model.requestAccess() } }
                        Button("open.settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
                    }
                } else {
                    Section {
                        if model.access == .limited {
                            Button("limited.access") { showLimitedLibraryPicker() }
                        }
                        LabeledContent("review.groupSize", value: "\(settings.groupSize)")
                        Button(LocalizedStringKey(model.pending == nil ? "start.review" : "resume.review"), systemImage: "arrow.right") {
                            Task { await model.start(nil, groupSize: settings.groupSize) }
                        }.disabled(model.busy || model.loading)
                    }
                    Section("albums.title") {
                        ForEach(model.albums) { album in
                            NavigationLink(value: album) {
                                HStack(spacing: 12) {
                                    MediaThumbnail(asset: album.cover).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(album.title.isEmpty ? String(localized: model.kind == .photo ? "all.photos" : "all.videos") : album.title)
                                        Text(album.count, format: .number).foregroundStyle(.secondary).font(.subheadline)
                                    }
                                }.padding(.vertical, 4)
                            }
                        }
                    }
                }
            }
            .navigationTitle(LocalizedStringKey(model.kind == .photo ? "tab.photos" : "tab.videos"))
            .navigationDestination(for: NativeMediaAlbum.self) { album in AlbumGridView(album: album, model: model, settings: settings) }
            .toolbar { Button { Task { await model.refresh() } } label: { Label("refresh", systemImage: "arrow.clockwise") }.disabled(model.busy) }
            .overlay { if model.albumsLoading && model.albums.isEmpty { ProgressView() } }
            .refreshable { await model.refresh() }
        }
        .task { await model.refresh() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.refresh() } } }
        .fullScreenCover(item: $model.review, onDismiss: { Task { await model.refresh() } }) { _ in ReviewScreen(model: model) }
        .alert("operation.failed", isPresented: $model.error) { Button("done", role: .cancel) {} } message: { Text("operation.failed.detail") }
    }

    private func showLimitedLibraryPicker() {
        guard let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
              var controller = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { return }
        while let presented = controller.presentedViewController { controller = presented }
        PHPhotoLibrary.shared().presentLimitedLibraryPicker(from: controller) { _ in Task { await model.refresh() } }
    }
}

private struct AlbumGridView: View {
    let album: NativeMediaAlbum
    @ObservedObject var model: LibraryModel
    @ObservedObject var settings: AppStore
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: 4)], spacing: 4) {
                ForEach(model.assets) { asset in
                    MediaThumbnail(asset: asset).aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .bottomTrailing) {
                            if asset.kind == .video {
                                Text(Duration.seconds(asset.duration), format: .time(pattern: .minuteSecond))
                                    .font(.caption).padding(4).background(.regularMaterial)
                            }
                        }
                        .onAppear {
                            if asset.id == model.assets.last?.id { Task { await model.load(album, more: true) } }
                        }
                }
            }.padding(16)
            if model.assetsLoading { ProgressView() }
            if model.assets.isEmpty && !model.assetsLoading { ContentUnavailableView("library.empty", systemImage: "photo") }
        }
        .background(MCTheme.background)
        .navigationTitle(album.title.isEmpty ? String(localized: model.kind == .photo ? "all.photos" : "all.videos") : album.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button(LocalizedStringKey(model.pending == nil ? "start.review" : "resume.review")) { Task { await model.start(album, groupSize: settings.groupSize) } }
                .disabled(model.busy || model.loading)
        }
        .task(id: album.id) { await model.load(album) }
        .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await model.load(album) } } }
        .onChange(of: model.review?.id) { _, value in if value == nil { Task { await model.load(album) } } }
    }
}
