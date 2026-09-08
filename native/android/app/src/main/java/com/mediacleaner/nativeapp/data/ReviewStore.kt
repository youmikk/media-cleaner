package com.mediacleaner.nativeapp.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

data class ReviewSession(
    val kind: MediaKind,
    val albumId: String,
    val albumTitle: String,
    val assets: List<MediaAsset>,
    val index: Int = 0,
    val marked: Set<Long> = emptySet(),
    val awaitingDeletion: Boolean = false,
)

// One bounded group per media type. Reviewed IDs are rows, never one growing
// JSON value; confirming a group and removing its session is one transaction.
class ReviewStore(context: Context) : SQLiteOpenHelper(context, "native-review.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE sessions (kind TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        db.execSQL("CREATE TABLE reviewed (kind TEXT NOT NULL, asset_id INTEGER NOT NULL, PRIMARY KEY(kind, asset_id))")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        error("Unsupported review database version")
    }

    suspend fun reviewed(kind: MediaKind, ids: List<Long>): Set<Long> = withContext(Dispatchers.IO) {
        if (ids.isEmpty()) return@withContext emptySet()
        val args = arrayOf(kind.name, *ids.map { it.toString() }.toTypedArray())
        readableDatabase.rawQuery("SELECT asset_id FROM reviewed WHERE kind = ? AND asset_id IN (${ids.joinToString { "?" }})", args).use { cursor ->
            buildSet { while (cursor.moveToNext()) add(cursor.getLong(0)) }
        }
    }

    suspend fun load(kind: MediaKind): ReviewSession? = withContext(Dispatchers.IO) {
        readableDatabase.rawQuery("SELECT payload FROM sessions WHERE kind = ?", arrayOf(kind.name)).use {
            if (!it.moveToFirst()) return@withContext null
            val value = JSONObject(it.getString(0))
            val items = value.getJSONArray("assets")
            require(items.length() in 1..20)
            val assets = (0 until items.length()).map { i ->
                val a = items.getJSONObject(i)
                MediaAsset(a.getLong("id"), a.getString("uri"), kind, a.getLong("created"), a.getLong("duration"), a.getLong("bytes"))
            }
            val marks = value.getJSONArray("marked")
            val index = value.getInt("index")
            require(index in 0..assets.size)
            ReviewSession(kind, value.getString("albumId"), value.getString("albumTitle"), assets,
                index, (0 until marks.length()).map { i -> marks.getLong(i) }.toSet(), value.optBoolean("awaitingDeletion"))
        }
    }

    suspend fun save(session: ReviewSession) = withContext(Dispatchers.IO) {
        val payload = JSONObject().put("albumId", session.albumId).put("albumTitle", session.albumTitle)
            .put("index", session.index).put("marked", JSONArray(session.marked.toList())).put("awaitingDeletion", session.awaitingDeletion)
            .put("assets", JSONArray(session.assets.map {
                JSONObject().put("id", it.id).put("uri", it.uri).put("created", it.created).put("duration", it.duration).put("bytes", it.bytes)
            }))
        writableDatabase.insertWithOnConflict("sessions", null, ContentValues().apply {
            put("kind", session.kind.name); put("payload", payload.toString())
        }, SQLiteDatabase.CONFLICT_REPLACE).also { check(it != -1L) }
        Unit
    }

    suspend fun complete(session: ReviewSession) = withContext(Dispatchers.IO) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            session.assets.forEach { asset ->
                db.execSQL("INSERT OR IGNORE INTO reviewed(kind, asset_id) VALUES (?, ?)", arrayOf(session.kind.name, asset.id))
            }
            db.delete("sessions", "kind = ?", arrayOf(session.kind.name))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
}
