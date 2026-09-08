import Foundation
import SQLite3

struct ReviewSession: Codable, Identifiable {
    var id: String { kind.rawValue }
    let kind: NativeMediaKind
    let albumID: String
    let albumTitle: String
    let assets: [NativeMediaAsset]
    var index = 0
    var marked = Set<String>()
    var awaitingDeletion = false
}

actor ReviewStore {
    private var connection: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func database() throws -> OpaquePointer {
        if let connection { return connection }
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var db: OpaquePointer?
        guard sqlite3_open(directory.appendingPathComponent("native-review.sqlite").path, &db) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            try execute(db, "CREATE TABLE IF NOT EXISTS sessions (kind TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            try execute(db, "CREATE TABLE IF NOT EXISTS reviewed (kind TEXT NOT NULL, asset_id TEXT NOT NULL, PRIMARY KEY(kind, asset_id))")
            connection = db
            return db
        } catch { sqlite3_close(db); throw error }
    }

    private func execute(_ db: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw CocoaError(.fileWriteUnknown) }
    }
    private func statement<T>(_ sql: String, values: [String], body: (OpaquePointer) throws -> T) throws -> T {
        let db = try database()
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw CocoaError(.fileReadUnknown) }
        defer { sqlite3_finalize(statement) }
        for (index, value) in values.enumerated() {
            guard sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient) == SQLITE_OK else { throw CocoaError(.fileWriteUnknown) }
        }
        return try body(statement)
    }
    private func write(_ sql: String, _ values: [String]) throws {
        try statement(sql, values: values) {
            guard sqlite3_step($0) == SQLITE_DONE else { throw CocoaError(.fileWriteUnknown) }
        }
    }

    func load(_ kind: NativeMediaKind) throws -> ReviewSession? {
        try statement("SELECT payload FROM sessions WHERE kind = ?", values: [kind.rawValue]) {
            let result = sqlite3_step($0)
            if result == SQLITE_DONE { return nil }
            guard result == SQLITE_ROW, let text = sqlite3_column_text($0, 0) else { throw CocoaError(.fileReadCorruptFile) }
            let session = try JSONDecoder().decode(ReviewSession.self, from: Data(String(cString: text).utf8))
            guard session.kind == kind, (1...20).contains(session.assets.count), (0...session.assets.count).contains(session.index) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return session
        }
    }
    func save(_ session: ReviewSession) throws {
        let payload = String(decoding: try JSONEncoder().encode(session), as: UTF8.self)
        try write("INSERT OR REPLACE INTO sessions(kind, payload) VALUES (?, ?)", [session.kind.rawValue, payload])
    }
    func reviewed(_ kind: NativeMediaKind, ids: [String]) throws -> Set<String> {
        guard !ids.isEmpty else { return [] }
        let params = Array(repeating: "?", count: ids.count).joined(separator: ",")
        return try statement("SELECT asset_id FROM reviewed WHERE kind = ? AND asset_id IN (\(params))", values: [kind.rawValue] + ids) {
            var result = Set<String>()
            var status = sqlite3_step($0)
            while status == SQLITE_ROW {
                if let value = sqlite3_column_text($0, 0) { result.insert(String(cString: value)) }
                status = sqlite3_step($0)
            }
            guard status == SQLITE_DONE else { throw CocoaError(.fileReadUnknown) }
            return result
        }
    }
    func complete(_ session: ReviewSession) throws {
        let db = try database()
        try execute(db, "BEGIN IMMEDIATE TRANSACTION")
        do {
            for asset in session.assets { try write("INSERT OR IGNORE INTO reviewed(kind, asset_id) VALUES (?, ?)", [session.kind.rawValue, asset.id]) }
            try write("DELETE FROM sessions WHERE kind = ?", [session.kind.rawValue])
            try execute(db, "COMMIT")
        } catch { try? execute(db, "ROLLBACK"); throw error }
    }
    deinit { if let connection { sqlite3_close(connection) } }
}
