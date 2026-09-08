package com.mediacleaner.nativeapp.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.backdrops.layerBackdrop
import com.kyant.backdrop.backdrops.rememberLayerBackdrop
import com.mediacleaner.nativeapp.BuildConfig
import com.mediacleaner.nativeapp.R
import com.mediacleaner.nativeapp.data.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RootScreen(state: AppState) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { state.refresh() }
    val deletion = rememberLauncherForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {
        state.deletionResult(it.resultCode == Activity.RESULT_OK)
    }
    val requestAccess = {
        permission.launch(if (Build.VERSION.SDK_INT >= 34) arrayOf(Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED)
        else if (Build.VERSION.SDK_INT >= 33) arrayOf(Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE))
    }
    DisposableEffect(owner) {
        val listener = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) state.refresh() }
        owner.lifecycle.addObserver(listener)
        onDispose { owner.lifecycle.removeObserver(listener) }
    }
    LaunchedEffect(Unit) { state.refresh() }

    val session = state.review
    if (session != null) {
        ReviewScreen(session, state.busy, state.glassEnabled, state::decide, state::undo, state::closeReview) {
            state.confirm { deletion.launch(IntentSenderRequest.Builder(it.intentSender).build()) }
        }
    } else {
        val backdrop = rememberLayerBackdrop()
        val density = LocalDensity.current
        var barHeight by remember { mutableStateOf(96.dp) }
        val title = when (state.selectedTab) {
            RootTab.PHOTOS -> R.string.tab_photos
            RootTab.VIDEOS -> R.string.tab_videos
            RootTab.PROFILE -> R.string.tab_profile
        }
        val allTitle = stringResource(if (state.kind == MediaKind.PHOTO) R.string.all_photos else R.string.all_videos)
        BackHandler(state.album != null) { if (!state.busy) state.openAlbum(null) }
        Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
            Scaffold(
                modifier = Modifier.layerBackdrop(backdrop),
                contentWindowInsets = WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal),
                topBar = {
                    TopAppBar(
                        title = { Text(state.album?.title?.ifEmpty { allTitle } ?: stringResource(title), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        navigationIcon = {
                            if (state.album != null) IconButton(onClick = { state.openAlbum(null) }, enabled = !state.busy) {
                                Icon(Icons.AutoMirrored.Outlined.ArrowBack, stringResource(R.string.back))
                            }
                        },
                        actions = {
                            if (state.selectedTab != RootTab.PROFILE) IconButton(onClick = state::refresh, enabled = !state.busy && !state.loading) {
                                Icon(Icons.Outlined.Refresh, stringResource(R.string.refresh))
                            }
                        },
                    )
                },
            ) { padding ->
                // Inset the scroll content, not its viewport: the glass needs
                // moving content behind it, while the last row stays reachable.
                Column(Modifier.padding(padding).fillMaxSize()) {
                    if (state.selectedTab == RootTab.PROFILE) SettingsScreen(state, barHeight)
                    else if (state.access == LibraryAccess.DENIED) {
                        LazyColumn(contentPadding = PaddingValues(start = 24.dp, top = 24.dp, end = 24.dp, bottom = barHeight + 24.dp),
                            verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            item { Text(stringResource(R.string.permission_title), style = MaterialTheme.typography.titleLarge) }
                            item { Text(stringResource(R.string.permission_detail)) }
                            item { Button(onClick = requestAccess) { Text(stringResource(R.string.grant_access)) } }
                            item { TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))) }) {
                                Text(stringResource(R.string.open_settings))
                            } }
                        }
                    } else {
                        if (state.access == LibraryAccess.LIMITED) TextButton(onClick = requestAccess, modifier = Modifier.padding(horizontal = 16.dp)) {
                            Text(stringResource(R.string.limited_access))
                        }
                        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(stringResource(R.string.group_size, state.groupSize), modifier = Modifier.weight(1f))
                            Button(onClick = { state.startReview(allTitle) }, enabled = !state.loading && !state.busy, modifier = Modifier.weight(1f)) {
                                Text(stringResource(if (state.pending == null) R.string.start_review else R.string.resume_review))
                            }
                        }
                        if (state.loading || state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
                        if (state.album == null) {
                            LazyColumn(Modifier.fillMaxSize(),
                                contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = barHeight + 16.dp)) {
                                items(state.albums, key = { it.id }) { album ->
                                    ListItem(
                                        headlineContent = { Text(album.title.ifEmpty { allTitle }) },
                                        supportingContent = { Text(stringResource(R.string.item_count, album.count)) },
                                        leadingContent = { MediaThumbnail(album.cover, Modifier.size(64.dp).clip(RoundedCornerShape(8.dp))) },
                                        trailingContent = { Icon(Icons.AutoMirrored.Outlined.ArrowForward, null) },
                                        modifier = Modifier.clickable(enabled = !state.busy) { state.openAlbum(album) },
                                    )
                                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                                }
                            }
                        } else LibraryGrid(state, barHeight)
                    }
                }
            }
            NativeTabBar(state, backdrop, Modifier.align(Alignment.BottomCenter)
                .onSizeChanged { barHeight = with(density) { it.height.toDp() } })
        }
    }
    if (state.error) AlertDialog(
        onDismissRequest = state::clearError,
        title = { Text(stringResource(R.string.operation_failed)) },
        text = { Text(stringResource(R.string.operation_failed_detail)) },
        confirmButton = { TextButton(onClick = state::clearError) { Text(stringResource(R.string.done)) } },
    )
}

