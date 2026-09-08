package com.mediacleaner.nativeapp.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val LightColors = lightColorScheme(
    primary = Color(0xFF0B6EDB),
    primaryContainer = Color(0xFFDCEBFB),
    secondary = Color(0xFF586575),
    secondaryContainer = Color(0xFFE3E8EF),
    tertiary = Color(0xFF277C63),
    onPrimary = Color.White,
    background = Color(0xFFF6F7FA),
    surface = Color(0xFFFFFFFF),
    surfaceVariant = Color(0xFFE9EBF0),
    onBackground = Color(0xFF17181C),
    onSurface = Color(0xFF17181C),
    onSurfaceVariant = Color(0xFF5F636B),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF71B7FF),
    primaryContainer = Color(0xFF193B60),
    secondary = Color(0xFFB2C1D2),
    secondaryContainer = Color(0xFF35404D),
    tertiary = Color(0xFF79CBB2),
    onPrimary = Color(0xFF003258),
    background = Color(0xFF101114),
    surface = Color(0xFF191B20),
    surfaceVariant = Color(0xFF2A2D34),
    onBackground = Color(0xFFF5F7FA),
    onSurface = Color(0xFFF5F7FA),
    onSurfaceVariant = Color(0xFFB5BAC4),
)

object MCSpacing {
    val xs = 8.dp
    val sm = 12.dp
    val md = 16.dp
    val lg = 24.dp
    val xl = 32.dp
}

object MCRadius {
    val control = 12.dp
    val card = 16.dp
    val sheet = 24.dp
}

@Composable
fun MediaCleanerTheme(theme: String = "system", content: @Composable () -> Unit) {
    val dark = theme == "dark" || (theme == "system" && isSystemInDarkTheme())
    val colors: ColorScheme = if (dark) DarkColors else LightColors
    MaterialTheme(
        colorScheme = colors,
        typography = Typography(),
        shapes = Shapes(
            small = androidx.compose.foundation.shape.RoundedCornerShape(MCRadius.control),
            medium = androidx.compose.foundation.shape.RoundedCornerShape(MCRadius.card),
            large = androidx.compose.foundation.shape.RoundedCornerShape(MCRadius.sheet),
        ),
        content = content,
    )
}
