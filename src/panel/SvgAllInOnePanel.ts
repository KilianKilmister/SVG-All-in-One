import * as path from "path";
import * as vscode from "vscode";
import {
  runExportPng,
  runExportPngVariants,
  runExtractPalette,
  runInsertSnippet,
  runQuickRecolor,
  runTextOperation,
  type SvgTextOperation
} from "../commands";
import { SvgAttributeSidebarProvider } from "./SvgAttributeSidebarProvider";
import { isSvgDocument, replaceWholeDocument, resolveSvgDocument } from "../svg/documentHelpers";
import { type SvgNodePath } from "../svg/svgDom";

type PanelOperation =
  | "format"
  | "cleanup"
  | "compress"
  | "recolor"
  | "extractPalette"
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

    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (SvgAllInOnePanel.currentPanel) {
      SvgAllInOnePanel.currentPanel.panel.reveal(column, true);
      await SvgAllInOnePanel.currentPanel.setDocument(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "svgAllInOne.panel",
      "SVG All in One",
      {
        viewColumn: column,
        preserveFocus: true
      },
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

  private readonly disposables: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly attributeSidebar: SvgAttributeSidebarProvider;
  private currentDocument: vscode.TextDocument;
  private syncingFromWebview = false;

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

    this.panel.title = `SVG All in One - ${path.basename(document.uri.fsPath || document.uri.path)}`;
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
        await this.pushDocumentToWebview();
      },
      undefined,
      this.disposables
    );

    vscode.workspace.onDidCloseTextDocument(
      async (document) => {
        if (document.uri.toString() !== this.currentDocument.uri.toString()) {
          return;
        }

        const next = vscode.window.activeTextEditor?.document;
        if (next && isSvgDocument(next)) {
          await this.setDocument(next);
          return;
        }

        this.dispose();
      },
      undefined,
      this.disposables
    );

    vscode.window.onDidChangeActiveTextEditor(
      async (editor) => {
        if (!editor || !isSvgDocument(editor.document)) {
          return;
        }
        await this.setDocument(editor.document);
      },
      undefined,
      this.disposables
    );

    this.panel.onDidDispose(
      () => {
        this.dispose();
      },
      undefined,
      this.disposables
    );
  }

  private async setDocument(document: vscode.TextDocument): Promise<void> {
    this.currentDocument = document;
    this.panel.title = `SVG All in One - ${path.basename(document.uri.fsPath || document.uri.path)}`;
    this.attributeSidebar.clearSelection();
    await this.pushDocumentToWebview();
  }

  private async handlePanelMessage(message: PanelMessage): Promise<void> {
    if (message.type === "ready") {
      await this.pushDocumentToWebview();
      return;
    }

    if (message.type === "updateFromEditor" && typeof message.text === "string") {
      if (message.text === this.currentDocument.getText()) {
        return;
      }
      // Guard against change-event loops while syncing Webview edits back to the real document.
      this.syncingFromWebview = true;
      try {
        await replaceWholeDocument(this.currentDocument, message.text);
      } finally {
        this.syncingFromWebview = false;
      }
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
      await this.executePanelOperation(message.operation);
    }
  }

  private async executePanelOperation(operation: PanelOperation): Promise<void> {
    const uri = this.currentDocument.uri;
    if (operation === "format" || operation === "cleanup" || operation === "compress") {
      await runTextOperation(operation as SvgTextOperation, uri);
      return;
    }
    if (operation === "recolor") {
      await runQuickRecolor(uri);
      return;
    }
    if (operation === "extractPalette") {
      await runExtractPalette(uri);
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
      await runInsertSnippet();
    }
  }

  private async pushDocumentToWebview(): Promise<void> {
    await this.panel.webview.postMessage({
      type: "document",
      fileName: path.basename(this.currentDocument.uri.fsPath || this.currentDocument.uri.path),
      text: this.currentDocument.getText()
    });
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
  <title>SVG All in One</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --fg: var(--vscode-editor-foreground);
      --panel: color-mix(in srgb, var(--bg) 92%, #0b1220);
      --muted: color-mix(in srgb, var(--fg) 45%, var(--bg));
      --accent: #0ea5e9;
      --danger: #ef4444;
      --border: color-mix(in srgb, var(--fg) 16%, transparent);
    }

    * {
      box-sizing: border-box;
    }

    html, body {
      height: 100%;
      margin: 0;
      padding: 0;
      background: radial-gradient(circle at top right, color-mix(in srgb, var(--accent) 24%, var(--bg)) 0%, var(--bg) 40%);
      color: var(--fg);
      font-family: "Segoe UI", "PingFang SC", sans-serif;
    }

    .root {
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
    }

    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 12px 6px;
      border-bottom: 1px solid var(--border);
      backdrop-filter: blur(6px);
    }

    .toolbar button {
      border: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 85%, var(--accent) 15%);
      color: var(--fg);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .toolbar button:hover {
      border-color: color-mix(in srgb, var(--accent) 70%, var(--border));
      background: color-mix(in srgb, var(--bg) 78%, var(--accent) 22%);
    }

    .toolbar .danger {
      background: color-mix(in srgb, var(--bg) 84%, var(--danger) 16%);
    }

    .meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 12px;
      color: var(--muted);
      font-size: 12px;
      border-bottom: 1px solid var(--border);
    }

    .workspace {
      display: grid;
      grid-template-columns: 1fr 6px 1fr;
      min-height: 0;
      min-width: 0;
    }

    .editor-pane, .preview-pane {
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--panel) 93%, transparent);
    }

    .pane-title {
      padding: 8px 10px;
      font-size: 12px;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    #sourceEditor {
      width: 100%;
      height: 100%;
      border: 0;
      padding: 10px;
      margin: 0;
      outline: 0;
      resize: none;
      font-size: 13px;
      line-height: 1.5;
      color: var(--fg);
      background: transparent;
      font-family: Consolas, "Courier New", monospace;
    }

    .divider {
      cursor: col-resize;
      background: color-mix(in srgb, var(--accent) 16%, var(--border));
    }

    .divider:hover {
      background: color-mix(in srgb, var(--accent) 32%, var(--border));
    }

    #previewHost {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 12px;
      background-image:
        linear-gradient(45deg, rgba(127, 127, 127, 0.1) 25%, transparent 25%),
        linear-gradient(-45deg, rgba(127, 127, 127, 0.1) 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, rgba(127, 127, 127, 0.1) 75%),
        linear-gradient(-45deg, transparent 75%, rgba(127, 127, 127, 0.1) 75%);
      background-size: 20px 20px;
      background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
    }

    #previewHost svg {
      display: block;
      margin: 0 auto;
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.25);
      background: transparent;
    }

    #previewHost [data-aii-id][data-aii-selected="1"] {
      filter: drop-shadow(0 0 0.5px #fff) drop-shadow(0 0 3px var(--accent));
      cursor: grab;
    }

    #previewHost [data-aii-id] {
      cursor: pointer;
    }

    #previewHost.dragging [data-aii-id][data-aii-selected="1"] {
      cursor: grabbing;
    }

    .palette {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
    }

    .swatch {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      border: 1px solid var(--border);
      cursor: pointer;
      flex-shrink: 0;
    }

    .error {
      color: #fca5a5;
      font-size: 12px;
      padding: 2px 12px 10px;
      min-height: 20px;
    }

    @media (max-width: 900px) {
      .workspace {
        grid-template-columns: 1fr;
        grid-template-rows: 1fr 1fr;
      }

      .divider {
        display: none;
      }
    }
  </style>
