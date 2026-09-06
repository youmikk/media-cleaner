package expo.modules.liquidglass

import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.lang.ref.WeakReference

/** Passive scene wrapper: it owns no bitmap, timer or extra drawing loop. */
class GlassSourceView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private var sourceKey = ""

  fun setSourceKey(value: String) {
    unregister()
    sourceKey = value
    register()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    register()
  }

  override fun onDetachedFromWindow() {
    unregister()
    super.onDetachedFromWindow()
  }

  // Yoga, not LinearLayout, owns the geometry of React children.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  private fun register() {
    if (isAttachedToWindow && sourceKey.isNotEmpty()) sources[sourceKey] = WeakReference(this)
  }

  private fun unregister() {
    if (sources[sourceKey]?.get() === this) sources.remove(sourceKey)
  }

  companion object {
    // Accessed only on the UI thread. A stopped React tree must not be kept alive.
    private val sources = mutableMapOf<String, WeakReference<GlassSourceView>>()
    fun find(key: String): GlassSourceView? = sources[key]?.get()
  }
}
