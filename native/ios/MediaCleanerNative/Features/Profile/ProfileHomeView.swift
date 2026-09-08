import SwiftUI

struct ProfileHomeView: View {
    @ObservedObject var settings: AppStore
    var body: some View {
        NavigationStack {
            Form {
                Section("settings.appearance") {
                    Picker("settings.theme", selection: $settings.theme) {
                        Text("theme.system").tag("system")
                        Text("theme.light").tag("light")
                        Text("theme.dark").tag("dark")
                    }
                }
                Section("review.settings") {
                    Picker("review.groupSize", selection: $settings.groupSize) {
                        ForEach([5, 10, 15, 20], id: \.self) { Text($0, format: .number).tag($0) }
                    }
                }
                UpdateSettingsSection(updates: settings.updates)
                Section { LabeledContent("version", value: "\(UpdateClient.currentVersion) (\(UpdateClient.currentBuild))") }
            }.navigationTitle("tab.profile")
        }
    }
}
