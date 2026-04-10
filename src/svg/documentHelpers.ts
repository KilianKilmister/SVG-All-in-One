import * as path from "path";
import * as vscode from "vscode";

export function isSvgDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "svg" || path.extname(document.uri.fsPath).toLowerCase() === ".svg";
}

export async function resolveSvgDocument(
  candidateUri?: vscode.Uri
): Promise<vscode.TextDocument | undefined> {
  if (candidateUri) {
    const document = await vscode.workspace.openTextDocument(candidateUri);
    if (isSvgDocument(document)) {
      return document;
    }
  }

  const active = vscode.window.activeTextEditor?.document;
  if (active && isSvgDocument(active)) {
    return active;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFiles: true,
    canSelectFolders: false,
    openLabel: "Select SVG File",
    filters: {
      SVG: ["svg"]
    }
  });

  if (!picked?.[0]) {
    return undefined;
  }

  return vscode.workspace.openTextDocument(picked[0]);
}

export async function replaceWholeDocument(
  document: vscode.TextDocument,
  content: string
): Promise<boolean> {
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, content);
  return vscode.workspace.applyEdit(edit);
}

export async function ensureVisible(document: vscode.TextDocument): Promise<void> {
  await vscode.window.showTextDocument(document, { preview: false });
}
