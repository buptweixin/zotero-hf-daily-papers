# Zotero HF Daily Papers

[![zotero target version](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

在 Zotero 里浏览、入库、自动分类打标签 [HuggingFace Daily Papers](https://huggingface.co/papers)。

English summary: A Zotero 7 plugin to browse HuggingFace Daily Papers, import them as `preprint` items with full arXiv-convention metadata, auto-tag (AI keywords, hot papers) and auto-file into date/topic collections, with optional startup auto-sync.

## 功能

- **浏览每日论文**：Tools ▸ HF Daily Papers ▸ Browse Daily Papers… 打开独立窗口，按日期浏览论文列表（标题、作者、upvotes、AI 关键词、可展开摘要），支持关键词筛选、全选，点击标题打开 HF 页面。已入库的论文会显示「已入库」标记。
- **一键入库**：勾选论文后点「导入选中论文」，按官方 arXiv translator 惯例写入元数据：
  - 条目类型 `preprint`，`repository` = arXiv，`archiveID` = `arXiv:<id>`，`DOI` = `10.48550/arXiv.<id>`，`url` = arXiv abs 链接
  - `extra` 记录 HF 每日日期、Upvotes、GitHub / 项目链接
  - 可选同时从 `arxiv.org/pdf/<id>` 下载 PDF 附件
  - 按 DOI/archiveID 自动查重，重复导入只会补充归类，不会产生重复条目
- **自动分类打标签**：
  - HF 的 AI 关键词 → 标签（最多 6 个）
  - upvotes 达到阈值 → `🔥Hot` 标签，来源 → `HF Papers` 标签
  - 根分类 `HF Daily Papers` 下按日期建子分类（如 `2026-08-19`）
  - 内置主题规则（LLM / 多模态 / Agent / RL / 生成模型 / RAG / 微调 / 安全 / 效率…）把论文归入主题子分类，规则可在设置中自定义（每行 `<正则> -> <分类名>`，命中多条则同时归入）
- **自动同步**：Zotero 启动后自动拉取最近 N 天、upvotes ≥ 阈值的论文入库（默认开启，可在设置关闭）；也可菜单手动同步。

所有行为均可在 Zotero Settings ▸ HF Daily Papers 中调整（回看天数、upvotes 阈值、是否下载 PDF、根分类名、标签策略、主题规则等）。

## 数据来源

- 列表：`https://huggingface.co/api/daily_papers?date=YYYY-MM-DD`
- 历史数据自 2024-01-31 起；周末/节假日无列表属正常现象。

## 安装

1. 下载 [Releases](../../releases) 中的 `.xpi` 文件（或自行构建，见下文）。
2. Zotero ▸ Tools ▸ Plugins ▸ 齿轮图标 ▸ Install Plugin From File… 选择 `.xpi`。

## 开发

```sh
# 使用 Node 20/22
npm install

# 开发模式（需要先复制 .env.example 为 .env 并填写 Zotero 路径）
npm start

# 构建 XPI（输出在 .scaffold/build/zotero-hf-daily-papers.xpi）
npm run build

# 运行集成测试（启动测试用 Zotero，需联网访问 huggingface.co）
npm test

# 代码检查
npm run lint:check
```

开发模式说明：`zotero-plugin serve` 会自动启动 Zotero 并加载 `build` 目录中的插件，修改 `src/**`、`addon/**` 后自动重载。首次使用请参考 [.env.example](.env.example) 配置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 与 `ZOTERO_PLUGIN_PROFILE_PATH`。

## 发布

1. 更新 `package.json` 的 `version`（含 `-beta.1` 等后缀时自动走 pre-release，上传 `update-beta.json`）。
2. 本地发布：在 `.env` 填 `GITHUB_TOKEN` 后运行 `npm run release`（会把 `package.json` 的 `repository` 指向的仓库作为发布目标——请先把它改成你的真实仓库地址）。
3. 或推送 tag 触发 CI：`git tag v0.1.0 && git push origin v0.1.0`（release.yml 自动构建并创建 Release，上传 `.xpi` 与 `update.json`）。

## 项目结构

```
src/
  index.ts              # 入口，注册插件实例
  addon.ts              # 插件数据与生命周期
  hooks.ts              # 启动/菜单注册
  modules/
    hf-api.ts           # HuggingFace API 封装
    importer.ts         # 入库、查重、集合管理、PDF 附件
    classifier.ts       # 打标签 + 主题规则分类
    sync.ts             # 手动/启动自动同步
    papersWindow.ts     # 浏览窗口（DOM 动态构建）
    preferenceScript.ts # 偏好面板绑定
  utils/
    locale.ts            # Fluent 本地化
    prefs.ts             # 偏好读写
    window.ts            # 窗口存活检查
    ztoolkit.ts          # toolkit 初始化
addon/
  content/papers.xhtml  # 浏览窗口骨架（逻辑在 papersWindow.ts）
  content/preferences.xhtml
  prefs.js              # 默认偏好
  locale/               # en-US / zh-CN
```

## 已知限制

- PDF 下载依赖 arXiv，批量导入大量论文时较慢（串行 + 间隔限速）。
- 浏览窗口的「已入库」检查按条目逐个搜索，列表较长时首次加载会多花 1–2 秒。
- 历史日期早于 2024-01-31 无数据。

## 致谢

基于 [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) 构建，使用 [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 与 [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold)。

## License

AGPL-3.0-or-later
