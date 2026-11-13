# dsh-app-icon

DeepSeek Harness 桌面版的**应用图标**切换插件：默认图标 / 自己的图片，随时还原。

入口：**设置 → 应用图标**。

- 改 exe 的图标资源 + `resources\tray.ico` + `resources\icon.png`
- 选图后在卡片里拖动 / 缩放，手动决定方框里的那一块
- 自动保留历史图标，可一键换回历史头像
- 需要退出 DSH 一次；后台趁关着改，改完自动重开
- 每次改前备份、改后逐张比对，对不上自动还原
- 只支持 Windows 桌面版

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile desktop add https://github.com/jiaxusummer/dsh-app-icon
```

本地开发也可以直接把本目录当 bundle 装：

```sh
dsh plugin --profile desktop add link:C:\path\to\dsh-app-icon
```

装完重启 DSH，在 **设置 → 应用图标** 里用。

## 发布

当前只从 GitHub 分发（npm 暂未发布）；以后发布 npm 时，把 `version` 改成你的版本：

```sh
npm publish
```

`package.json` 里的 `license`、`files`、`exports` 已经齐了；要上 DSH 插件市场，再按市场要求补仓库地址和截图。

## 文档

完整说明（原理、踩坑、应急）见 [docs/DETAIL.md](docs/DETAIL.md)；字体/字号/卡片布局/按钮状态的规则见 [docs/LAYOUT.md](docs/LAYOUT.md)。

默认图标来自 DeepSeek Harness 官方安装包，仅用于还原官方外观；插件图标是另画的。MIT License。
