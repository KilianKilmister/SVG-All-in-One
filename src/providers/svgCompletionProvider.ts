import * as vscode from "vscode";

interface ElementCompletion {
  name: string;
  detail: string;
  snippet: string;
}

const ELEMENTS: ElementCompletion[] = [
  { name: "svg", detail: "SVG root", snippet: "svg width=\"${1:256}\" height=\"${2:256}\" viewBox=\"0 0 ${1} ${2}\">\n  $0\n</svg>" },
  { name: "g", detail: "Group", snippet: "g>\n  $0\n</g>" },
  { name: "path", detail: "Path", snippet: "path d=\"${1:M10 10H90V90H10Z}\" fill=\"${2:#0ea5e9}\" />" },
  { name: "rect", detail: "Rectangle", snippet: "rect x=\"${1:10}\" y=\"${2:10}\" width=\"${3:80}\" height=\"${4:60}\" fill=\"${5:#22c55e}\" />" },
  { name: "circle", detail: "Circle", snippet: "circle cx=\"${1:50}\" cy=\"${2:50}\" r=\"${3:30}\" fill=\"${4:#f43f5e}\" />" },
  { name: "ellipse", detail: "Ellipse", snippet: "ellipse cx=\"${1:50}\" cy=\"${2:50}\" rx=\"${3:30}\" ry=\"${4:20}\" fill=\"${5:#f59e0b}\" />" },
  { name: "line", detail: "Line", snippet: "line x1=\"${1:0}\" y1=\"${2:0}\" x2=\"${3:100}\" y2=\"${4:100}\" stroke=\"${5:#334155}\" stroke-width=\"${6:2}\" />" },
  { name: "polyline", detail: "Polyline", snippet: "polyline points=\"${1:10,10 50,30 90,10}\" fill=\"none\" stroke=\"${2:#0f172a}\" />" },
  { name: "polygon", detail: "Polygon", snippet: "polygon points=\"${1:50,10 90,90 10,90}\" fill=\"${2:#8b5cf6}\" />" },
  { name: "text", detail: "Text", snippet: "text x=\"${1:24}\" y=\"${2:48}\" font-size=\"${3:24}\" fill=\"${4:#111827}\">${5:Hello SVG}</text>" },
  { name: "defs", detail: "Definitions", snippet: "defs>\n  $0\n</defs>" },
  { name: "linearGradient", detail: "Linear Gradient", snippet: "linearGradient id=\"${1:grad}\">\n  <stop offset=\"0%\" stop-color=\"${2:#6366f1}\" />\n  <stop offset=\"100%\" stop-color=\"${3:#14b8a6}\" />\n</linearGradient>" },
  { name: "radialGradient", detail: "Radial Gradient", snippet: "radialGradient id=\"${1:grad}\">\n  <stop offset=\"0%\" stop-color=\"${2:#f97316}\" />\n  <stop offset=\"100%\" stop-color=\"${3:#fb7185}\" />\n</radialGradient>" },
  { name: "clipPath", detail: "Clip Path", snippet: "clipPath id=\"${1:clip}\">\n  $0\n</clipPath>" },
  { name: "mask", detail: "Mask", snippet: "mask id=\"${1:mask}\">\n  $0\n</mask>" }
];

const ATTRIBUTES = [
  "id",
  "class",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "width",
  "height",
  "viewBox",
  "d",
  "points",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "fill-opacity",
  "transform",
  "font-size",
  "font-family",
  "text-anchor",
  "preserveAspectRatio",
  "stop-color",
  "offset",
  "href"
];

const ATTRIBUTE_VALUE_SUGGESTIONS: Record<string, string[]> = {
  "stroke-linecap": ["butt", "round", "square"],
  "stroke-linejoin": ["miter", "round", "bevel"],
  "text-anchor": ["start", "middle", "end"],
  "preserveAspectRatio": ["none", "xMidYMid meet", "xMidYMid slice"],
  fill: ["none", "currentColor", "#0ea5e9", "url(#grad)"],
  stroke: ["none", "currentColor", "#0f172a"],
  transform: ["translate(10 10)", "scale(1.2)", "rotate(15)", "skewX(10)"]
};

function inTagContext(linePrefix: string): boolean {
  const lastOpen = linePrefix.lastIndexOf("<");
  const lastClose = linePrefix.lastIndexOf(">");
  return lastOpen > lastClose;
}

function buildElementCompletions(): vscode.CompletionItem[] {
  return ELEMENTS.map((item) => {
    const completion = new vscode.CompletionItem(item.name, vscode.CompletionItemKind.Struct);
    completion.insertText = new vscode.SnippetString(item.snippet);
    completion.detail = item.detail;
    completion.documentation = new vscode.MarkdownString(`SVG element \`${item.name}\``);
    return completion;
  });
}

function buildAttributeCompletions(): vscode.CompletionItem[] {
  return ATTRIBUTES.map((name) => {
    const completion = new vscode.CompletionItem(name, vscode.CompletionItemKind.Property);
    completion.insertText = new vscode.SnippetString(`${name}="${1}"`);
    completion.detail = "SVG attribute";
    return completion;
  });
}

class SvgCompletionProvider implements vscode.CompletionItemProvider {
  public provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.ProviderResult<vscode.CompletionItem[]> {
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const completions: vscode.CompletionItem[] = [];

    const elementContext = /<\/?[\w:-]*$/.test(linePrefix);
    if (elementContext) {
      completions.push(...buildElementCompletions());
    }

    const attributeContext = inTagContext(linePrefix) && /\s[\w:-]*$/.test(linePrefix);
    if (attributeContext) {
      completions.push(...buildAttributeCompletions());
    }

    const valueContext = linePrefix.match(/([\w:-]+)\s*=\s*["'][^"']*$/);
    if (valueContext) {
      const attr = valueContext[1];
      const values = ATTRIBUTE_VALUE_SUGGESTIONS[attr];
      if (values?.length) {
        for (const value of values) {
          const item = new vscode.CompletionItem(value, vscode.CompletionItemKind.Value);
          item.insertText = value;
          item.detail = `${attr} value`;
          completions.push(item);
        }
      }
    }

    return completions;
  }
}

export function registerSvgCompletionProvider(): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    [
      { language: "svg", scheme: "file" },
      { language: "svg", scheme: "untitled" }
    ],
    new SvgCompletionProvider(),
    "<",
    " ",
    "\"",
    "'"
  );
}
