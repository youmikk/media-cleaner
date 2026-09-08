package com.mediacleaner.nativeapp.ui

import android.view.LayoutInflater
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.mediacleaner.nativeapp.R

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
@Composable
fun NativeVideo(uri: String, modifier: Modifier) {
    val owner = LocalLifecycleOwner.current
    // A single AndroidView owns the player. Reuse it across adjacent videos;
    // releasing happens only after its lifecycle observer is detached.
    AndroidView(modifier = modifier,
        onReset = null,
        factory = { context ->
            val view = LayoutInflater.from(context).inflate(R.layout.video_player, null) as PlayerView
            view.player = ExoPlayer.Builder(context).setLoadControl(DefaultLoadControl.Builder()
                .setBufferDurationsMs(1000, 6000, 500, 500).setTargetBufferBytes(12 * 1024 * 1024).build()).build()
            val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) view.player?.pause() }
            owner.lifecycle.addObserver(observer)
            view.setTag(R.id.player_observer, observer)
            view
        },
        update = { view ->
            val player = view.player ?: return@AndroidView
            if (player.currentMediaItem?.mediaId != uri) {
                player.setMediaItem(MediaItem.Builder().setMediaId(uri).setUri(uri).build())
                player.prepare()
                player.playWhenReady = false
            }
        },
        onRelease = { view ->
            (view.getTag(R.id.player_observer) as? LifecycleEventObserver)?.let { owner.lifecycle.removeObserver(it) }
            view.player?.release()
            view.player = null
        },
    )
}
