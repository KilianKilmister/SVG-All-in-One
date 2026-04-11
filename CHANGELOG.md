# Changelog

All notable changes to this project are documented in this file.

## [0.1.0] - 2026-04-11

### Added
- Split SVG source + preview workflow in a dedicated panel.
- Top toolbar operations: format, cleanup, compress, save, export PNG, export multi-scale PNG.
- Interactive element editing in preview:
  - Drag move
  - Rotate left/right (15deg step)
  - Scale up/down (10% step)
  - Delete selected element
- Preview editing state management:
  - Undo / redo
  - Dirty state and save prompt when closing panel
  - Live sync back to source editor
- Context-menu color tools on selected node:
  - Modify color
  - Extract color
- Selected-node attribute sidebar:
  - Precise edit / add / remove attribute
- SVG diagnostics:
  - Invalid/common-illegal attributes
  - Duplicate `id`
  - Basic accessibility checks
- SVG completion/snippet-like suggestions for tags, attributes, and common attribute values.

### Changed
- Canvas zoom interaction switched to `Ctrl/Cmd + Mouse Wheel`.
- Removed bottom-right mini preview map.
