package expo.modules.photomove

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaScannerConnection
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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * photoo-style in-place photo moving.
 *
 * With the "All files access" permission the file is moved with
 * File.renameTo (falling back to a stream copy that restores the original
 * mtime) and MediaScanner re-indexes both paths. The bytes, EXIF, taken
 * date and modified time are all untouched — only the location changes.
 */
class PhotoMoveModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PhotoMove")

    Function("cpuCores") {
      Runtime.getRuntime().availableProcessors()
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
          // DATE_ADDED is in SECONDS, DATE_TAKEN in MILLISECONDS — mixing the
          // two silently files half the library under 1970.
          val taken = if (takenC >= 0 && !c.isNull(takenC)) c.getLong(takenC) else 0L
          val created = if (taken > 0) taken else c.getLong(addedC) * 1000L
          out.add(
            ScanRow(
              id = c.getLong(idC).toString(),
              creationTime = created.toDouble(),
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
    var dest: File? = null
    var copied = false
    return try {
      val id = idStr.substringBefore('/').toLong()
      val filesUri = MediaStore.Files.getContentUri("external")
      var srcPath: String? = null
      context.contentResolver.query(
        filesUri,
        arrayOf(MediaStore.MediaColumns.DATA),
        "${MediaStore.MediaColumns._ID} = ?",
        arrayOf(id.toString()),
        null
      )?.use { c -> if (c.moveToFirst()) srcPath = c.getString(0) }

      val source = srcPath?.let { File(it) }
      if (source == null || !source.exists()) {
        return mapOf("id" to idStr, "ok" to false, "error" to "not_found")
      }
      val oldPath = source.absolutePath
      val oldDir = source.parentFile?.absolutePath

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
      if (!destDir.exists()) destDir.mkdirs()
      var target = File(destDir, source.name)
      var n = 1
      while (target.exists() && n < 1000) {
        target = File(destDir, "${source.nameWithoutExtension}_$n.${source.extension}")
        n++
      }
      // Never let FileOutputStream truncate an existing user file when the
      // bounded collision search is exhausted.
      if (target.exists()) {
        return mapOf("id" to idStr, "ok" to false, "error" to "name_collision")
      }
      dest = target

      val originalMtime = source.lastModified()
      val sourceLength = source.length()
      var moved = source.renameTo(target)
      if (!moved) {
        // Cross-volume: stream copy, then verify BEFORE touching the source.
        source.inputStream().use { input ->
          FileOutputStream(target).use { output ->
            input.copyTo(output)
            output.flush()
            // close() only guarantees the bytes reached the page cache. If
            // the device loses power (or the process is killed) after the
            // source is deleted but before the pages are written back, the
            // photo is gone for good. Force it down first.
            try {
              output.fd.sync()
            } catch (e: Exception) {
              // sync unsupported on this fs — verification below still runs
            }
          }
        }
        copied = true
        if (!target.exists() || target.length() != sourceLength) {
          target.delete()
          return mapOf("id" to idStr, "ok" to false, "error" to "copy_incomplete")
        }
        target.setLastModified(originalMtime)
        // A failed delete used to still report success, leaving the SAME
        // photo in two folders — which the duplicate detector then offered
        // up for cleaning.
        if (!source.delete()) {
          target.delete()
          return mapOf("id" to idStr, "ok" to false, "error" to "source_locked")
        }
        moved = true
      }
      if (!moved) {
        return mapOf("id" to idStr, "ok" to false, "error" to "move_failed")
      }

      // Re-index both paths and wait briefly for the destination callback.
      // A filesystem move normally creates a NEW MediaStore id; returning
      // the old id made immediate undo/delete target an entry that no longer
      // existed.
      val scanLatch = CountDownLatch(1)
      var newId: String? = null
      MediaScannerConnection.scanFile(
        context,
        arrayOf(oldPath, target.absolutePath),
        null,
        { path, uri ->
          if (path == target.absolutePath) {
            newId = uri?.lastPathSegment
            scanLatch.countDown()
          }
        }
      )
      scanLatch.await(5, TimeUnit.SECONDS)
      mapOf(
        "id" to idStr,
        "newId" to (newId ?: idStr),
        "ok" to true,
        "newPath" to target.absolutePath,
        "oldPath" to oldPath,
        "oldDir" to oldDir
      )
    } catch (e: Exception) {
      // A partially written destination must never survive: MediaScanner
      // would index the truncated file and the user gets a corrupt photo
      // next to the intact original.
      if (copied) dest?.delete()
      mapOf("id" to idStr, "ok" to false, "error" to (e.message ?: "unknown"))
    }
  }
}
