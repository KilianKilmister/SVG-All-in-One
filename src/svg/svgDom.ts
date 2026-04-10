import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

export type SvgNodePath = number[];

export interface SvgNodeSnapshot {
  nodePath: SvgNodePath;
  tagName: string;
  attributes: Record<string, string>;
}

function extractXmlDeclaration(svgText: string): string | undefined {
  const match = svgText.match(/^\s*(<\?xml[\s\S]*?\?>)/i);
  return match?.[1];
}

function stripXmlDeclaration(svgText: string): string {
  return svgText.replace(/^\s*<\?xml[\s\S]*?\?>\s*/i, "");
}

function parseSvg(svgText: string): Document | undefined {
  const parser = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: () => undefined,
      fatalError: () => undefined
    }
  });
  const document = parser.parseFromString(svgText, "image/svg+xml");
  if (!document?.documentElement) {
    return undefined;
  }
  if (document.documentElement.tagName.toLowerCase() === "parsererror") {
    return undefined;
  }
  if (document.documentElement.tagName.toLowerCase() !== "svg") {
    return undefined;
  }
  return document;
}

function elementChildren(element: Element): Element[] {
  const children: Element[] = [];
  for (let i = 0; i < element.childNodes.length; i += 1) {
    const node = element.childNodes[i];
    if (node.nodeType === 1) {
      children.push(node as Element);
    }
  }
  return children;
}

function resolveElementByPath(root: Element, path: SvgNodePath): Element | undefined {
  let current = root;
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0) {
      return undefined;
    }
    const children = elementChildren(current);
    const next = children[index];
    if (!next) {
      return undefined;
    }
    current = next;
  }
  return current;
}

function readAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (let i = 0; i < element.attributes.length; i += 1) {
    const attr = element.attributes.item(i);
    if (attr) {
      attributes[attr.name] = attr.value;
    }
  }
  return attributes;
}

function serializeSvg(document: Document, xmlDeclaration?: string): string {
  const serializer = new XMLSerializer();
  let serialized = serializer.serializeToString(document);
  serialized = stripXmlDeclaration(serialized).trim();
  return xmlDeclaration ? `${xmlDeclaration}\n${serialized}` : serialized;
}

export function readNodeByPath(svgText: string, nodePath: SvgNodePath): SvgNodeSnapshot | undefined {
  const document = parseSvg(svgText);
  if (!document) {
    return undefined;
  }
  const target = resolveElementByPath(document.documentElement, nodePath);
  if (!target) {
    return undefined;
  }
  return {
    nodePath: [...nodePath],
    tagName: target.tagName,
    attributes: readAttributes(target)
  };
}

export function updateNodeByPath(
  svgText: string,
  nodePath: SvgNodePath,
  mutator: (element: Element) => void
): { svgText: string; snapshot: SvgNodeSnapshot } | undefined {
  const xmlDeclaration = extractXmlDeclaration(svgText);
  const document = parseSvg(svgText);
  if (!document) {
    return undefined;
  }

  const target = resolveElementByPath(document.documentElement, nodePath);
  if (!target) {
    return undefined;
  }

  mutator(target);
  const nextSvg = serializeSvg(document, xmlDeclaration);
  return {
    svgText: nextSvg,
    snapshot: {
      nodePath: [...nodePath],
      tagName: target.tagName,
      attributes: readAttributes(target)
    }
  };
}
