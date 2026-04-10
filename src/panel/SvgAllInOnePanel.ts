import * as path from "path";
import * as vscode from "vscode";
import {
  runExportPng,
  runExportPngVariants,
  runInsertSnippet,
  runTextOperation,
  type SvgTextOperation
} from "../commands";
import {
  ensureVisible,
  isSvgDocument,
  replaceWholeDocument,
  resolveSvgDocument
} from "../svg/documentHelpers";
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

    if (SvgAllInOnePanel.currentPanel) {
      SvgAllInOnePanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside, true);
      await SvgAllInOnePanel.currentPanel.setDocument(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "svgAllInOne.preview",
      "SVG Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
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
              "SVG 文件已外部变更。预览草稿未保存，请先保存或重新打开预览。"
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
      await this.saveDraft(true);
      return;
    }

    if (message.type === "copyToClipboard" && typeof message.text === "string") {
      await vscode.env.clipboard.writeText(message.text);
      void vscode.window.showInformationMessage(`已复制颜色: ${message.text}`);
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
      await runTextOperation(operation as SvgTextOperation, uri);
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

  private stripPreviewRuntimeAttributes(svgText: string): string {
    return svgText
      .replace(/\sdata-aii-id=(['"])(.*?)\1/g, "")
      .replace(/\sdata-aii-path=(['"])(.*?)\1/g, "")
      .replace(/\sdata-aii-selected=(['"])(.*?)\1/g, "");
  }

  private async saveDraft(showSavedMessage: boolean): Promise<boolean> {
    if (!this.isDirty || !this.draftText) {
      return true;
    }
    const cleaned = this.stripPreviewRuntimeAttributes(this.draftText);
    if (!cleaned.trim()) {
      return false;
    }
    if (cleaned.trim() === this.currentDocument.getText().trim()) {
      this.isDirty = false;
      this.draftText = cleaned;
      await this.panel.webview.postMessage({ type: "dirtyState", dirty: false });
      await this.panel.webview.postMessage({ type: "saved", text: cleaned });
      return true;
    }

    this.syncingFromWebview = true;
    try {
      const applied = await replaceWholeDocument(this.currentDocument, cleaned);
      if (!applied) {
        void vscode.window.showErrorMessage("保存失败：无法写入 SVG 文件。");
        return false;
      }
      await ensureVisible(this.currentDocument);
    } finally {
      this.syncingFromWebview = false;
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
      return this.saveDraft(false);
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
        await this.saveDraft(false);
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
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${csp}"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><style>
*{box-sizing:border-box}html,body{height:100%;margin:0;padding:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:"Segoe UI","PingFang SC",sans-serif}
.root{height:100%;display:flex;flex-direction:column}.toolbar{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 10px;border-bottom:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 15%,transparent)}
.group{display:flex;gap:6px;align-items:center;flex-wrap:wrap}button{border:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 15%,transparent);background:color-mix(in srgb,var(--vscode-editor-background) 86%,#0b1220);color:inherit;border-radius:7px;padding:5px 9px;font-size:12px;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}.meta,.status{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;font-size:12px;color:color-mix(in srgb,var(--vscode-editor-foreground) 50%,var(--vscode-editor-background));border-bottom:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 12%,transparent)}
.status{border-top:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 12%,transparent);border-bottom:0}.dirty{color:#f59e0b;font-weight:600}.saved{color:#22c55e;font-weight:600}
#previewHost{position:relative;flex:1;overflow:auto;padding:12px;background-image:linear-gradient(45deg,rgba(127,127,127,.1) 25%,transparent 25%),linear-gradient(-45deg,rgba(127,127,127,.1) 25%,transparent 25%),linear-gradient(45deg,transparent 75%,rgba(127,127,127,.1) 75%),linear-gradient(-45deg,transparent 75%,rgba(127,127,127,.1) 75%);background-size:20px 20px;background-position:0 0,0 10px,10px -10px,-10px 0}
#previewHost svg{display:block;margin:0 auto;max-width:100%;height:auto;border-radius:6px;box-shadow:0 8px 20px rgba(0,0,0,.25)}
#previewHost [data-aii-id]{cursor:pointer}#previewHost [data-aii-id][data-aii-selected="1"]{filter:drop-shadow(0 0 1px #fff) drop-shadow(0 0 3px #0ea5e9);cursor:grab}#previewHost.dragging [data-aii-id][data-aii-selected="1"]{cursor:grabbing}
.error{min-height:20px;padding:2px 10px 8px;color:#fca5a5;font-size:12px}.ctx{position:fixed;z-index:20;display:none;min-width:120px;border:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 15%,transparent);border-radius:8px;overflow:hidden;background:color-mix(in srgb,var(--vscode-editor-background) 90%,#0b1220)}
.ctx button{width:100%;border:0;border-bottom:1px solid color-mix(in srgb,var(--vscode-editor-foreground) 15%,transparent);border-radius:0;text-align:left;background:transparent;padding:8px 10px}.ctx button:last-child{border-bottom:0}
</style></head><body><div class="root"><div class="toolbar"><div class="group"><button data-op="format">格式化</button><button data-op="cleanup">清理字符</button><button data-op="compress">压缩</button><button data-op="exportPng">导出 PNG</button><button data-op="exportPngVariants">导出多倍率</button><button data-op="insertSnippet">插入片段</button><button id="rotateLeft" disabled>左转 15°</button><button id="rotateRight" disabled>右转 15°</button><button id="deleteElement" disabled>删除元素</button></div><div class="group"><button id="saveButton" disabled>保存</button></div></div><div class="meta"><div id="fileName">-</div><div id="selectionInfo">未选中元素</div></div><div id="previewHost"></div><div class="status"><span id="dirtyState" class="saved">已保存</span><span>右键已选元素：修改颜色 / 提取颜色</span></div><div class="error" id="error"></div></div><div class="ctx" id="contextMenu"><button id="menuEditColor">修改颜色</button><button id="menuExtractColor">提取颜色</button></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();const previewHost=document.getElementById("previewHost");const errorNode=document.getElementById("error");const fileNameNode=document.getElementById("fileName");const selectionInfoNode=document.getElementById("selectionInfo");const saveButton=document.getElementById("saveButton");const dirtyStateNode=document.getElementById("dirtyState");const rotateLeftButton=document.getElementById("rotateLeft");const rotateRightButton=document.getElementById("rotateRight");const deleteButton=document.getElementById("deleteElement");const contextMenu=document.getElementById("contextMenu");const menuEditColor=document.getElementById("menuEditColor");const menuExtractColor=document.getElementById("menuExtractColor");const COLOR_ATTRS=["fill","stroke","stop-color","flood-color","lighting-color","color"];
const state={rawSvgText:"",svgRoot:undefined,selectedId:undefined,xmlDeclaration:"",drag:undefined,dragging:false};
function setError(m){errorNode.textContent=m||""}function setDirty(d){saveButton.disabled=!d;dirtyStateNode.textContent=d?"未保存":"已保存";dirtyStateNode.className=d?"dirty":"saved"}function hideCtx(){contextMenu.style.display="none"}function showCtx(x,y){contextMenu.style.left=x+"px";contextMenu.style.top=y+"px";contextMenu.style.display="block"}
function parseXmlHeader(t){const m=t.match(/^\\s*(<\\?xml[\\s\\S]*?\\?>)/i);return m?m[1]:""}function parseSvg(t){const p=new DOMParser();const d=p.parseFromString(t,"image/svg+xml");const e=d.querySelector("parsererror");if(e)throw new Error(e.textContent||"SVG parse error");const r=d.documentElement;if(!r||r.tagName.toLowerCase()!=="svg")throw new Error("当前内容不是有效 SVG");return r}
function tagElements(root){let id=0;function walk(el,parent){Array.from(el.children).forEach((c,i)=>{const np=parent.concat(i);c.setAttribute("data-aii-id",String(++id));c.setAttribute("data-aii-path",np.join("."));walk(c,np);});}walk(root,[]);}
function selectedElement(){if(!state.svgRoot||!state.selectedId)return undefined;return state.svgRoot.querySelector('[data-aii-id="'+state.selectedId+'"]')}
function readNodePath(el){const raw=el.getAttribute("data-aii-path");return raw?raw.split(".").filter(Boolean).map((n)=>Number(n)):[]}function readAttrs(el){const a={};for(const at of el.attributes){if(!at.name.startsWith("data-aii-"))a[at.name]=at.value;}return a;}
function updateSelection(){const t=selectedElement();const ok=Boolean(t);rotateLeftButton.disabled=!ok;rotateRightButton.disabled=!ok;deleteButton.disabled=!ok;selectionInfoNode.textContent=ok?"已选中: <"+t.tagName+">":"未选中元素";}
function postSelection(){const t=selectedElement();if(!t){vscode.postMessage({type:"selectionCleared"});return;}vscode.postMessage({type:"selectionChanged",nodePath:readNodePath(t),tagName:t.tagName,attributes:readAttrs(t)});}
function clearSelection(){if(!state.svgRoot){state.selectedId=undefined;updateSelection();postSelection();return;}const s=state.svgRoot.querySelector('[data-aii-selected="1"]');if(s)s.removeAttribute("data-aii-selected");state.selectedId=undefined;updateSelection();postSelection();}
function selectElement(el){if(!state.svgRoot||!el){clearSelection();return;}const id=el.getAttribute("data-aii-id");if(!id){clearSelection();return;}clearSelection();state.selectedId=id;el.setAttribute("data-aii-selected","1");updateSelection();postSelection();}
function markDraft(){if(!state.svgRoot)return;const body=new XMLSerializer().serializeToString(state.svgRoot);const next=state.xmlDeclaration?state.xmlDeclaration+"\\n"+body:body;state.rawSvgText=next;setDirty(true);postSelection();vscode.postMessage({type:"draftChanged",text:next});}
function toSvgPoint(svg,x,y){const p=svg.createSVGPoint();p.x=x;p.y=y;const ctm=svg.getScreenCTM();if(!ctm)return{x:0,y:0};const t=p.matrixTransform(ctm.inverse());return{x:t.x,y:t.y};}
function startDrag(e,target){if(e.button!==0||!state.svgRoot||!target)return;const from=toSvgPoint(state.svgRoot,e.clientX,e.clientY);state.drag={pointerId:e.pointerId,originX:from.x,originY:from.y,originalTransform:target.getAttribute("transform")||""};state.dragging=true;previewHost.classList.add("dragging");target.setPointerCapture(e.pointerId);e.preventDefault();}
function moveDrag(e){if(!state.dragging||!state.drag||!state.svgRoot)return;const t=selectedElement();if(!t)return;const now=toSvgPoint(state.svgRoot,e.clientX,e.clientY);const dx=now.x-state.drag.originX;const dy=now.y-state.drag.originY;t.setAttribute("transform",(state.drag.originalTransform+" translate("+dx.toFixed(2)+" "+dy.toFixed(2)+")").trim());e.preventDefault();}
function endDrag(e){if(!state.dragging)return;state.dragging=false;previewHost.classList.remove("dragging");if(state.drag&&e.pointerId===state.drag.pointerId)markDraft();state.drag=undefined;}
function rotateSelected(delta){const t=selectedElement();if(!t)return;let b;try{b=t.getBBox();}catch(_){return;}const cx=(b.x+b.width/2).toFixed(2);const cy=(b.y+b.height/2).toFixed(2);const ex=t.getAttribute("transform")||"";t.setAttribute("transform",(ex+" rotate("+delta+" "+cx+" "+cy+")").trim());markDraft();}
function deleteSelected(){const t=selectedElement();if(!t)return;t.remove();clearSelection();markDraft();}
function collectColors(el){const colors=[];for(const a of COLOR_ATTRS){const v=el.getAttribute(a);if(v&&!/^none$/i.test(v)&&!/^url\\(/i.test(v))colors.push(v.trim());}const style=el.getAttribute("style");if(style){const rx=/(fill|stroke|stop-color|flood-color|lighting-color|color)\\s*:\\s*([^;]+)/gi;for(const m of style.matchAll(rx)){const v=(m[2]||"").trim();if(v&&!/^none$/i.test(v)&&!/^url\\(/i.test(v))colors.push(v);}}return Array.from(new Set(colors));}
function replaceStyleColors(style,nextColor){return style.replace(/(fill|stroke|stop-color|flood-color|lighting-color|color)\\s*:\\s*([^;]+)/gi,(_f,p)=>p+": "+nextColor);}
function editSelectedColor(){const t=selectedElement();if(!t)return;const cs=collectColors(t);const next=window.prompt("输入目标颜色（如 #22c55e）",cs[0]||"#22c55e");if(!next){hideCtx();return;}let changed=false;for(const a of COLOR_ATTRS){if(t.hasAttribute(a)){t.setAttribute(a,next.trim());changed=true;}}const style=t.getAttribute("style");if(style){t.setAttribute("style",replaceStyleColors(style,next.trim()));changed=true;}if(!changed)t.setAttribute("fill",next.trim());hideCtx();markDraft();}
function extractSelectedColor(){const t=selectedElement();if(!t)return;const cs=collectColors(t);if(!cs.length){setError("当前元素没有可提取颜色。");hideCtx();return;}hideCtx();vscode.postMessage({type:"copyToClipboard",text:cs[0]});}
function renderSvg(svgText){if(!svgText.trim()){previewHost.innerHTML="";clearSelection();setError("");return;}try{const root=parseSvg(svgText);tagElements(root);state.svgRoot=root;previewHost.innerHTML="";previewHost.appendChild(root);setError("");root.addEventListener("click",(e)=>{hideCtx();const t=e.target instanceof Element?e.target.closest("[data-aii-id]"):null;if(!t){clearSelection();return;}selectElement(t);});root.addEventListener("contextmenu",(e)=>{const t=e.target instanceof Element?e.target.closest("[data-aii-id]"):null;if(!t){clearSelection();hideCtx();return;}e.preventDefault();selectElement(t);showCtx(e.clientX,e.clientY);});root.addEventListener("pointerdown",(e)=>{const t=e.target instanceof Element?e.target.closest("[data-aii-id]"):null;if(!t)return;selectElement(t);startDrag(e,t);});root.addEventListener("pointermove",moveDrag);root.addEventListener("pointerup",endDrag);root.addEventListener("pointercancel",endDrag);}catch(err){setError("SVG 解析失败: "+(err instanceof Error?err.message:String(err)));}}
for(const b of document.querySelectorAll("[data-op]")){b.addEventListener("click",()=>{vscode.postMessage({type:"requestOperation",operation:b.getAttribute("data-op")});});}
rotateLeftButton.addEventListener("click",()=>rotateSelected(-15));rotateRightButton.addEventListener("click",()=>rotateSelected(15));deleteButton.addEventListener("click",deleteSelected);saveButton.addEventListener("click",()=>vscode.postMessage({type:"requestSave"}));menuEditColor.addEventListener("click",editSelectedColor);menuExtractColor.addEventListener("click",extractSelectedColor);
window.addEventListener("click",()=>hideCtx());window.addEventListener("keydown",(e)=>{if(!state.selectedId)return;const step=e.shiftKey?10:1;const t=selectedElement();if(!t)return;const ex=t.getAttribute("transform")||"";if(e.key==="ArrowUp"){t.setAttribute("transform",(ex+" translate(0 "+(-step)+")").trim());markDraft();e.preventDefault();}else if(e.key==="ArrowDown"){t.setAttribute("transform",(ex+" translate(0 "+step+")").trim());markDraft();e.preventDefault();}else if(e.key==="ArrowLeft"){t.setAttribute("transform",(ex+" translate("+(-step)+" 0)").trim());markDraft();e.preventDefault();}else if(e.key==="ArrowRight"){t.setAttribute("transform",(ex+" translate("+step+" 0)").trim());markDraft();e.preventDefault();}else if(e.key==="Delete"||e.key==="Backspace"){deleteSelected();e.preventDefault();}});
window.addEventListener("message",(event)=>{const m=event.data;if(m.type==="document"){fileNameNode.textContent=m.fileName||"-";state.xmlDeclaration=parseXmlHeader(m.text||"");state.rawSvgText=m.text||"";hideCtx();clearSelection();renderSvg(state.rawSvgText);}else if(m.type==="dirtyState"){setDirty(Boolean(m.dirty));}else if(m.type==="saved"){state.rawSvgText=m.text||state.rawSvgText;setDirty(false);renderSvg(state.rawSvgText);}});
setDirty(false);updateSelection();vscode.postMessage({type:"ready"});
</script></body></html>`;
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
