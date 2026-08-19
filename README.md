# MediaCleaner

**中文** · [English](./README.en.md)

MediaCleaner 是一款完全离线的开源照片与视频清理应用，支持 iOS 和 Android。它把大相册拆成一组组可确认的清理任务，支持按相册和时间筛选，并在设备端识别相似、重复、连拍和低质量照片。清理进度、分析缓存和收藏都保存在本机，照片与视频不会上传。

项目基于 React Native 0.81 + Expo SDK 54（managed workflow），并通过一个本地原生模块完成批量媒体查询、低分辨率灰度解码和 Android 原地分类。

**协议：** MIT · **版本：** v1.22.0

## 功能特性

**清理流程。** 照片与视频入口都可选择相册、时间范围和每组数量（2–20），并使用同一套**卡片堆叠**交互。左右滑动浏览；**上滑标记删除**，顶部红色删除提示条会跟随手势出现；**下滑移动到其他相册**。标记只是预选，真正的删除会在每组结束时一次性提交，因此**系统确认框每组只弹一次**。跳过会保留整组内容，中途退出也不会删除任何文件。视频任意时刻**只有当前条目占用播放器**，预缓冲限制在 6 秒 / 12 MB。首次启动先请求权限，再动手练习左右浏览、上滑标记和点击底部分类型标签；教程不读取或改动真实相册。

**按时间清理。** 照片和视频首页的时间选择器都支持**按年、按年月**圈定范围("2023年"/"2023年6月"),把大相册拆成一小块一小块地清。

**智能建议。** "我的"页提供六张建议卡:最大文件(进入清理流时每张照片带文件大小角标)、连拍照片(时间戳+感知哈希双重校验,自动保留最清晰一张)、旧截图(90 天未动)、**完全重复**(哈希+分辨率+文件大小三重确认,每组保留一份)、**重复视频**(时长+分辨率+大小匹配,自动生成封面)、**低质量照片**(模糊 / 欠曝 / 过曝 / 全黑全白废片)。建议卡清理是**独立的临时会话**,不会影响主相册的续清进度和首页预览。

**分析引擎。** 每张照片**一次解码**同时产出 dHash 差值哈希、拉普拉斯清晰度和曝光直方图;安卓/iOS 走原生降采样解码直出 64×64 灰度图,指标存入全局照片指标库并**增量落盘**——中断可续、跨相册复用、永不重复分析。相似聚类只比较 **2 分钟时间窗内**的连续照片(photoo 同款策略),并行度按 CPU 核数自适应;进度浮层显示实时剩余时间估算,可随时取消;缓存带 `assetCount` + `modificationTime` 指纹,相册变化时询问是否重新分析;iOS 内存警告时自动暂停。

**断点续清。** 进入清理即记录"前"快照;退出即暂停——随机顺序、当前组、组内位置和已标记列表全部保留,首页卡片始终显示这一组,点击直接续清。照片与视频**会话相互独立**,互不覆盖;**确认过的组(含保留的照片)从顺序中彻底移除**,不会重复出现。分类全部处理后保持 100% 完成状态,只有新增资产会进入下一次清理队列。

**信息展示。** 底部毛玻璃信息栏显示拍摄时间与**反向地理编码的地址**(城市·区·街道,结果缓存);点开可见全中文 EXIF 详情(相机/镜头/光圈/快门/ISO/焦距等)。EXIF 走**三级来源逐字段合并**:系统接口 → 原生 ExifInterface(安卓)/ ImageIO(iOS)→ JS 解析器兜底,任一来源缺的字段由其他来源补齐;详情弹窗渐进加载,位置先显示坐标、地址解析完成后自动升级。图片全部走 `expo-image` 原生缓存并预加载下一张。

**工具。** 「我的喜欢」集中展示点过爱心的照片和视频,支持网格/列表切换;另有摄影画像(拍摄时段分布、最活跃星期/月份、日均拍摄等)和压缩工具(挑最大的文件按高/中/低质量批量压缩,可选删除原文件)。

**回收站(Android)。** 开启后删除会先复制到应用内 `trash/` 目录保留 30 天,支持全选、恢复、彻底删除,剩余不足 7 天红字提示;iOS 使用系统"最近删除"。

**平台界面。** iOS 26+ 的标签栏和信息栏使用**原生 Liquid Glass**（`expo-glass-effect`），旧版 iOS 使用 `expo-blur`。Android 的应用内界面由 MediaCleaner 统一绘制，导航、选择器、开关、对话框和底部面板不会随小米、vivo 等厂商皮肤变化。权限、媒体删除确认和分享面板属于系统流程，继续使用系统界面。

