package com.mediacleaner.nativeapp.data

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

enum class MediaKind { PHOTO, VIDEO }
enum class LibraryAccess { DENIED, LIMITED, FULL }

data class MediaAsset(
    val id: Long,
    val uri: String,
    val kind: MediaKind,
    val created: Long,
    val duration: Long = 0,
    val bytes: Long = 0,
)

data class MediaAlbum(val id: String, val title: String, val count: Int, val cover: MediaAsset?)

interface MediaLibraryClient {
    fun access(kind: MediaKind): LibraryAccess
    suspend fun albums(kind: MediaKind): List<MediaAlbum>
    suspend fun assets(kind: MediaKind, albumId: String, offset: Int, limit: Int): List<MediaAsset>
}

class MediaStoreLibrary(private val context: Context) : MediaLibraryClient {
    override fun access(kind: MediaKind): LibraryAccess {
        val full = if (Build.VERSION.SDK_INT >= 33) {
            if (kind == MediaKind.PHOTO) Manifest.permission.READ_MEDIA_IMAGES else Manifest.permission.READ_MEDIA_VIDEO
        } else Manifest.permission.READ_EXTERNAL_STORAGE
        fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        return when {
            granted(full) -> LibraryAccess.FULL
            Build.VERSION.SDK_INT >= 34 && granted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) -> LibraryAccess.LIMITED
            else -> LibraryAccess.DENIED
        }
    }

    private fun collection(kind: MediaKind) = if (kind == MediaKind.PHOTO) {
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    } else MediaStore.Video.Media.EXTERNAL_CONTENT_URI

    override suspend fun albums(kind: MediaKind): List<MediaAlbum> = withContext(Dispatchers.IO) {
        val result = linkedMapOf<String, MediaAlbum>()
        // Use the shared image/video columns; duration exists only on videos.
        val columns = arrayOf("_id", "bucket_id", "bucket_display_name", "datetaken", "_size")
        context.contentResolver.query(collection(kind), columns, null, null, "datetaken DESC, _id DESC")?.use { cursor ->
            var count = 0
            var first: MediaAsset? = null
            while (cursor.moveToNext()) {
                ensureActive()
                val asset = MediaAsset(cursor.getLong(0), ContentUris.withAppendedId(collection(kind), cursor.getLong(0)).toString(), kind,
                    cursor.getLong(3), bytes = cursor.getLong(4))
                if (first == null) first = asset
                count++
                val id = cursor.getString(1) ?: continue
                val old = result[id]
                result[id] = if (old == null) MediaAlbum(id, cursor.getString(2) ?: id, 1, asset)
                    else old.copy(count = old.count + 1)
            }
            listOf(MediaAlbum("all", "", count, first)) + result.values.sortedBy { it.title.lowercase() }
        } ?: throw IllegalStateException("MediaStore returned no cursor")
    }

    override suspend fun assets(kind: MediaKind, albumId: String, offset: Int, limit: Int): List<MediaAsset> = withContext(Dispatchers.IO) {
        val args = Bundle().apply {
            putString(android.content.ContentResolver.QUERY_ARG_SQL_SORT_ORDER, "datetaken DESC, _id DESC")
            if (albumId != "all") {
                putString(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION, "bucket_id = ?")
                putStringArray(android.content.ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, arrayOf(albumId))
            }
        }
        val columns = mutableListOf("_id", "datetaken", "_size")
        if (kind == MediaKind.VIDEO) columns += "duration"
        val out = mutableListOf<MediaAsset>()
        context.contentResolver.query(collection(kind), columns.toTypedArray(), args, null)?.use { cursor ->
            // Some OEM providers ignore QUERY_ARG_OFFSET. Cursor positioning
            // keeps paging deterministic without materializing the full result.
            cursor.moveToPosition(offset.coerceAtLeast(0) - 1)
            while (out.size < limit.coerceIn(1, 200) && cursor.moveToNext()) {
                ensureActive()
                out += MediaAsset(cursor.getLong(0), ContentUris.withAppendedId(collection(kind), cursor.getLong(0)).toString(),
                    kind, cursor.getLong(1), if (kind == MediaKind.VIDEO) cursor.getLong(3) else 0L, cursor.getLong(2))
            }
        } ?: throw IllegalStateException("MediaStore returned no cursor")
        out
    }

    suspend fun existing(assets: List<MediaAsset>): Set<Long> = withContext(Dispatchers.IO) {
        assets.filter { asset ->
            context.contentResolver.query(Uri.parse(asset.uri), arrayOf("_id"), null, null, null)?.use { it.moveToFirst() }
                ?: throw IllegalStateException("Unable to verify deletion")
        }.map { it.id }.toSet()
    }
}
