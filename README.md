# SVG All in One (VS Code Extension)

SVG All in One 是一个面向设计/前端开发的 VS Code SVG 工具箱，目标是把常用 SVG 操作集中到一个扩展里完成。

## 已实现功能

1. 分栏编辑预览（源码 + 实时预览）
1. 导出 PNG（指定宽度或原始尺寸）
1. 多倍率导出 PNG（`@1x/@2x/@3x` 自定义倍率）
1. 快捷改色（支持指定颜色或全量替换）
1. 清理 SVG XML 无用字符（注释、空行、BOM 等）
1. SVG 压缩（SVGO）
1. SVG 格式化（XML 格式化）
1. 预览区拖动元素位置（拖拽）
1. 预览区快捷旋转元素（`±15°`）
1. 预览区快捷删除元素
1. 快捷编辑自动补全（元素、属性、属性值）
1. 调色板提取 + 一键复制颜色
1. 常用 SVG 片段快速插入

## 使用方式

1. 打开任意 `.svg` 文件。
1. 通过命令面板执行：`SVG All in One: Open Split Editor + Preview`。
1. 在面板中可以直接编辑源码、拖拽/旋转元素，并调用工具栏命令。
1. 也可以在命令面板单独执行导出、压缩、改色、格式化等命令。

## 主要命令

- `SVG All in One: Open Split Editor + Preview`
- `SVG All in One: Export PNG`
- `SVG All in One: Export PNG Variants (@1x/@2x/@3x)`
- `SVG All in One: Quick Recolor`
- `SVG All in One: Cleanup Useless XML`
- `SVG All in One: Compress SVG (SVGO)`
- `SVG All in One: Format SVG`
- `SVG All in One: Extract Color Palette`
- `SVG All in One: Insert SVG Snippet`

## 本地开发

```bash
npm install
npm run compile
```

按 `F5` 启动 Extension Development Host 进行调试。

## 技术栈

- TypeScript
- VS Code Extension API
- `svgo`（压缩）
- `xml-formatter`（格式化）
- `@resvg/resvg-js`（SVG 渲染 PNG）
