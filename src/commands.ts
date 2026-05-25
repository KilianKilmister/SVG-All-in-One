import * as path from "path";
import * as l10n from '@vscode/l10n';
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
  format: l10n.t("Format"),
  cleanup: l10n.t("Cleanup"),
  compress: l10n.t("Compress")
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
      vscode.window.showInformationMessage(l10n.t("SVG remains unchanged"));
    }
    return false;
  }

  const applied = await replaceWholeDocument(document, next);
  if (!applied) {
    vscode.window.showErrorMessage(l10n.t("Failed to write SVG"));
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
    return l10n.t("Color may not be empty");
  }

  const patterns = [
    /^#[0-9a-fA-F]{3,8}$/,
    /^rgba?\(\s*[^)]+\)$/,
    /^hsla?\(\s*[^)]+\)$/,
    /^[a-zA-Z]+$/
  ];
  return patterns.some((pattern) => pattern.test(value))
    ? undefined
    : l10n.t("Please enter a valid CSS color.");
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
    title: l10n.t("Enter base width"),
    prompt: l10n.t("Used for exporting PNGs at multiple scales"),
    value: "512",
    validateInput: (value) => {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) && parsed > 0 ? undefined : l10n.t("Please enter a number greater than 0");
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
    openLabel: l10n.t("Select export directory")
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
    l10n.t("SVG {0} complete", OPERATION_LABELS[operation]),
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
      { label: l10n.t("All colors"), description: l10n.t("Replace all recognizable colors such as fill/stroke"), picked: true },
      ...palette.map((color) => ({ label: color }))
    ],
    {
      title: l10n.t("Select the color to replace"),
      placeHolder: l10n.t("Replace all colors by default")
    }
  );
  if (!fromPick) {
    return false;
  }

  const toColor = await vscode.window.showInputBox({
    title: l10n.t("Target color"),
    prompt: l10n.t("Enter the target color"),
    value: "#22c55e",
    validateInput: validateColorInput
  });
  if (!toColor) {
    return false;
  }

  const fromColor = fromPick.label === l10n.t("All colors") ? undefined : fromPick.label;
  return applySvgTransform(
    document,
    (svg) => quickRecolorSvg(svg, toColor.trim(), fromColor),
    fromColor
      ? l10n.t("The color {0} has been replaced with {1}", fromColor, toColor.trim())
      : l10n.t("All recognizable colors have been replaced with {0}", toColor.trim()),
    options
  );
}

export async function runExportPng(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const widthInput = await vscode.window.showInputBox({
    title: l10n.t("PNG width (optional)"),
    prompt: l10n.t("If left blank the original SVG size is used"),
    validateInput: (value) => {
      if (!value.trim()) {
        return undefined;
      }
      const numeric = Number(value.trim());
      return Number.isFinite(numeric) && numeric > 0 ? undefined : l10n.t("Please enter a number greater than 0");
    }
  });
  if (widthInput === undefined) {
    return false;
  }

  const targetUri = await vscode.window.showSaveDialog({
    saveLabel: l10n.t("Export PNG"),
    filters: { PNG: ["png"] },
    defaultUri: suggestPngUri(document)
  });
  if (!targetUri) {
    return false;
  }

  const width = widthInput.trim() ? Number(widthInput.trim()) : undefined;
  const png = renderSvgToPng(document.getText(), width);
  await vscode.workspace.fs.writeFile(targetUri, png);
  vscode.window.showInformationMessage(l10n.t("PNGs exported: {0}", targetUri.fsPath));
  return true;
}

export async function runExportPngVariants(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const scalesInput = await vscode.window.showInputBox({
    title: l10n.t("Export magnification"),
    prompt: l10n.t("Enter a list of multipliers, separated by commas"),
    value: "1,2,3",
    validateInput: (value) => (parseScales(value) ? undefined : l10n.t("Please enter a list of valid numbers, such as 1,2,3"))
  });
  if (!scalesInput) {
    return false;
  }

  const scales = parseScales(scalesInput);
  if (!scales) {
    vscode.window.showErrorMessage(l10n.t("Ratio analysis failed"));
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

  vscode.window.showInformationMessage(l10n.t("{0} PNGs exported: {1}", outputs.length, outputs.join(", ")));
  return true;
}

export async function runExtractPalette(uri?: vscode.Uri): Promise<boolean> {
  const document = await getSvgDocument(uri);
  if (!document) {
    return false;
  }

  const colors = extractColorPalette(document.getText());
  if (!colors.length) {
    vscode.window.showWarningMessage(l10n.t("No extractable color was detected"));
    return false;
  }

  const picked = await vscode.window.showQuickPick(
    colors.map((color) => ({ label: color, description: l10n.t("Click to copy the color value") })),
    {
      title: l10n.t("SVG color palette"),
      placeHolder: l10n.t("Select a color and copy it to the clipboard")
    }
  );
  if (!picked) {
    return false;
  }

  await vscode.env.clipboard.writeText(picked.label);
  vscode.window.showInformationMessage(l10n.t("Color copied: {0}", picked.label));
  return true;
}
