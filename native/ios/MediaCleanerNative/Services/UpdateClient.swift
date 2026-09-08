import Foundation

struct NativeUpdate: Identifiable {
    let version: String
    let build: Int
    let preview: Bool
    let downloadURL: URL
    let notes: String
    var id: String { "\(version)-\(preview)-\(build)" }
    var label: String { "\(version) (\(build))" }

    func download(source: Int) -> URL {
        let prefix = source == 1 ? "https://ghproxy.net/" : source == 2 ? "https://gh-proxy.com/" : ""
        return URL(string: prefix + downloadURL.absoluteString)!
    }
    func newer(than other: NativeUpdate) -> Bool {
        let ours = version.split(separator: ".").map { Int($0)! }
        let theirs = other.version.split(separator: ".").map { Int($0)! }
        for index in 0..<3 where ours[index] != theirs[index] { return ours[index] > theirs[index] }
        if preview != other.preview { return !preview }
        return build > other.build
    }
}

struct UpdateClient {
    static let repository = "youmikk/media-cleaner"
    static let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.1"
    static let currentBuild = Int(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1") ?? 1
    static let currentPreview = (Bundle.main.infoDictionary?["MCPrerelease"] as? String ?? "YES") == "YES"
    private let decoder = JSONDecoder()

    private struct Feed: Decodable {
        let schemaVersion: Int
        let applicationId: String
        let channels: [String: [String: Entry]]
    }
    private struct Entry: Decodable { let tag: String; let downloadUrl: String; let notes: String }
    private struct Release: Decodable {
        let tag_name: String
        let prerelease: Bool
        let draft: Bool
        let body: String?
        let assets: [Asset]
    }
    private struct Asset: Decodable { let name: String; let browser_download_url: String }

    func check(includePreview: Bool) async throws -> NativeUpdate? {
        let repo = Self.repository
        let endpoints = [
            "https://cdn.jsdelivr.net/gh/\(repo)@main/native/releases.json",
            "https://raw.githubusercontent.com/\(repo)/main/native/releases.json",
            "https://gh-proxy.com/https://raw.githubusercontent.com/\(repo)/main/native/releases.json",
            "https://api.github.com/repos/\(repo)/releases?per_page=100",
            "https://gh-proxy.com/https://api.github.com/repos/\(repo)/releases?per_page=100",
        ]
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5; config.timeoutIntervalForResource = 8
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let current = NativeUpdate(version: Self.currentVersion, build: Self.currentBuild, preview: Self.currentPreview,
            downloadURL: URL(string: "https://github.com/\(repo)")!, notes: "")
        var reachedSource = false
        for endpoint in endpoints {
            try Task.checkCancellation()
            do {
                var request = URLRequest(url: URL(string: endpoint)!, cachePolicy: .reloadIgnoringLocalCacheData)
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                request.setValue("MediaCleaner/\(Self.currentVersion)", forHTTPHeaderField: "User-Agent")
                let (data, response) = try await session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 1024 * 1024 else { throw URLError(.badServerResponse) }
                let candidates = try (endpoint.contains("/releases?") ? releases(data) : manifest(data))
                reachedSource = true
                let update = candidates.filter { (includePreview || !$0.preview) && $0.newer(than: current) }
                    .max { $1.newer(than: $0) }
                if let update { return update }
            } catch {
                if Task.isCancelled { throw CancellationError() }
                // Blocked hosts and invalid responses fall through to the next source.
            }
        }
        if reachedSource { return nil }
        throw URLError(.cannotConnectToHost)
    }

    private func manifest(_ data: Data) throws -> [NativeUpdate] {
        let feed = try decoder.decode(Feed.self, from: data)
        guard feed.schemaVersion == 1, feed.applicationId == Bundle.main.bundleIdentifier,
              feed.channels["stable"] != nil, feed.channels["preview"] != nil else { throw URLError(.cannotParseResponse) }
        return try ["stable", "preview"].compactMap { channel in
            guard let value = feed.channels[channel]?["ios"] else { return nil }
            guard let result = entry(tag: value.tag, preview: channel == "preview", address: value.downloadUrl, notes: value.notes) else {
                throw URLError(.cannotParseResponse)
            }
            return result
        }
    }
    private func releases(_ data: Data) throws -> [NativeUpdate] {
        try decoder.decode([Release].self, from: data).compactMap { release in
            guard !release.draft, let asset = release.assets.first(where: { $0.name == "MediaCleaner-Native-iOS-unsigned.ipa" }) else { return nil }
            return entry(tag: release.tag_name, preview: release.prerelease, address: asset.browser_download_url, notes: release.body ?? "")
        }
    }
    private func entry(tag: String, preview: Bool, address: String, notes: String) -> NativeUpdate? {
        let pattern = try! NSRegularExpression(pattern: #"^native-v([0-9]+\.[0-9]+\.[0-9]+)-(stable|preview)\.([0-9]+)$"#)
        let source = tag as NSString
        guard let match = pattern.firstMatch(in: tag, range: NSRange(location: 0, length: source.length)) else { return nil }
        let version = source.substring(with: match.range(at: 1))
        guard (source.substring(with: match.range(at: 2)) == "preview") == preview,
              let build = Int(source.substring(with: match.range(at: 3))), build > 0,
              version.split(separator: ".").allSatisfy({ Int($0) != nil }),
              let url = URL(string: address), url.scheme == "https", url.host == "github.com",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil,
              url.path == "/\(Self.repository)/releases/download/\(tag)/MediaCleaner-Native-iOS-unsigned.ipa" else { return nil }
        return NativeUpdate(version: version, build: build, preview: preview, downloadURL: url, notes: String(notes.prefix(16000)))
    }
}
