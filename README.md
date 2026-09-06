<p align="center">
  <img src="./assets/icon.png" width="96" height="96" alt="净相图标" />
</p>

# 净相（MediaCleaner）

离线清理照片与视频，支持 iOS 和 Android。

[下载应用](https://github.com/youmikk/media-cleaner/releases/latest) · [更新日志](./CHANGELOG.json) · [反馈建议](https://github.com/youmikk/media-cleaner/issues) · [English](./README.en.md)

净相是一款开源的相册清理工具。按相册和时间，把照片与视频分成小组逐步整理；通过智能建议，集中检查重复内容、旧截图和占空间的大文件。随时停下，下次接着清理。

## 主要功能

- **分组清理**：按相册、年份或月份筛选，自选每组数量，浏览后统一确认保留或删除。
- **智能建议**：筛选重复照片与视频、连拍、低质量照片、旧截图和大文件，供你检查与选择。
- **共享进度**：不同分类共享清理记录，已确认的内容不再重复进入清理队列，新增内容继续整理。
- **我的喜欢**：收藏想留下的照片与视频，支持网格和列表查看。
- **照片详情**：查看拍摄时间、位置和 EXIF 信息，通过摄影画像了解自己的拍摄习惯。
- **压缩工具**：选择压缩质量并生成新文件，是否删除原文件由你决定。
- **清理提醒**：设置适合自己的提醒时间区间。
- **自适应外观**：支持深浅主题和中英文，液态玻璃按设备能力适配，Android 可手动开关。
- **低电量适配**：进入低电量模式时提示，可开关自动省电适配，调节玻璃采样、动画和分析节奏。

## 隐私与数据

照片分析在设备上完成，清理进度和收藏保存在本机，照片与视频不会上传到应用服务器。更新检查、在线更新日志和地址解析等功能可能需要联网。

标记不会立即删除文件，每组结束后由你确认。浏览和智能分析不改写照片、视频的原文件。

Android 可开启应用回收站，暂存已删除内容 30 天并支持恢复；暂存内容仍占用存储空间。iOS 使用系统「最近删除」。

## 反馈与贡献

欢迎通过 [Issues](https://github.com/youmikk/media-cleaner/issues) 反馈问题、提出建议，也欢迎提交代码改进和翻译。反馈问题时，请附上设备型号、系统版本和复现步骤。

## 开源许可

项目采用 [MIT License](./LICENSE)，分发时须保留版权与许可声明。

Android 液态玻璃效果使用 [Kyant0/AndroidLiquidGlass](https://github.com/Kyant0/AndroidLiquidGlass/) 1.0.6 的官方折射与高光着色器，通过本地原生 View 接入 React Native。[接入说明](./modules/liquid-glass/README.md) · [Apache 2.0 许可证](./modules/liquid-glass/android/src/main/assets/licenses/AndroidLiquidGlass.txt)
