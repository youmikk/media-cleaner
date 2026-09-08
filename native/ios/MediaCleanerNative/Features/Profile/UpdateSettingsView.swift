import SwiftUI

struct UpdateSettingsSection: View {
    @ObservedObject var updates: UpdateStore
    var body: some View {
        Section("updates.title") {
            Toggle("updates.automatic", isOn: $updates.automatic)
            Toggle("updates.preview", isOn: $updates.includePreview).disabled(updates.status == .checking)
            DownloadSourcePicker(source: $updates.source)
            Button { Task { await updates.check(manual: true) } } label: {
                Label(LocalizedStringKey(updates.status == .checking ? "updates.checking" : "updates.check"), systemImage: "arrow.clockwise")
            }.disabled(updates.status == .checking)
            if updates.status == .current { Text("updates.current").foregroundStyle(.secondary) }
            if updates.status == .failed { Text("updates.failed").foregroundStyle(MCTheme.destructive) }
            if let update = updates.update {
                Button(String(format: String(localized: "updates.available"), update.label)) { updates.showUpdate = true }
            }
        }
    }
}

private struct DownloadSourcePicker: View {
    @Binding var source: Int
    var body: some View {
        Picker("updates.source", selection: $source) {
            Text("updates.direct").tag(0)
            Text("updates.mirrorOne").tag(1)
            Text("updates.mirrorTwo").tag(2)
        }
    }
}

struct UpdatePresentation: View {
    @ObservedObject var updates: UpdateStore
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .task { await updates.check() }
            .onChange(of: phase) { _, value in if value == .active { Task { await updates.check() } } }
            .sheet(isPresented: $updates.showUpdate) {
                if let update = updates.update { UpdateDetailView(update: update, updates: updates) }
            }
    }
}

private struct UpdateDetailView: View {
    let update: NativeUpdate
    @ObservedObject var updates: UpdateStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("version", value: update.label)
                    Text(LocalizedStringKey(update.preview ? "updates.channelPreview" : "updates.channelStable"))
                    if !update.notes.isEmpty { Text(update.notes) }
                }
                Section {
                    DownloadSourcePicker(source: $updates.source)
                    Text("updates.iosSigning").foregroundStyle(.secondary)
                    Button {
                        openURL(update.download(source: updates.source)) { accepted in
                            if !accepted { updates.openFailed() }
                        }
                    } label: { Label("updates.download", systemImage: "arrow.down.circle") }
                    if updates.status == .failed { Text("updates.failed").foregroundStyle(MCTheme.destructive) }
                }
            }
            .navigationTitle("updates.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("close") { dismiss() } } }
        }
    }
}
