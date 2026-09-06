package expo.modules.liquidglass

import android.content.res.Resources
import android.graphics.BlendMode
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.view.View
import androidx.annotation.RequiresApi
import kotlin.math.PI
import kotlin.math.ceil

/**
 * Kyant0/AndroidLiquidGlass 1.0.6's lens + highlight shaders in a View host.
 * Matches the catalog's vibrancy -> blur -> lens -> translucent surface order.
 * Only a bounded region is recorded; no screenshot or media decode is needed.
 */
@RequiresApi(33)
internal class GlassRenderer(
  resources: Resources,
  width: Int,
  height: Int,
  radius: Float,
  tint: Int,
  highlightColor: Int,
  shadowColor: Int,
  lowPowerMode: Boolean,
  density: Float
) {
  private val node = RenderNode("KyantLiquidGlassBackdrop")
  private val sourcePosition = IntArray(2)
  private val hostPosition = IntArray(2)
  private val sampleScale = if (lowPowerMode) 0.5f else 1f
  private val sampleDensity = density * sampleScale
  private val sampleWidth = width * sampleScale
  private val sampleHeight = height * sampleScale
  private val padding = capturePadding(sampleDensity)
  private val captureWidth = ceil(sampleWidth).toInt() + padding * 2
  private val captureHeight = ceil(sampleHeight).toInt() + padding * 2
  private val bounds = RectF(0f, 0f, width.toFloat(), height.toFloat())
  private val cornerRadius = radius
  private val tintPaint = Paint().apply { color = tint }
  private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = shadowColor
    style = Paint.Style.STROKE
    strokeWidth = 2f * density
  }
  private val highlightPaint = Paint(Paint.ANTI_ALIAS_FLAG)

  init {
    val shader = RuntimeShader(shaderSource(resources, R.raw.kyant_refraction))
    shader.setFloatUniform("size", sampleWidth, sampleHeight)
    shader.setFloatUniform("offset", -padding.toFloat(), -padding.toFloat())
    val sampleRadius = radius * sampleScale
    shader.setFloatUniform("cornerRadii", sampleRadius, sampleRadius, sampleRadius, sampleRadius)
    shader.setFloatUniform("refractionHeight", minOf(24f * sampleDensity, sampleHeight / 2f))
    shader.setFloatUniform("refractionAmount", -24f * sampleDensity)
    shader.setFloatUniform("depthEffect", 0f)
    val vibrancy = RenderEffect.createColorFilterEffect(
      ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(1.5f) })
    )
    val blur = RenderEffect.createBlurEffect(8f * sampleDensity, 8f * sampleDensity, vibrancy, Shader.TileMode.CLAMP)
    val glass = RenderEffect.createRuntimeShaderEffect(shader, "content")
    // Record a blur margin, then clip at the host. Clamping the capture to the
    // visible bar itself smears the very edges the lens is meant to refract.
    node.setPosition(-padding, -padding, captureWidth - padding, captureHeight - padding)
    node.setClipToBounds(true)
    node.setRenderEffect(RenderEffect.createChainEffect(glass, blur))

    val highlight = RuntimeShader(shaderSource(resources, R.raw.kyant_highlight)).apply {
      setFloatUniform("size", width.toFloat(), height.toFloat())
      setFloatUniform("cornerRadii", radius, radius, radius, radius)
      setColorUniform("color", Color.rgb(Color.red(highlightColor), Color.green(highlightColor), Color.blue(highlightColor)))
      setFloatUniform("angle", (PI / 4).toFloat())
      setFloatUniform("falloff", 1f)
    }
    highlightPaint.apply {
      this.shader = highlight
      alpha = Color.alpha(highlightColor)
      style = Paint.Style.STROKE
      strokeWidth = 2f * ceil(density)
      blendMode = BlendMode.PLUS
    }
  }

  fun record(source: View, host: View, background: Int) {
    source.getLocationInWindow(sourcePosition)
    host.getLocationInWindow(hostPosition)
    val canvas = node.beginRecording(captureWidth, captureHeight)
    try {
      canvas.drawColor(background)
      canvas.translate(padding.toFloat(), padding.toFloat())
      canvas.scale(sampleScale, sampleScale)
      canvas.translate(
        (sourcePosition[0] - hostPosition[0]).toFloat(),
        (sourcePosition[1] - hostPosition[1]).toFloat()
      )
      // Source and glass are separate sibling subtrees; never capture our own
      // display list (a guard at the call site also rejects ancestor sources).
      source.draw(canvas)
    } finally {
      node.endRecording()
    }
  }

  fun draw(canvas: Canvas) {
    val checkpoint = canvas.save()
    try {
      canvas.scale(1f / sampleScale, 1f / sampleScale)
      canvas.drawRenderNode(node)
    } finally {
      canvas.restoreToCount(checkpoint)
    }
    // Only the backdrop loses resolution. The rim, controls and text stay sharp.
    canvas.drawRect(bounds, tintPaint)
    // Kyant's directional highlight keeps the rounded lens edge legible even
    // over a flat page background. The native host clips both strokes inside.
    canvas.drawRoundRect(bounds, cornerRadius, cornerRadius, edgePaint)
    canvas.drawRoundRect(bounds, cornerRadius, cornerRadius, highlightPaint)
  }

  fun release() {
    node.setRenderEffect(null)
    node.discardDisplayList()
  }

  companion object {
    private val cachedShaders = mutableMapOf<Int, String>()

    fun capturePadding(density: Float): Int = ceil(24f * density).toInt()

    fun fitsSurface(width: Int, height: Int, density: Float, lowPowerMode: Boolean): Boolean {
      val scale = if (lowPowerMode) 0.5f else 1f
      val padding = capturePadding(density * scale)
      return width > 0 && height > 0 && height <= 200f * density &&
        (ceil(width * scale).toLong() + padding * 2) * (ceil(height * scale).toLong() + padding * 2) <= 1_048_576L
    }

    private fun shaderSource(resources: Resources, resource: Int): String {
      return cachedShaders.getOrPut(resource) {
        resources.openRawResource(resource).bufferedReader().use { it.readText() }
      }
    }
  }
}
