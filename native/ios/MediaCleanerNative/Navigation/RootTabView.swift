import SwiftUI

struct RootTabView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        // Keeping the platform TabView is intentional: on iOS 26 this is the
        // system tab shell and receives Apple's Liquid Glass behavior.
        TabView(selection: $store.selectedTab) {
            LibraryHomeView(kind: .photo, settings: store)
                .tabItem { Label("tab.photos", systemImage: "photo.on.rectangle") }
                .tag(RootTab.photos)

            LibraryHomeView(kind: .video, settings: store)
                .tabItem { Label("tab.videos", systemImage: "video") }
                .tag(RootTab.videos)

            ProfileHomeView(settings: store)
                .tabItem { Label("tab.profile", systemImage: "person.crop.circle") }
                .tag(RootTab.profile)
        }
        .tint(MCTheme.accent)
        .preferredColorScheme(store.theme == "system" ? nil : (store.theme == "dark" ? .dark : .light))
        .overlay { UpdatePresentation(updates: store.updates) }
    }
}
