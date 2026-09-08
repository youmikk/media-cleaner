import Foundation
import Combine

@MainActor
final class UpdateStore: ObservableObject {
    enum Status { case idle, checking, current, available, failed }
    @Published var automatic = UserDefaults.standard.object(forKey: "native.updates.automatic") as? Bool ?? true {
        didSet { UserDefaults.standard.set(automatic, forKey: "native.updates.automatic") }
    }
    @Published var includePreview = UserDefaults.standard.object(forKey: "native.updates.preview") as? Bool ?? UpdateClient.currentPreview {
        didSet {
            UserDefaults.standard.set(includePreview, forKey: "native.updates.preview")
            UserDefaults.standard.removeObject(forKey: "native.updates.lastSuccess")
            update = nil; showUpdate = false; status = .idle
        }
    }
    @Published var source = UserDefaults.standard.object(forKey: "native.updates.source") as? Int ?? 1 {
        didSet { UserDefaults.standard.set(source, forKey: "native.updates.source") }
    }
    @Published private(set) var status: Status = .idle
    @Published private(set) var update: NativeUpdate?
    @Published var showUpdate = false
    private var lastAttempt = Date.distantPast

    func check(manual: Bool = false) async {
        guard status != .checking else { return }
        let lastSuccess = UserDefaults.standard.object(forKey: "native.updates.lastSuccess") as? Date ?? .distantPast
        if !manual && (!automatic || Date().timeIntervalSince(lastSuccess) < 86400 || Date().timeIntervalSince(lastAttempt) < 60) { return }
        lastAttempt = Date()
        status = .checking
        do {
            let result = try await UpdateClient().check(includePreview: includePreview)
            UserDefaults.standard.set(Date(), forKey: "native.updates.lastSuccess")
            update = result; status = result == nil ? .current : .available
            if result != nil { showUpdate = true }
        } catch {
            status = manual && !Task.isCancelled ? .failed : .idle
        }
    }
    func openFailed() { status = .failed }
}
