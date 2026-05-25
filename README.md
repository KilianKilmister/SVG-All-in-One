# SVG All in One

English | [简体中文](./README.zh-CN.md)

`SVG All in One` is an all-in-one SVG toolkit for VS Code, covering editing, preview, optimization, export, diagnostics, and productivity enhancements.

## Features

- Split editing workflow: source editor + interactive preview panel
- One-click processing: `Format` / `Cleanup` / `Compress`
- Export: PNG and multi-scale PNG (`@1x/@2x/@3x`)
- Interactive element editing in preview:
  - Drag to move
  - Rotate left/right (15° per step)
  - Scale up/down (10% per step)
  - Delete selected element
- Context-menu color tools (after selecting an element):
  - `Modify Color`
  - `Extract Color`
- Selected-node attribute sidebar (precise attribute editing)
- SVG diagnostics:
  - Invalid/uncommon attributes
  - Duplicate `id`
  - Basic accessibility checks (`title` / `desc` / `role` / `aria`)
- Smart completion (snippet-style while typing):
  - Tag completion
  - Attribute completion
  - Common attribute value completion
- Localized UI (EN, CN)

## Usage

1. Open any `.svg` file.
2. Click the editor title bar command icon, or run:
   - `SVG All in One: Open Split Editor + Preview`
3. Use the top toolbar in the preview panel for format/cleanup/compress/export/save.
4. Click elements in preview to select and edit interactively; right-click to recolor or extract color.

## Key Interactions

- Canvas zoom: `Ctrl/Cmd + Mouse Wheel`
- History operations: `Undo` / `Redo`
- Unsaved change prompt: when closing the preview panel

## Commands

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

## Local Development

```bash
pnpm install
pnpm run compile
```

Press `F5` to launch the Extension Development Host.

## Tech Stack

- TypeScript
- VS Code Extension API
- `svgo`
- `xml-formatter`
- `@resvg/resvg-js`
- `@xmldom/xmldom`
