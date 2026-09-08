package com.mediacleaner.nativeapp.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.mediacleaner.nativeapp.R
import com.mediacleaner.nativeapp.data.ReviewSession
import com.mediacleaner.nativeapp.data.MediaKind

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReviewScreen(session: ReviewSession, busy: Boolean, glassEnabled: Boolean, decide: (Boolean) -> Unit,
    undo: () -> Unit, close: () -> Unit, confirm: () -> Unit) {
    BackHandler { if (!busy) close() }
    val current = session.assets.getOrNull(session.index)
    val density = LocalDensity.current
    val threshold = with(density) { 96.dp.toPx() }
    val backdrop = rememberLayerBackdrop()
    var actionHeight by remember { mutableStateOf(144.dp) }
    val shape = RoundedCornerShape(MCRadius.sheet)

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Scaffold(
            modifier = Modifier.layerBackdrop(backdrop),
            contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
            topBar = {
                TopAppBar(title = { Text(session.albumTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) }, navigationIcon = {
                    IconButton(close, enabled = !busy) { Icon(Icons.Outlined.Close, stringResource(R.string.close)) }
                }, actions = {
                    IconButton(undo, enabled = !busy && session.index > 0) {
                        Icon(Icons.AutoMirrored.Outlined.Undo, stringResource(R.string.undo))
                    }
                })
            },
        ) { padding ->
            if (current != null) {
                Box(Modifier.padding(padding).padding(horizontal = 16.dp).fillMaxSize().pointerInput(current.id, busy, threshold) {
                    var distance = 0f
                    detectHorizontalDragGestures(onDragStart = { distance = 0f },
                        onHorizontalDrag = { change, amount -> change.consume(); distance += amount },
                        onDragEnd = { if (!busy && kotlin.math.abs(distance) >= threshold) decide(distance < 0) })
                }) {
                    // Keep the next thumbnail's composition when it becomes current.
                    session.assets.drop(session.index).take(2).asReversed().forEach { asset ->
                        key(asset.id) { MediaThumbnail(asset, Modifier.fillMaxSize(), large = true) }
                    }
                    // Keep one player view across adjacent videos.
                    if (current.kind == MediaKind.VIDEO) NativeVideo(current.uri, Modifier.fillMaxSize().padding(bottom = actionHeight))
                }
            } else LazyColumn(Modifier.padding(padding).fillMaxSize(),
                contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = actionHeight + 16.dp)) {
                item {
                    Text(stringResource(if (session.assets.isEmpty()) R.string.review_finished else R.string.review_summary),
                        style = MaterialTheme.typography.titleLarge)
                }
                items(session.assets, key = { it.id }) { asset ->
                    ListItem(headlineContent = { Text(stringResource(if (asset.id in session.marked) R.string.mark_delete else R.string.keep)) },
                        leadingContent = { MediaThumbnail(asset, Modifier.size(64.dp).clip(RoundedCornerShape(8.dp))) })
                }
            }
        }

        Column(Modifier.align(Alignment.BottomCenter).onSizeChanged { actionHeight = with(density) { it.height.toDp() } }
            .navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp).widthIn(max = 560.dp).fillMaxWidth()
            .nativeGlass(backdrop, glassEnabled, shape).clip(shape).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.fillMaxWidth().height(4.dp)) {
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            if (current != null) {
                Text(stringResource(R.string.review_progress, session.index + 1, session.assets.size))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedButton({ decide(true) }, Modifier.weight(1f), enabled = !busy) {
                        Icon(Icons.Outlined.DeleteOutline, null)
                        Text(stringResource(R.string.mark_delete), Modifier.padding(start = 8.dp))
                    }
                    Button({ decide(false) }, Modifier.weight(1f), enabled = !busy) {
                        Icon(Icons.Outlined.Check, null)
                        Text(stringResource(R.string.keep), Modifier.padding(start = 8.dp))
                    }
                }
            } else if (session.assets.isNotEmpty()) {
                Button(confirm, Modifier.fillMaxWidth(), enabled = !busy) {
                    Text(stringResource(if (session.marked.isEmpty()) R.string.confirm_keep else R.string.confirm_delete, session.marked.size))
                }
            } else Button(close, Modifier.fillMaxWidth()) { Text(stringResource(R.string.done)) }
        }
    }
}
