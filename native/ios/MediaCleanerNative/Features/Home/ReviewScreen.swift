import SwiftUI

struct ReviewScreen: View {
    @ObservedObject var model: LibraryModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            if let session = model.review {
                Group {
                    if session.index < session.assets.count {
                        let current = session.assets[session.index]
                        ZStack {
                            // Stable identities let the preloaded next image become
                            // current without discarding its native image view.
                            ForEach(Array(session.assets.dropFirst(session.index).prefix(2).reversed())) { asset in
                                MediaThumbnail(asset: asset, large: true)
                            }
                            if current.kind == .video { NativeVideo(assetID: current.id) }
                        }
                        .padding(.horizontal, 16)
                        .gesture(DragGesture(minimumDistance: 24).onEnded { value in
                            if abs(value.translation.width) > 96 && abs(value.translation.width) > abs(value.translation.height) && !model.busy {
                                Task { await model.decide(delete: value.translation.width < 0) }
                            }
                        })
                    } else {
                        List {
                            if session.assets.isEmpty { Text("review.finished").font(.title3) }
                            else {
                                Section("review.summary") {
                                    ForEach(session.assets) { asset in
                                        HStack {
                                            MediaThumbnail(asset: asset).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                                            Text(LocalizedStringKey(session.marked.contains(asset.id) ? "mark.delete" : "keep"))
                                                .foregroundStyle(session.marked.contains(asset.id) ? MCTheme.destructive : Color.primary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                .navigationTitle(session.albumTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Label("close", systemImage: "xmark") }.disabled(model.busy) }
                    ToolbarItem(placement: .primaryAction) {
                        Button { Task { await model.undo() } } label: { Label("undo", systemImage: "arrow.uturn.backward") }
                            .disabled(model.busy || session.index == 0)
                    }
                }
                .safeAreaInset(edge: .bottom) {
                    VStack(spacing: 12) {
                        if session.index < session.assets.count {
                            Text("\(session.index + 1) / \(session.assets.count)").font(.caption).monospacedDigit()
                            HStack(spacing: 16) {
                                Button(role: .destructive) { Task { await model.decide(delete: true) } } label: {
                                    Label("mark.delete", systemImage: "trash").frame(maxWidth: .infinity)
                                }.buttonStyle(.bordered)
                                Button { Task { await model.decide(delete: false) } } label: {
                                    Label("keep", systemImage: "checkmark").frame(maxWidth: .infinity)
                                }.buttonStyle(.borderedProminent)
                            }
                        } else if session.assets.isEmpty { Button("done") { dismiss() } }
                        else {
                            Button { Task { await model.confirm() } } label: {
                                if session.marked.isEmpty { Text("confirm.keep").frame(maxWidth: .infinity) }
                                else { Text(String(format: String(localized: "confirm.delete"), session.marked.count)).frame(maxWidth: .infinity) }
                            }.buttonStyle(.borderedProminent).tint(session.marked.isEmpty ? MCTheme.accent : MCTheme.destructive)
                        }
                    }.disabled(model.busy).controlSize(.large).padding(16)
                        .modifier(ReviewMaterial()).padding(.horizontal, 16).padding(.bottom, 8)
                }
            }
        }
        .interactiveDismissDisabled(model.busy)
        .alert("operation.failed", isPresented: $model.error) { Button("done", role: .cancel) {} } message: { Text("operation.failed.detail") }
    }
}

private struct ReviewMaterial: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        }
    }
}