</head>
<body>
  <div class="root">
    <div class="toolbar">
      <button data-op="format">格式化</button>
      <button data-op="cleanup">清理字符</button>
      <button data-op="compress">压缩</button>
      <button data-op="recolor">快捷改色</button>
      <button data-op="extractPalette">提取调色板</button>
      <button data-op="exportPng">导出 PNG</button>
      <button data-op="exportPngVariants">导出多倍率</button>
      <button data-op="insertSnippet">插入片段</button>
      <button id="rotateLeft">左转 15°</button>
      <button id="rotateRight">右转 15°</button>
      <button id="deleteElement" class="danger">删除元素</button>
    </div>
    <div class="meta">
      <div id="fileName">-</div>
      <div id="selectionInfo">未选择元素</div>
    </div>
    <div class="workspace" id="workspace">
      <div class="editor-pane">
        <div class="pane-title">Source</div>
        <textarea id="sourceEditor" spellcheck="false"></textarea>
      </div>
      <div class="divider" id="divider"></div>
      <div class="preview-pane">
        <div class="pane-title">Preview / Drag / Rotate</div>
        <div id="previewHost"></div>
      </div>
    </div>
    <div class="palette" id="palette">颜色: 无</div>
    <div class="error" id="error"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sourceEditor = document.getElementById("sourceEditor");
    const previewHost = document.getElementById("previewHost");
    const errorNode = document.getElementById("error");
    const fileNameNode = document.getElementById("fileName");
    const selectionInfoNode = document.getElementById("selectionInfo");
    const paletteNode = document.getElementById("palette");
    const workspace = document.getElementById("workspace");
    const divider = document.getElementById("divider");
    const rotateLeftButton = document.getElementById("rotateLeft");
    const rotateRightButton = document.getElementById("rotateRight");
    const deleteElementButton = document.getElementById("deleteElement");

    const state = {
      svgRoot: undefined,
      selectedId: undefined,
      xmlDeclaration: "",
      pushTimer: undefined,
      drag: undefined,
      dragging: false
    };

    function debouncePush() {
      window.clearTimeout(state.pushTimer);
      state.pushTimer = window.setTimeout(() => {
        vscode.postMessage({ type: "updateFromEditor", text: sourceEditor.value });
      }, 180);
    }

    function setError(message) {
      errorNode.textContent = message || "";
    }

    function updateSelectionLabel() {
      if (!state.selectedId || !state.svgRoot) {
        selectionInfoNode.textContent = "未选择元素";
        return;
      }
      const target = state.svgRoot.querySelector('[data-aii-id="' + state.selectedId + '"]');
      if (!target) {
        selectionInfoNode.textContent = "未选择元素";
        return;
      }
      selectionInfoNode.textContent = "已选择: <" + target.tagName + ">";
    }

    function parseXmlHeader(text) {
      const match = text.match(/^\\s*(<\\?xml[\\s\\S]*?\\?>)/i);
      return match ? match[1] : "";
    }

    function parseSvg(text) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "image/svg+xml");
      const parseError = doc.querySelector("parsererror");
      if (parseError) {
        throw new Error(parseError.textContent || "SVG parse error");
      }
      const root = doc.documentElement;
      if (!root || root.tagName.toLowerCase() !== "svg") {
        throw new Error("当前内容不是有效 SVG 根元素");
      }
      return root;
    }

    function tagElements(svgRoot) {
      let index = 0;
      const walker = document.createTreeWalker(svgRoot, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      while (node) {
        if (node !== svgRoot) {
          // Stable runtime id for selection/dragging in preview without mutating original semantic attrs.
          node.setAttribute("data-aii-id", String(++index));
        }
        node = walker.nextNode();
      }
    }

    function extractPalette(svgText) {
      const matches = [];
      const regex = /\\b(fill|stroke|stop-color|flood-color|lighting-color|color)=["']([^"']+)["']/gi;
      let m;
      while ((m = regex.exec(svgText))) {
        const value = m[2].trim();
        if (value && !/^none$/i.test(value) && !/^url\\(/i.test(value)) {
          matches.push(value);
        }
      }
      return Array.from(new Set(matches)).sort((a, b) => a.localeCompare(b));
    }

    function updatePalette(svgText) {
      const colors = extractPalette(svgText);
      if (!colors.length) {
        paletteNode.textContent = "颜色: 无";
        return;
      }
      paletteNode.innerHTML = "";
      const label = document.createElement("span");
      label.textContent = "颜色:";
      paletteNode.appendChild(label);
      for (const color of colors) {
        const swatch = document.createElement("div");
        swatch.className = "swatch";
        swatch.title = color + " (点击复制)";
        swatch.style.background = color;
        swatch.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(color);
          } catch (_) {
            vscode.postMessage({ type: "requestOperation", operation: "extractPalette" });
          }
        });
        paletteNode.appendChild(swatch);
      }
    }

    function getElementPath(element) {
      const path = [];
      let current = element;
      while (current && current.parentElement && current.parentElement !== state.svgRoot) {
        const parent = current.parentElement;
        const siblings = Array.from(parent.children).filter((child) => child.nodeType === 1);
        path.unshift(siblings.indexOf(current));
        current = parent;
      }
      if (current && current.parentElement === state.svgRoot) {
        const rootChildren = Array.from(state.svgRoot.children).filter((child) => child.nodeType === 1);
        path.unshift(rootChildren.indexOf(current));
      }
      return path;
    }

    function readElementAttributes(element) {
      const attrs = {};
      for (const attr of element.attributes) {
        if (attr.name.startsWith("data-aii-")) {
          continue;
        }
        attrs[attr.name] = attr.value;
      }
      return attrs;
    }

    function postSelectionState() {
      const target = pickSelectedElement();
      if (!target) {
        vscode.postMessage({ type: "selectionCleared" });
        return;
      }
      vscode.postMessage({
        type: "selectionChanged",
        nodePath: getElementPath(target),
        tagName: target.tagName,
        attributes: readElementAttributes(target)
      });
    }

    function clearSelection() {
      if (!state.svgRoot) {
        state.selectedId = undefined;
        updateSelectionLabel();
        postSelectionState();
        return;
      }
      const selected = state.svgRoot.querySelector('[data-aii-selected="1"]');
      if (selected) {
        selected.removeAttribute("data-aii-selected");
      }
      state.selectedId = undefined;
      updateSelectionLabel();
      postSelectionState();
    }

    function selectElement(element) {
      if (!state.svgRoot || !element || !element.getAttribute) {
        clearSelection();
        return;
      }
      const id = element.getAttribute("data-aii-id");
      if (!id) {
        clearSelection();
        return;
      }
      clearSelection();
      element.setAttribute("data-aii-selected", "1");
      state.selectedId = id;
      updateSelectionLabel();
      postSelectionState();
    }

    function serializeAndSync() {
      if (!state.svgRoot) {
        return;
      }
      const serializer = new XMLSerializer();
      const body = serializer.serializeToString(state.svgRoot);
      const next = state.xmlDeclaration ? state.xmlDeclaration + "\\n" + body : body;
      sourceEditor.value = next;
      updatePalette(next);
      postSelectionState();
      debouncePush();
    }

    function pickSelectedElement() {
      if (!state.svgRoot || !state.selectedId) {
        return undefined;
      }
      return state.svgRoot.querySelector('[data-aii-id="' + state.selectedId + '"]');
    }

    function toSvgPoint(svg, clientX, clientY) {
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) {
        return { x: 0, y: 0 };
      }
      const transformed = point.matrixTransform(ctm.inverse());
      return { x: transformed.x, y: transformed.y };
    }

    function startDrag(event, target) {
      if (event.button !== 0 || !state.svgRoot || !target) {
        return;
      }
      const svg = state.svgRoot;
      const from = toSvgPoint(svg, event.clientX, event.clientY);
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
      if (!state.dragging || !state.drag || !state.svgRoot) {
        return;
      }
      const target = pickSelectedElement();
      if (!target) {
        return;
      }
      const now = toSvgPoint(state.svgRoot, event.clientX, event.clientY);
      const dx = now.x - state.drag.originX;
      const dy = now.y - state.drag.originY;
      const translated = "translate(" + dx.toFixed(2) + " " + dy.toFixed(2) + ")";
      // Append temporary translate over existing transform so drag works for most authored SVGs.
      target.setAttribute("transform", (state.drag.originalTransform + " " + translated).trim());
      event.preventDefault();
    }

    function endDrag(event) {
      if (!state.dragging) {
        return;
      }
      state.dragging = false;
      previewHost.classList.remove("dragging");
      if (state.drag && event.pointerId === state.drag.pointerId) {
        serializeAndSync();
      }
      state.drag = undefined;
    }

    function rotateSelected(delta) {
      const target = pickSelectedElement();
      if (!target) {
        return;
      }
      let bbox;
      try {
        bbox = target.getBBox();
      } catch (_) {
        return;
      }
      const cx = (bbox.x + bbox.width / 2).toFixed(2);
      const cy = (bbox.y + bbox.height / 2).toFixed(2);
      const existing = target.getAttribute("transform") || "";
      // Rotate around geometric bbox center to provide an intuitive default pivot.
      target.setAttribute("transform", (existing + " rotate(" + delta + " " + cx + " " + cy + ")").trim());
      serializeAndSync();
    }

    function nudgeSelected(dx, dy) {
      const target = pickSelectedElement();
      if (!target) {
        return;
      }
      const existing = target.getAttribute("transform") || "";
      target.setAttribute("transform", (existing + " translate(" + dx + " " + dy + ")").trim());
      serializeAndSync();
    }

    function deleteSelected() {
      const target = pickSelectedElement();
      if (!target) {
        return;
      }
      target.remove();
      clearSelection();
      serializeAndSync();
    }

    function renderSvg(svgText) {
      if (!svgText.trim()) {
        previewHost.innerHTML = "";
        clearSelection();
        setError("");
        updatePalette(svgText);
        return;
      }

      try {
        const root = parseSvg(svgText);
        tagElements(root);
        state.svgRoot = root;
        previewHost.innerHTML = "";
        previewHost.appendChild(root);
        setError("");
        updatePalette(svgText);

        root.addEventListener("click", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-aii-id]") : null;
          if (!target) {
            clearSelection();
            return;
          }
          selectElement(target);
        });

        root.addEventListener("pointerdown", (event) => {
          const target = event.target instanceof Element ? event.target.closest("[data-aii-id]") : null;
          if (!target) {
            return;
          }
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

    sourceEditor.addEventListener("input", () => {
      renderSvg(sourceEditor.value);
      debouncePush();
    });

    for (const button of document.querySelectorAll("[data-op]")) {
      button.addEventListener("click", () => {
        vscode.postMessage({
          type: "requestOperation",
          operation: button.getAttribute("data-op")
        });
      });
    }

    rotateLeftButton.addEventListener("click", () => rotateSelected(-15));
    rotateRightButton.addEventListener("click", () => rotateSelected(15));
    deleteElementButton.addEventListener("click", deleteSelected);

    window.addEventListener("keydown", (event) => {
      if (!state.selectedId) {
        return;
      }
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowUp") {
        nudgeSelected(0, -step);
        event.preventDefault();
      } else if (event.key === "ArrowDown") {
        nudgeSelected(0, step);
        event.preventDefault();
      } else if (event.key === "ArrowLeft") {
        nudgeSelected(-step, 0);
        event.preventDefault();
      } else if (event.key === "ArrowRight") {
        nudgeSelected(step, 0);
        event.preventDefault();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelected();
        event.preventDefault();
      }
    });

    divider.addEventListener("pointerdown", (event) => {
      if (window.matchMedia("(max-width: 900px)").matches) {
        return;
      }
      const totalWidth = workspace.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        const rect = workspace.getBoundingClientRect();
        const left = Math.min(Math.max(moveEvent.clientX - rect.left, 260), totalWidth - 260);
        workspace.style.gridTemplateColumns = left + "px 6px 1fr";
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      event.preventDefault();
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "document") {
        fileNameNode.textContent = message.fileName || "-";
        state.xmlDeclaration = parseXmlHeader(message.text || "");
        sourceEditor.value = message.text || "";
        clearSelection();
        renderSvg(sourceEditor.value);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    SvgAllInOnePanel.currentPanel = undefined;
    this.attributeSidebar.clearSelection();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
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
