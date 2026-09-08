package com.mediacleaner.nativeapp.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.mediacleaner.nativeapp.BuildConfig
import com.mediacleaner.nativeapp.data.NativeUpdate
import com.mediacleaner.nativeapp.data.UpdateClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

enum class UpdateStatus { IDLE, CHECKING, CURRENT, AVAILABLE, FAILED }

class UpdateState(context: Context, private val scope: CoroutineScope) {
    private val preferences = context.getSharedPreferences("native-updates", 0)
    private val client = UpdateClient()
    private var lastAttempt = 0L
    var automatic by mutableStateOf(preferences.getBoolean("automatic", true))
        private set
    var includePreview by mutableStateOf(preferences.getBoolean("preview", BuildConfig.UPDATE_PRERELEASE))
        private set
    var source by mutableStateOf(preferences.getInt("source", 1).coerceIn(0, 2))
        private set
    var status by mutableStateOf(UpdateStatus.IDLE)
        private set
    var update by mutableStateOf<NativeUpdate?>(null)
        private set
    var showUpdate by mutableStateOf(false)
        private set

    fun automatic(value: Boolean) { automatic = value; preferences.edit().putBoolean("automatic", value).apply() }
    fun preview(value: Boolean) {
        includePreview = value; preferences.edit().putBoolean("preview", value).remove("lastSuccess").apply()
        update = null; showUpdate = false; status = UpdateStatus.IDLE
    }
    fun source(value: Int) { source = value; preferences.edit().putInt("source", value).apply() }
    fun dismiss() { showUpdate = false }
    fun show() { if (update != null) showUpdate = true }
    fun openFailed() { status = UpdateStatus.FAILED }

    fun check(manual: Boolean = false) {
        if (status == UpdateStatus.CHECKING) return
        val now = System.currentTimeMillis()
        if (!manual && (!automatic || now - preferences.getLong("lastSuccess", 0) < 86_400_000 || now - lastAttempt < 60_000)) return
        lastAttempt = now
        val channel = includePreview
        status = UpdateStatus.CHECKING
        scope.launch {
            try {
                val result = client.check(channel)
                preferences.edit().putLong("lastSuccess", System.currentTimeMillis()).apply()
                update = result; status = if (result == null) UpdateStatus.CURRENT else UpdateStatus.AVAILABLE
                if (result != null) showUpdate = true
            } catch (e: CancellationException) { status = UpdateStatus.IDLE; throw e }
            catch (e: Exception) { status = if (manual) UpdateStatus.FAILED else UpdateStatus.IDLE }
        }
    }
}
