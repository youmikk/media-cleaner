package com.mediacleaner.nativeapp.ui

import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import com.kyant.backdrop.Backdrop
import com.kyant.backdrop.drawBackdrop
import com.kyant.backdrop.effects.blur
import com.kyant.backdrop.effects.lens
import com.kyant.backdrop.effects.vibrancy

@Composable
fun Modifier.nativeGlass(backdrop: Backdrop, enabled: Boolean, shape: Shape): Modifier {
    val surface = MaterialTheme.colorScheme.surface
    if (!enabled || Build.VERSION.SDK_INT < 33) return background(surface, shape)
    val tint = surface.copy(alpha = 0.4f)
    return drawBackdrop(backdrop = backdrop, shape = { shape }, effects = {
        vibrancy(); blur(8.dp.toPx()); lens(24.dp.toPx(), 24.dp.toPx())
    }, onDrawSurface = { drawRect(tint) })
}
