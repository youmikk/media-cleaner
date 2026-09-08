package com.mediacleaner.nativeapp.ui

import android.graphics.Bitmap
import android.net.Uri
import android.os.CancellationSignal
import android.util.Size
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.BrokenImage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import com.mediacleaner.nativeapp.data.MediaAsset
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

// Cap concurrent thumbnail jobs; off-screen cells cancel their native request.
private val thumbnailSlots = Semaphore(3)

@Composable
fun MediaThumbnail(asset: MediaAsset?, modifier: Modifier = Modifier, large: Boolean = false) {
    val resolver = LocalContext.current.contentResolver
    val cancellation = remember(asset?.uri, large) { CancellationSignal() }
    var bitmap by remember(asset?.uri, large) { mutableStateOf<Bitmap?>(null) }
    DisposableEffect(cancellation) { onDispose { cancellation.cancel() } }
    LaunchedEffect(asset?.uri, large) {
        val item = asset ?: return@LaunchedEffect
        try {
            bitmap = thumbnailSlots.withPermit {
                withContext(Dispatchers.IO) {
                    resolver.loadThumbnail(Uri.parse(item.uri), if (large) Size(1200, 1200) else Size(256, 256), cancellation)
                }
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { bitmap = null }
    }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        val image = bitmap
        if (image != null) Image(image.asImageBitmap(), contentDescription = null,
            contentScale = if (large) ContentScale.Fit else ContentScale.Crop, modifier = Modifier.fillMaxSize())
        else Icon(Icons.Outlined.BrokenImage, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
