package com.mediacleaner.nativeapp.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.mediacleaner.nativeapp.R

@Composable
fun UpdateSettings(updates: UpdateState) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.updates_title), style = MaterialTheme.typography.titleMedium)
        UpdateToggle(stringResource(R.string.updates_automatic), updates.automatic, true, updates::automatic)
        UpdateToggle(stringResource(R.string.updates_preview), updates.includePreview, updates.status != UpdateStatus.CHECKING, updates::preview)
        DownloadSources(updates)
        TextButton(onClick = { updates.check(manual = true) }, enabled = updates.status != UpdateStatus.CHECKING) {
            Icon(Icons.Outlined.Refresh, null)
            Text(stringResource(if (updates.status == UpdateStatus.CHECKING) R.string.updates_checking else R.string.updates_check), Modifier.padding(start = 8.dp))
        }
        when (updates.status) {
            UpdateStatus.CURRENT -> Text(stringResource(R.string.updates_current), color = MaterialTheme.colorScheme.onSurfaceVariant)
            UpdateStatus.FAILED -> Text(stringResource(R.string.updates_failed), color = MaterialTheme.colorScheme.error)
            UpdateStatus.AVAILABLE -> TextButton(onClick = updates::show) {
                Text(stringResource(R.string.updates_available, updates.update?.label ?: ""))
            }
            else -> Unit
        }
    }
}

@Composable
private fun UpdateToggle(label: String, checked: Boolean, enabled: Boolean, change: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = change).heightIn(min = 48.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(checked, onCheckedChange = null, enabled = enabled)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DownloadSources(updates: UpdateState) {
    Text(stringResource(R.string.updates_source), style = MaterialTheme.typography.labelLarge)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf(R.string.updates_direct, R.string.updates_mirror_one, R.string.updates_mirror_two).forEachIndexed { index, label ->
            FilterChip(updates.source == index, onClick = { updates.source(index) }, label = { Text(stringResource(label)) })
        }
    }
}

@Composable
fun UpdatePrompt(updates: UpdateState) {
    val item = updates.update ?: return
    if (!updates.showUpdate) return
    val context = LocalContext.current
    AlertDialog(onDismissRequest = updates::dismiss,
        title = { Text(stringResource(R.string.updates_available, item.label)) },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(if (item.preview) R.string.updates_channel_preview else R.string.updates_channel_stable))
                if (item.notes.isNotBlank()) Text(item.notes)
                DownloadSources(updates)
                if (updates.status == UpdateStatus.FAILED) Text(stringResource(R.string.updates_failed), color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = {
            TextButton(onClick = {
                try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(item.download(updates.source)))) }
                catch (e: Exception) { updates.openFailed() }
            }) {
                Icon(Icons.Outlined.Download, null)
                Text(stringResource(R.string.updates_download), Modifier.padding(start = 8.dp))
            }
        },
        dismissButton = { TextButton(onClick = updates::dismiss) { Text(stringResource(R.string.updates_later)) } },
    )
}
