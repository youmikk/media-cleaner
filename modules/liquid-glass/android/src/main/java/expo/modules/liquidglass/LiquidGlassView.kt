package expo.modules.liquidglass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Path
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

/** Decorative layer only; React keeps the actual buttons in a stable sibling. */
class LiquidGlassView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var sourceKey = ""
  var effectEnabled = true
  var lowPowerMode = false
  var radiusDp = 28f
  var surfaceTint = Color.TRANSPARENT
  var fallbackColor = Color.TRANSPARENT
  var highlightColor = Color.TRANSPARENT
  var shadowColor = Color.TRANSPARENT
  private val onStatus by EventDispatcher()
  private var observer: ViewTreeObserver? = null
  private var renderer: GlassRenderer? = null
  private var failed = false
  private var previousEffectEnabled = true
  private var previousLowPowerMode = false
  private var disposed = false
  private var lastStatus = ""
  private var frameReady = false
  private var radiusPx = 0f
  private val materialClip = Path()
  private var capturedSource: WeakReference<GlassSourceView>? = null
  private var capturedVersion = -1L
  private var lastCaptureAt = 0L
  private var refreshPending = false
  private val sourcePosition = IntArray(2)
  private val hostPosition = IntArray(2)
  private val capturedPosition = IntArray(4)
  private val refreshFrame = Runnable {
    refreshPending = false
    updateFrame()
    invalidate()
  }

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    updateFrame()
    true
  }

  init {
    setWillNotDraw(false)
    isClickable = false
    isFocusable = false
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    clipToOutline = true
    outlineProvider = object : ViewOutlineProvider() {
      override fun getOutline(view: View, outline: Outline) {
        outline.setRoundRect(0, 0, view.width, view.height, radiusPx)
      }
    }
  }

  fun applySettings() {
    // Explicitly re-enabling or changing capture quality may recover a lost
    // GPU context. Keep failures latched during ordinary frames/prop updates.
    if ((!previousEffectEnabled && effectEnabled) || previousLowPowerMode != lowPowerMode) failed = false
    previousEffectEnabled = effectEnabled
    previousLowPowerMode = lowPowerMode
    radiusPx = (radiusDp.coerceAtLeast(0f) * resources.displayMetrics.density)
      .coerceAtMost(minOf(width, height).coerceAtLeast(0) / 2f)
    materialClip.rewind()
    materialClip.addRoundRect(0f, 0f, width.toFloat(), height.toFloat(), radiusPx, radiusPx, Path.Direction.CW)
    invalidateOutline()
    releaseRenderer()
    updateObserver()
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    applySettings()
  }

  override fun onDetachedFromWindow() {
    removeObserver()
    releaseRenderer()
    super.onDetachedFromWindow()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    // Android can hide the window before JS receives AppState's event.
    if (visibility != VISIBLE) {
      removeObserver()
      releaseRenderer()
    } else {
      applySettings()
    }
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    // Modal pickers own another window. Do not sample the covered page while
    // its picker header is rendering glass in the foreground window.
    if (hasWindowFocus) {
      applySettings()
    } else {
      removeObserver()
      releaseRenderer()
    }
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    applySettings()
  }

  private fun updateObserver() {
    if (disposed || !isAttachedToWindow || !effectEnabled || failed ||
      windowVisibility != VISIBLE || !hasWindowFocus()) {
      removeObserver()
      return
    }
    if (observer?.isAlive == true) return
    viewTreeObserver.takeIf { it.isAlive }?.let {
      observer = it
      it.addOnPreDrawListener(preDraw)
    }
  }

  private fun removeObserver() {
    observer?.takeIf { it.isAlive }?.removeOnPreDrawListener(preDraw)
    observer = null
  }

  private fun updateFrame() {
    if (Build.VERSION.SDK_INT < 33 || disposed || failed) return
    if (!effectEnabled || !isShown || windowVisibility != VISIBLE || !hasWindowFocus()) {
      releaseRenderer()
      report("fallback", "inactive")
      return
    }
    // Refuse accidental full-screen glass or oversized Dynamic Type/tablet
    // buffers. The functional UI remains in place with its solid surface.
    if (!GlassRenderer.fitsSurface(width, height, resources.displayMetrics.density, lowPowerMode) || !isHardwareAccelerated) {
      releaseRenderer()
      report("fallback", "unsupported-surface")
      return
    }
    val source = GlassSourceView.find(sourceKey)
    if (source == null || !source.isAttachedToWindow || !source.isShown ||
      source.width <= 0 || source.height <= 0 || source.rootView !== rootView) {
      releaseRenderer()
      report("fallback", "source-unavailable")
      return
    }
    var ancestor = parent
    while (ancestor != null) {
      if (ancestor === source) {
        disableEffect("recursive-source")
        return
      }
      ancestor = ancestor.parent
    }
    source.getLocationInWindow(sourcePosition)
    getLocationInWindow(hostPosition)
    val now = SystemClock.uptimeMillis()
    if (lowPowerMode && frameReady) {
      val unchanged = capturedSource?.get() === source && capturedVersion == source.contentVersion &&
        capturedPosition[0] == sourcePosition[0] && capturedPosition[1] == sourcePosition[1] &&
        capturedPosition[2] == hostPosition[0] && capturedPosition[3] == hostPosition[1]
      if (unchanged) return
      val remaining = LOW_POWER_FRAME_MS - (now - lastCaptureAt)
      if (remaining > 0) {
        // Flush the final source change even if scrolling stops between samples.
        // The source version check prevents this one-shot callback feeding itself.
        if (!refreshPending) {
          refreshPending = true
          postDelayed(refreshFrame, remaining)
        }
        return
      }
    }
    removeCallbacks(refreshFrame)
    refreshPending = false
    try {
      val current = renderer ?: GlassRenderer(
        resources, width, height, radiusPx, surfaceTint, highlightColor, shadowColor, lowPowerMode, resources.displayMetrics.density
      ).also { renderer = it }
      current.record(source, this, fallbackColor)
      capturedSource = WeakReference(source)
      capturedVersion = source.contentVersion
      capturedPosition[0] = sourcePosition[0]
      capturedPosition[1] = sourcePosition[1]
      capturedPosition[2] = hostPosition[0]
      capturedPosition[3] = hostPosition[1]
      lastCaptureAt = now
      val wasReady = frameReady
      frameReady = true
      // Normal recording follows the current frame. Low-power trailing samples
      // invalidate once in refreshFrame, then stop once the source is unchanged.
      if (!wasReady) invalidate()
      report("ready", if (lowPowerMode) "kyant-backdrop-1.0.6-low-power" else "kyant-backdrop-1.0.6")
    } catch (error: Exception) {
      disableEffect(error.javaClass.simpleName)
    } catch (error: LinkageError) {
      disableEffect(error.javaClass.simpleName)
    } catch (error: OutOfMemoryError) {
      disableEffect("memory-pressure")
    }
  }

  override fun draw(canvas: Canvas) {
    // Fabric can replace a View's background/outline during style updates.
    // Explicit clipping also rounds the solid fallback and the native paint.
    val checkpoint = canvas.save()
    try {
      canvas.clipPath(materialClip)
      super.draw(canvas)
    } finally {
      canvas.restoreToCount(checkpoint)
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(fallbackColor)
    if (Build.VERSION.SDK_INT >= 33 && canvas.isHardwareAccelerated && frameReady) {
      try {
        renderer?.draw(canvas)
      } catch (error: Exception) {
        disableEffect(error.javaClass.simpleName)
      } catch (error: LinkageError) {
        disableEffect(error.javaClass.simpleName)
      } catch (error: OutOfMemoryError) {
        disableEffect("memory-pressure")
      }
    }
  }

  private fun report(state: String, reason: String) {
    val next = "$state:$reason"
    if (lastStatus == next || disposed) return
    lastStatus = next
    try {
      onStatus(mapOf("state" to state, "reason" to reason, "sourceKey" to sourceKey))
    } catch (error: Exception) {
      // The React runtime can already be gone while a view is detaching.
    }
  }

  private fun disableEffect(reason: String) {
    failed = true // Do not repeatedly compile a failing GPU shader every frame.
    removeObserver()
    releaseRenderer()
    report("fallback", reason)
    invalidate()
  }

  private fun releaseRenderer() {
    removeCallbacks(refreshFrame)
    refreshPending = false
    capturedSource = null
    capturedVersion = -1L
    val previous = renderer
    renderer = null
    val wasReady = frameReady
    frameReady = false
    if (Build.VERSION.SDK_INT >= 33) {
      try {
        previous?.release()
      } catch (error: Exception) {
        // Best-effort GPU cleanup: a lost rendering context must not crash exit.
      }
    }
    if (wasReady) invalidate()
  }

  fun dispose() {
    disposed = true
    removeObserver()
    releaseRenderer()
  }

  companion object {
    private const val LOW_POWER_FRAME_MS = 67L
  }
}
