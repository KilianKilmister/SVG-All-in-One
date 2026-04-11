# SVG All in One

`SVG All in One` 是一个面向 VS Code 的 SVG 全流程工具扩展，覆盖编辑、预览、优化、导出和诊断。

## 功能概览

- 分栏编辑预览（源码编辑 + 右侧可交互预览）
- 一键处理：`Format` / `Cleanup` / `Compress`
- 导出：PNG、PNG 多倍率导出（`@1x/@2x/@3x`）
- 元素交互编辑：
  - 拖动移动
  - 左旋/右旋（15°步进）
  - 放大/缩小（10%步进）
  - 删除选中元素
- 右键颜色工具（选中元素后）：
  - `修改颜色`
  - `提取颜色`
- 选中节点属性侧边栏（精确编辑属性）
- SVG 代码诊断：
  - 非法/不常见属性
  - 重复 `id`
  - 基础可访问性检查（`title` / `desc` / `role` / `aria`）
- 编辑增强（snippets 风格自动补全）：
  - 标签补全
  - 属性补全
  - 常见属性值补全

## 使用方式

1. 打开任意 `.svg` 文件。
2. 点击编辑器标题栏命令图标，或在命令面板执行：
   - `SVG All in One: Open Split Editor + Preview`
3. 在预览面板顶部工具栏执行格式化、清理、压缩、导出、保存等操作。
4. 在预览中点击元素进行选中和交互编辑；右键可调色或提取颜色。

## 关键交互

- 画布缩放：`Ctrl/Cmd + 鼠标滚轮`
- 操作历史：`Undo` / `Redo`
- 预览未保存关闭提醒：关闭 panel 时会提示保存

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

按 `F5` 启动 `Extension Development Host` 调试。

## 技术栈

- TypeScript
- VS Code Extension API
- `svgo`
- `xml-formatter`
- `@resvg/resvg-js`
- `@xmldom/xmldom`
