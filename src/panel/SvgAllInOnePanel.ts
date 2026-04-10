import * as path from "path";
import * as vscode from "vscode";
import {
  runExportPng,
  runExportPngVariants,
  runInsertSnippet,
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
  | "exportPngVariants"
  | "insertSnippet";

interface PanelMessage {
  type: string;
  text?: string;
  operation?: PanelOperation;
  nodePath?: SvgNodePath;
  tagName?: string;
  attributes?: Record<string, string>;
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

        if (this.isDirty) {
          if (!this.warnedExternalChangeWhileDirty) {
            this.warnedExternalChangeWhileDirty = true;
            void vscode.window.showWarningMessage(
              "SVG 文件已外部变更，预览草稿尚未保存。请先保存或重新打开预览。"
            );
          }
          return;
        }

        await this.pushDocumentToWebview();
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
      this.isDirty = true;
      this.draftText = message.text;
      await this.panel.webview.postMessage({ type: "dirtyState", dirty: true });
      return;
    }

    if (message.type === "requestSave") {
      await this.saveDraft(true, true);
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
      await this.pushDocumentToWebview();
    }
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
    if (operation === "insertSnippet") {
      await runInsertSnippet(uri);
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
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private async pushDocumentToWebview(): Promise<void> {
    await this.panel.webview.postMessage({
      type: "document",
      fileName: path.basename(this.currentDocument.uri.fsPath || this.currentDocument.uri.path),
      text: this.currentDocument.getText()
    });
    await this.panel.webview.postMessage({ type: "dirtyState", dirty: this.isDirty });
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
    .root { height: 100%; display: flex; flex-direction: column; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); }
    .group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    button { border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); background: color-mix(in srgb, var(--vscode-editor-background) 86%, #0b1220); color: inherit; border-radius: 7px; padding: 5px 9px; font-size: 12px; cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .meta, .status { display: flex; justify-content: space-between; gap: 8px; padding: 6px 10px; font-size: 12px; color: color-mix(in srgb, var(--vscode-editor-foreground) 50%, var(--vscode-editor-background)); border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent); }
    .status { border-top: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent); border-bottom: 0; }
    .dirty { color: #f59e0b; font-weight: 600; }
    .saved { color: #22c55e; font-weight: 600; }
    #previewHost { position: relative; flex: 1; overflow: auto; padding: 12px; background-image: linear-gradient(45deg, rgba(127,127,127,.1) 25%, transparent 25%), linear-gradient(-45deg, rgba(127,127,127,.1) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(127,127,127,.1) 75%), linear-gradient(-45deg, transparent 75%, rgba(127,127,127,.1) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0; }
    #previewHost svg { display: block; margin: 0 auto; max-width: 100%; height: auto; border-radius: 6px; box-shadow: 0 8px 20px rgba(0,0,0,.25); }
    #previewHost [data-aii-id] { cursor: pointer; }
    #previewHost [data-aii-id][data-aii-selected="1"] { filter: drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #0ea5e9); cursor: grab; }
    #previewHost.dragging [data-aii-id][data-aii-selected="1"] { cursor: grabbing; }
    .error { min-height: 20px; padding: 2px 10px 8px; color: #fca5a5; font-size: 12px; }
    .ctx { position: fixed; z-index: 20; display: none; min-width: 120px; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); border-radius: 8px; overflow: hidden; background: color-mix(in srgb, var(--vscode-editor-background) 90%, #0b1220); box-shadow: 0 10px 20px rgba(0,0,0,.28); }
    .ctx button { width: 100%; border: 0; border-bottom: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent); border-radius: 0; text-align: left; background: transparent; padding: 8px 10px; }
    .ctx button:last-child { border-bottom: 0; }
  </style>
</head>
<body>
  <div class="root">
    <div class="toolbar">
      <div class="group">
        <button data-op="format">格式化</button>
        <button data-op="cleanup">清理字符</button>
        <button data-op="compress">压缩</button>
        <button data-op="exportPng">导出 PNG</button>
        <button data-op="exportPngVariants">导出多倍率</button>
        <button data-op="insertSnippet">插入片段</button>
        <button id="rotateLeft" disabled>左转 15°</button>
        <button id="rotateRight" disabled>右转 15°</button>
        <button id="deleteElement" disabled>删除元素</button>
      </div>
      <div class="group"><button id="saveButton" disabled>保存</button></div>
    </div>
    <div class="meta"><div id="fileName">-</div><div id="selectionInfo">未选中元素</div></div>
    <div id="previewHost"></div>
    <div class="status"><span id="dirtyState" class="saved">已保存</span><span>右键已选元素：修改颜色 / 提取颜色</span></div>
    <div class="error" id="error"></div>
  </div>
  <div class="ctx" id="contextMenu">
    <button id="menuEditColor">修改颜色</button>
    <button id="menuExtractColor">提取颜色</button>
  </div>
  <input id="colorPicker" type="color" style="position:fixed;left:-9999px;top:-9999px;opacity:0;" />

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const previewHost = document.getElementById("previewHost");
    const errorNode = document.getElementById("error");
    const fileNameNode = document.getElementById("fileName");
    const selectionInfoNode = document.getElementById("selectionInfo");
    const saveButton = document.getElementById("saveButton");
    const dirtyStateNode = document.getElementById("dirtyState");
    const rotateLeftButton = document.getElementById("rotateLeft");
    const rotateRightButton = document.getElementById("rotateRight");
    const deleteButton = document.getElementById("deleteElement");
    const contextMenu = document.getElementById("contextMenu");
    const menuEditColor = document.getElementById("menuEditColor");
    const menuExtractColor = document.getElementById("menuExtractColor");
    const colorPicker = document.getElementById("colorPicker");
    const COLOR_ATTRS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"];

    const state = {
      rawSvgText: "",
      svgRoot: undefined,
      selectedId: undefined,
      xmlDeclaration: "",
      drag: undefined,
      dragging: false
    };

    function setError(message) { errorNode.textContent = message || ""; }
    function setDirty(dirty) {
      saveButton.disabled = !dirty;
      dirtyStateNode.textContent = dirty ? "未保存" : "已保存";
      dirtyStateNode.className = dirty ? "dirty" : "saved";
    }
    function hideContextMenu() { contextMenu.style.display = "none"; }
    function showContextMenu(x, y) {
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
      if (!root || root.tagName.toLowerCase() !== "svg") throw new Error("当前内容不是有效 SVG");
      return root;
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
      deleteButton.disabled = !hasSelection;
      selectionInfoNode.textContent = hasSelection ? "已选中: <" + selected.tagName + ">" : "未选中元素";
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
    function markDraftChanged() {
      if (!state.svgRoot) return;
      const body = new XMLSerializer().serializeToString(state.svgRoot);
      const next = state.xmlDeclaration ? state.xmlDeclaration + "\\n" + body : body;
      state.rawSvgText = next;
      setDirty(true);
      postSelectionState();
      vscode.postMessage({ type: "draftChanged", text: next });
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
        originalTransform: target.getAttribute("transform") || ""
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
      target.setAttribute(
        "transform",
        (state.drag.originalTransform + " translate(" + dx.toFixed(2) + " " + dy.toFixed(2) + ")").trim()
      );
      event.preventDefault();
    }
    function endDrag(event) {
      if (!state.dragging) return;
      state.dragging = false;
      previewHost.classList.remove("dragging");
      if (state.drag && event.pointerId === state.drag.pointerId) markDraftChanged();
      state.drag = undefined;
    }
    function rotateSelected(delta) {
      const target = selectedElement();
      if (!target) return;
      let bbox;
      try { bbox = target.getBBox(); } catch (_) { return; }
      const cx = (bbox.x + bbox.width / 2).toFixed(2);
      const cy = (bbox.y + bbox.height / 2).toFixed(2);
      const existing = target.getAttribute("transform") || "";
      target.setAttribute("transform", (existing + " rotate(" + delta + " " + cx + " " + cy + ")").trim());
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
      const existing = target.getAttribute("transform") || "";
      target.setAttribute("transform", (existing + " translate(" + dx + " " + dy + ")").trim());
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
    function openColorPicker(rawColor) {
      colorPicker.value = normalizeColorForPicker(rawColor);
      try {
        if (typeof colorPicker.showPicker === "function") {
          colorPicker.showPicker();
          return;
        }
      } catch (_) {
        // Ignore fallback errors and try a click-based picker open.
      }

      const prevLeft = colorPicker.style.left;
      const prevTop = colorPicker.style.top;
      const prevOpacity = colorPicker.style.opacity;
      colorPicker.style.left = "12px";
      colorPicker.style.top = "12px";
      colorPicker.style.opacity = "0.01";
      colorPicker.click();
      requestAnimationFrame(() => {
        colorPicker.style.left = prevLeft;
        colorPicker.style.top = prevTop;
        colorPicker.style.opacity = prevOpacity;
      });
    }
    function editSelectedColor() {
      const target = selectedElement();
      if (!target) return;
      const colors = collectColors(target);
      openColorPicker(colors[0]);
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

    function renderSvg(svgText) {
      if (!svgText.trim()) {
        previewHost.innerHTML = "";
        clearSelection();
        setError("");
        return;
      }
      try {
        const root = parseSvg(svgText);
        tagElements(root);
        state.svgRoot = root;
        previewHost.innerHTML = "";
        previewHost.appendChild(root);
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
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError("SVG 解析失败: " + message);
      }
    }

    for (const button of document.querySelectorAll("[data-op]")) {
      button.addEventListener("click", () => {
        vscode.postMessage({ type: "requestOperation", operation: button.getAttribute("data-op") });
      });
    }
    saveButton.addEventListener("click", () => vscode.postMessage({ type: "requestSave" }));
    rotateLeftButton.addEventListener("click", () => rotateSelected(-15));
    rotateRightButton.addEventListener("click", () => rotateSelected(15));
    deleteButton.addEventListener("click", deleteSelected);
    menuEditColor.addEventListener("click", (event) => {
      event.stopPropagation();
      hideContextMenu();
      editSelectedColor();
    });
    menuExtractColor.addEventListener("click", (event) => {
      event.stopPropagation();
      extractSelectedColor();
    });
    colorPicker.addEventListener("input", () => {
      applyColorToSelection(colorPicker.value);
      hideContextMenu();
    });
    colorPicker.addEventListener("change", () => {
      applyColorToSelection(colorPicker.value);
      hideContextMenu();
    });
    window.addEventListener("click", () => hideContextMenu());
    window.addEventListener("scroll", () => hideContextMenu(), { passive: true });
    window.addEventListener("keydown", (event) => {
      if (!selectedElement()) return;
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowUp") { nudgeSelected(0, -step); event.preventDefault(); }
      else if (event.key === "ArrowDown") { nudgeSelected(0, step); event.preventDefault(); }
      else if (event.key === "ArrowLeft") { nudgeSelected(-step, 0); event.preventDefault(); }
      else if (event.key === "ArrowRight") { nudgeSelected(step, 0); event.preventDefault(); }
      else if (event.key === "Delete" || event.key === "Backspace") { deleteSelected(); event.preventDefault(); }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "document") {
        fileNameNode.textContent = message.fileName || "-";
        state.xmlDeclaration = parseXmlHeader(message.text || "");
        state.rawSvgText = message.text || "";
        hideContextMenu();
        clearSelection();
        renderSvg(state.rawSvgText);
      } else if (message.type === "dirtyState") {
        setDirty(Boolean(message.dirty));
      } else if (message.type === "saved") {
        state.rawSvgText = message.text || state.rawSvgText;
        setDirty(false);
        renderSvg(state.rawSvgText);
      }
    });

    setDirty(false);
    updateSelectionState();
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

