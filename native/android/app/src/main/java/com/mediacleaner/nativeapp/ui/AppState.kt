package com.mediacleaner.nativeapp.ui

import android.app.Application
import android.app.PendingIntent
import android.net.Uri
import android.provider.MediaStore
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.mediacleaner.nativeapp.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class RootTab { PHOTOS, VIDEOS, PROFILE }

class AppState(application: Application) : AndroidViewModel(application) {
    val library = MediaStoreLibrary(application)
    private val reviews = ReviewStore(application)
    private val preferences = application.getSharedPreferences("native-settings", 0)
    var selectedTab by mutableStateOf(RootTab.PHOTOS)
        private set
    var theme by mutableStateOf(preferences.getString("theme", "system") ?: "system")
        private set
    var groupSize by mutableStateOf(preferences.getInt("groupSize", 5).coerceIn(5, 20))
        private set
    var glassEnabled by mutableStateOf(preferences.getBoolean("glass", true))
        private set
    var photoAccess by mutableStateOf(library.access(MediaKind.PHOTO))
        private set
    var videoAccess by mutableStateOf(library.access(MediaKind.VIDEO))
        private set
    var albums by mutableStateOf<List<MediaAlbum>>(emptyList())
        private set
    var album by mutableStateOf<MediaAlbum?>(null)
        private set
    var assets by mutableStateOf<List<MediaAsset>>(emptyList())
        private set
    var hasMore by mutableStateOf(false)
        private set
    var loading by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf(false)
        private set
    var pending by mutableStateOf<ReviewSession?>(null)
        private set
    var review by mutableStateOf<ReviewSession?>(null)
        private set
    private var loadJob: Job? = null
    private var loadGeneration = 0
    private var nextAssetOffset = 0
    val kind get() = if (selectedTab == RootTab.VIDEOS) MediaKind.VIDEO else MediaKind.PHOTO
    val access get() = if (kind == MediaKind.PHOTO) photoAccess else videoAccess

    fun selectTab(value: RootTab) {
        if (selectedTab == value || busy) return
        selectedTab = value; album = null; assets = emptyList(); pending = null
        refresh()
    }

    fun settings(newTheme: String = theme, newGroupSize: Int = groupSize, glass: Boolean = glassEnabled) {
        theme = newTheme; groupSize = newGroupSize; glassEnabled = glass
        preferences.edit().putString("theme", theme).putInt("groupSize", groupSize).putBoolean("glass", glass).apply()
    }

    fun refresh() {
        photoAccess = library.access(MediaKind.PHOTO)
        videoAccess = library.access(MediaKind.VIDEO)
        if (review != null || busy) return
        loadJob?.cancel()
        val request = ++loadGeneration
        if (selectedTab == RootTab.PROFILE) { loading = false; return }
        if (access == LibraryAccess.DENIED) {
            albums = emptyList(); assets = emptyList(); pending = null; hasMore = false; loading = false
            return
        }
        val requestedKind = kind
        loadJob = viewModelScope.launch {
            loading = true
            try {
                pending = reviews.load(requestedKind)
                val selected = album
                if (selected == null) albums = library.albums(requestedKind)
                else {
                    assets = library.assets(requestedKind, selected.id, 0, 90)
                    nextAssetOffset = assets.size; hasMore = assets.size == 90
                }
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { android.util.Log.e("Library", "Load failed", e); error = true }
            finally { if (request == loadGeneration) loading = false }
        }
    }

    fun openAlbum(value: MediaAlbum?) {
        if (busy) return
        album = value; assets = emptyList(); hasMore = false; refresh()
    }
    fun loadMore() {
        val selected = album ?: return
        if (loading || busy || error || !hasMore) return
        val requestedKind = kind
        val offset = nextAssetOffset
        val request = ++loadGeneration
        loadJob = viewModelScope.launch {
            loading = true
            try {
                val page = library.assets(requestedKind, selected.id, offset, 90)
                assets = (assets + page).distinctBy { it.id }
                nextAssetOffset = offset + page.size
                hasMore = page.size == 90
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = true }
            finally { if (request == loadGeneration) loading = false }
        }
    }

    fun startReview(allTitle: String) = mutate {
        reviews.load(kind)?.let { review = it; pending = it; return@mutate }
        val selected = album ?: MediaAlbum("all", allTitle, 0, null)
        val group = mutableListOf<MediaAsset>()
        var offset = 0
        while (group.size < groupSize) {
            val page = library.assets(kind, selected.id, offset, 200)
            val seen = reviews.reviewed(kind, page.map { it.id })
            group += page.filter { it.id !in seen }.take(groupSize - group.size)
            if (page.size < 200) break
            offset += page.size
        }
        val session = ReviewSession(kind, selected.id, selected.title.ifEmpty { allTitle }, group)
        if (group.isNotEmpty()) reviews.save(session)
        review = session; pending = session.takeIf { group.isNotEmpty() }
    }

    fun decide(delete: Boolean) = mutate {
        val session = review ?: return@mutate
        val asset = session.assets.getOrNull(session.index) ?: return@mutate
        val next = session.copy(index = session.index + 1, marked = if (delete) session.marked + asset.id else session.marked - asset.id)
        reviews.save(next); review = next; pending = next
    }
    fun undo() = mutate {
        val session = review ?: return@mutate
        if (session.index == 0) return@mutate
        val index = session.index - 1
        val next = session.copy(index = index, marked = session.marked - session.assets[index].id)
        reviews.save(next); review = next; pending = next
    }
    fun closeReview() { if (!busy) { review = null; refresh() } }
    fun clearError() { error = false }

    fun confirm(launchDelete: (PendingIntent) -> Unit) = mutate {
        val session = review ?: return@mutate
        if (session.index < session.assets.size) return@mutate
        if (session.marked.isEmpty()) { reviews.complete(session); pending = null; review = null; return@mutate }
        val request = session.copy(awaitingDeletion = true)
        reviews.save(request); review = request; pending = request
        val selected = request.assets.filter { it.id in request.marked }
        val existing = library.existing(selected)
        if (existing.isEmpty()) {
            reviews.complete(session); preferences.edit().remove("pendingDelete").apply()
            pending = null; review = null; return@mutate
        }
        withContext(Dispatchers.IO) {
            check(preferences.edit().putString("pendingDelete", session.kind.name).commit())
        }
        launchDelete(MediaStore.createDeleteRequest(getApplication<Application>().contentResolver,
            selected.filter { it.id in existing }.map { Uri.parse(it.uri) }))
    }

    fun deletionResult(accepted: Boolean) = mutate {
        val targetKind = preferences.getString("pendingDelete", null)?.let { MediaKind.valueOf(it) } ?: return@mutate
        val session = reviews.load(targetKind)
        if (session == null) { preferences.edit().remove("pendingDelete").apply(); return@mutate }
        if (accepted) {
            val remaining = library.existing(session.assets.filter { it.id in session.marked })
            if (remaining.isNotEmpty()) throw IllegalStateException("Delete was not completed")
            reviews.complete(session); review = null; pending = null
        } else {
            val next = session.copy(awaitingDeletion = false)
            reviews.save(next); review = next; pending = next
        }
        preferences.edit().remove("pendingDelete").apply()
    }

    private fun mutate(action: suspend () -> Unit) {
        if (busy) return
        busy = true
        viewModelScope.launch {
            try { action() }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { android.util.Log.e("Review", "Operation failed", e); error = true }
            finally { busy = false; if (review == null) refresh() }
        }
    }
}
