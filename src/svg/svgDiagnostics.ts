import * as vscode from "vscode";

const PRESENTATION_ATTRIBUTES = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-opacity",
  "opacity",
  "color",
  "display",
  "visibility",
  "filter",
  "clip-path",
  "mask",
  "pointer-events",
  "vector-effect"
]);

const GLOBAL_ATTRIBUTES = new Set([
  "id",
  "class",
  "style",
  "transform",
  "tabindex",
  "focusable",
  "lang",
  "xml:lang",
  "xml:space",
  "xlink:href"
]);

const TAG_ATTRIBUTES: Record<string, string[]> = {
  svg: ["width", "height", "viewBox", "xmlns", "xmlns:xlink", "preserveAspectRatio", "role"],
  g: ["transform"],
  defs: [],
  symbol: ["viewBox", "preserveAspectRatio"],
  use: ["href", "x", "y", "width", "height"],
  path: ["d", "pathLength"],
  rect: ["x", "y", "width", "height", "rx", "ry", "pathLength"],
  circle: ["cx", "cy", "r", "pathLength"],
  ellipse: ["cx", "cy", "rx", "ry", "pathLength"],
  line: ["x1", "y1", "x2", "y2", "pathLength"],
  polygon: ["points", "pathLength"],
  polyline: ["points", "pathLength"],
  text: ["x", "y", "dx", "dy", "textLength", "lengthAdjust", "font-size", "font-family", "text-anchor"],
  tspan: ["x", "y", "dx", "dy", "font-size", "font-family", "text-anchor"],
  image: ["href", "x", "y", "width", "height", "preserveAspectRatio", "crossorigin"],
  linearGradient: ["id", "x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod", "href"],
  radialGradient: ["id", "cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod", "href"],
  stop: ["offset", "stop-color", "stop-opacity"],
  clipPath: ["id", "clipPathUnits", "transform"],
  mask: ["id", "x", "y", "width", "height", "maskUnits", "maskContentUnits"],
  pattern: ["id", "x", "y", "width", "height", "patternUnits", "patternContentUnits", "patternTransform", "viewBox"],
  filter: ["id", "x", "y", "width", "height", "filterUnits", "primitiveUnits"],
  title: [],
  desc: []
};

const KNOWN_TAGS = new Set(Object.keys(TAG_ATTRIBUTES));

function toRange(document: vscode.TextDocument, start: number, length: number): vscode.Range {
  return new vscode.Range(document.positionAt(start), document.positionAt(start + Math.max(1, length)));
}

function createDiagnostic(
  document: vscode.TextDocument,
  start: number,
  length: number,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code: string
): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(toRange(document, start, length), message, severity);
  diagnostic.source = "svg-all-in-one";
  diagnostic.code = code;
  return diagnostic;
}

function isAllowedAttribute(tagName: string, attributeName: string): boolean {
  if (
    attributeName.startsWith("data-") ||
    attributeName.startsWith("aria-") ||
    attributeName.startsWith("xmlns")
  ) {
    return true;
  }
  if (GLOBAL_ATTRIBUTES.has(attributeName) || PRESENTATION_ATTRIBUTES.has(attributeName)) {
    return true;
  }
  const tagAllowed = TAG_ATTRIBUTES[tagName];
  return Boolean(tagAllowed?.includes(attributeName));
}

function collectDuplicateIdDiagnostics(
  document: vscode.TextDocument,
  text: string,
  output: vscode.Diagnostic[]
): void {
  const regex = /\bid=(['"])([^"']+)\1/g;
  const firstOccurrence = new Map<string, { start: number; length: number; flagged: boolean }>();

  for (const match of text.matchAll(regex)) {
    const idValue = match[2];
    const idStart = (match.index ?? 0) + match[0].indexOf(idValue);
    const idLength = idValue.length;
    const first = firstOccurrence.get(idValue);

    if (!first) {
      firstOccurrence.set(idValue, { start: idStart, length: idLength, flagged: false });
      continue;
    }

    if (!first.flagged) {
      output.push(
        createDiagnostic(
          document,
          first.start,
          first.length,
          `Duplicate id "${idValue}"`,
          vscode.DiagnosticSeverity.Error,
          "duplicate-id"
        )
      );
      first.flagged = true;
    }

    output.push(
      createDiagnostic(
        document,
        idStart,
        idLength,
        `Duplicate id "${idValue}"`,
        vscode.DiagnosticSeverity.Error,
        "duplicate-id"
      )
    );
  }
}

