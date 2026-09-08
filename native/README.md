# MediaCleaner 双端原生预览

这是独立的 SwiftUI 和 Kotlin/Compose 工程，没有 React Native、Expo 或 JavaScript 运行时依赖。原生初始版本为 0.0.1，版本来源是 `native/version.json`，两端工程配置保持一致。现有 1.30.0 发布版仍在仓库根目录。

[功能清单](shared/FEATURES.md) · [架构与数据契约](shared/CONTRACTS.md) · [界面规范](shared/DESIGN.md)

## 本阶段代码

- 三个原生 Tab：照片、视频、我的；两端使用相同信息结构。
- PhotoKit / MediaStore 权限请求、部分授权、相册与真实封面、分页缩略图网格。
- 最新优先的 5 / 10 / 15 / 20 项分组，保留或标记删除、撤销、组末确认。
- 每组一次系统批量删除请求，照片和视频分开保存当前组及游标。
- SQLite 存储已确认 ID，跨相册共享；保留项同样不再进入后续清理。
- iOS AVPlayer / Android Media3 播放当前视频，邻居只渲染缩略图。
- 系统/浅色/深色设置、中英文系统语言；Android 13+ 玻璃开关。
- 两端每日自动/手动检查更新、预发行接收开关，以及原站和两条国内加速下载线路。

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
- GitHub Actions 选择 `Native preview (SwiftUI / Compose)`，点击 `Run workflow`。入口放在 `main`，源码分支 `source_ref` 默认是 `native-foundation`，再选择要构建的平台。
- 工作流先将源码分支解析为一个提交，两端构建及预发行都使用该提交。源码保留在原生分支即可打包，无需新建仓库。
- workflow 有“发布到 GitHub Releases”和“标记为预发行版本”两个独立选项。默认不发布；勾选发布后，预发行开启为 Pre-release，关闭为正式发行。所选平台全部成功后才会发布。
- 标签采用 `native-v<版本>-preview.<构建编号>` 或 `native-v<版本>-stable.<构建编号>`。原生版暂不成为仓库全局 Latest，以保持旧版更新通道稳定；原生 App 读取自己的正式/预发行通道。
- 发布 APK 使用原生版专用的 `NATIVE_ANDROID_KEYSTORE_BASE64`、`NATIVE_ANDROID_KEYSTORE_PASSWORD`、`NATIVE_ANDROID_KEY_ALIAS`、`NATIVE_ANDROID_KEY_PASSWORD` 四个签名 Secrets，不影响旧版签名；两条通道共用固定签名，构建号随运行递增。未配置签名时只能生成调试 artifact，不能发布可持续升级的 APK。此前随机调试签名的预览包可能需要卸载后首次安装固定签名版本。
- iOS 产物未签名，需要自行签名安装。
- 双端预览标识均为 `com.mediacleaner.app.nativepreview`，可与旧版并装。
- 原生预览不读取或覆盖旧版的收藏、清理会话或分析缓存。正式替换前必须完成数据导入、签名和升级验证。
- 标记本身不删除；系统确认删除的是设备媒体原件，独立安装标识不会隔离相册内容。

## 更新与国内下载

“我的 → 软件更新”提供自动检查、手动检查、接收预发行版本和下载线路。正式构建默认不接收预发行，预发行构建默认开启，用户可修改。自动检查每天一次，失败不计为当天成功检查。

成功发布后，工作流将对应平台、通道的版本、构建号、说明、直链和 SHA-256 自动写入 `main/native/releases.json`。单端发布保留另一端记录，重跑旧版本不会覆盖更新的记录。更新查询先读取 jsDelivr CDN，再尝试 GitHub raw、代理及 Releases API；下载提供 GitHub 原站、`ghproxy.net` 和 `gh-proxy.com`，第三方线路可用性会变化，可以切换。加速只用于本仓库真实 APK/IPA 附件。

同版本下构建号可触发更新，正式版优先于同版本的预发行版，当前平台没有安装包的 Release 不会提示。更新只在点击下载后交由系统浏览器处理，不自动替换安装包。

## 验证

`node native/scripts/check-foundation.mjs` 检查版本、资源、工程元数据和手动 workflow；`node --test native/scripts/update-release-feed.test.mjs` 验证通道、版本排序和发布清单合并。它们不会启动 Gradle、Xcode 或模拟器，不能证明原生编译、帧率、玻璃像素或照片删除行为。

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
