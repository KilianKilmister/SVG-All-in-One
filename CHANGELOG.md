# Changelog

English | [简体中文](./CHANGELOG.zh-CN.md)

All notable changes to this project are documented in this file.

## [0.1.*] - 2026-04-13

### Major change
- Added localization using the VS code localization api.
  - `package.json`: localizable strings in format `%svgAllInOne.<KEY>%`
    localization files: `package.nls.<LANG>.json`
  - General localization in code: `l10n.t("<LOCALIZATION> {0} {1}", param, pram2, ...)`.
    localization files: `l10n/bundle.l10n.<LANG>.json`

### Minor changes
- Minor config tweaks:
  - `tsconfig.json`: set `module` and `moduleResolution` to `nodenext`; won't break anything
  - `.gitignore`: added package-lock.json
    - @note: should `pnpm-lock.yaml` also be added?
  - `package.json`: removed unneeded activation events as prompted by vscode:
    - `"This activation event can be removed as VS Code generates these automatically from your package.json contribution declarations."`
  - Added `launch.json`
- Added localization to `features` in `readme.md`

### Added deps
- Localization
  - `@vscode/l10n`
  - `@vscode/l10n-dev` (dev-dep)

## [0.1.1] - 2026-04-13

### Fixed
- Release packaging now includes runtime dependencies by default, fixing `command not found` issues after installation.
- SVG toolkit dependencies (`@resvg/resvg-js`, `svgo`, `xml-formatter`) are lazy-loaded with explicit runtime error messages, so missing packages no longer crash extension activation globally.

### Changed
- Added fallback scripts for troubleshooting only:
- `package:vsix:no-deps`
- `publish:vsix:no-deps`

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
