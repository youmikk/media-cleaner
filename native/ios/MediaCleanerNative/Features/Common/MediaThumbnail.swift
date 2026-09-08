import SwiftUI
import Photos

struct MediaThumbnail: UIViewRepresentable {
    let asset: NativeMediaAsset?
    var large = false
    private static let manager = PHCachingImageManager()

    final class Coordinator {
        var id: String?
        var request = PHInvalidImageRequestID
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.clipsToBounds = true
        view.backgroundColor = .secondarySystemGroupedBackground
        view.tintColor = .secondaryLabel
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        return view
    }
    func updateUIView(_ view: UIImageView, context: Context) {
        guard context.coordinator.id != asset?.id || view.image == nil else { return }
        Self.manager.cancelImageRequest(context.coordinator.request)
        context.coordinator.id = asset?.id
        view.image = UIImage(systemName: "photo")
        view.contentMode = large ? .scaleAspectFit : .scaleAspectFill
        guard let asset, let photo = PHAsset.fetchAssets(withLocalIdentifiers: [asset.id], options: nil).firstObject else { return }
        let options = PHImageRequestOptions()
        options.resizeMode = .fast
        options.deliveryMode = .opportunistic
        options.isNetworkAccessAllowed = false
        let size: CGFloat = large ? 1200 : 256
        context.coordinator.request = Self.manager.requestImage(for: photo, targetSize: CGSize(width: size, height: size),
            contentMode: large ? .aspectFit : .aspectFill, options: options) { image, _ in
                DispatchQueue.main.async {
                    if context.coordinator.id == asset.id, let image { view.image = image }
                }
            }
    }
    static func dismantleUIView(_ view: UIImageView, coordinator: Coordinator) {
        coordinator.id = nil
        manager.cancelImageRequest(coordinator.request)
        view.image = nil
    }
}
