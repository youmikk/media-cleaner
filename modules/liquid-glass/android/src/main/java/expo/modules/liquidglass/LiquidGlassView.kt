package expo.modules.liquidglass

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.os.Build
import android.os.PowerManager
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewTreeObserver
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

/** Decorative layer only; React keeps the actual buttons in a stable sibling. */
class LiquidGlassView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var sourceKey = ""
  var effectEnabled = true
  var radiusDp = 28f
  var surfaceTint = Color.TRANSPARENT
  var fallbackColor = Color.TRANSPARENT
  private val onStatus by EventDispatcher()
  private val powerManager = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
  private var observer: ViewTreeObserver? = null
  private var renderer: GlassRenderer? = null
  private var failed = false
  private var disposed = false
  private var lastStatus = ""
  private var frameReady = false
  private var radiusPx = 0f
  private var powerSaving = true

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
    // JS owns the shared power subscription. Check the native state only on
    // configuration/resume, never a Binder query on every fallback frame.
    powerSaving = try {
      powerManager?.isPowerSaveMode != false
    } catch (error: Exception) {
      true
    }
    radiusPx = (radiusDp.coerceAtLeast(0f) * resources.displayMetrics.density)
      .coerceAtMost(minOf(width, height).coerceAtLeast(0) / 2f)
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
    if (disposed || !isAttachedToWindow || !effectEnabled || powerSaving || failed ||
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
    if (!effectEnabled || !isShown || windowVisibility != VISIBLE || !hasWindowFocus() || powerSaving) {
      releaseRenderer()
      report("fallback", "inactive-or-power-saving")
      return
    }
    // Refuse accidental full-screen glass or oversized Dynamic Type/tablet
    // buffers. The functional UI remains in place with its solid surface.
    if (width <= 0 || height <= 0 || height > 200 * resources.displayMetrics.density ||
      width.toLong() * height.toLong() > 1_048_576L || !isHardwareAccelerated) {
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
    try {
      val current = renderer ?: GlassRenderer(
        resources, width, height, radiusPx, surfaceTint, resources.displayMetrics.density
      ).also { renderer = it }
      current.record(source, this, fallbackColor)
      val wasReady = frameReady
      frameReady = true
      // Only wake the host for its first frame. Subsequent recordings update
      // the RenderNode in the current frame; no timer/invalidate feedback loop.
      if (!wasReady) invalidate()
      report("ready", "android-liquid-glass")
    } catch (error: Exception) {
      disableEffect(error.javaClass.simpleName)
    } catch (error: LinkageError) {
      disableEffect(error.javaClass.simpleName)
    } catch (error: OutOfMemoryError) {
      disableEffect("memory-pressure")
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
}
