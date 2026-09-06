package expo.modules.liquidglass

import android.content.res.Resources
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.view.View
import androidx.annotation.RequiresApi

/**
 * AndroidLiquidGlassView 1.0.5's unmodified MIT AGSL, hosted in a bounded
 * RenderNode. Unlike its full-source capture, this records only the bar-sized
 * region. No screenshot bitmap, PixelCopy, file or media operation is used.
 */
@RequiresApi(33)
internal class GlassRenderer(
  resources: Resources,
  width: Int,
  height: Int,
  radius: Float,
  tint: Int,
  density: Float
) {
  private val node = RenderNode("MediaCleanerLiquidGlass")
  private val sourcePosition = IntArray(2)
  private val hostPosition = IntArray(2)

  init {
    val shader = RuntimeShader(shaderSource(resources))
    shader.setFloatUniform("size", width.toFloat(), height.toFloat())
    shader.setFloatUniform("offset", 0f, 0f)
    shader.setFloatUniform("cornerRadii", radius, radius, radius, radius)
    shader.setFloatUniform("refractionHeight", minOf(14f * density, height / 3f))
    shader.setFloatUniform("refractionAmount", -18f * density)
    shader.setFloatUniform("depthEffect", 0.12f)
    shader.setFloatUniform("chromaticAberration", 0.12f)
    shader.setFloatUniform("contrast", 0f)
    shader.setFloatUniform("whitePoint", 0f)
    shader.setFloatUniform("chromaMultiplier", 1f)
    shader.setFloatUniform("tintColor", Color.red(tint) / 255f, Color.green(tint) / 255f, Color.blue(tint) / 255f)
    shader.setFloatUniform("tintAlpha", Color.alpha(tint) / 255f)
    val blur = RenderEffect.createBlurEffect(6f * density, 6f * density, Shader.TileMode.CLAMP)
    val glass = RenderEffect.createRuntimeShaderEffect(shader, "content")
    node.setPosition(0, 0, width, height)
    node.setClipToBounds(true)
    node.setRenderEffect(RenderEffect.createChainEffect(glass, blur))
  }

  fun record(source: View, host: View, background: Int) {
    source.getLocationInWindow(sourcePosition)
    host.getLocationInWindow(hostPosition)
    val canvas = node.beginRecording(host.width, host.height)
    try {
      canvas.drawColor(background)
      canvas.clipRect(0, 0, host.width, host.height)
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

  fun draw(canvas: Canvas) = canvas.drawRenderNode(node)

  fun release() {
    node.setRenderEffect(null)
    node.discardDisplayList()
  }

  companion object {
    private var cachedShader: String? = null

    private fun shaderSource(resources: Resources): String {
      return cachedShader ?: resources.openRawResource(R.raw.mediacleaner_liquidglass)
        .bufferedReader().use { it.readText() }.also { cachedShader = it }
    }
  }
}
