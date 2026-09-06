package expo.modules.photomove

import android.content.Context
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * photoo-style in-place photo moving.
 *
 * With the "All files access" permission the MediaStore row's RELATIVE_PATH
 * is updated in place. The row id, bytes, EXIF and every timestamp remain the
 * same; unlike a filesystem rename + rescan, this does not create a new row
 * with a new DATE_ADDED value.
 */
class PhotoMoveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PhotoMove")

    Function("cpuCores") {
      Runtime.getRuntime().availableProcessors()
    }

    // JS refuses to categorize on older binaries. Version 1 used a raw
    // filesystem rename followed by MediaScanner, which some OEM galleries
    // re-indexed with a new added/modified time.
    Function("moveApiVersion") { 2 }

    // Restoring with MediaLibrary.createAssetAsync creates a new row with
    // today's DATE_ADDED/DATE_MODIFIED on Android. JS only enables restore
    // when this metadata-preserving implementation is present.
    Function("restoreApiVersion") { 1 }

    AsyncFunction("getProtectedMetadata") { assetId: String ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      val id = assetId.substringBefore('/').toLongOrNull()
        ?: throw Exception("INVALID_ID")
      val uri = ContentUris.withAppendedId(
        MediaStore.Files.getContentUri("external"),
        id
      )
      val snapshot = readMoveSnapshot(context, uri)
        ?: throw Exception("NOT_FOUND")
      val metadata = snapshotToMap(snapshot).toMutableMap()
      val storageRoot = Environment.getExternalStorageDirectory().canonicalFile
      val originalFile = File(snapshot.path).canonicalFile
      val rootPrefix = storageRoot.absolutePath.trimEnd(File.separatorChar) + File.separator
      metadata["originalDir"] = originalFile.parentFile?.absolutePath
      metadata["pathRestorable"] = originalFile.absolutePath.startsWith(rootPrefix)
      metadata
    }

    AsyncFunction("albumTimestampDigest") { albumId: String, mediaType: String ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      albumTimestampDigest(context, albumId, mediaType)
    }

    AsyncFunction("restoreFromTrash") {
        fileUri: String,
        metadataJson: String,
        originalDir: String? ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      restoreOne(context, fileUri, metadataJson, originalDir)
    }

    Function("hasAllFilesPermission") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Environment.isExternalStorageManager()
      } else {
        false
      }
    }

    Function("requestAllFilesPermission") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val context = appContext.reactContext
        if (context != null) {
          try {
            val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
            intent.data = Uri.parse("package:" + context.packageName)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
          } catch (e: Exception) {
            try {
              val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
              fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
              context.startActivity(fallback)
            } catch (e2: Exception) {
              // settings screen unavailable — nothing else to do
            }
          }
        }
      }
      null
    }

    AsyncFunction("moveToAlbum") { assetIds: List<String>, albumName: String, destDir: String? ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
        !Environment.isExternalStorageManager()
      ) {
        throw Exception("PERMISSION_REQUIRED")
      }
      assetIds.map { moveOne(context, it, albumName, destDir) }
    }

    // photoo-style SUBSAMPLED decode: the image is decoded small from the
    // start (inSampleSize), never expanded at full resolution. Returns
    // base64 of size*size grayscale bytes for the JS analysis pipeline.
    AsyncFunction("decodeGray") { uri: String, size: Int ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      fun open(): InputStream? =
        if (uri.startsWith("content://")) {
          context.contentResolver.openInputStream(Uri.parse(uri))
        } else {
          FileInputStream(File(uri.removePrefix("file://")))
        }

      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
      if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
        throw Exception("DECODE_FAILED")
      }
      var sample = 1
      while (
        bounds.outWidth / (sample * 2) >= size &&
        bounds.outHeight / (sample * 2) >= size
      ) {
        sample *= 2
      }
      val opts = BitmapFactory.Options().apply { inSampleSize = sample }
      var bmp: Bitmap? = null
      var scaled: Bitmap? = null
      try {
        bmp = open()?.use { BitmapFactory.decodeStream(it, null, opts) }
          ?: throw Exception("DECODE_FAILED")
        scaled = Bitmap.createScaledBitmap(bmp, size, size, true)
        val pixels = IntArray(size * size)
        scaled.getPixels(pixels, 0, size, 0, 0, size, size)
        val bytes = ByteArray(size * size)
        for (i in pixels.indices) {
          val p = pixels[i]
          val r = (p shr 16) and 0xFF
          val g = (p shr 8) and 0xFF
          val b = p and 0xFF
          val luma = (0.299 * r + 0.587 * g + 0.114 * b).toInt().coerceIn(0, 255)
          bytes[i] = luma.toByte()
        }
        Base64.encodeToString(bytes, Base64.NO_WRAP)
      } finally {
        // Without this, an OOM or decode failure leaked the full-resolution
        // bitmap (megabytes) and left it to the finalizer — while up to
        // CONCURRENCY decodes run at once and the JS side just moves on to
        // the next photo. That is how a long analysis run OOM-killed the app.
        if (scaled !== bmp) scaled?.recycle()
        bmp?.recycle()
      }
    }

    // Full EXIF via androidx ExifInterface (photoo-style): handles
    // JPEG/HEIF/DNG/WebP — camera make/model, lens, exposure, ISO, focal.
    AsyncFunction("readExif") { uri: String ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      fun open(): InputStream? =
        if (uri.startsWith("content://")) {
          context.contentResolver.openInputStream(Uri.parse(uri))
        } else {
          FileInputStream(File(uri.removePrefix("file://")))
        }
      val out = mutableMapOf<String, Any?>()
      open()?.use { stream ->
        val exif = ExifInterface(stream)
        fun putStr(key: String, tag: String) {
          val v = exif.getAttribute(tag)
          if (!v.isNullOrEmpty()) out[key] = v
        }
        putStr("Make", ExifInterface.TAG_MAKE)
        putStr("Model", ExifInterface.TAG_MODEL)
        putStr("LensModel", ExifInterface.TAG_LENS_MODEL)
        putStr("DateTimeOriginal", ExifInterface.TAG_DATETIME_ORIGINAL)
        val f = exif.getAttributeDouble(ExifInterface.TAG_F_NUMBER, 0.0)
        if (f > 0) out["FNumber"] = f
        val ex = exif.getAttributeDouble(ExifInterface.TAG_EXPOSURE_TIME, 0.0)
        if (ex > 0) out["ExposureTime"] = ex
        val iso = exif.getAttributeInt(
          ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, 0
        )
        if (iso > 0) out["ISOSpeedRatings"] = iso
        val fl = exif.getAttributeDouble(ExifInterface.TAG_FOCAL_LENGTH, 0.0)
        if (fl > 0) out["FocalLength"] = fl
        val fl35 = exif.getAttributeInt(
          ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, 0
        )
        if (fl35 > 0) out["FocalLengthIn35mmFilm"] = fl35
      } ?: throw Exception("OPEN_FAILED")
      out
    }

    // Batch file sizes without a single per-file stat.
    //
    // Images/Video are queried FIRST because those are the collections the
    // granular Android 13+ permissions (READ_MEDIA_IMAGES / READ_MEDIA_VIDEO)
    // actually cover. Going straight to MediaStore.Files — as this used to —
    // can come back empty on those devices, and the JS caller then falls back
    // to FileSystem stats, which report 0 under scoped storage. That is how
    // the gallery size ended up showing 0 B on Android.
    AsyncFunction("getSizes") { assetIds: List<String> ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      val numeric = assetIds.mapNotNull { it.substringBefore('/').toLongOrNull() }
      val out = ConcurrentHashMap<String, Double>()
      if (numeric.isEmpty()) return@AsyncFunction out.toMap()

      var missing = numeric
      for (collection in listOf(
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
        MediaStore.Files.getContentUri("external")
      )) {
        querySizesInto(context, collection, missing, out)
        missing = missing.filter { !out.containsKey(it.toString()) }
        if (missing.isEmpty()) break
      }
      // Last resort: with "All files access" the real path can be stat-ed.
      // Only reached for rows whose SIZE column is empty — a file the media
      // scanner has written but not finished indexing.
      if (
        missing.isNotEmpty() &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
        Environment.isExternalStorageManager()
      ) {
        statSizesInto(context, missing, out)
      }
      out.toMap()
    }

    // Exact size of the WHOLE media library: one cursor per collection
    // projecting only SIZE, no per-file I/O. A 20k-asset library costs a few
    // tens of milliseconds, so the JS side no longer has to size 60 assets
    // and extrapolate the rest.
    AsyncFunction("librarySize") {
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      // Two independent cursors — run them on two threads.
      val pool = Executors.newFixedThreadPool(2)
      try {
        val photo = pool.submit<LongArray> {
          sumCollection(context, MediaStore.Images.Media.EXTERNAL_CONTENT_URI)
        }
        val video = pool.submit<LongArray> {
          sumCollection(context, MediaStore.Video.Media.EXTERNAL_CONTENT_URI)
        }
        val p = photo.get()
        val v = video.get()
        mapOf(
          "photoBytes" to p[0].toDouble(),
          "photoCount" to p[1].toDouble(),
          "videoBytes" to v[0].toDouble(),
          "videoCount" to v[1].toDouble()
        )
      } finally {
        pool.shutdown()
      }
    }

    // ONE cursor per collection for the ENTIRE library, carrying every column
    // the app needs — crucially including SIZE, which expo-media-library does
    // not expose at all. That omission is the only reason a separate batched
    // size query had to exist; with this, sizes come for free.
    //
    // Results come back as PARALLEL ARRAYS rather than a list of objects: a
    // 15k-photo library would otherwise put 15k maps of nine keys each across
    // the bridge, and that crossing is precisely the cost being removed here.
    AsyncFunction("scanLibrary") { mediaType: String, limit: Int ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      val rows = ArrayList<ScanRow>(4096)
      if (mediaType != "video") {
        scanCollection(context, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, 0, rows)
      }
      if (mediaType != "photo") {
        scanCollection(context, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, 1, rows)
      }
      // Newest first — every existing caller assumes that ordering.
      rows.sortByDescending { it.creationTime }
      val total = rows.size
      val take: List<ScanRow> =
        if (limit > 0 && total > limit) rows.subList(0, limit) else rows

      mapOf(
        "ids" to take.map { it.id },
        "creationTime" to take.map { it.creationTime },
        "modificationTime" to take.map { it.modificationTime },
        "width" to take.map { it.width },
        "height" to take.map { it.height },
        "size" to take.map { it.size },
        "duration" to take.map { it.duration },
        "albumId" to take.map { it.albumId },
        "mediaType" to take.map { it.mediaType },
        "total" to total
      )
    }
  }

  private class ScanRow(
    val id: String,
    val creationTime: Double,
    val modificationTime: Double,
    val width: Int,
    val height: Int,
    val size: Double,
    val duration: Double,
    val albumId: String,
    val mediaType: Int
  )

  /**
   * Read one MediaStore collection into `out`.
   *
   * Images and Video are queried separately rather than through
   * MediaStore.Files, for the same reason getSizes does it: those are the
   * collections the granular Android 13+ permissions actually cover.
   */
  private fun scanCollection(
    context: Context,
    collection: Uri,
    mediaType: Int,
    out: MutableList<ScanRow>
  ) {
    // MediaColumns.DATE_TAKEN / BUCKET_ID / DURATION only exist on the
    // generic column set from API 29. Naming a column the provider does not
    // know throws on query, so pre-Q devices ask for less rather than crash.
    val isQ = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    val projection = mutableListOf(
      MediaStore.MediaColumns._ID,
      MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.DATE_MODIFIED,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.WIDTH,
      MediaStore.MediaColumns.HEIGHT
    )
    if (isQ) {
      projection.add(MediaStore.MediaColumns.DATE_TAKEN)
      projection.add(MediaStore.MediaColumns.BUCKET_ID)
    }
    // Video.Media.DURATION predates the generic column and is safe anywhere.
    if (mediaType == 1) projection.add(MediaStore.Video.Media.DURATION)

    try {
      context.contentResolver.query(
        collection,
        projection.toTypedArray(),
        null,
        null,
        null
      )?.use { c ->
        val idC = c.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
        val addedC = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
        val modC = c.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
        val sizeC = c.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
        val wC = c.getColumnIndexOrThrow(MediaStore.MediaColumns.WIDTH)
        val hC = c.getColumnIndexOrThrow(MediaStore.MediaColumns.HEIGHT)
        val bucketC = if (isQ) c.getColumnIndex(MediaStore.MediaColumns.BUCKET_ID) else -1
        val takenC = if (isQ) c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN) else -1
        val durC = if (mediaType == 1) {
          c.getColumnIndex(MediaStore.Video.Media.DURATION)
        } else {
          -1
        }

        while (c.moveToNext()) {
          // Match expo-media-library exactly: its Android `creationTime` is
          // DATE_TAKEN, including zero when the provider has not populated
          // it. Falling back to DATE_ADDED here gave one asset two different
          // "creation" times depending on which cache/read path supplied it.
          val taken = if (takenC >= 0 && !c.isNull(takenC)) c.getLong(takenC) else 0L
          out.add(
            ScanRow(
              id = c.getLong(idC).toString(),
              creationTime = taken.toDouble(),
              modificationTime = c.getLong(modC) * 1000.0,
              width = c.getInt(wC),
              height = c.getInt(hC),
              size = c.getLong(sizeC).toDouble(),
              duration = if (durC >= 0) c.getLong(durC) / 1000.0 else 0.0,
              albumId = if (bucketC >= 0) (c.getString(bucketC) ?: "") else "",
              mediaType = mediaType
            )
          )
        }
      }
    } catch (e: Exception) {
      // An unreadable collection yields nothing rather than failing the scan.
    }
  }

  /** Full raw timestamp digest for one MediaStore bucket or whole library. */
  private fun albumTimestampDigest(
    context: Context,
    albumId: String,
    mediaType: String
  ): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val collections = mutableListOf<Pair<Uri, Int>>()
    if (mediaType != "video") {
      collections.add(MediaStore.Images.Media.EXTERNAL_CONTENT_URI to 0)
    }
    if (mediaType != "photo") {
      collections.add(MediaStore.Video.Media.EXTERNAL_CONTENT_URI to 1)
    }
    for ((collection, kind) in collections) {
      val scoped = albumId.isNotBlank() && albumId != "all"
      val selection = if (scoped) "${MediaStore.MediaColumns.BUCKET_ID} = ?" else null
      val args = if (scoped) arrayOf(albumId) else null
      val cursor = context.contentResolver.query(
        collection,
        arrayOf(
          MediaStore.MediaColumns._ID,
          MediaStore.MediaColumns.DATE_TAKEN,
          MediaStore.MediaColumns.DATE_ADDED,
          MediaStore.MediaColumns.DATE_MODIFIED
        ),
        selection,
        args,
        "${MediaStore.MediaColumns._ID} ASC"
      ) ?: throw Exception("TIMESTAMP_QUERY_FAILED")
      cursor.use { c ->
        while (c.moveToNext()) {
          val taken = if (c.isNull(1)) "null" else c.getLong(1).toString()
          digest.update(
            "$kind:${c.getLong(0)}:$taken:${c.getLong(2)}:${c.getLong(3)};"
              .toByteArray(Charsets.UTF_8)
          )
        }
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  /**
   * Fill `out` with {id: bytes} for whichever of `ids` exist in `collection`.
   *
   * The 500-id chunks run in PARALLEL: ContentResolver is thread-safe, and a
   * large selection needs dozens of cursors that used to be issued one after
   * another on a single background thread.
   */
  private fun querySizesInto(
    context: Context,
    collection: Uri,
    ids: List<Long>,
    out: ConcurrentHashMap<String, Double>
  ) {
    val chunks = ids.chunked(500)
    if (chunks.isEmpty()) return
    if (chunks.size == 1) {
      querySizeChunkInto(context, collection, chunks[0], out)
      return
    }
    val threads = minOf(
      chunks.size,
      maxOf(1, minOf(4, Runtime.getRuntime().availableProcessors()))
    )
    val pool = Executors.newFixedThreadPool(threads)
    try {
      chunks
        // Explicit Runnable: a bare lambda returning Unit is ambiguous
        // between submit(Runnable) and submit(Callable<Unit>).
        .map { c ->
          pool.submit(Runnable { querySizeChunkInto(context, collection, c, out) })
        }
        .forEach { it.get() }
    } finally {
      pool.shutdown()
    }
  }

  private fun querySizeChunkInto(
    context: Context,
    collection: Uri,
    chunk: List<Long>,
    out: ConcurrentHashMap<String, Double>
  ) {
    val placeholders = chunk.joinToString(",") { "?" }
    try {
      context.contentResolver.query(
        collection,
        arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE),
        "${MediaStore.MediaColumns._ID} IN ($placeholders)",
        chunk.map { it.toString() }.toTypedArray(),
        null
      )?.use { c ->
        while (c.moveToNext()) {
          val size = c.getLong(1)
          // A 0 is "unknown", not "empty file" — leaving the id out lets the
          // next collection (or the stat fallback) answer for it.
          if (size > 0) out[c.getLong(0).toString()] = size.toDouble()
        }
      }
    } catch (e: Exception) {
      // One unreadable collection must not kill the whole batch: the caller
      // still gets everything the other collections returned.
    }
  }

  /**
   * Stat the real files for ids MediaStore has no SIZE for. Only called with
   * "All files access" — without it File.length() returns 0 under scoped
   * storage, which is the very problem this module exists to avoid.
   */
  private fun statSizesInto(
    context: Context,
    ids: List<Long>,
    out: ConcurrentHashMap<String, Double>
  ) {
    val filesUri = MediaStore.Files.getContentUri("external")
    ids.chunked(500).forEach { chunk ->
      val placeholders = chunk.joinToString(",") { "?" }
      try {
        context.contentResolver.query(
          filesUri,
          arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DATA),
          "${MediaStore.MediaColumns._ID} IN ($placeholders)",
          chunk.map { it.toString() }.toTypedArray(),
          null
        )?.use { c ->
          while (c.moveToNext()) {
            val path = c.getString(1) ?: continue
            val len = File(path).length()
            if (len > 0) out[c.getLong(0).toString()] = len.toDouble()
          }
        }
      } catch (e: Exception) {
        // best effort — a missing id just stays "unknown size" for the caller
      }
    }
  }

  /** [totalBytes, count] for one MediaStore collection. */
  private fun sumCollection(context: Context, collection: Uri): LongArray {
    var bytes = 0L
    var count = 0L
    try {
      context.contentResolver.query(
        collection,
        arrayOf(MediaStore.MediaColumns.SIZE),
        null,
        null,
        null
      )?.use { c ->
        while (c.moveToNext()) {
          count++
          bytes += c.getLong(0)
        }
      }
    } catch (e: Exception) {
      // Permission revoked mid-flight — report what we have rather than
      // failing the whole call and leaving the UI with no number at all.
    }
    return longArrayOf(bytes, count)
  }

  /**
   * Restore an app-trash byte-for-byte copy as a new MediaStore row while
   * explicitly carrying forward every original time field we recorded
   * before deletion. The row is published only after byte and metadata
   * verification; on any mismatch it is deleted and the trash copy remains.
   */
  private fun restoreOne(
    context: Context,
    fileUri: String,
    metadataJson: String,
    originalDir: String?
  ): Map<String, Any?> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return mapOf("ok" to false, "error" to "unsupported_android")
    }
    var inserted: Uri? = null
    return try {
      val source = File(fileUri.removePrefix("file://")).canonicalFile
      if (!source.exists() || !source.isFile || source.length() <= 0L) {
        return mapOf("ok" to false, "error" to "trash_file_missing")
      }
      val meta = JSONObject(metadataJson)
      val displayName = meta.optString("displayName", "").trim()
      if (
        displayName.isEmpty() ||
        displayName.contains('/') ||
        displayName.contains('\\') ||
        displayName == "." ||
        displayName == ".."
      ) {
        return mapOf("ok" to false, "error" to "invalid_filename")
      }

      val storageRoot = Environment.getExternalStorageDirectory().canonicalFile
      val targetDir = originalDir?.takeIf { it.isNotBlank() }?.let { File(it).canonicalFile }
        ?: return mapOf("ok" to false, "error" to "original_folder_missing")
      val rootPrefix = storageRoot.absolutePath.trimEnd(File.separatorChar) + File.separator
      if (!targetDir.absolutePath.startsWith(rootPrefix)) {
        return mapOf("ok" to false, "error" to "invalid_destination")
      }
      val relativePath = targetDir.absolutePath
        .removePrefix(rootPrefix)
        .replace(File.separatorChar, '/')
        .trim('/') + "/"
      if (File(targetDir, displayName).exists()) {
        // A restore may have completed while the AsyncStorage index update
        // failed. Treat the exact same row as an idempotent retry; a different
        // file with the same name remains a hard collision.
        val existing = findExistingRestored(context, targetDir, displayName)
        if (existing != null && restoredMatchesMetadata(existing.second, meta)) {
          return mapOf(
            "ok" to true,
            "id" to existing.first,
            "path" to existing.second.path,
            "alreadyRestored" to true
          )
        }
        return mapOf("ok" to false, "error" to "name_collision")
      }

      val isVideo = meta.optString("mediaType", "photo") == "video"
      val collection = if (isVideo) {
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI
      } else {
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      }
      val dateAddedKnown = meta.has("dateAdded") && !meta.isNull("dateAdded")
      val dateModifiedKnown = meta.has("dateModified") && !meta.isNull("dateModified")
      val dateTakenKnown =
        meta.optBoolean("dateTakenPresent", false) && meta.has("dateTaken")
      val dateAdded = if (dateAddedKnown) meta.optLong("dateAdded") else 0L
      val dateModified = if (dateModifiedKnown) meta.optLong("dateModified") else 0L
      val dateTaken = if (dateTakenKnown) meta.optLong("dateTaken") else 0L
      val fileMtime = meta.optLong("fileMtime", 0L)
      val mimeType = meta.optString("mimeType", "").takeIf { it.isNotBlank() }
      val expectedSize = meta.optLong("size", 0L)
      val expectedWidth = meta.optInt("width", 0)
      val expectedHeight = meta.optInt("height", 0)
      val expectedDuration = meta.optLong("duration", 0L)
      val expectedOrientation = meta.optInt("orientation", 0)
      if (expectedSize <= 0L || source.length() != expectedSize) {
        return mapOf("ok" to false, "error" to "trash_copy_incomplete")
      }

      val initial = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
        mimeType?.let { put(MediaStore.MediaColumns.MIME_TYPE, it) }
        if (dateAddedKnown) put(MediaStore.MediaColumns.DATE_ADDED, dateAdded)
        if (dateModifiedKnown) put(MediaStore.MediaColumns.DATE_MODIFIED, dateModified)
        if (dateTakenKnown) put(MediaStore.MediaColumns.DATE_TAKEN, dateTaken)
        // Width, height, duration and orientation are provider-derived on
        // several OEM builds and may be rejected when supplied on insert.
        // The bytes must reproduce them after publish; strict verification
        // below still rolls the row back if any value differs.
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      inserted = context.contentResolver.insert(collection, initial)
        ?: return mapOf("ok" to false, "error" to "insert_failed")

      context.contentResolver.openFileDescriptor(inserted!!, "w")?.use { descriptor ->
        FileInputStream(source).use { input ->
          FileOutputStream(descriptor.fileDescriptor).use { output ->
            input.copyTo(output)
            output.flush()
            output.fd.sync()
          }
        }
      } ?: throw Exception("open_destination_failed")

      var restored = readMoveSnapshot(context, inserted!!)
      val restoredFile = restored?.path?.let { File(it) }
      val expectedMtime = if (fileMtime > 0L) fileMtime else dateModified * 1000L
      if (restoredFile != null && expectedMtime > 0L) {
        restoredFile.setLastModified(expectedMtime)
      }
      val publish = ContentValues().apply {
        put(MediaStore.MediaColumns.IS_PENDING, 0)
        if (dateAddedKnown) put(MediaStore.MediaColumns.DATE_ADDED, dateAdded)
        if (dateModifiedKnown) put(MediaStore.MediaColumns.DATE_MODIFIED, dateModified)
        if (dateTakenKnown) put(MediaStore.MediaColumns.DATE_TAKEN, dateTaken)
      }
      if (context.contentResolver.update(inserted!!, publish, null, null) != 1) {
        throw Exception("publish_failed")
      }
      restored = readMoveSnapshot(context, inserted!!)
      // Some OEM providers finish their metadata pass just after IS_PENDING
      // clears. Re-read after a short settling window before the JS side is
      // allowed to remove the only backup copy.
      Thread.sleep(300)
      restored = readMoveSnapshot(context, inserted!!)
      val finalFile = restored?.path?.let { File(it) }
      val valid = restored != null &&
        restored.size == expectedSize &&
        restored.displayName == displayName &&
        (!dateAddedKnown || restored.dateAdded == dateAdded) &&
        (!dateModifiedKnown || restored.dateModified == dateModified) &&
        restored.dateTaken == (if (dateTakenKnown) dateTaken else null) &&
        (mimeType == null || restored.mimeType == mimeType) &&
        (expectedWidth <= 0 || restored.width == expectedWidth) &&
        (expectedHeight <= 0 || restored.height == expectedHeight) &&
        (!isVideo || expectedDuration <= 0L || restored.duration == expectedDuration) &&
        (isVideo || restored.orientation == expectedOrientation) &&
        restored.mediaType == (if (isVideo) {
          MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
        } else {
          MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
        }) &&
        finalFile?.exists() == true &&
        (expectedMtime <= 0L || finalFile.lastModified() == expectedMtime)
      if (!valid) throw Exception("metadata_verification_failed")

      mapOf(
        "ok" to true,
        "id" to (inserted!!.lastPathSegment ?: ""),
        "path" to restored!!.path
      )
    } catch (e: Exception) {
      inserted?.let {
        try {
          context.contentResolver.delete(it, null, null)
        } catch (ignored: Exception) {
          // Best effort: the unpublished row is invisible to other apps.
        }
      }
      mapOf("ok" to false, "error" to (e.message ?: "restore_failed"))
    }
  }

  /**
   * Move one asset. `destDirOverride` is an absolute directory path used to
   * UNDO a previous move: the original may well have lived in DCIM/Camera,
   * and re-deriving the destination from an album name would drop it into
   * Pictures/Camera instead — a different folder that shows up as a new
   * album while the real camera roll silently loses a photo.
   */
  private fun moveOne(
    context: Context,
    idStr: String,
    albumName: String,
    destDirOverride: String? = null
  ): Map<String, Any?> {
    return try {
      val id = idStr.substringBefore('/').toLong()
      val filesUri = MediaStore.Files.getContentUri("external")
      val itemUri = ContentUris.withAppendedId(filesUri, id)
      val before = readMoveSnapshot(context, itemUri)
      val source = before?.path?.let { File(it) }
      if (before == null || source == null || !source.exists()) {
        return mapOf("id" to idStr, "ok" to false, "error" to "not_found")
      }
      val oldPath = source.absolutePath
      val oldDir = source.parentFile?.absolutePath
      val originalFileMtime = source.lastModified()

      val destDir = if (!destDirOverride.isNullOrBlank()) {
        File(destDirOverride)
      } else {
        // The album name is user-typed: strip anything that could escape
        // the pictures root now that we hold All-Files access.
        val safeName = albumName
          .replace(Regex("[/\\\\]"), "_")
          .replace("..", "_")
          .trim()
          .ifEmpty { "Album" }
        File(
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
          safeName
        )
      }
      val storageRoot = Environment.getExternalStorageDirectory().canonicalFile
      val canonicalDest = destDir.canonicalFile
      val rootPrefix = storageRoot.absolutePath.trimEnd(File.separatorChar) + File.separator
      if (!canonicalDest.absolutePath.startsWith(rootPrefix)) {
        return mapOf("id" to idStr, "ok" to false, "error" to "invalid_destination")
      }
      val relativePath = canonicalDest.absolutePath
        .removePrefix(rootPrefix)
        .replace(File.separatorChar, '/')
        .trim('/') + "/"

      val target = File(canonicalDest, before.displayName)
      // A collision must fail instead of silently renaming the user's file.
      // The filename is protected metadata too.
      if (target.exists() && target.absolutePath != source.absolutePath) {
        return mapOf("id" to idStr, "ok" to false, "error" to "name_collision")
      }
      if (target.absolutePath == source.absolutePath) {
        return mapOf(
          "id" to idStr,
          "newId" to idStr,
          "ok" to true,
          "newPath" to source.absolutePath,
          "oldPath" to oldPath,
          "oldDir" to oldDir
        )
      }

      val moved = updateMoveRow(
        context,
        itemUri,
        relativePath,
        target.name,
        before
      )
      // Do not retry with path-only values. Some providers reject writes to
      // timestamp columns; moving anyway would reproduce the exact metadata
      // regression this API exists to prevent.
      if (!moved) {
        return mapOf("id" to idStr, "ok" to false, "error" to "move_failed")
      }

      var after = readMoveSnapshot(context, itemUri)
      val movedFile = after?.path?.let { File(it) }
      if (movedFile != null && movedFile.exists() && movedFile.lastModified() != originalFileMtime) {
        movedFile.setLastModified(originalFileMtime)
        after = readMoveSnapshot(context, itemUri)
      }
      val fileMtimePreserved = movedFile?.lastModified() == originalFileMtime

      if (
        !sameProtectedMetadata(before, after) ||
        movedFile == null ||
        !movedFile.exists() ||
        !fileMtimePreserved
      ) {
        // A vendor MediaStore provider changed protected metadata. Put the
        // same row back immediately; never report a successful category move.
        val oldRelative = File(oldPath).parentFile?.canonicalFile?.absolutePath
          ?.removePrefix(rootPrefix)
          ?.replace(File.separatorChar, '/')
          ?.trim('/')
          ?.plus("/")
          ?: return mapOf("id" to idStr, "ok" to false, "error" to "rollback_path_missing")
        updateMoveRow(
          context,
          itemUri,
          oldRelative,
          before.displayName,
          before
        )
        File(oldPath).takeIf { it.exists() }?.setLastModified(originalFileMtime)
        val restored = readMoveSnapshot(context, itemUri)
        val restoredFile = restored?.path?.let { File(it) }
        val rollbackOk = sameProtectedMetadata(before, restored) && restoredFile?.exists() == true
        return mapOf(
          "id" to idStr,
          "ok" to false,
          "error" to if (rollbackOk) "metadata_changed_rolled_back" else "metadata_rollback_failed"
        )
      }

      val verified = after
        ?: return mapOf("id" to idStr, "ok" to false, "error" to "verification_failed")

      mapOf(
        "id" to idStr,
        "newId" to idStr,
        "ok" to true,
        "newPath" to verified.path,
        "oldPath" to oldPath,
        "oldDir" to oldDir
      )
    } catch (e: Exception) {
      mapOf("id" to idStr, "ok" to false, "error" to (e.message ?: "unknown"))
    }
  }

  private data class MoveSnapshot(
    val path: String,
    val displayName: String,
    val size: Long,
    val dateAdded: Long,
    val dateModified: Long,
    val dateTaken: Long?,
    val mimeType: String?,
    val width: Int,
    val height: Int,
    val duration: Long,
    val orientation: Int,
    val mediaType: Int
  )

  private fun findExistingRestored(
    context: Context,
    targetDir: File,
    displayName: String
  ): Pair<String, MoveSnapshot>? {
    val targetPath = File(targetDir, displayName).canonicalPath
    val collection = MediaStore.Files.getContentUri("external")
    return context.contentResolver.query(
      collection,
      arrayOf(MediaStore.MediaColumns._ID),
      "${MediaStore.MediaColumns.DATA} = ?",
      arrayOf(targetPath),
      null
    )?.use { cursor ->
      if (!cursor.moveToFirst()) return@use null
      val id = cursor.getLong(0).toString()
      val uri = ContentUris.withAppendedId(collection, cursor.getLong(0))
      val snapshot = readMoveSnapshot(context, uri) ?: return@use null
      id to snapshot
    }
  }

  private fun restoredMatchesMetadata(snapshot: MoveSnapshot, meta: JSONObject): Boolean {
    val dateTakenPresent = meta.optBoolean("dateTakenPresent", false)
    val fileMtime = meta.optLong("fileMtime", 0L)
    val file = File(snapshot.path)
    return snapshot.displayName == meta.optString("displayName") &&
      snapshot.size == meta.optLong("size", -1L) &&
      snapshot.dateAdded == meta.optLong("dateAdded", -1L) &&
      snapshot.dateModified == meta.optLong("dateModified", -1L) &&
      (if (dateTakenPresent) snapshot.dateTaken == meta.optLong("dateTaken") else snapshot.dateTaken == null) &&
      snapshot.mimeType == meta.optString("mimeType", "").takeIf { it.isNotBlank() } &&
      snapshot.width == meta.optInt("width", 0) &&
      snapshot.height == meta.optInt("height", 0) &&
      snapshot.duration == meta.optLong("duration", 0L) &&
      snapshot.orientation == meta.optInt("orientation", 0) &&
      snapshot.mediaType == (if (meta.optString("mediaType") == "video") {
        MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
      } else {
        MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE
      }) &&
      file.exists() && fileMtime > 0L && file.lastModified() == fileMtime
  }

  private fun snapshotToMap(snapshot: MoveSnapshot): Map<String, Any?> = mapOf(
    "displayName" to snapshot.displayName,
    "size" to snapshot.size.toDouble(),
    "dateAdded" to snapshot.dateAdded.toDouble(),
    "dateModified" to snapshot.dateModified.toDouble(),
    "dateTakenPresent" to (snapshot.dateTaken != null),
    "dateTaken" to snapshot.dateTaken?.toDouble(),
    "mimeType" to snapshot.mimeType,
    "width" to snapshot.width,
    "height" to snapshot.height,
    "duration" to snapshot.duration.toDouble(),
    "orientation" to snapshot.orientation,
    "mediaType" to if (
      snapshot.mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO
    ) "video" else "photo",
    "fileMtime" to File(snapshot.path).takeIf { it.exists() }?.lastModified()?.toDouble()
  )

  private fun readMoveSnapshot(context: Context, uri: Uri): MoveSnapshot? {
    val projection = arrayOf(
      MediaStore.MediaColumns.DATA,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.DATE_MODIFIED,
      MediaStore.MediaColumns.DATE_TAKEN,
      MediaStore.MediaColumns.MIME_TYPE,
      MediaStore.MediaColumns.WIDTH,
      MediaStore.MediaColumns.HEIGHT,
      MediaStore.Video.Media.DURATION,
      MediaStore.Images.Media.ORIENTATION,
      MediaStore.Files.FileColumns.MEDIA_TYPE
    )
    return context.contentResolver.query(uri, projection, null, null, null)?.use { c ->
      if (!c.moveToFirst()) return@use null
      val takenColumn = c.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN)
      MoveSnapshot(
        path = c.getString(0),
        displayName = c.getString(1),
        size = c.getLong(2),
        dateAdded = c.getLong(3),
        dateModified = c.getLong(4),
        dateTaken = if (takenColumn >= 0 && !c.isNull(takenColumn)) c.getLong(takenColumn) else null,
        mimeType = if (c.isNull(6)) null else c.getString(6),
        width = c.getInt(7),
        height = c.getInt(8),
        duration = c.getLong(9),
        orientation = c.getInt(10),
        mediaType = c.getInt(11)
      )
    }
  }

  private fun updateMoveRow(
    context: Context,
    uri: Uri,
    relativePath: String,
    displayName: String,
    snapshot: MoveSnapshot
  ): Boolean {
    return try {
      val values = ContentValues().apply {
        put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.DATE_ADDED, snapshot.dateAdded)
        put(MediaStore.MediaColumns.DATE_MODIFIED, snapshot.dateModified)
        snapshot.dateTaken?.let { put(MediaStore.MediaColumns.DATE_TAKEN, it) }
      }
      context.contentResolver.update(uri, values, null, null) == 1
    } catch (e: Exception) {
      false
    }
  }

  private fun sameProtectedMetadata(before: MoveSnapshot, after: MoveSnapshot?): Boolean {
    return after != null &&
      before.size == after.size &&
      before.dateAdded == after.dateAdded &&
      before.dateModified == after.dateModified &&
      before.dateTaken == after.dateTaken &&
      before.displayName == after.displayName &&
      before.mimeType == after.mimeType &&
      before.width == after.width &&
      before.height == after.height &&
      before.duration == after.duration &&
      before.orientation == after.orientation &&
      before.mediaType == after.mediaType
  }
}