@Composable
private fun LibraryGrid(state: AppState, bottomInset: Dp) {
    val grid = rememberLazyGridState()
    val needsMore by remember { derivedStateOf {
        grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index?.let { it >= state.assets.lastIndex - 12 } ?: false
    } }
    LaunchedEffect(needsMore, state.assets.size, state.loading, state.hasMore) {
        if (needsMore && !state.loading) state.loadMore()
    }
    LazyVerticalGrid(GridCells.Adaptive(100.dp), state = grid,
        contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = bottomInset + 16.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(state.assets, key = { it.id }) { asset ->
            Box(Modifier.aspectRatio(1f).clip(RoundedCornerShape(8.dp))) {
                MediaThumbnail(asset, Modifier.fillMaxSize())
                if (asset.kind == MediaKind.VIDEO) Surface(modifier = Modifier.align(Alignment.BottomEnd), color = MaterialTheme.colorScheme.surface) {
                    Text("${asset.duration / 60000}:${(asset.duration / 1000 % 60).toString().padStart(2, '0')}",
                        style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(4.dp))
                }
            }
        }
        if (state.assets.isEmpty() && !state.loading) item(span = { GridItemSpan(maxLineSpan) }) {
            Text(stringResource(R.string.library_empty), modifier = Modifier.padding(16.dp))
        }
    }
}

@Composable
private fun NativeTabBar(state: AppState, backdrop: Backdrop, modifier: Modifier) {
    val capsule = RoundedCornerShape(50)
    Row(modifier.navigationBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp)
        .widthIn(max = 460.dp).fillMaxWidth().nativeGlass(backdrop, state.glassEnabled, capsule)
        .clip(capsule).selectableGroup().padding(6.dp)) {
        RootTab.entries.forEach { tab ->
            val (label, image) = when (tab) {
                RootTab.PHOTOS -> R.string.tab_photos to Icons.Outlined.PhotoLibrary
                RootTab.VIDEOS -> R.string.tab_videos to Icons.Outlined.Videocam
                RootTab.PROFILE -> R.string.tab_profile to Icons.Outlined.PersonOutline
            }
            val selected = state.selectedTab == tab
            Column(Modifier.weight(1f).clip(capsule)
                .background(if (selected) MaterialTheme.colorScheme.primaryContainer else androidx.compose.ui.graphics.Color.Transparent)
                .selectable(selected, enabled = !state.busy, role = Role.Tab, onClick = { state.selectTab(tab) })
                .heightIn(min = 56.dp).padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(image, null, tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
                Text(stringResource(label), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsScreen(state: AppState, bottomInset: Dp) {
    LazyColumn(contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = bottomInset + 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Text(stringResource(R.string.settings_appearance), style = MaterialTheme.typography.titleMedium) }
        item {
            Column(Modifier.selectableGroup()) {
                listOf("system" to R.string.theme_system, "light" to R.string.theme_light, "dark" to R.string.theme_dark).forEach { (key, label) ->
                    Row(Modifier.fillMaxWidth().selectable(state.theme == key, role = Role.RadioButton, onClick = { state.settings(newTheme = key) }).padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(state.theme == key, onClick = null)
                        Text(stringResource(label), Modifier.padding(start = 12.dp))
                    }
                }
            }
        }
        item { Text(stringResource(R.string.review_settings), style = MaterialTheme.typography.titleMedium) }
        item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(5, 10, 15, 20).forEach { size -> FilterChip(state.groupSize == size, onClick = { state.settings(newGroupSize = size) }, label = { Text(size.toString()) }) }
            }
        }
        if (Build.VERSION.SDK_INT >= 33) item {
            Row(Modifier.fillMaxWidth().toggleable(state.glassEnabled, role = Role.Switch, onValueChange = { state.settings(glass = it) }),
                verticalAlignment = Alignment.CenterVertically) {
                Text(stringResource(R.string.liquid_glass), Modifier.weight(1f))
                Switch(state.glassEnabled, onCheckedChange = null)
            }
        }
        item { Text(stringResource(R.string.version_label, BuildConfig.VERSION_NAME), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
