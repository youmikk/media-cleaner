# MediaCleaner 双端原生预览

这是独立的 SwiftUI 和 Kotlin/Compose 工程，没有 React Native、Expo 或 JavaScript 运行时依赖。现有 1.30.0 发布版仍在仓库根目录。

[功能清单](shared/FEATURES.md) · [架构与数据契约](shared/CONTRACTS.md) · [界面规范](shared/DESIGN.md)

## 本阶段代码

- 三个原生 Tab：照片、视频、我的；两端使用相同信息结构。
- PhotoKit / MediaStore 权限请求、部分授权、相册与真实封面、分页缩略图网格。
- 最新优先的 5 / 10 / 15 / 20 项分组，保留或标记删除、撤销、组末确认。
- 每组一次系统批量删除请求，照片和视频分开保存当前组及游标。
- SQLite 存储已确认 ID，跨相册共享；保留项同样不再进入后续清理。
- iOS AVPlayer / Android Media3 播放当前视频，邻居只渲染缩略图。
- 系统/浅色/深色设置、中英文系统语言；Android 13+ 玻璃开关。

这是首批主流程源代码，尚未完成真机验收。时间筛选、随机顺序、统计、智能分析、旧数据导入等功能按清单继续迁移，不能据此当作旧版的完整替代品。界面没有次要功能的占位按钮。

## 平台要求

| | iOS | Android |
| --- | --- | --- |
| 界面 | SwiftUI、系统 TabView 和导航 | Jetpack Compose、Material 3 控件 |
| 材质 | iOS 26 Liquid Glass；旧系统材质降级 | 直接依赖 Kyant Backdrop 1.0.6，Android 13+ 启用 |
| 预览最低系统 | iOS 17 | Android 11 / API 30 |
| 开发工具 | Xcode 26、XcodeGen | JDK 21、Gradle 8.14.3、Android SDK 36 |

Android 预览以 API 30 起步，使用 MediaStore 批量删除确认。Android 8-10 的旧系统适配尚未迁移。Kyant 发布的 AAR 使用 Java 21 字节码，所以原生工程使用 JDK 21；Compose BOM 2026.02.01、Kotlin 2.3.10、AGP 8.13.2 均固定版本。

## 工程与安装

- Android Studio 打开 `native/android`；独立 Gradle wrapper 已随源码提供。
- macOS 在 `native/ios` 执行 `xcodegen generate`，打开 `MediaCleanerNative.xcodeproj`。
- `build-native-preview.yml` 合入默认分支后，GitHub Actions 才会显示 `Native preview (SwiftUI / Compose)`，由维护者手动选平台构建。
- workflow 只上传预览 artifact，不发布 GitHub Release；iOS 产物未签名，需要自行签名安装。
- 双端预览标识均为 `com.mediacleaner.app.nativepreview`，可与旧版并装。
- 原生预览不读取或覆盖旧版的收藏、清理会话或分析缓存。正式替换前必须完成数据导入、签名和升级验证。
- 标记本身不删除；系统确认删除的是设备媒体原件，独立安装标识不会隔离相册内容。

## 验证

`node native/scripts/check-foundation.mjs` 使用仓库已有 Node 依赖检查版本、资源、工程元数据和手动 workflow。它不会启动 Gradle、Xcode 或模拟器，不能证明原生编译、帧率、玻璃像素或照片删除行为。

构建及真机验证由维护者执行。本阶段重点核对：

1. 两端完整/部分/拒绝授权及从设置返回，照片/视频单独授权。
2. 中英文、浅深主题、最大字号、横屏和系统返回。
3. 超过一页的相册，缩略图显示及视频切换、前后台播放生命周期。
4. 标记、撤销、组确认、系统取消和成功删除；强制退出后恢复本组。
5. 照片和视频会话相互独立，重叠相册不重复整理已确认项。
6. iOS 26 底栏与操作区系统材质；Android 13+ 导航及清理操作区的背景折射和玻璃开关，列表最后一项不被遮挡。

iCloud-only 内容当前不自动下载，Live Photo 播放在后续迁移。系统删除成功但进度写入失败时，保留事务意图供再次确认；尚需真机覆盖该恢复路径。

## 许可证

应用沿用仓库 MIT License。Android 通过 Maven Central 依赖 [Kyant Backdrop](https://github.com/Kyant0/AndroidLiquidGlass/) 1.0.6，使用 Apache 2.0；完整许可随 APK 的 `assets/licenses/AndroidLiquidGlass.txt` 分发。新原生工程没有复制旧 Expo 模块的 AGSL 适配实现。
