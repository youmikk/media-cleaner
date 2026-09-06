package expo.modules.liquidglass

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class LiquidGlassModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MediaCleanerLiquidGlass")

    Function("isSupported") {
      val context = appContext.reactContext
      val manager = context?.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
      Build.VERSION.SDK_INT >= 33 && context != null && manager?.isLowRamDevice != true
    }

    View(GlassSourceView::class) {
      Name("GlassSource")
      Prop("sourceKey") { view: GlassSourceView, value: String -> view.setSourceKey(value) }
    }

    View(LiquidGlassView::class) {
      Name("GlassView")
      Events("onStatus")
      Prop("sourceKey") { view: LiquidGlassView, value: String -> view.sourceKey = value }
      Prop("effectEnabled") { view: LiquidGlassView, value: Boolean -> view.effectEnabled = value }
      Prop("cornerRadius") { view: LiquidGlassView, value: Float -> view.radiusDp = value }
      Prop("surfaceTint") { view: LiquidGlassView, value: Int -> view.surfaceTint = value }
      Prop("fallbackColor") { view: LiquidGlassView, value: Int -> view.fallbackColor = value }
      OnViewDidUpdateProps { view: LiquidGlassView -> view.applySettings() }
      OnViewDestroys { view: LiquidGlassView -> view.dispose() }
    }
  }
}
