import * as path from "path";
import * as vscode from "vscode";
import {
  cleanupSvgContent,
  compressSvgContent,
  extractColorPalette,
  formatSvgContent,
  inferSvgBaseWidth,
  quickRecolorSvg,
  renderSvgToPng
} from "./svg/svgToolkit";
import { ensureVisible, replaceWholeDocument, resolveSvgDocument } from "./svg/documentHelpers";

export type SvgTextOperation = "format" | "cleanup" | "compress";

interface TransformOptions {
  revealDocument?: boolean;
  showMessage?: boolean;
}

const OPERATION_LABELS: Record<SvgTextOperation, string> = {
  format: "格式化",
  cleanup: "清理无用字符",
  compress: "压缩"
};

function transformByOperation(svg: string, operation: SvgTextOperation): string {
  if (operation === "format") {
    return formatSvgContent(svg);
  }
  if (operation === "cleanup") {
    return cleanupSvgContent(svg);
  }
  return compressSvgContent(svg);
}

async function applySvgTransform(
  document: vscode.TextDocument,
  transformer: (svg: string) => string,
  successMessage: string,
  options?: TransformOptions
): Promise<boolean> {
  const source = document.getText();
  const next = transformer(source);

  if (next === source) {
    if (options?.showMessage !== false) {
      vscode.window.showInformationMessage("SVG 内容没有变化。");
    }
    return false;
  }

  const applied = await replaceWholeDocument(document, next);
  if (!applied) {
    vscode.window.showErrorMessage("写入 SVG 内容失败。");
    return false;
  }

  if (options?.revealDocument !== false) {
    await ensureVisible(document);
  }

  if (options?.showMessage !== false) {
    vscode.window.showInformationMessage(successMessage);
  }
  return true;
}

async function getSvgDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  return resolveSvgDocument(uri);
}

function validateColorInput(color: string): string | undefined {
  const value = color.trim();
  if (!value) {
    return "颜色不能为空";
  }

  const patterns = [
    /^#[0-9a-fA-F]{3,8}$/,
    /^rgba?\(\s*[^)]+\)$/,
    /^hsla?\(\s*[^)]+\)$/,
    /^[a-zA-Z]+$/
  ];
  return patterns.some((pattern) => pattern.test(value))
    ? undefined
    : "请输入有效颜色（例如 #0ea5e9 / rgb(14,165,233) / red）";
}

function parseScales(input: string): number[] | undefined {
  const values = input
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (!values.length) {
    return undefined;
  }
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

async function readBaseWidth(svg: string): Promise<number | undefined> {
  const inferred = inferSvgBaseWidth(svg);
  if (inferred && inferred > 0) {
    return inferred;
  }

  const entered = await vscode.window.showInputBox({
    title: "输入基础宽度（像素）",
    prompt: "用于多倍率 PNG 导出；如无 width/viewBox 请手动输入",
    value: "512",
    validateInput: (value) => {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? undefined : "请输入大于 0 的数字";
    }
  });

  if (!entered) {
    return undefined;
  }
  return Number(entered.trim());
}

function suggestPngUri(document: vscode.TextDocument): vscode.Uri | undefined {
  if (document.uri.scheme !== "file") {
    return undefined;
  }
  const parsed = path.parse(document.uri.fsPath);
  return vscode.Uri.file(path.join(parsed.dir, `${parsed.name}.png`));
}

async function chooseOutputDirectory(
  document: vscode.TextDocument
): Promise<vscode.Uri | undefined> {
  if (document.uri.scheme === "file") {
    return vscode.Uri.file(path.parse(document.uri.fsPath).dir);
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "选择导出目录"
  });
  return picked?.[0];
}

export async function runTextOperation(
  operation: SvgTextOperation,
  uri?: vscode.Uri,
  options?: TransformOptions
): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  return applySvgTransform(
    document,
    (svg) => transformByOperation(svg, operation),
    `SVG ${OPERATION_LABELS[operation]}完成。`,
    options
  );
}