function collectIllegalAttributeDiagnostics(
  document: vscode.TextDocument,
  text: string,
  output: vscode.Diagnostic[]
): void {
  const tagRegex = /<([a-zA-Z][\w:.-]*)(\s[^<>]*?)?>/g;
  for (const tagMatch of text.matchAll(tagRegex)) {
    const fullTag = tagMatch[0];
    if (fullTag.startsWith("</") || fullTag.startsWith("<!") || fullTag.startsWith("<?")) {
      continue;
    }

    const tagName = tagMatch[1].toLowerCase();
    if (!KNOWN_TAGS.has(tagName)) {
      continue;
    }

    const attributesPart = tagMatch[2] ?? "";
    const attrRegex = /([:@A-Za-z_][\w:.-]*)\s*=\s*(['"])(.*?)\2/g;
    for (const attrMatch of attributesPart.matchAll(attrRegex)) {
      const attrName = attrMatch[1];
      if (isAllowedAttribute(tagName, attrName)) {
        continue;
      }
      const attrsStartOffset = 1 + tagName.length;
      const absoluteStart = (tagMatch.index ?? 0) + attrsStartOffset + (attrMatch.index ?? 0);
      output.push(
        createDiagnostic(
          document,
          absoluteStart,
          attrName.length,
          `Attribute "${attrName}" is not commonly valid on <${tagName}>`,
          vscode.DiagnosticSeverity.Warning,
          "invalid-attribute"
        )
      );
    }
  }
}

function collectAccessibilityDiagnostics(
  document: vscode.TextDocument,
  text: string,
  output: vscode.Diagnostic[]
): void {
  const svgOpenTagMatch = /<svg\b([^>]*)>/i.exec(text);
  if (!svgOpenTagMatch || svgOpenTagMatch.index === undefined) {
    return;
  }

  const svgTagStart = svgOpenTagMatch.index;
  const svgTagLength = svgOpenTagMatch[0].length;
  const svgAttrs = svgOpenTagMatch[1];
  const isAriaHidden = /\baria-hidden\s*=\s*(['"])true\1/i.test(svgAttrs);
  const hasTitle = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(text);
  const hasDesc = /<desc\b[^>]*>[\s\S]*?<\/desc>/i.test(text);
  const hasAriaLabel = /\baria-label\s*=|\baria-labelledby\s*=/i.test(svgAttrs);
  const hasRole = /\brole\s*=/i.test(svgAttrs);

  if (!isAriaHidden && !hasTitle && !hasAriaLabel) {
    output.push(
      createDiagnostic(
        document,
        svgTagStart,
        svgTagLength,
        "SVG should include <title> or aria-label for accessibility",
        vscode.DiagnosticSeverity.Warning,
        "a11y-title"
      )
    );
  }

  if (!isAriaHidden && !hasDesc) {
    output.push(
      createDiagnostic(
        document,
        svgTagStart,
        svgTagLength,
        "Consider adding <desc> to improve SVG accessibility",
        vscode.DiagnosticSeverity.Information,
        "a11y-desc"
      )
    );
  }

  if (!isAriaHidden && !hasRole) {
    output.push(
      createDiagnostic(
        document,
        svgTagStart,
        svgTagLength,
        "Consider setting role=\"img\" for accessible SVGs",
        vscode.DiagnosticSeverity.Information,
        "a11y-role"
      )
    );
  }

  const imageRegex = /<image\b([^>]*)\/?>/gi;
  for (const match of text.matchAll(imageRegex)) {
    const attrs = match[1] ?? "";
    const hasLabel = /\baria-label\s*=|\baria-labelledby\s*=|\balt\s*=|\btitle\s*=/i.test(attrs);
    if (hasLabel || isAriaHidden || match.index === undefined) {
      continue;
    }
    output.push(
      createDiagnostic(
        document,
        match.index,
        match[0].length,
        "<image> should have aria-label/aria-labelledby (or mark the SVG aria-hidden)",
        vscode.DiagnosticSeverity.Warning,
        "a11y-image-label"
      )
    );
  }
}

export function buildSvgDiagnostics(document: vscode.TextDocument): vscode.Diagnostic[] {
  const text = document.getText();
  if (!text.trim()) {
    return [];
  }

  const diagnostics: vscode.Diagnostic[] = [];
  collectDuplicateIdDiagnostics(document, text, diagnostics);
  collectIllegalAttributeDiagnostics(document, text, diagnostics);
  collectAccessibilityDiagnostics(document, text, diagnostics);
  return diagnostics;
}
