import * as vscode from "vscode";
import {
  runExportPng,
  runExportPngVariants,
  runExtractPalette,
  runInsertSnippet,
  runQuickRecolor,
  runTextOperation
} from "./commands";
import { SvgAttributeSidebarProvider } from "./panel/SvgAttributeSidebarProvider";
import { SvgAllInOnePanel } from "./panel/SvgAllInOnePanel";
import { registerSvgDiagnostics } from "./providers/svgDiagnosticsProvider";
import { registerSvgCompletionProvider } from "./providers/svgCompletionProvider";

function asUri(input: unknown): vscode.Uri | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof vscode.Uri) {
    return input;
  }
  if (Array.isArray(input) && input[0] instanceof vscode.Uri) {
    return input[0];
  }
  return undefined;
}

function asAttributeName(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "attributeName" in input) {
    const value = (input as { attributeName?: unknown }).attributeName;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const attributeSidebar = new SvgAttributeSidebarProvider();

  context.subscriptions.push(registerSvgCompletionProvider());
  context.subscriptions.push(registerSvgDiagnostics(context));
  context.subscriptions.push(
    attributeSidebar,
    vscode.window.registerTreeDataProvider("svgAllInOne.attributePanel", attributeSidebar)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("svgAllInOne.openPanel", async (arg?: unknown) => {
      await SvgAllInOnePanel.createOrShow(context, attributeSidebar, asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.formatSvg", async (arg?: unknown) => {
      await runTextOperation("format", asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.cleanupSvg", async (arg?: unknown) => {
      await runTextOperation("cleanup", asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.compressSvg", async (arg?: unknown) => {
      await runTextOperation("compress", asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.quickRecolor", async (arg?: unknown) => {
      await runQuickRecolor(asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.exportPng", async (arg?: unknown) => {
      await runExportPng(asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.exportPngVariants", async (arg?: unknown) => {
      await runExportPngVariants(asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.extractPalette", async (arg?: unknown) => {
      await runExtractPalette(asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.insertSnippet", async (arg?: unknown) => {
      await runInsertSnippet(asUri(arg));
    }),
    vscode.commands.registerCommand("svgAllInOne.editAttribute", async (attributeName?: string) => {
      await attributeSidebar.editAttribute(asAttributeName(attributeName));
    }),
    vscode.commands.registerCommand("svgAllInOne.addAttribute", async () => {
      await attributeSidebar.addAttribute();
    }),
    vscode.commands.registerCommand("svgAllInOne.removeAttribute", async (attributeName?: string) => {
      await attributeSidebar.removeAttribute(asAttributeName(attributeName));
    })
  );
}

export function deactivate(): void {
  // Nothing to dispose manually.
}

