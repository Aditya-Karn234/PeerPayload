package com.peerpayload.connect.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// The desktop design system (packages/ui/src/theme.css) for Compose:
// graphite, bone, one orange accent; text on the accent is graphite.

@Immutable
data class Tokens(
    val page: Color,
    val surface: Color,
    val surface2: Color,
    val ink: Color,
    val inkSecondary: Color,
    val inkMuted: Color,
    val border: Color,
    val borderStrong: Color,
    val accent: Color = Color(0xFFFF6818),
    val accentInk: Color = Color(0xFF1A1A1A),
    val accentSoft: Color,
    val track: Color,
    val progress: Color,
    val good: Color,
    val warning: Color,
    val critical: Color,
)

private val Light = Tokens(
    page = Color(0xFFF4F1E8), surface = Color(0xFFFBF9F4), surface2 = Color(0xFFECE8DE),
    ink = Color(0xFF1A1A1A), inkSecondary = Color(0xFF5C5D57), inkMuted = Color(0xFF73746E),
    border = Color(0xFFD5D2CA), borderStrong = Color(0xFFB5B1A6),
    accentSoft = Color(0x1CFF6818), track = Color(0xFFE4E0D6), progress = Color(0xFF343A3A),
    good = Color(0xFF1F8A58), warning = Color(0xFFB07A0C), critical = Color(0xFFC63A32),
)

private val Dark = Tokens(
    page = Color(0xFF151615), surface = Color(0xFF1D1F1E), surface2 = Color(0xFF262928),
    ink = Color(0xFFF4F1E8), inkSecondary = Color(0xFFB3B2AA), inkMuted = Color(0xFF8B8C85),
    border = Color(0xFF343737), borderStrong = Color(0xFF4A4E4E),
    accentSoft = Color(0x24FF6818), track = Color(0xFF2C2F2E), progress = Color(0xFFD5D2CA),
    good = Color(0xFF3CBF7F), warning = Color(0xFFE8AA24), critical = Color(0xFFEC6A62),
)

val LocalTokens = staticCompositionLocalOf { Light }

val Mono = FontFamily.Monospace

/** Small uppercase mono label, the desktop's section/eyebrow style. */
val LabelStyle = TextStyle(fontFamily = Mono, fontSize = 11.sp, letterSpacing = 1.sp, fontWeight = FontWeight.Medium)

@Composable
fun ConnectTheme(content: @Composable () -> Unit) {
    val t = if (isSystemInDarkTheme()) Dark else Light
    val scheme = (if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()).copy(
        primary = t.accent,
        onPrimary = t.accentInk,
        background = t.page,
        onBackground = t.ink,
        surface = t.surface,
        onSurface = t.ink,
        surfaceVariant = t.surface2,
        onSurfaceVariant = t.inkSecondary,
        surfaceContainer = t.surface,
        surfaceContainerHigh = t.surface2,
        outline = t.borderStrong,
        outlineVariant = t.border,
        error = t.critical,
    )
    val shapes = Shapes(
        extraSmall = RoundedCornerShape(2.dp),
        small = RoundedCornerShape(4.dp),
        medium = RoundedCornerShape(4.dp),
        large = RoundedCornerShape(6.dp),
        extraLarge = RoundedCornerShape(6.dp),
    )

    androidx.compose.runtime.CompositionLocalProvider(LocalTokens provides t) {
        MaterialTheme(colorScheme = scheme, shapes = shapes, typography = Typography(), content = content)
    }
}
