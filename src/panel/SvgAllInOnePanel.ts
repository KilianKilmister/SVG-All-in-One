import * as path from "path";
import * as vscode from "vscode";
import {
  runExportPng,
  runExportPngVariants,
  runTextOperation,
  type SvgTextOperation
} from "../commands";
import { replaceWholeDocument, resolveSvgDocument } from "../svg/documentHelpers";
import { type SvgNodePath } from "../svg/svgDom";
import { SvgAttributeSidebarProvider } from "./SvgAttributeSidebarProvider";

type PanelOperation =
  | "format"
  | "cleanup"
  | "compress"
  | "exportPng"
  | "exportPngVariants";

interface PanelMessage {
  type: string;
  text?: string;
  operation?: PanelOperation;
  nodePath?: SvgNodePath;
  tagName?: string;
  attributes?: Record<string, string>;
  resizeMode?: "proportional" | "free";
  ratio?: number;
  width?: number;
  height?: number;
  currentWidth?: number;
  currentHeight?: number;
  preserveHistory?: boolean;
}

export class SvgAllInOnePanel {
  private static currentPanel: SvgAllInOnePanel | undefined;

  public static async createOrShow(
    context: vscode.ExtensionContext,
    attributeSidebar: SvgAttributeSidebarProvider,
    uri?: vscode.Uri
  ): Promise<void> {
    const document = await resolveSvgDocument(uri);
    if (!document) {
      return;
    }

    // Keep native SVG editor on the left so it has line numbers/syntax coloring like built-in view.
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: false,
      preserveFocus: true
    });

    if (SvgAllInOnePanel.currentPanel) {
      SvgAllInOnePanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, true);
      await SvgAllInOnePanel.currentPanel.setDocument(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "svgAllInOne.preview",
      "SVG Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    SvgAllInOnePanel.currentPanel = new SvgAllInOnePanel(
      context,
      panel,
      document,
      attributeSidebar
    );
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly attributeSidebar: SvgAttributeSidebarProvider;
  private readonly disposables: vscode.Disposable[] = [];

  private currentDocument: vscode.TextDocument;
  private syncingFromWebview = false;
  private pendingWebviewSyncTexts: string[] = [];
  private isDirty = false;
  private draftText: string | undefined;
  private warnedExternalChangeWhileDirty = false;

  private constructor(
    context: vscode.ExtensionContext,
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    attributeSidebar: SvgAttributeSidebarProvider
  ) {
    this.context = context;
    this.panel = panel;
    this.currentDocument = document;
    this.attributeSidebar = attributeSidebar;

    this.panel.title = `SVG Preview - ${path.basename(document.uri.fsPath || document.uri.path)}`;
    this.panel.webview.html = this.getWebviewHtml(this.panel.webview);
    this.bindEvents();
    void this.pushDocumentToWebview();
  }

  private bindEvents(): void {
    this.panel.webview.onDidReceiveMessage(
      async (message: PanelMessage) => {
        await this.handlePanelMessage(message);
      },
      undefined,
      this.disposables
    );

    vscode.workspace.onDidChangeTextDocument(
      async (event) => {
        if (event.document.uri.toString() !== this.currentDocument.uri.toString()) {
          return;
        }

        this.currentDocument = event.document;
        this.attributeSidebar.tryRefreshSelectionFromDocument(event.document);

        if (this.syncingFromWebview) {
          return;
        }

        const textNow = event.document.getText();
        const pendingIndex = this.pendingWebviewSyncTexts.findIndex(
          (pendingText) => pendingText.trim() === textNow.trim()
        );
        if (pendingIndex >= 0) {
          this.pendingWebviewSyncTexts.splice(pendingIndex, 1);
          this.isDirty = event.document.isDirty;
          this.draftText = textNow;
          this.warnedExternalChangeWhileDirty = false;
          await this.panel.webview.postMessage({ type: "dirtyState", dirty: this.isDirty });
          return;
        }

        this.isDirty = event.document.isDirty;
        this.draftText = textNow;
        this.warnedExternalChangeWhileDirty = false;
        await this.pushDocumentToWebview(true);
      },
      undefined,
      this.disposables
    );

    vscode.window.onDidChangeActiveTextEditor(
      async (editor) => {
        if (!editor || editor.document.languageId !== "svg") {
          return;
        }
        await this.setDocument(editor.document);
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        void this.handleDispose();
      },
      undefined,
      this.disposables
    );
  }

  private async setDocument(document: vscode.TextDocument): Promise<void> {
    if (document.uri.toString() === this.currentDocument.uri.toString()) {
      return;
    }

    if (this.isDirty) {
      const proceed = await this.promptSaveBeforeSwitch();
      if (!proceed) {
        return;
      }
    }

    this.currentDocument = document;
    this.panel.title = `SVG Preview - ${path.basename(document.uri.fsPath || document.uri.path)}`;
    this.attributeSidebar.clearSelection();
    this.pendingWebviewSyncTexts = [];
    this.isDirty = false;
    this.draftText = undefined;
    this.warnedExternalChangeWhileDirty = false;
    await this.pushDocumentToWebview();
  }

  private async handlePanelMessage(message: PanelMessage): Promise<void> {
    if (message.type === "ready") {
      await this.pushDocumentToWebview();
      return;
    }

    if (message.type === "draftChanged" && typeof message.text === "string") {
      const cleaned = this.stripPreviewRuntimeAttributes(message.text);
      if (!cleaned.trim()) {
        return;
      }

      const currentText = this.currentDocument.getText();
      if (cleaned.trim() !== currentText.trim()) {
        this.pendingWebviewSyncTexts.push(cleaned);
        this.syncingFromWebview = true;
        try {
          const applied = await replaceWholeDocument(this.currentDocument, cleaned);
          if (!applied) {
            this.pendingWebviewSyncTexts = this.pendingWebviewSyncTexts.filter(
              (pendingText) => pendingText.trim() !== cleaned.trim()
            );
            void vscode.window.showErrorMessage("同步 SVG 到编辑器失败。");
            return;
          }
        } finally {
          this.syncingFromWebview = false;
        }
      }

      this.draftText = cleaned;
      this.isDirty = this.currentDocument.isDirty;
      this.warnedExternalChangeWhileDirty = false;
      this.attributeSidebar.tryRefreshSelectionFromDocument(this.currentDocument);
      await this.panel.webview.postMessage({ type: "dirtyState", dirty: this.isDirty });
      return;
    }

    if (message.type === "requestSave") {
      await this.saveDraft(true, true);
      return;
    }

    if (message.type === "requestCanvasResize") {
      await this.requestCanvasResizeFromUser(message.currentWidth, message.currentHeight);
      return;
    }

    if (message.type === "copyToClipboard" && typeof message.text === "string") {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage(`已复制颜色：${message.text}`);
      return;
    }

    if (
      message.type === "selectionChanged" &&
      Array.isArray(message.nodePath) &&
      typeof message.tagName === "string" &&
      message.attributes
    ) {
      this.attributeSidebar.setSelection(
        this.currentDocument,
        message.nodePath,
        message.tagName,
        message.attributes
      );
      return;
    }

    if (message.type === "selectionCleared") {
      this.attributeSidebar.clearSelection();
      return;
    }

    if (message.type === "requestOperation" && message.operation) {
      await this.saveDraft(false);
      await this.executePanelOperation(message.operation);
      await this.pushDocumentToWebview(true);
    }
  }

  private async requestCanvasResizeFromUser(
    currentWidth?: number,
    currentHeight?: number
  ): Promise<void> {
    const modePick = await vscode.window.showQuickPick(
      [
        {
          label: "按比例调整",
          description: "输入缩放比例（例如 1.5）",
          mode: "proportional" as const
        },
        {
          label: "自由调整",
          description: "分别输入宽度和高度",
          mode: "free" as const
        }
      ],
      {
        title: "调整 SVG 画布分辨率",
        placeHolder: "请选择调整方式"
      }
    );

    if (!modePick) {
      return;
    }

    if (modePick.mode === "proportional") {
      const ratioInput = await vscode.window.showInputBox({
        title: "按比例调整画布",
        prompt: "输入缩放比例（> 0）",
        value: "1",
        validateInput: (value) => {
          const ratio = Number(value.trim());
          return Number.isFinite(ratio) && ratio > 0 ? undefined : "请输入大于 0 的数字";
        }
      });

      if (!ratioInput) {
        return;
      }

      const ratio = Number(ratioInput.trim());
      await this.panel.webview.postMessage({
        type: "applyCanvasResize",
        resizeMode: "proportional",
        ratio
      });
      return;
    }

    const widthInput = await vscode.window.showInputBox({
      title: "设置画布宽度",
      prompt: "输入像素宽度（> 0）",
      value:
        typeof currentWidth === "number" && Number.isFinite(currentWidth)
          ? String(Math.max(1, Math.round(currentWidth)))
          : "512",
      validateInput: (value) => {
        const width = Number(value.trim());
        return Number.isFinite(width) && width > 0 ? undefined : "请输入大于 0 的数字";
      }
    });
    if (!widthInput) {
      return;
    }

    const heightInput = await vscode.window.showInputBox({
      title: "设置画布高度",
      prompt: "输入像素高度（> 0）",
      value:
        typeof currentHeight === "number" && Number.isFinite(currentHeight)
          ? String(Math.max(1, Math.round(currentHeight)))
          : "512",
      validateInput: (value) => {
        const height = Number(value.trim());
        return Number.isFinite(height) && height > 0 ? undefined : "请输入大于 0 的数字";
      }
    });
    if (!heightInput) {
      return;
    }

    await this.panel.webview.postMessage({
      type: "applyCanvasResize",
      resizeMode: "free",
      width: Number(widthInput.trim()),
      height: Number(heightInput.trim())
    });
  }

  private async executePanelOperation(operation: PanelOperation): Promise<void> {
    const uri = this.currentDocument.uri;
    if (operation === "format" || operation === "cleanup" || operation === "compress") {
      await runTextOperation(operation as SvgTextOperation, uri, { revealDocument: false });
      return;
    }
    if (operation === "exportPng") {
      await runExportPng(uri);
      return;
    }
    if (operation === "exportPngVariants") {
      await runExportPngVariants(uri);
      return;
    }
  }

  private stripPreviewRuntimeAttributes(svgText: string): string {
    return svgText
      .replace(/\sdata-aii-id=(['"])(.*?)\1/g, "")
      .replace(/\sdata-aii-path=(['"])(.*?)\1/g, "")
      .replace(/\sdata-aii-selected=(['"])(.*?)\1/g, "");
  }

  private async saveDraft(showSavedMessage: boolean, persistDocument = false): Promise<boolean> {
    const persistCurrentDocument = async (): Promise<boolean> => {
      if (!persistDocument) {
        return true;
      }
      const saved = await this.currentDocument.save();
      if (!saved) {
        void vscode.window.showErrorMessage("保存失败：VS Code 未能保存当前 SVG 文件。");
        return false;
      }
      return true;
    };

    if (!this.isDirty || !this.draftText) {
      const persisted = await persistCurrentDocument();
      if (persisted) {
        await this.panel.webview.postMessage({
          type: "dirtyState",
          dirty: this.currentDocument.isDirty || this.isDirty
        });
      }
      if (persisted && showSavedMessage) {
        void vscode.window.showInformationMessage("预览修改已保存。");
      }
      return persisted;
    }

    const cleaned = this.stripPreviewRuntimeAttributes(this.draftText);
    if (!cleaned.trim()) {
      return false;
    }

    if (cleaned.trim() === this.currentDocument.getText().trim()) {
      const persisted = await persistCurrentDocument();
      if (!persisted) {
        return false;
      }

      this.isDirty = false;
      this.draftText = cleaned;
      await this.panel.webview.postMessage({ type: "dirtyState", dirty: false });
      await this.panel.webview.postMessage({ type: "saved", text: cleaned });

      if (showSavedMessage) {
        void vscode.window.showInformationMessage("预览修改已保存。");
      }
      return true;
    }

    this.syncingFromWebview = true;
    try {
      const applied = await replaceWholeDocument(this.currentDocument, cleaned);
      if (!applied) {
        void vscode.window.showErrorMessage("保存失败：无法写入 SVG 文件。");
        return false;
      }
    } finally {
      this.syncingFromWebview = false;
    }

    const persisted = await persistCurrentDocument();
    if (!persisted) {
      return false;
    }

    this.isDirty = false;
    this.draftText = cleaned;
    this.warnedExternalChangeWhileDirty = false;
    this.attributeSidebar.tryRefreshSelectionFromDocument(this.currentDocument);
    await this.panel.webview.postMessage({ type: "dirtyState", dirty: false });
    await this.panel.webview.postMessage({ type: "saved", text: cleaned });

    if (showSavedMessage) {
      void vscode.window.showInformationMessage("预览修改已保存。");
    }
    return true;
  }

  private async promptSaveBeforeSwitch(): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(
      "当前预览有未保存改动。切换文件前是否保存？",
      "保存",
      "不保存",
      "取消"
    );

    if (choice === "取消") {
      return false;
    }
    if (choice === "保存") {
      return this.saveDraft(false, true);
    }

    this.isDirty = false;
    this.draftText = undefined;
    await this.panel.webview.postMessage({ type: "dirtyState", dirty: false });
    return true;
  }

  private async handleDispose(): Promise<void> {
    SvgAllInOnePanel.currentPanel = undefined;

    if (this.isDirty) {
      const choice = await vscode.window.showWarningMessage(
        "关闭预览时检测到未保存改动，是否保存？",
        "保存",
        "不保存"
      );
      if (choice === "保存") {
        await this.saveDraft(false, true);
      }
    }

    this.attributeSidebar.clearSelection();
    this.pendingWebviewSyncTexts = [];
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
  private async pushDocumentToWebview(preserveHistory = false): Promise<void> {
    const dirty = this.isDirty || this.currentDocument.isDirty;
    await this.panel.webview.postMessage({
      type: "document",
      fileName: path.basename(this.currentDocument.uri.fsPath || this.currentDocument.uri.path),
      text: this.currentDocument.getText(),
      preserveHistory
    });
    await this.panel.webview.postMessage({ type: "dirtyState", dirty });
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: "Segoe UI", "PingFang SC", sans-serif; }
    .root { position: relative; height: 100%; display: flex; flex-direction: column; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); }
    .group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .toolbar-divider { width: 1px; height: 18px; background: color-mix(in srgb, var(--vscode-editor-foreground) 22%, transparent); display: inline-block; margin: 0 2px; }
    button { border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); background: color-mix(in srgb, var(--vscode-editor-background) 86%, #0b1220); color: inherit; border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .meta, .status { display: flex; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: 12px; color: color-mix(in srgb, var(--vscode-editor-foreground) 50%, var(--vscode-editor-background)); border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent); }
    .meta { align-items: center; }
    #fileName { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 45%; }
    #canvasInfo { margin-left: auto; white-space: nowrap; }
    #selectionInfo { white-space: nowrap; }
    .status { border-top: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent); border-bottom: 0; }
    .dirty { color: #f59e0b; font-weight: 600; }
    .saved { color: #22c55e; font-weight: 600; }
    #previewHost { position: relative; flex: 1; overflow: auto; padding: 12px; background-image: linear-gradient(45deg, rgba(127,127,127,.1) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.1) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.1) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.1) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
    #previewHost .canvas-stage { transform-origin: top left; width: max-content; margin: 0 auto; }
    #previewHost svg { display: block; margin: 0 auto; max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 8px 20px rgba(0,0,0,.25); }
    #previewHost [data-aii-id] { cursor: pointer; }
    #previewHost [data-aii-id][data-aii-selected="1"] { filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #0ea5e9); cursor: grab; }
    #previewHost.dragging [data-aii-id][data-aii-selected="1"] { cursor: grabbing; }
    .error { min-height: 20px; padding: 2px 10px 8px; color: #fca5a5; font-size: 12px; }
    .ctx { position: fixed; z-index: 20; display: none; min-width: 220px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--vscode-editor-background) 90%, #0b1220); box-shadow: 0 10px 20px rgba(0,0,0,.28); }
    .ctx button { width: 100%; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); border-radius: 0; text-align: left; background: transparent; padding: 8px 10px; }
    .ctx button:last-child { border-bottom: 0; }
    .ctx .color-editor { display: none; padding: 8px 10px; border-top: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); }
    .ctx .color-editor.visible { display: block; }
    .ctx .swatches { display: grid; grid-template-columns: repeat(8, 1fr); gap: 6px; margin-bottom: 8px; }
    .ctx .swatch { width: 18px; height: 18px; border-radius: 4px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 28%, transparent); cursor: pointer; }
    .ctx .swatch.active { outline: 2px solid #0ea5e9; outline-offset: 1px; }
    .ctx .color-row { display: flex; align-items: center; gap: 6px; }
    .ctx .color-row input { flex: 1; height: 26px; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 0 8px; font-size: 12px; }
    .ctx .native-color { width: 34px; min-width: 34px; height: 34px; padding: 0; border-radius: 6px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent); background: transparent; cursor: pointer; flex: 0 0 auto; }
    .ctx .native-color::-webkit-color-swatch-wrapper { padding: 0; }
    .ctx .native-color::-webkit-color-swatch { border: 0; border-radius: 4px; }
    .ctx .native-color::-moz-color-swatch { border: 0; border-radius: 4px; }
    .ctx .apply-color { width: auto; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent); border-radius: 6px; padding: 4px 8px; }
    .mini-map { position: absolute; right: 12px; bottom: 38px; width: 160px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, #0b1220); border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 16%, transparent); border-radius: 8px; box-shadow: 0 8px 20px rgba(0,0,0,.3); overflow: hidden; }
    .mini-map .title { padding: 4px 8px; font-size: 11px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent); }
    .mini-map .body { height: 104px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--vscode-editor-background) 96%, #0b1220); }
    .mini-map .body .hint { opacity: 0.7; font-size: 11px; }
    .mini-map .body svg { width: 100%; height: 100%; object-fit: contain; box-shadow: none; border-radius: 0; margin: 0; }
  </style>
</head>
<body>
  <div class="root">
    <div class="toolbar">
      <div class="group">
        <button data-op="format">Format</button>
        <button data-op="cleanup">Cleanup</button>
        <button data-op="compress">Compress</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button id="undoButton" disabled>Undo</button>
        <button id="redoButton" disabled>Redo</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button id="rotateLeft" disabled>Rotate Left 15°</button>
        <button id="rotateRight" disabled>Rotate Right 15°</button>
        <button id="scaleDown" disabled>Scale -10%</button>
        <button id="scaleUp" disabled>Scale +10%</button>
        <button id="deleteElement" disabled>Delete</button>
      </div>
      <div class="group">
        <button id="canvasZoomOut">-</button>
        <button id="canvasZoomReset">100%</button>
        <button id="canvasZoomIn">+</button>
        <button id="resolutionButton">Resize</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button id="saveButton" disabled>Save</button>
        <span class="toolbar-divider" aria-hidden="true"></span>
        <button data-op="exportPng">Export PNG</button>
        <button data-op="exportPngVariants">Export Variants</button>
      </div>
    </div>
    <div class="meta"><div id="fileName">-</div><div id="canvasInfo">Zoom 100% | Canvas - | Original -</div><div id="selectionInfo">No selection</div></div>
    <div id="previewHost"></div>
    <div id="miniMap" class="mini-map"><div class="title">Overview</div><div id="miniMapBody" class="body"><div class="hint">No SVG</div></div></div>
    <div class="status"><span id="dirtyState" class="saved">Saved</span><span>Right click selected element: Edit color / Extract color</span></div>
    <div class="error" id="error"></div>
  </div>
  <div class="ctx" id="contextMenu">
    <button id="menuEditColor">修改颜色</button>
    <button id="menuExtractColor">提取颜色</button>
    <div id="menuColorEditor" class="color-editor">
      <div id="menuColorSwatches" class="swatches"></div>
      <div class="color-row">
        <input id="menuColorValue" type="text" value="#22c55e" placeholder="#22c55e / rgb(34,197,94)" />
        <input id="menuNativeColor" class="native-color" type="color" value="#22c55e" title="系统色盘" />
        <button id="menuApplyColor" class="apply-color">应用</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const previewHost = document.getElementById("previewHost");
    const miniMapBody = document.getElementById("miniMapBody");
    const errorNode = document.getElementById("error");
    const fileNameNode = document.getElementById("fileName");
    const canvasInfoNode = document.getElementById("canvasInfo");
    const selectionInfoNode = document.getElementById("selectionInfo");
    const saveButton = document.getElementById("saveButton");
    const dirtyStateNode = document.getElementById("dirtyState");
    const undoButton = document.getElementById("undoButton");
    const redoButton = document.getElementById("redoButton");
    const rotateLeftButton = document.getElementById("rotateLeft");
    const rotateRightButton = document.getElementById("rotateRight");
    const scaleDownButton = document.getElementById("scaleDown");
    const scaleUpButton = document.getElementById("scaleUp");
    const deleteButton = document.getElementById("deleteElement");
    const zoomOutButton = document.getElementById("canvasZoomOut");
    const zoomResetButton = document.getElementById("canvasZoomReset");
    const zoomInButton = document.getElementById("canvasZoomIn");
    const resolutionButton = document.getElementById("resolutionButton");
    const contextMenu = document.getElementById("contextMenu");
    const menuEditColor = document.getElementById("menuEditColor");
    const menuExtractColor = document.getElementById("menuExtractColor");
    const menuColorEditor = document.getElementById("menuColorEditor");
    const menuColorSwatches = document.getElementById("menuColorSwatches");
    const menuColorValue = document.getElementById("menuColorValue");
    const menuNativeColor = document.getElementById("menuNativeColor");
    const menuApplyColor = document.getElementById("menuApplyColor");
    const COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"];
    const DEFAULT_MENU_COLORS = ["#0ea5e9", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#3b82f6", "#f97316", "#111827", "#4b5563", "#9ca3af", "#ffffff"];
    const MAX_HISTORY = 200;
    const MIN_ZOOM = 0.1;
    const MAX_ZOOM = 8;
    const ZOOM_STEP = 0.1;
    const SCALE_STEP = 0.1;
    const TRANSFORM_EPSILON = 1e-4;

    const state = {
      rawSvgText: "",
      baseSvgText: "",
      svgRoot: undefined,
      selectedId: undefined,
      xmlDeclaration: "",
      drag: undefined,
      dragging: false,
      history: [],
      historyIndex: -1,
      canvasStage: undefined,
      canvasZoom: 1,
      originalResolution: undefined
    };

    function setError(message) {
      errorNode.textContent = message || "";
    }
    function isDraftDirty(text) {
      return (text || "").trim() !== (state.baseSvgText || "").trim();
    }
    function setDirty(dirty) {
      const nextDirty = Boolean(dirty);
      saveButton.disabled = !nextDirty;
      dirtyStateNode.textContent = nextDirty ? "Unsaved" : "Saved";
      dirtyStateNode.className = nextDirty ? "dirty" : "saved";
    }
    function updateHistoryButtons() {
      undoButton.disabled = state.historyIndex <= 0;
      redoButton.disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
    }
    function resetHistory(text) {
      state.history = [text];
      state.historyIndex = 0;
      updateHistoryButtons();
    }
    function pushHistory(text) {
      if (!text) {
        updateHistoryButtons();
        return;
      }
      const current = state.history[state.historyIndex];
      if (current === text) {
        updateHistoryButtons();
        return;
      }
      if (state.historyIndex < state.history.length - 1) {
        state.history = state.history.slice(0, state.historyIndex + 1);
      }
      state.history.push(text);
      if (state.history.length > MAX_HISTORY) {
        const overflow = state.history.length - MAX_HISTORY;
        state.history.splice(0, overflow);
        state.historyIndex = Math.max(0, state.historyIndex - overflow);
      }
      state.historyIndex = state.history.length - 1;
      updateHistoryButtons();
    }
    function hideColorEditor() {
      menuColorEditor.classList.remove("visible");
      menuColorSwatches.innerHTML = "";
    }
    function hideContextMenu() {
      hideColorEditor();
      contextMenu.style.display = "none";
    }
    function showContextMenu(x, y) {
      hideColorEditor();
      contextMenu.style.left = x + "px";
      contextMenu.style.top = y + "px";
      contextMenu.style.display = "block";
    }
    function parseXmlHeader(text) {
      const match = text.match(/^\\s*(<\\?xml[\\s\\S]*?\\?>)/i);
      return match ? match[1] : "";
    }

    function parseSvg(text) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "image/svg+xml");
      const parseError = doc.querySelector("parsererror");
      if (parseError) throw new Error(parseError.textContent || "SVG parse error");
      const root = doc.documentElement;
      if (!root || root.tagName.toLowerCase() !== "svg") throw new Error("Current content is not valid SVG.");
      return root;
    }
    function parseLength(value) {
      if (!value) {
        return undefined;
      }
      const numeric = Number.parseFloat(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    }
    function readResolutionFromRoot(root) {
      if (!root) {
        return undefined;
      }
      const width = parseLength(root.getAttribute("width"));
      const height = parseLength(root.getAttribute("height"));
      if (width && height && width > 0 && height > 0) {
        return { width, height };
      }
      const viewBox = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map((value) => Number(value));
      if (viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value))) {
        const vbWidth = Math.abs(viewBox[2]);
        const vbHeight = Math.abs(viewBox[3]);
        if (vbWidth > 0 && vbHeight > 0) {
          return { width: vbWidth, height: vbHeight };
        }
      }
      return undefined;
    }
    function formatResolution(resolution) {
      if (!resolution) {
        return "-";
      }
      return Math.round(resolution.width) + " x " + Math.round(resolution.height);
    }
    function updateCanvasInfo() {
      const current = readResolutionFromRoot(state.svgRoot);
      const currentText = formatResolution(current);
      const originalText = formatResolution(state.originalResolution || current);
      const zoomValue = Math.round(state.canvasZoom * 100);
      canvasInfoNode.textContent = "Zoom " + zoomValue + "% | Canvas " + currentText + " | Original " + originalText;
      zoomResetButton.textContent = zoomValue + "%";
    }
    function stripRuntimeAttributesFromTree(root) {
      if (!root) {
        return;
      }
      const clearAttrs = (element) => {
        element.removeAttribute("data-aii-id");
        element.removeAttribute("data-aii-path");
        element.removeAttribute("data-aii-selected");
      };
      clearAttrs(root);
      for (const element of root.querySelectorAll("[data-aii-id], [data-aii-path], [data-aii-selected]")) {
        clearAttrs(element);
      }
    }
    function refreshMiniMap() {
      miniMapBody.innerHTML = "";
      if (!state.svgRoot) {
        const hint = document.createElement("div");
        hint.className = "hint";
        hint.textContent = "No SVG";
        miniMapBody.appendChild(hint);
        return;
      }
      const clone = state.svgRoot.cloneNode(true);
      stripRuntimeAttributesFromTree(clone);
      miniMapBody.appendChild(clone);
    }
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }
    function applyCanvasZoom() {
      if (state.canvasStage) {
        state.canvasStage.style.transform = "scale(" + Number(state.canvasZoom.toFixed(2)) + ")";
      }
      updateCanvasInfo();
    }
    function setCanvasZoom(value) {
      state.canvasZoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
      applyCanvasZoom();
    }
    function createTransformModel() {
      return {
        translateX: 0,
        translateY: 0,
        scaleX: 1,
        scaleY: 1,
        rotateAngle: 0,
        rotateCx: 0,
        rotateCy: 0,
        hasRotateCenter: false,
        others: []
      };
    }
    function cloneTransformModel(model) {
      return {
        translateX: model.translateX,
        translateY: model.translateY,
        scaleX: model.scaleX,
        scaleY: model.scaleY,
        rotateAngle: model.rotateAngle,
        rotateCx: model.rotateCx,
        rotateCy: model.rotateCy,
        hasRotateCenter: model.hasRotateCenter,
        others: model.others.slice()
      };
    }
    function parseTransformNumbers(raw) {
      return raw
        .trim()
        .split(/[\s,]+/)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value));
    }
    function normalizeAngle(angle) {
      if (!Number.isFinite(angle)) {
        return 0;
      }
      const remainder = angle % 360;
      return Math.abs(remainder) < TRANSFORM_EPSILON ? 0 : angle;
    }
    function formatNumber(value, digits = 4) {
      if (!Number.isFinite(value)) {
        return "0";
      }
      const normalized = Math.abs(value) < TRANSFORM_EPSILON ? 0 : value;
      return String(Number(normalized.toFixed(digits)));
    }
    function parseTransform(raw) {
      const model = createTransformModel();
      if (!raw) {
        return model;
      }
      const expression = /([a-zA-Z]+)\(([^)]*)\)/g;
      let match;
      while ((match = expression.exec(raw)) !== null) {
        const name = match[1].toLowerCase();
        const args = parseTransformNumbers(match[2]);
        if (name === "translate") {
          const x = args.length > 0 ? args[0] : 0;
          const y = args.length > 1 ? args[1] : 0;
          model.translateX += x;
          model.translateY += y;
          continue;
        }
        if (name === "scale") {
          const x = args.length > 0 ? args[0] : 1;
          const y = args.length > 1 ? args[1] : x;
          model.scaleX *= x;
          model.scaleY *= y;
          continue;
        }
        if (name === "rotate") {
          const delta = args.length > 0 ? args[0] : 0;
          model.rotateAngle += delta;
          if (args.length >= 3) {
            model.rotateCx = args[1];
            model.rotateCy = args[2];
            model.hasRotateCenter = true;
          }
          continue;
        }
        model.others.push(match[0].trim());
      }
      return model;
    }
    function serializeTransform(model) {
      const parts = model.others.slice();
      if (Math.abs(model.translateX) >= TRANSFORM_EPSILON || Math.abs(model.translateY) >= TRANSFORM_EPSILON) {
        parts.push("translate(" + formatNumber(model.translateX) + " " + formatNumber(model.translateY) + ")");
      }
      if (Math.abs(model.scaleX - 1) >= TRANSFORM_EPSILON || Math.abs(model.scaleY - 1) >= TRANSFORM_EPSILON) {
        if (Math.abs(model.scaleX - model.scaleY) < TRANSFORM_EPSILON) {
          parts.push("scale(" + formatNumber(model.scaleX) + ")");
        } else {
          parts.push("scale(" + formatNumber(model.scaleX) + " " + formatNumber(model.scaleY) + ")");
        }
      }
      const angle = normalizeAngle(model.rotateAngle);
      if (Math.abs(angle) >= TRANSFORM_EPSILON) {
        if (model.hasRotateCenter) {
          parts.push("rotate(" + formatNumber(angle) + " " + formatNumber(model.rotateCx) + " " + formatNumber(model.rotateCy) + ")");
        } else {
          parts.push("rotate(" + formatNumber(angle) + ")");
        }
      }
      return parts.join(" ").trim();
    }
    function applyTransform(target, model) {
      const transformed = serializeTransform(model);
      if (transformed) {
        target.setAttribute("transform", transformed);
      } else {
        target.removeAttribute("transform");
      }
    }

    function tagElements(root) {
      let id = 0;
      function walk(element, parentPath) {
        Array.from(element.children).forEach((child, index) => {
          const nodePath = parentPath.concat(index);
          child.setAttribute("data-aii-id", String(++id));
          child.setAttribute("data-aii-path", nodePath.join("."));
          walk(child, nodePath);
        });
      }
      walk(root, []);
    }

    function selectedElement() {
      if (!state.svgRoot || !state.selectedId) return undefined;
      return state.svgRoot.querySelector('[data-aii-id="' + state.selectedId + '"]');
    }
    function readNodePath(element) {
      const raw = element.getAttribute("data-aii-path");
      return raw ? raw.split(".").filter(Boolean).map((v) => Number(v)) : [];
    }
    function findElementByPath(root, nodePath) {
      let current = root;
      for (const index of nodePath) {
        const child = current.children.item(index);
        if (!child) {
          return undefined;
        }
        current = child;
      }
      return current === root ? undefined : current;
    }
    function readAttributes(element) {
      const attrs = {};
      for (const attr of element.attributes) {
        if (!attr.name.startsWith("data-aii-")) attrs[attr.name] = attr.value;
      }
      return attrs;
    }
    function updateSelectionState() {
      const selected = selectedElement();
      const hasSelection = Boolean(selected);
      rotateLeftButton.disabled = !hasSelection;
      rotateRightButton.disabled = !hasSelection;
      scaleDownButton.disabled = !hasSelection;
      scaleUpButton.disabled = !hasSelection;
      deleteButton.disabled = !hasSelection;
      selectionInfoNode.textContent = hasSelection ? "Selected: <" + selected.tagName + ">" : "No selection";
    }
    function postSelectionState() {
      const selected = selectedElement();
      if (!selected) {
        vscode.postMessage({ type: "selectionCleared" });
        return;
      }
      vscode.postMessage({
        type: "selectionChanged",
        nodePath: readNodePath(selected),
        tagName: selected.tagName,
        attributes: readAttributes(selected)
      });
    }
    function clearSelection() {
      if (!state.svgRoot) {
        state.selectedId = undefined;
        updateSelectionState();
        postSelectionState();
        return;
      }
      const current = state.svgRoot.querySelector('[data-aii-selected="1"]');
      if (current) current.removeAttribute("data-aii-selected");
      state.selectedId = undefined;
      updateSelectionState();
      postSelectionState();
    }
    function selectElement(element) {
      if (!state.svgRoot || !element) { clearSelection(); return; }
      const id = element.getAttribute("data-aii-id");
      if (!id) { clearSelection(); return; }
      clearSelection();
      state.selectedId = id;
      element.setAttribute("data-aii-selected", "1");
      updateSelectionState();
      postSelectionState();
    }
    function serializeSvgRoot() {
      const body = new XMLSerializer().serializeToString(state.svgRoot);
      return state.xmlDeclaration ? state.xmlDeclaration + "\\n" + body : body;
    }
    function markDraftChanged(shouldPushHistory = true) {
      if (!state.svgRoot) return;
      const next = serializeSvgRoot();
      if (next === state.rawSvgText) {
        return;
      }
      state.rawSvgText = next;
      if (shouldPushHistory) {
        pushHistory(next);
      }
      setDirty(isDraftDirty(next));
      updateCanvasInfo();
      refreshMiniMap();
      postSelectionState();
      vscode.postMessage({ type: "draftChanged", text: next });
    }
    function applyHistorySnapshot(nextIndex) {
      if (nextIndex < 0 || nextIndex >= state.history.length) {
        return;
      }
      const current = selectedElement();
      const selectedPath = current ? readNodePath(current) : [];
      const next = state.history[nextIndex];
      if (typeof next !== "string") {
        return;
      }
      state.historyIndex = nextIndex;
      state.rawSvgText = next;
      state.xmlDeclaration = parseXmlHeader(next);
      hideContextMenu();
      renderSvg(next, { selectedPath });
      setDirty(isDraftDirty(next));
      updateHistoryButtons();
      vscode.postMessage({ type: "draftChanged", text: next });
    }
    function undoHistory() {
      if (state.historyIndex <= 0) {
        return;
      }
      applyHistorySnapshot(state.historyIndex - 1);
    }
    function redoHistory() {
      if (state.historyIndex >= state.history.length - 1) {
        return;
      }
      applyHistorySnapshot(state.historyIndex + 1);
    }
    function toSvgPoint(svg, x, y) {
      const point = svg.createSVGPoint();
      point.x = x;
      point.y = y;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const transformed = point.matrixTransform(ctm.inverse());
      return { x: transformed.x, y: transformed.y };
    }
    function startDrag(event, target) {
      if (event.button !== 0 || !state.svgRoot || !target) return;
      const from = toSvgPoint(state.svgRoot, event.clientX, event.clientY);
      state.drag = {
        pointerId: event.pointerId,
        originX: from.x,
        originY: from.y,
        baseTransformModel: parseTransform(target.getAttribute("transform") || ""),
        moved: false
      };
      state.dragging = true;
      previewHost.classList.add("dragging");
      target.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    function moveDrag(event) {
      if (!state.dragging || !state.drag || !state.svgRoot) return;
      const target = selectedElement();
      if (!target) return;
      const now = toSvgPoint(state.svgRoot, event.clientX, event.clientY);
      const dx = now.x - state.drag.originX;
      const dy = now.y - state.drag.originY;
      const nextModel = cloneTransformModel(state.drag.baseTransformModel);
      nextModel.translateX += dx;
      nextModel.translateY += dy;
      applyTransform(target, nextModel);
      if (Math.abs(dx) >= TRANSFORM_EPSILON || Math.abs(dy) >= TRANSFORM_EPSILON) {
        state.drag.moved = true;
      }
      event.preventDefault();
    }
    function endDrag(event) {
      if (!state.dragging) return;
      state.dragging = false;
      previewHost.classList.remove("dragging");
      if (state.drag && event.pointerId === state.drag.pointerId && state.drag.moved) {
        markDraftChanged();
      }
      state.drag = undefined;
    }
    function rotateSelected(delta) {
      const target = selectedElement();
      if (!target) return;
      let bbox;
      try { bbox = target.getBBox(); } catch (_) { return; }
      const model = parseTransform(target.getAttribute("transform") || "");
      model.rotateAngle += delta;
      model.rotateCx = bbox.x + bbox.width / 2;
      model.rotateCy = bbox.y + bbox.height / 2;
      model.hasRotateCenter = true;
      applyTransform(target, model);
      markDraftChanged();
    }
    function scaleSelected(deltaScale) {
      const target = selectedElement();
      if (!target || !Number.isFinite(deltaScale) || deltaScale === 0) return;
      let bbox;
      try { bbox = target.getBBox(); } catch (_) { return; }
      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      const model = parseTransform(target.getAttribute("transform") || "");
      const oldScaleX = Math.abs(model.scaleX) < TRANSFORM_EPSILON ? 1 : model.scaleX;
      const oldScaleY = Math.abs(model.scaleY) < TRANSFORM_EPSILON ? 1 : model.scaleY;
      const nextScaleX = Math.max(0.05, oldScaleX + deltaScale);
      const nextScaleY = Math.max(0.05, oldScaleY + deltaScale);
      const ratioX = nextScaleX / oldScaleX;
      const ratioY = nextScaleY / oldScaleY;
      model.translateX += cx * (1 - ratioX);
      model.translateY += cy * (1 - ratioY);
      model.scaleX = nextScaleX;
      model.scaleY = nextScaleY;
      applyTransform(target, model);
      markDraftChanged();
    }
    function deleteSelected() {
      const target = selectedElement();
      if (!target) return;
      target.remove();
      clearSelection();
      markDraftChanged();
    }
    function nudgeSelected(dx, dy) {
      const target = selectedElement();
      if (!target) return;
      const model = parseTransform(target.getAttribute("transform") || "");
      model.translateX += dx;
      model.translateY += dy;
      applyTransform(target, model);
      markDraftChanged();
    }
    function adjustResolution() {
      if (!state.svgRoot) {
        return;
      }
      const current = readResolutionFromRoot(state.svgRoot);
      if (!current) {
        setError("Cannot detect current canvas resolution.");
        return;
      }
      vscode.postMessage({
        type: "requestCanvasResize",
        currentWidth: current.width,
        currentHeight: current.height
      });
    }
    function applyCanvasResize(payload) {
      if (!state.svgRoot) {
        return;
      }
      const current = readResolutionFromRoot(state.svgRoot);
      if (!current) {
        setError("Cannot detect current canvas resolution.");
        return;
      }
      let nextWidth = current.width;
      let nextHeight = current.height;
      if (payload.resizeMode === "proportional") {
        const ratio = Number(payload.ratio);
        if (!Number.isFinite(ratio) || ratio <= 0) {
          setError("Invalid ratio.");
          return;
        }
        nextWidth = current.width * ratio;
        nextHeight = current.height * ratio;
      } else if (payload.resizeMode === "free") {
        const width = Number(payload.width);
        const height = Number(payload.height);
        if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
          setError("Width and height must be positive numbers.");
          return;
        }
        nextWidth = width;
        nextHeight = height;
      } else {
        return;
      }
      setError("");
      state.svgRoot.setAttribute("width", String(Math.max(1, Math.round(nextWidth))));
      state.svgRoot.setAttribute("height", String(Math.max(1, Math.round(nextHeight))));
      markDraftChanged();
    }

    function collectColors(element) {
      const colors = [];
      for (const attr of COLOR_ATTRS) {
        const value = element.getAttribute(attr);
        if (value && !/^none$/i.test(value) && !/^url\\(/i.test(value)) colors.push(value.trim());
      }
      const style = element.getAttribute("style");
      if (style) {
        const rx = /(fill|stroke|stop-color|flood-color|lighting-color|color)\\s*:\\s*([^;]+)/gi;
        for (const match of style.matchAll(rx)) {
          const value = (match[2] || "").trim();
          if (value && !/^none$/i.test(value) && !/^url\\(/i.test(value)) colors.push(value);
        }
      }
      return Array.from(new Set(colors));
    }
    function normalizeColorForPicker(value) {
      if (!value) return "#22c55e";
      const hex = value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
      if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
        return ("#" + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]).toLowerCase();
      }
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.appendChild(probe);
      const computed = getComputedStyle(probe).color;
      probe.remove();
      const m = computed.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/i);
      if (!m) return "#22c55e";
      const toHex = (n) => Number(n).toString(16).padStart(2, "0");
      return "#" + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
    }
    function replaceStyleColors(style, color) {
      return style.replace(
        /(fill|stroke|stop-color|flood-color|lighting-color|color)\\s*:\\s*([^;]+)/gi,
        (_all, prop) => prop + ": " + color
      );
    }
    function applyColorToSelection(color) {
      const target = selectedElement();
      if (!target) return;
      let changed = false;
      for (const attr of COLOR_ATTRS) {
        if (target.hasAttribute(attr)) {
          target.setAttribute(attr, color);
          changed = true;
        }
      }
      const style = target.getAttribute("style");
      if (style) {
        target.setAttribute("style", replaceStyleColors(style, color));
        changed = true;
      }
      if (!changed) target.setAttribute("fill", color);
      markDraftChanged();
    }
    function isValidCssColor(value) {
      const probe = document.createElement("span");
      probe.style.color = "";
      probe.style.color = value.trim();
      return Boolean(probe.style.color);
    }
    function applyMenuColor() {
      const value = menuColorValue.value.trim();
      if (!isValidCssColor(value)) {
        setError("颜色格式无效，请输入如 #22c55e 或 rgb(34,197,94)");
        return;
      }
      setError("");
      menuNativeColor.value = normalizeColorForPicker(value);
      applyColorToSelection(value);
      hideContextMenu();
    }
    function openColorEditor(initialColor, suggestions) {
      menuColorValue.value = initialColor;
      menuNativeColor.value = normalizeColorForPicker(initialColor);
      menuColorSwatches.innerHTML = "";
      const deduped = Array.from(new Set([initialColor, ...suggestions, ...DEFAULT_MENU_COLORS]))
        .map((item) => normalizeColorForPicker(item));
      const activeColor = normalizeColorForPicker(initialColor);
      for (const color of deduped) {
        const swatch = document.createElement("button");
        swatch.type = "button";
        swatch.className = "swatch";
        swatch.style.background = color;
        if (color === activeColor) {
          swatch.classList.add("active");
        }
        swatch.title = color;
        swatch.addEventListener("click", (event) => {
          event.stopPropagation();
          menuColorValue.value = color;
          menuNativeColor.value = color;
          applyMenuColor();
        });
        menuColorSwatches.appendChild(swatch);
      }
      menuColorEditor.classList.add("visible");
    }
    function editSelectedColor() {
      const target = selectedElement();
      if (!target) return;
      const colors = collectColors(target);
      openColorEditor(normalizeColorForPicker(colors[0]), colors);
    }
    function extractSelectedColor() {
      const target = selectedElement();
      if (!target) return;
      const colors = collectColors(target);
      if (!colors.length) {
        setError("当前元素没有可提取颜色。");
        hideContextMenu();
        return;
      }
      hideContextMenu();
      vscode.postMessage({ type: "copyToClipboard", text: colors[0] });
    }

    function renderSvg(svgText, options = {}) {
      if (!svgText.trim()) {
        state.svgRoot = undefined;
        state.canvasStage = undefined;
        previewHost.innerHTML = "";
        clearSelection();
        updateCanvasInfo();
        refreshMiniMap();
        setError("");
        return;
      }
      try {
        const root = parseSvg(svgText);
        tagElements(root);
        state.svgRoot = root;
        previewHost.innerHTML = "";
        const stage = document.createElement("div");
        stage.className = "canvas-stage";
        stage.appendChild(root);
        previewHost.appendChild(stage);
        state.canvasStage = stage;
        setError("");

        root.addEventListener("click", (event) => {
          hideContextMenu();
          const target = event.target instanceof Element ? event.target.closest("[data-aii-id]") : null;
          if (!target) { clearSelection(); return; }
          selectElement(target);
        });
        root.addEventListener("contextmenu", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-aii-id]") : null;
          if (!target) { clearSelection(); hideContextMenu(); return; }
          event.preventDefault();
          selectElement(target);
          showContextMenu(event.clientX, event.clientY);
        });
        root.addEventListener("pointerdown", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-aii-id]") : null;
          if (!target) return;
          selectElement(target);
          startDrag(event, target);
        });
        root.addEventListener("pointermove", moveDrag);
        root.addEventListener("pointerup", endDrag);
        root.addEventListener("pointercancel", endDrag);

        const selectedPath = Array.isArray(options.selectedPath) ? options.selectedPath : [];
        clearSelection();
        if (selectedPath.length) {
          const restored = findElementByPath(root, selectedPath);
          if (restored) {
            selectElement(restored);
          }
        }
        applyCanvasZoom();
        updateCanvasInfo();
        refreshMiniMap();
      } catch (error) {
        state.svgRoot = undefined;
        state.canvasStage = undefined;
        const message = error instanceof Error ? error.message : String(error);
        setError("SVG parse failed: " + message);
      }
    }
    function isEditableInputTarget(target) {
      return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
    }

    for (const button of document.querySelectorAll("[data-op]")) {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "requestOperation", operation: button.getAttribute("data-op") });
      });
    }
    saveButton.addEventListener("click", () => vscode.postMessage({ type: "requestSave" }));
    undoButton.addEventListener("click", undoHistory);
    redoButton.addEventListener("click", redoHistory);
    rotateLeftButton.addEventListener("click", () => rotateSelected(-15));
    rotateRightButton.addEventListener("click", () => rotateSelected(15));
    scaleDownButton.addEventListener("click", () => scaleSelected(-SCALE_STEP));
    scaleUpButton.addEventListener("click", () => scaleSelected(SCALE_STEP));
    deleteButton.addEventListener("click", deleteSelected);
    zoomOutButton.addEventListener("click", () => setCanvasZoom(state.canvasZoom - ZOOM_STEP));
    zoomResetButton.addEventListener("click", () => setCanvasZoom(1));
    zoomInButton.addEventListener("click", () => setCanvasZoom(state.canvasZoom + ZOOM_STEP));
    resolutionButton.addEventListener("click", adjustResolution);
    menuEditColor.addEventListener("click", (event) => {
      event.stopPropagation();
      editSelectedColor();
    });
    menuExtractColor.addEventListener("click", (event) => {
      event.stopPropagation();
      extractSelectedColor();
    });
    menuApplyColor.addEventListener("click", (event) => {
      event.stopPropagation();
      applyMenuColor();
    });
    menuColorValue.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        applyMenuColor();
      }
    });
    menuNativeColor.addEventListener("input", (event) => {
      event.stopPropagation();
      menuColorValue.value = menuNativeColor.value;
    });
    menuNativeColor.addEventListener("change", (event) => {
      event.stopPropagation();
      menuColorValue.value = menuNativeColor.value;
    });
    menuColorEditor.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    window.addEventListener("click", () => hideContextMenu());
    window.addEventListener("scroll", () => hideContextMenu(), { passive: true });
    window.addEventListener("keydown", (event) => {
      if (isEditableInputTarget(event.target)) {
        return;
      }
      const key = String(event.key || "").toLowerCase();
      const withCommand = event.ctrlKey || event.metaKey;
      if (withCommand && !event.altKey) {
        if (key === "z") {
          if (event.shiftKey) {
            redoHistory();
          } else {
            undoHistory();
          }
          event.preventDefault();
          return;
        }
        if (key === "y") {
          redoHistory();
          event.preventDefault();
          return;
        }
        if (key === "=" || key === "+") {
          setCanvasZoom(state.canvasZoom + ZOOM_STEP);
          event.preventDefault();
          return;
        }
        if (key === "-") {
          setCanvasZoom(state.canvasZoom - ZOOM_STEP);
          event.preventDefault();
          return;
        }
        if (key === "0") {
          setCanvasZoom(1);
          event.preventDefault();
          return;
        }
      }
      if (!selectedElement()) return;
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowUp") { nudgeSelected(0, -step); event.preventDefault(); }
      else if (event.key === "ArrowDown") { nudgeSelected(0, step); event.preventDefault(); }
      else if (event.key === "ArrowLeft") { nudgeSelected(-step, 0); event.preventDefault(); }
      else if (event.key === "ArrowRight") { nudgeSelected(step, 0); event.preventDefault(); }
      else if (event.key === "Delete" || event.key === "Backspace") { deleteSelected(); event.preventDefault(); }
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "document") {
        const preserveHistory = Boolean(message.preserveHistory);
        const previousSelected = selectedElement();
        const selectedPath = previousSelected ? readNodePath(previousSelected) : [];
        fileNameNode.textContent = message.fileName || "-";
        state.baseSvgText = message.text || "";
        state.rawSvgText = state.baseSvgText;
        state.xmlDeclaration = parseXmlHeader(state.rawSvgText);
        hideContextMenu();
        if (!preserveHistory) {
          state.canvasZoom = 1;
          renderSvg(state.rawSvgText);
          state.originalResolution = readResolutionFromRoot(state.svgRoot);
          updateCanvasInfo();
          resetHistory(state.rawSvgText);
          setDirty(false);
        } else {
          renderSvg(state.rawSvgText, { selectedPath });
          if (state.history[state.historyIndex] !== state.rawSvgText) {
            pushHistory(state.rawSvgText);
          } else {
            updateHistoryButtons();
          }
        }
      } else if (message.type === "dirtyState") {
        setDirty(Boolean(message.dirty) || isDraftDirty(state.rawSvgText));
      } else if (message.type === "saved") {
        const current = selectedElement();
        const selectedPath = current ? readNodePath(current) : [];
        state.baseSvgText = message.text || state.baseSvgText;
        state.rawSvgText = message.text || state.rawSvgText;
        state.xmlDeclaration = parseXmlHeader(state.rawSvgText);
        hideContextMenu();
        renderSvg(state.rawSvgText, { selectedPath });
        if (state.history[state.historyIndex] !== state.rawSvgText) {
          pushHistory(state.rawSvgText);
        } else {
          updateHistoryButtons();
        }
        setDirty(false);
      } else if (message.type === "applyCanvasResize") {
        applyCanvasResize(message);
      }
    });

    setDirty(false);
    updateHistoryButtons();
    updateSelectionState();
    updateCanvasInfo();
    refreshMiniMap();
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let value = "";
  for (let i = 0; i < 24; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}


