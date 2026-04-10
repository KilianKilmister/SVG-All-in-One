import * as vscode from "vscode";
import { ensureVisible, replaceWholeDocument } from "../svg/documentHelpers";
import { readNodeByPath, type SvgNodePath, type SvgNodeSnapshot, updateNodeByPath } from "../svg/svgDom";

interface SelectionState extends SvgNodeSnapshot {
  documentUri: vscode.Uri;
}

class AttributeItem extends vscode.TreeItem {
  public readonly contextValue = "svgAttribute";
  public readonly attributeName: string;

  constructor(attributeName: string, attributeValue: string) {
    super(attributeName, vscode.TreeItemCollapsibleState.None);
    this.attributeName = attributeName;
    this.description = attributeValue;
    this.tooltip = `${attributeName}="${attributeValue}"`;
    this.command = {
      command: "svgAllInOne.editAttribute",
      title: "Edit SVG Attribute",
      arguments: [attributeName]
    };
  }
}

class InfoItem extends vscode.TreeItem {
  public readonly contextValue = "svgInfo";

  constructor(label: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
  }
}

type SidebarItem = AttributeItem | InfoItem;

export class SvgAttributeSidebarProvider
  implements vscode.TreeDataProvider<SidebarItem>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<SidebarItem | undefined | null | void>();
  private state: SelectionState | undefined;

  public readonly onDidChangeTreeData = this.emitter.event;

  public dispose(): void {
    this.emitter.dispose();
  }

  public setSelection(
    document: vscode.TextDocument,
    nodePath: SvgNodePath,
    tagName: string,
    attributes: Record<string, string>
  ): void {
    this.state = {
      documentUri: document.uri,
      nodePath: [...nodePath],
      tagName,
      attributes: { ...attributes }
    };
    this.refresh();
  }

  public clearSelection(): void {
    this.state = undefined;
    this.refresh();
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: SidebarItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SidebarItem): vscode.ProviderResult<SidebarItem[]> {
    if (element) {
      return [];
    }
    if (!this.state) {
      return [new InfoItem("No selected SVG node", "Select a node in the preview panel")];
    }

    const items: SidebarItem[] = [];
    items.push(new InfoItem(`<${this.state.tagName}>`, "Selected node"));

    const entries = Object.entries(this.state.attributes).sort(([a], [b]) => a.localeCompare(b));
    if (!entries.length) {
      items.push(new InfoItem("No attributes", "Use + to add one"));
      return items;
    }

    for (const [name, value] of entries) {
      items.push(new AttributeItem(name, value));
    }
    return items;
  }

  public async editAttribute(attributeName?: string): Promise<void> {
    if (!this.state) {
      vscode.window.showInformationMessage("Select an SVG node in preview first.");
      return;
    }

    let targetAttribute = attributeName;
    if (!targetAttribute) {
      const picked = await vscode.window.showQuickPick(Object.keys(this.state.attributes), {
        title: "Select attribute to edit"
      });
      if (!picked) {
        return;
      }
      targetAttribute = picked;
    }

    const initialValue = this.state.attributes[targetAttribute] ?? "";
    const nextValue = await vscode.window.showInputBox({
      title: `Edit attribute: ${targetAttribute}`,
      value: initialValue,
      prompt: "Input new attribute value",
      ignoreFocusOut: true
    });

    if (nextValue === undefined) {
      return;
    }

    await this.applyNodeMutation((element) => {
      element.setAttribute(targetAttribute!, nextValue);
    });
  }

  public async addAttribute(): Promise<void> {
    if (!this.state) {
      vscode.window.showInformationMessage("Select an SVG node in preview first.");
      return;
    }

    const name = await vscode.window.showInputBox({
      title: "Add SVG attribute",
      prompt: "Attribute name (e.g. stroke-width)",
      validateInput: (value) =>
        /^[A-Za-z_][\w:.-]*$/.test(value.trim())
          ? undefined
          : "Use a valid XML attribute name",
      ignoreFocusOut: true
    });
    if (!name) {
      return;
    }

    const value = await vscode.window.showInputBox({
      title: `Value for ${name.trim()}`,
      prompt: "Attribute value",
      ignoreFocusOut: true
    });
    if (value === undefined) {
      return;
    }

    await this.applyNodeMutation((element) => {
      element.setAttribute(name.trim(), value);
    });
  }

  public async removeAttribute(attributeName?: string): Promise<void> {
    if (!this.state) {
      vscode.window.showInformationMessage("Select an SVG node in preview first.");
      return;
    }

    let targetAttribute = attributeName;
    if (!targetAttribute) {
      const names = Object.keys(this.state.attributes);
      if (!names.length) {
        vscode.window.showInformationMessage("Current node has no attribute to remove.");
        return;
      }
      const picked = await vscode.window.showQuickPick(names, {
        title: "Select attribute to remove"
      });
      if (!picked) {
        return;
      }
      targetAttribute = picked;
    }

    const confirm = await vscode.window.showQuickPick(
      ["Remove", "Cancel"],
      { title: `Remove attribute "${targetAttribute}"?` }
    );
    if (confirm !== "Remove") {
      return;
    }

    await this.applyNodeMutation((element) => {
      element.removeAttribute(targetAttribute!);
    });
  }

  private async applyNodeMutation(mutator: (element: Element) => void): Promise<void> {
    if (!this.state) {
      return;
    }

    const document = await vscode.workspace.openTextDocument(this.state.documentUri);
    const updated = updateNodeByPath(document.getText(), this.state.nodePath, mutator);
    if (!updated) {
      vscode.window.showErrorMessage(
        "Cannot update selected node. Please reselect the node from preview."
      );
      return;
    }

    const applied = await replaceWholeDocument(document, updated.svgText);
    if (!applied) {
      vscode.window.showErrorMessage("Failed to write SVG document.");
      return;
    }

    await ensureVisible(document);
    this.state = {
      documentUri: this.state.documentUri,
      ...updated.snapshot
    };
    this.refresh();
  }

  public tryRefreshSelectionFromDocument(document: vscode.TextDocument): void {
    if (!this.state || document.uri.toString() !== this.state.documentUri.toString()) {
      return;
    }
    const snapshot = readNodeByPath(document.getText(), this.state.nodePath);
    if (!snapshot) {
      this.clearSelection();
      return;
    }
    this.state = {
      documentUri: document.uri,
      ...snapshot
    };
    this.refresh();
  }
}
