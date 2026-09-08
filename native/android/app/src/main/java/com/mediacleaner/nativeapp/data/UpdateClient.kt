package com.mediacleaner.nativeapp.data

import com.mediacleaner.nativeapp.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.io.ByteArrayOutputStream
import android.os.SystemClock

data class NativeUpdate(
    val version: String,
    val build: Long,
    val preview: Boolean,
    val downloadUrl: String,
    val notes: String,
) {
    val label get() = "$version ($build)"
    fun download(source: Int): String = when (source) {
        1 -> "https://ghproxy.net/$downloadUrl"
        2 -> "https://gh-proxy.com/$downloadUrl"
        else -> downloadUrl
    }

    fun compare(other: NativeUpdate): Int {
        val ours = version.split('.').map { it.toLong() }
        val theirs = other.version.split('.').map { it.toLong() }
        for (index in 0..2) if (ours[index] != theirs[index]) return ours[index].compareTo(theirs[index])
        if (preview != other.preview) return if (preview) -1 else 1
        return build.compareTo(other.build)
    }
}

class UpdateClient {
    private val repository = "youmikk/media-cleaner"
    private val tagPattern = Regex("^native-v([0-9]+\\.[0-9]+\\.[0-9]+)-(stable|preview)\\.([0-9]+)$")
    private val manifestPath = "$repository/main/native/releases.json"
    private val endpoints = listOf(
        "https://cdn.jsdelivr.net/gh/$repository@main/native/releases.json",
        "https://raw.githubusercontent.com/$manifestPath",
        "https://gh-proxy.com/https://raw.githubusercontent.com/$manifestPath",
        "https://api.github.com/repos/$repository/releases?per_page=100",
        "https://gh-proxy.com/https://api.github.com/repos/$repository/releases?per_page=100",
    )

    suspend fun check(includePreview: Boolean): NativeUpdate? = withContext(Dispatchers.IO) {
        val current = NativeUpdate(BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong(), BuildConfig.UPDATE_PRERELEASE, "", "")
        var reachedSource = false
        for (endpoint in endpoints) {
            ensureActive()
            try {
                val body = request(endpoint)
                val candidates = if (endpoint.contains("/releases?")) releases(JSONArray(body)) else manifest(JSONObject(body))
                reachedSource = true
                val update = candidates.filter { includePreview || !it.preview }
                    .filter { it.build >= current.build && it.compare(current) > 0 }.maxWithOrNull { a, b -> a.compare(b) }
                if (update != null) return@withContext update
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { /* A blocked or invalid source falls through to the next mirror. */ }
        }
        if (reachedSource) return@withContext null
        throw IllegalStateException("Update sources unavailable")
    }

    private fun request(address: String): String {
        val connection = URL(address).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5000; connection.readTimeout = 5000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "MediaCleaner/${BuildConfig.VERSION_NAME}")
            connection.setRequestProperty("Cache-Control", "no-cache")
            check(connection.responseCode == 200)
            val deadline = SystemClock.elapsedRealtime() + 8000
            return connection.inputStream.use { input ->
                val output = ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    check(SystemClock.elapsedRealtime() < deadline)
                    val count = input.read(buffer)
                    if (count < 0) break
                    check(output.size() + count <= 1024 * 1024)
                    output.write(buffer, 0, count)
                }
                output.toString("UTF-8")
            }
        } finally { connection.disconnect() }
    }

    private fun manifest(value: JSONObject): List<NativeUpdate> {
        require(value.getInt("schemaVersion") == 1 && value.getString("applicationId") == BuildConfig.APPLICATION_ID)
        val channels = value.getJSONObject("channels")
        return listOf("stable", "preview").mapNotNull { channel ->
            val value = channels.getJSONObject(channel).optJSONObject("android") ?: return@mapNotNull null
            entry(value.getString("tag"), channel == "preview", value.getString("downloadUrl"), value.optString("notes"))
                ?: throw IllegalArgumentException("Invalid update entry")
        }
    }

    private fun releases(values: JSONArray): List<NativeUpdate> = buildList {
        for (index in 0 until values.length()) {
            val release = values.getJSONObject(index)
            if (release.optBoolean("draft")) continue
            val assets = release.optJSONArray("assets") ?: continue
            for (assetIndex in 0 until assets.length()) {
                val asset = assets.getJSONObject(assetIndex)
                if (asset.optString("name") != "MediaCleaner-Native-Android.apk") continue
                entry(release.optString("tag_name"), release.optBoolean("prerelease"),
                    asset.optString("browser_download_url"), release.optString("body"))?.let { add(it) }
            }
        }
    }

    private fun entry(tag: String, preview: Boolean, address: String, notes: String): NativeUpdate? {
        val match = tagPattern.matchEntire(tag) ?: return null
        if ((match.groupValues[2] == "preview") != preview) return null
        val uri = URI(address)
        if (uri.scheme != "https" || uri.host != "github.com" || uri.userInfo != null || uri.port != -1 ||
            uri.query != null || uri.fragment != null || uri.path != "/$repository/releases/download/$tag/MediaCleaner-Native-Android.apk") return null
        val build = match.groupValues[3].toLongOrNull()?.takeIf { it > 0 } ?: return null
        if (match.groupValues[1].split('.').any { it.toLongOrNull() == null }) return null
        return NativeUpdate(match.groupValues[1], build, preview, address, notes.take(16000))
    }
}