export async function runQuickRecolor(
  uri?: vscode.Uri,
  options?: TransformOptions
): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const source = document.getText();
  const palette = extractColorPalette(source);
  const fromPick = await vscode.window.showQuickPick(
    [
      { label: "全部颜色", description: "替换 fill/stroke 等所有可识别颜色", picked: true },
      ...palette.map((color) => ({ label: color }))
    ],
    {
      title: "选择要替换的颜色",
      placeHolder: "默认替换全部颜色"
    }
  );
  if (!fromPick) {
    return false;
  }

  const toColor = await vscode.window.showInputBox({
    title: "目标颜色",
    prompt: "输入目标颜色（如 #22c55e）",
    value: "#22c55e",
    validateInput: validateColorInput
  });
  if (!toColor) {
    return false;
  }

  const fromColor = fromPick.label === "全部颜色" ? undefined : fromPick.label;
  return applySvgTransform(
    document,
    (svg) => quickRecolorSvg(svg, toColor.trim(), fromColor),
    fromColor
      ? `已将颜色 ${fromColor} 替换为 ${toColor.trim()}。`
      : `已将全部可识别颜色替换为 ${toColor.trim()}。`,
    options
  );
}

export async function runExportPng(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const widthInput = await vscode.window.showInputBox({
    title: "PNG 宽度（可选）",
    prompt: "留空则使用 SVG 原始尺寸",
    validateInput: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      const numeric = Number(value.trim());
      return Number.isFinite(numeric) && numeric > 0 ? undefined : "请输入大于 0 的数字";
    }
  });
  if (widthInput === undefined) {
    return false;
  }

  const targetUri = await vscode.window.showSaveDialog({
    saveLabel: "导出 PNG",
    filters: { PNG: ["png"] },
    defaultUri: suggestPngUri(document)
  });
  if (!targetUri) {
    return false;
  }

  const width = widthInput.trim() ? Number(widthInput.trim()) : undefined;
  const png = renderSvgToPng(document.getText(), width);
  await vscode.workspace.fs.writeFile(targetUri, png);
  vscode.window.showInformationMessage(`PNG 已导出：${targetUri.fsPath}`);
  return true;
}

export async function runExportPngVariants(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const scalesInput = await vscode.window.showInputBox({
    title: "导出倍率",
    prompt: "输入倍率列表，逗号分隔（例如 1,2,3）",
    value: "1,2,3",
    validateInput: (value) => (parseScales(value) ? undefined : "请输入有效数字列表，如 1,2,3")
  });
  if (!scalesInput) {
    return false;
  }

  const scales = parseScales(scalesInput);
  if (!scales) {
    vscode.window.showErrorMessage("倍率解析失败。");
    return false;
  }

  const outputDir = await chooseOutputDirectory(document);
  if (!outputDir) {
    return false;
  }

  const sourceSvg = document.getText();
  const baseWidth = await readBaseWidth(sourceSvg);
  if (!baseWidth) {
    return false;
  }

  const sourcePath = document.uri.scheme === "file" ? document.uri.fsPath : document.uri.path;
  const baseName = path.parse(sourcePath).name || "image";

  const outputs: string[] = [];
  for (const scale of scales) {
    const width = Math.round(baseWidth * scale);
    const png = renderSvgToPng(sourceSvg, width);
    const suffix = scale === 1 ? "" : `@${scale}x`;
    const fileName = `${baseName}${suffix}.png`;
    const target = vscode.Uri.joinPath(outputDir, fileName);
    await vscode.workspace.fs.writeFile(target, png);
    outputs.push(fileName);
  }

  vscode.window.showInformationMessage(`已导出 ${outputs.length} 个 PNG：${outputs.join(", ")}`);
  return true;
}

export async function runExtractPalette(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const colors = extractColorPalette(document.getText());
  if (!colors.length) {
    vscode.window.showWarningMessage("未识别到可提取颜色。");
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    colors.map((color) => ({ label: color, description: "点击复制颜色值" })),
    {
      title: "SVG 调色板",
      placeHolder: "选择一个颜色复制到剪贴板"
    }
  );
  if (!picked) {
    return false;
  }

  await vscode.env.clipboard.writeText(picked.label);
  vscode.window.showInformationMessage(`已复制颜色：${picked.label}`);
  return true;
}


