import SwiftUI
import AVKit
import Photos

struct NativeVideo: UIViewControllerRepresentable {
    let assetID: String
    final class Coordinator {
        var id: String?
        var request = PHInvalidImageRequestID
        var backgroundObserver: NSObjectProtocol?
        deinit { if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) } }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let controller = AVPlayerViewController()
        controller.player = AVPlayer()
        context.coordinator.backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak controller] _ in controller?.player?.pause() }
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        guard context.coordinator.id != assetID else { return }
        controller.player?.pause()
        controller.player?.replaceCurrentItem(with: nil)
        PHImageManager.default().cancelImageRequest(context.coordinator.request)
        context.coordinator.id = assetID
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetID], options: nil).firstObject else { return }
        let options = PHVideoRequestOptions()
        options.isNetworkAccessAllowed = false
        context.coordinator.request = PHImageManager.default().requestPlayerItem(forVideo: asset, options: options) { item, _ in
            DispatchQueue.main.async {
                guard context.coordinator.id == assetID else { return }
                item?.preferredForwardBufferDuration = 6
                controller.player?.replaceCurrentItem(with: item)
            }
        }
    }
    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) {
        coordinator.id = nil
        PHImageManager.default().cancelImageRequest(coordinator.request)
        controller.player?.pause()
        controller.player?.replaceCurrentItem(with: nil)
        controller.player = nil
        if let observer = coordinator.backgroundObserver { NotificationCenter.default.removeObserver(observer); coordinator.backgroundObserver = nil }
    }
}
