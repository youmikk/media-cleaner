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
import java.io.InputStream

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

    AsyncFunction("moveToAlbum") { assetIds: List<String>, albumName: String ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
        !Environment.isExternalStorageManager()
      ) {
        throw Exception("PERMISSION_REQUIRED")
      }
      assetIds.map { moveOne(context, it, albumName) }
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
      val bmp = open()?.use { BitmapFactory.decodeStream(it, null, opts) }
        ?: throw Exception("DECODE_FAILED")
      val scaled = Bitmap.createScaledBitmap(bmp, size, size, true)
      if (scaled !== bmp) bmp.recycle()
      val pixels = IntArray(size * size)
      scaled.getPixels(pixels, 0, size, 0, 0, size, size)
      scaled.recycle()
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

    // Batch file sizes in ONE MediaStore query (vs hundreds of stat calls).
    AsyncFunction("getSizes") { assetIds: List<String> ->
      val context = appContext.reactContext ?: throw Exception("NO_CONTEXT")
      val out = mutableMapOf<String, Double>()
      val numeric = assetIds.mapNotNull { it.substringBefore('/').toLongOrNull() }
      if (numeric.isEmpty()) return@AsyncFunction out
      val filesUri = MediaStore.Files.getContentUri("external")
      numeric.chunked(500).forEach { chunk ->
        val placeholders = chunk.joinToString(",") { "?" }
        context.contentResolver.query(
          filesUri,
          arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.SIZE),
          "${MediaStore.MediaColumns._ID} IN ($placeholders)",
          chunk.map { it.toString() }.toTypedArray(),
          null
        )?.use { c ->
          while (c.moveToNext()) {
            out[c.getLong(0).toString()] = c.getLong(1).toDouble()
          }
        }
      }
      out
    }
  }

  private fun moveOne(
    context: Context,
    idStr: String,
    albumName: String
  ): Map<String, Any?> {
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

      val destDir = File(
        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
        albumName
      )
      if (!destDir.exists()) destDir.mkdirs()
      var dest = File(destDir, source.name)
      var n = 1
      while (dest.exists()) {
        dest = File(destDir, "${source.nameWithoutExtension}_$n.${source.extension}")
        n++
      }

      val originalMtime = source.lastModified()
      var moved = source.renameTo(dest)
      if (!moved) {
        // Cross-volume: stream copy, restore mtime, verify, delete source.
        source.inputStream().use { input ->
          dest.outputStream().use { output -> input.copyTo(output) }
        }
        dest.setLastModified(originalMtime)
        if (dest.exists() && dest.length() == source.length()) {
          source.delete()
          moved = true
        } else {
          dest.delete()
        }
      }
      if (!moved) {
        return mapOf("id" to idStr, "ok" to false, "error" to "move_failed")
      }

      // Re-index both paths: the old entry disappears, the new one is
      // created from the SAME bytes (EXIF taken-date) and SAME mtime.
      MediaScannerConnection.scanFile(
        context,
        arrayOf(source.absolutePath, dest.absolutePath),
        null,
        null
      )
      mapOf("id" to idStr, "ok" to true, "newPath" to dest.absolutePath)
    } catch (e: Exception) {
      mapOf("id" to idStr, "ok" to false, "error" to (e.message ?: "unknown"))
    }
  }
}
