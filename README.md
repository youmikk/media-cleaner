# MediaCleaner 🧹

**中文** · [English](./README.en.md)

一款开源的 iOS / Android **照片视频清理应用**,基于 **React Native + Expo SDK 54**(managed workflow)。按小组滑动浏览相册、整组批量删除、设备端相似/重复/连拍/低质量检测,实时看到释放了多少空间——完全离线,任何数据都不会离开你的设备。

**协议:** MIT · **版本:** v1.0.0

## 功能特性

**清理流程。** 照片页按全局分组大小(5/10/15/20,设置中调整)把相册切成小组;照片保持原始宽高比,切换为弹簧动画(reanimated + gesture-handler)。左右滑动浏览;**上滑标记删除**——顶部红色发光删除条随手势滑下,超过约 40% 屏高即标记并伴随触感反馈;**下滑移动到其他相册**。标记只是预选:真正的删除在每组结束的确认页一次性批量提交,**系统确认框每组只弹一次**;跳过即整组保留,中途退出不删任何东西。视频页点击标签直接进入竖向自动播放清理流(右上角可切相册),右侧悬浮删除/收藏按钮,同样按组批量确认。首次启动有 3 步手势教程。

**按时间清理。** 照片首页的时间选择器支持**按年、按年月**圈定范围("2023年"/"2023年6月"),把大相册拆成一小块一小块地清。

**智能建议。** "我的"页提供六张建议卡:最大文件(进入清理流时每张照片带文件大小角标)、连拍照片(时间戳+感知哈希双重校验,自动保留最清晰一张)、旧截图(90 天未动)、**完全重复**(哈希+分辨率+文件大小三重确认,每组保留一份)、**重复视频**(时长+分辨率+大小匹配,自动生成封面)、**低质量照片**(模糊 / 欠曝 / 过曝 / 全黑全白废片)。

**分析引擎。** 每张照片**一次解码**同时产出 dHash 差值哈希、拉普拉斯清晰度和曝光直方图;指标存入全局照片指标库并**增量落盘**——中断可续、跨相册复用、永不重复分析。分块(50 张/批,低电量自动降到 10)+ 6 路并行,进度浮层可取消;缓存带 `assetCount` + `modificationTime` 指纹,相册变化时询问是否重新分析;iOS 内存警告时自动暂停。

**断点续清。** 进入清理即记录"前"快照;应用被杀后下次启动提示**继续或放弃**,继续会恢复乱序后的完整顺序、当前组、组内位置和已标记列表。结束时计算"后"快照,喂给"我的"页的空间对比图和使用统计。

**信息展示。** 底部毛玻璃信息栏显示拍摄时间与**反向地理编码的地址**(城市·区·街道,结果缓存);点开可见全中文 EXIF 详情(相机/镜头/光圈/快门/ISO/焦距等)。图片全部走 `expo-image` 原生缓存并预加载下一张。

**工具。** 摄影画像(拍摄时段分布、最活跃星期/月份、日均拍摄等)、压缩工具(挑最大的文件按高/中/低质量批量压缩,图片用 expo-image-manipulator,视频用 react-native-compressor,可选删除原文件)。

**回收站(Android)。** 开启后删除会先复制到应用内 `trash/` 目录保留 30 天,支持全选、恢复、彻底删除,剩余不足 7 天红字提示;iOS 使用系统"最近删除"。

**液态玻璃。** iOS 26+ 上标签栏和信息栏是**原生 Liquid Glass**(`expo-glass-effect`,真实折射与高光);旧系统和 Android 自动回退到 `expo-blur` 毛玻璃,由统一的 `GlassSurface` 组件适配。

**设置。** 全局分组大小、清理顺序(随机/按日期,默认随机)、相似检测开关、回收站开关(仅 Android)、每日提醒(8:00–20:00 随机时间)、主题(跟随系统/浅色/深色,即时生效)、语言(**默认中文**,可切英文)。

## 项目结构

```
MediaCleaner/
├── App.js                     # Provider、权限门、会话恢复提示、教程
├── app.json                   # Expo 配置 + 图标/启动页 + 权限插件
├── assets/                    # icon / adaptive-icon / splash
├── src/
│   ├── navigation/index.js    # 底部标签(液态玻璃)+ 三个栈
│   ├── theme/  ├── i18n/      # 深浅色调色板 · 中英文案
│   ├── context/               # SettingsContext · AppContext
│   ├── screens/               # AlbumSelect / Cleaning / VideoCleaning /
│   │                          # Profile / RecycleBin / BurstClean(兼去重) /
│   │                          # GalleryInsights / Compress
│   ├── components/            # PhotoCard, VideoCard, BottomInfoBar, GlassSurface,
│   │                          # LiquidTabBar, GlowingTrashBar, TutorialOverlay,
│   │                          # AlbumPicker, TimePicker, SimilarModal, EXIFModal,
│   │                          # MoveSheet, GroupConfirmSheet, StorageChart, 等
│   └── utils/                 # chunkedAnalyzer, imageHashing(dHash), burstDetection,
│                              # deletionManager(批量删除), trashManager, sessionManager,
│                              # statsManager, geocode, notificationScheduler, 等
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

相册大小采用抽样估算(前 300 项外推);单相册哈希上限 3000 张。相似判定用 64 位 dHash、汉明距离阈值 10(`chunkedAnalyzer.js` 中的 `SIMILAR_THRESHOLD` 可调);完全重复要求哈希、分辨率、文件大小三者全等。"移动到相册"在 iOS 上是加入目标相册(iOS 相册非互斥),照片只是离开当前清理范围。删除始终经过系统确认弹窗——这是平台强制要求;本应用已把弹窗压缩到**每组一次**。连拍清理中预选集是删除对象,星标(最清晰)那张保留。

## 参与贡献

欢迎 Issue 和 PR。Fork 后建特性分支(`git checkout -b feat/xxx`),保持代码风格(函数组件 + hooks),尽量双平台验证,PR 描述清楚改动。适合上手的方向:pHash/DCT 哈希、更多语言、iCloud 卸载照片处理、单元测试。

## 协议

[MIT](./LICENSE) —— 随意使用,注明出处更佳。
