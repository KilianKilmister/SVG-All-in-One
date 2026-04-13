type XmlFormatterFn = (xml: string, options?: Record<string, unknown>) => string;
type OptimizeFn = typeof import("svgo").optimize;
type ResvgCtor = typeof import("@resvg/resvg-js").Resvg;

let xmlFormatterFn: XmlFormatterFn | undefined;
let optimizeFn: OptimizeFn | undefined;
let resvgCtor: ResvgCtor | undefined;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function missingDependencyError(packageName: string, error: unknown): Error {
  return new Error(
    `Missing runtime dependency "${packageName}". Reinstall dependencies and publish without --no-dependencies. Details: ${errorMessage(error)}`
  );
}

function getXmlFormatter(): XmlFormatterFn {
  if (xmlFormatterFn) {
    return xmlFormatterFn;
  }
  try {
    const loaded = require("xml-formatter") as { default?: XmlFormatterFn } | XmlFormatterFn;
    const formatter = (typeof loaded === "function" ? loaded : loaded.default) as XmlFormatterFn | undefined;
    if (typeof formatter !== "function") {
      throw new Error("Invalid xml-formatter export.");
    }
    xmlFormatterFn = formatter;
    return formatter;
  } catch (error) {
    throw missingDependencyError("xml-formatter", error);
  }
}

function getOptimize(): OptimizeFn {
  if (optimizeFn) {
    return optimizeFn;
  }
  try {
    const loaded = require("svgo") as { optimize?: OptimizeFn };
    if (typeof loaded.optimize !== "function") {
      throw new Error("Invalid svgo export.");
    }
    optimizeFn = loaded.optimize;
    return loaded.optimize;
  } catch (error) {
    throw missingDependencyError("svgo", error);
  }
}

function getResvgCtor(): ResvgCtor {
  if (resvgCtor) {
    return resvgCtor;
  }
  try {
    const loaded = require("@resvg/resvg-js") as { Resvg?: ResvgCtor };
    if (typeof loaded.Resvg !== "function") {
      throw new Error("Invalid @resvg/resvg-js export.");
    }
    resvgCtor = loaded.Resvg;
    return loaded.Resvg;
  } catch (error) {
    throw missingDependencyError("@resvg/resvg-js", error);
  }
}

const COLOR_ATTRS = [
  "fill",
  "stroke",
  "stop-color",
  "flood-color",
  "lighting-color",
  "color"
];

const SKIP_COLOR_VALUES = new Set([
  "none",
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset"
]);

function normalizeColorValue(value: string): string {
  return value.trim().toLowerCase();
}

function isColorValue(value: string): boolean {
  const normalized = normalizeColorValue(value);
  if (!normalized || SKIP_COLOR_VALUES.has(normalized) || normalized.startsWith("url(")) {
    return false;
  }
  return true;
}

function sanitizeSourceSvg(svg: string): string {
  return svg.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function cleanupSvgContent(svg: string): string {
  // Cleanup intentionally keeps semantic content untouched and only removes noisy XML artifacts.
  const normalized = sanitizeSourceSvg(svg);
  const withoutComments = normalized.replace(/<!--[\s\S]*?-->/g, "");
  const withoutDoctype = withoutComments.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const noEmptyLines = withoutDoctype
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .filter((line, index, arr) => !(line.trim() === "" && arr[index - 1]?.trim() === ""))
    .join("\n");

  return noEmptyLines.trim();
}

export function formatSvgContent(svg: string): string {
  return getXmlFormatter()(svg, {
    indentation: "  ",
    lineSeparator: "\n",
    collapseContent: true,
    whiteSpaceAtEndOfSelfclosingTag: true
  }).trim();
}

export function compressSvgContent(svg: string): string {
  const result = getOptimize()(svg, {
    multipass: true,
    js2svg: {
      pretty: false,
      indent: 0
    },
    plugins: ["preset-default"]
  });

  return result.data;
}

function collectColorsFromStyle(styleContent: string, sink: Set<string>): void {
  const styleRegex =
    /\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;]+)(;?)/gi;
  for (const match of styleContent.matchAll(styleRegex)) {
    const value = match[2].trim();
    if (isColorValue(value)) {
      sink.add(value);
    }
  }
}

export function extractColorPalette(svg: string): string[] {
  const palette = new Set<string>();
  const attrRegex = new RegExp(`\\b(${COLOR_ATTRS.join("|")})=(['"])(.*?)\\2`, "gim");

  for (const match of svg.matchAll(attrRegex)) {
    const value = match[3].trim();
    if (isColorValue(value)) {
      palette.add(value);
    }
  }

  for (const styleMatch of svg.matchAll(/\bstyle=(['"])(.*?)\1/gim)) {
    collectColorsFromStyle(styleMatch[2], palette);
  }

  return Array.from(palette).sort((a, b) => a.localeCompare(b));
}

function recolorInlineStyles(styleContent: string, from: string | undefined, to: string): string {
  // Inline style blocks need separate parsing because they are not covered by attribute regex.
  return styleContent.replace(
    /\b(fill|stroke|stop-color|flood-color|lighting-color|color)\s*:\s*([^;]+)(;?)/gi,
    (fullMatch, prop: string, value: string, ending: string) => {
      const normalizedValue = value.trim();
      if (!isColorValue(normalizedValue)) {
        return fullMatch;
      }
      if (from && normalizeColorValue(normalizedValue) !== normalizeColorValue(from)) {
        return fullMatch;
      }
      return `${prop}: ${to}${ending}`;
    }
  );
}

export function quickRecolorSvg(svg: string, to: string, from?: string): string {
  let output = svg;
  const attrRegex = new RegExp(`\\b(${COLOR_ATTRS.join("|")})=(['"])(.*?)\\2`, "gim");

  output = output.replace(attrRegex, (fullMatch, attr: string, quote: string, value: string) => {
    const trimmed = value.trim();
    if (!isColorValue(trimmed)) {
      return fullMatch;
    }
    if (from && normalizeColorValue(trimmed) !== normalizeColorValue(from)) {
      return fullMatch;
    }
    return `${attr}=${quote}${to}${quote}`;
  });

  output = output.replace(/\bstyle=(['"])(.*?)\1/gim, (fullMatch, quote: string, style: string) => {
    const next = recolorInlineStyles(style, from, to);
    return `style=${quote}${next}${quote}`;
  });

  return output;
}

function parseSvgLength(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)(px)?$/i);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

export function inferSvgBaseWidth(svg: string): number | undefined {
  // Export width priority: explicit width attribute first, fallback to viewBox width.
  const widthMatch = svg.match(/\bwidth=(['"])(.*?)\1/i);
  const parsedWidth = parseSvgLength(widthMatch?.[2]);
  if (parsedWidth && parsedWidth > 0) {
    return parsedWidth;
  }

  const viewBox = svg.match(/\bviewBox=(['"])(.*?)\1/i)?.[2];
  if (viewBox) {
    const parts = viewBox
      .trim()
      .split(/[,\s]+/)
      .map((part) => Number(part));
    if (parts.length === 4 && Number.isFinite(parts[2]) && parts[2] > 0) {
      return parts[2];
    }
  }

  return undefined;
}

export function renderSvgToPng(svg: string, width?: number): Uint8Array {
  // Resvg fitTo width keeps aspect ratio and provides deterministic @Nx outputs.
  const fitWidth = width && Number.isFinite(width) && width > 0 ? Math.round(width) : undefined;
  const Resvg = getResvgCtor();
  const resvg = new Resvg(svg, fitWidth ? { fitTo: { mode: "width", value: fitWidth } } : undefined);
  return resvg.render().asPng();
}