**设置。** 清理顺序(随机/按日期,默认随机)、相似检测开关、回收站开关(仅 Android)、每日提醒、主题(跟随系统/浅色/深色,即时生效)、语言(**默认中文**,可切英文)、**导出诊断日志**。照片和视频的每组数量直接在各自清理入口调整并独立保存。

## 项目结构

```
MediaCleaner/
├── App.js                     # Provider、权限门、会话恢复提示、教程
├── app.json                   # Expo 配置 + 图标/启动页 + 权限插件
├── assets/                    # icon / adaptive-icon / splash
├── modules/photo-move/        # 本地原生模块(Kotlin/Swift):原地移动分类、
│                              # 降采样解码、批量体积查询、原生 EXIF、CPU 核数
├── src/
│   ├── navigation/index.js    # iOS 液态玻璃 / Android 自有底部导航 + 三个栈
│   ├── theme/  ├── i18n/      # 分平台深浅色调色板 · 中英文案
│   ├── context/               # SettingsContext · AppContext
│   ├── screens/               # AlbumSelect / Cleaning / VideoCleaning /
│   │                          # Profile / RecycleBin / BurstClean(兼去重) /
│   │                          # GalleryInsights / Compress
│   ├── components/            # PhotoCard, VideoCard, BottomInfoBar, GlassSurface,
│   │                          # LiquidTabBar, GlowingTrashBar, TutorialOverlay,
│   │                          # AlbumPicker, TimePicker, SimilarModal, EXIFModal,
│   │                          # AppDialog, AppBottomSheet, AppSwitch, SettingsRow,
│   │                          # MoveSheet, GroupConfirmSheet, StorageChart, 等
│   └── utils/                 # chunkedAnalyzer, imageHashing(dHash), burstDetection,
│                              # deletionManager(批量删除), trashManager, sessionManager,
│                              # statsManager, geocode, logger(诊断日志),
│                              # notificationScheduler, 等
```

## 快速开始

前置:Node 20+、npm,以及 Expo Go(或 Xcode / Android Studio)。

```bash
git clone https://github.com/youmikk/media-cleaner.git
cd media-cleaner
npm install
npx expo start
```

用 Expo Go 扫码,或按 `i` / `a` 启动模拟器。模拟器的相册权限受限,**真机体验才完整**。发布构建用 EAS:`npx eas build -p android --profile preview`(APK)/ `npx eas build -p ios --profile production`(需 Apple 开发者账号);仓库里还带了一个 GitHub Actions 工作流,可在免费 macOS 运行器上产出未签名 IPA 供自签测试。

> 部分能力(Android 13+ 通知、视频压缩、原生液态玻璃)需要安装版应用(EAS / dev build),Expo Go 中会优雅降级。

## 实现说明与已知取舍

相册大小与占用空间通过原生 **MediaStore 批量查询**一次取回(安卓 scoped storage 下逐个 stat 会得到 0);扫描上限 2 万张,指标库上限 6000 条(LRU 淘汰)。相似判定用 64 位 dHash、汉明距离阈值 8,且**只在 2 分钟时间窗内聚类**(`chunkedAnalyzer.js` 中的 `SIMILAR_THRESHOLD` / `SIMILAR_TIME_WINDOW_MS` 可调);完全重复要求哈希、分辨率、文件大小三者全等。**安卓的"移动到相册"是原地移动**(photoo 同款:同卷 rename + MediaScanner 重扫,不复制、不改变任何照片信息),需要首次启动授予的"所有文件访问权限";iOS 上是加入目标相册(iOS 相册非互斥),照片只是离开当前清理范围。删除始终经过系统确认弹窗——这是平台强制要求;本应用已把弹窗压缩到**每组一次**。连拍清理中预选集是删除对象,星标(最清晰)那张保留。视频清理流任意时刻只保留一个播放器实例(前后条目为封面帧),预缓冲限制在 6 秒 / 12MB 以内。

## 参与贡献

欢迎 Issue 和 PR。Fork 后建特性分支(`git checkout -b feat/xxx`),保持代码风格(函数组件 + hooks),尽量双平台验证,PR 描述清楚改动。适合上手的方向:pHash/DCT 哈希、更多语言、iCloud 卸载照片处理、单元测试。

## 协议

[MIT](./LICENSE) —— 随意使用,注明出处更佳。
