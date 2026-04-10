import * as vscode from "vscode";
import { buildSvgDiagnostics } from "../svg/svgDiagnostics";

export function registerSvgDiagnostics(context: vscode.ExtensionContext): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection("svg-all-in-one");

  const update = (document: vscode.TextDocument): void => {
    if (document.languageId !== "svg") {
      return;
    }
    collection.set(document.uri, buildSvgDiagnostics(document));
  };

  const clear = (document: vscode.TextDocument): void => {
    collection.delete(document.uri);
  };

  for (const document of vscode.workspace.textDocuments) {
    update(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument((event) => update(event.document)),
    vscode.workspace.onDidCloseTextDocument(clear)
  );

  return collection;
}
