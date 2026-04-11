# SVG All in One

[English](./README.md) | 简体中文

`SVG All in One` 是一个面向 VS Code 的 SVG 一体化工具扩展，覆盖编辑、预览、优化、导出、诊断与效率增强。

## 功能概览

- 分栏编辑工作流：源码编辑器 + 可交互预览面板
- 一键处理：`Format` / `Cleanup` / `Compress`
- 导出能力：PNG 与多倍率 PNG（`@1x/@2x/@3x`）
- 预览区交互编辑：
  - 拖动移动
  - 左旋/右旋（每次 15°）
  - 放大/缩小（每次 10%）
  - 删除选中元素
- 右键颜色工具（选中元素后）：
  - `修改颜色`
  - `提取颜色`
- 选中节点属性侧边栏（精确编辑属性）
- SVG 诊断：
  - 非法/不常见属性
  - 重复 `id`
  - 基础可访问性检查（`title` / `desc` / `role` / `aria`）
- 智能补全（输入时 snippet 风格）：
  - 标签补全
  - 属性补全
  - 常见属性值补全

## 使用方式

1. 打开任意 `.svg` 文件。
2. 点击编辑器标题栏命令图标，或执行：
   - `SVG All in One: Open Split Editor + Preview`
3. 在预览面板顶部工具栏执行格式化/清理/压缩/导出/保存。
4. 在预览中点击元素进行选中与交互编辑；右键可改色或提取颜色。

## 关键交互

- 画布缩放：`Ctrl/Cmd + 鼠标滚轮`
- 历史操作：`Undo` / `Redo`
- 关闭预览面板时未保存提醒

## 命令列表

- `SVG All in One: Open Split Editor + Preview`
- `SVG All in One: Export PNG`
- `SVG All in One: Export PNG Variants (@1x/@2x/@3x)`
- `SVG All in One: Quick Recolor`
- `SVG All in One: Cleanup Useless XML`
- `SVG All in One: Compress SVG (SVGO)`
- `SVG All in One: Format SVG`
- `SVG All in One: Extract Color Palette`
- `SVG All in One: Edit Selected Attribute`
- `SVG All in One: Add Attribute`
- `SVG All in One: Remove Attribute`

## 本地开发

```bash
pnpm install
pnpm run compile
```

按 `F5` 启动 Extension Development Host。

## 技术栈

- TypeScript
- VS Code Extension API
- `svgo`
- `xml-formatter`
- `@resvg/resvg-js`
- `@xmldom/xmldom`
