import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface AnswerSpanRange {
  start: number;
  end: number;
}

export interface AnswerDomMapper {
  offsetAtPoint(clientX: number, clientY: number): number | null;
  rangeForSpan(span: AnswerSpanRange): Range | null;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

type VisibleSegment = {
  value: string;
  start: number;
  end: number;
  mode: "markdown-text" | "literal" | "inline-code";
};

type VisibleUnit = {
  value: string;
  start: number;
  end: number;
};

type VisibleAnswerMap = {
  text: string;
  startOffsets: number[];
  endOffsets: number[];
};

type TextNodeMapping = {
  node: Text;
  startOffsets: number[];
  endOffsets: number[];
};

const NON_RENDERED_MARKDOWN_NODES = new Set([
  "definition",
  "image",
  "imageReference",
  "yaml",
]);

function nodeBounds(node: MarkdownNode, answerLength: number) {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (end as number) < (start as number) ||
    (end as number) > answerLength
  ) {
    return null;
  }
  return { start: start as number, end: end as number };
}

function codeValueBounds(
  answer: string,
  node: MarkdownNode,
  bounds: { start: number; end: number }
) {
  const value = node.value || "";
  if (!value) return null;
  const raw = answer.slice(bounds.start, bounds.end);
  let searchFrom = 0;

  if (node.type === "inlineCode") {
    const opening = /^(`+)/.exec(raw)?.[0];
    if (opening) searchFrom = opening.length;
  } else {
    const openingLineEnd = raw.indexOf("\n");
    if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(raw) && openingLineEnd !== -1) {
      searchFrom = openingLineEnd + 1;
    }
  }

  const relativeStart = raw.indexOf(value, searchFrom);
  if (relativeStart === -1) return bounds;
  return {
    start: bounds.start + relativeStart,
    end: bounds.start + relativeStart + value.length,
  };
}

function codeLineSegments(
  answer: string,
  value: string,
  bounds: { start: number; end: number }
) {
  const raw = answer.slice(bounds.start, bounds.end);
  const openingLine = /^[ \t]{0,3}(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r)/.exec(
    raw
  )?.[0];
  const contentStart = bounds.start + (openingLine?.length || 0);
  const sourceLines: Array<{ start: number; end: number; value: string }> = [];
  let cursor = contentStart;

  while (cursor < bounds.end) {
    let lineEnd = cursor;
    while (
      lineEnd < bounds.end &&
      answer[lineEnd] !== "\r" &&
      answer[lineEnd] !== "\n"
    ) {
      lineEnd++;
    }
    sourceLines.push({
      start: cursor,
      end: lineEnd,
      value: answer.slice(cursor, lineEnd),
    });
    if (answer.startsWith("\r\n", lineEnd)) cursor = lineEnd + 2;
    else cursor = lineEnd < bounds.end ? lineEnd + 1 : lineEnd;
  }

  const segments: VisibleSegment[] = [];
  let sourceIndex = 0;
  for (const line of value.split("\n")) {
    if (!line) {
      sourceIndex++;
      continue;
    }
    while (sourceIndex < sourceLines.length) {
      const sourceLine = sourceLines[sourceIndex++];
      const relativeStart = sourceLine.value.indexOf(line);
      if (relativeStart === -1) continue;
      segments.push({
        value: line,
        start: sourceLine.start + relativeStart,
        end: sourceLine.start + relativeStart + line.length,
        mode: "literal",
      });
      break;
    }
  }
  return segments;
}

function collectVisibleSegments(
  answer: string,
  node: MarkdownNode,
  segments: VisibleSegment[]
) {
  if (NON_RENDERED_MARKDOWN_NODES.has(node.type)) return;

  const bounds = nodeBounds(node, answer.length);
  if (node.type === "text" && typeof node.value === "string" && bounds) {
    segments.push({ ...bounds, mode: "markdown-text", value: node.value });
    return;
  }
  if (
    (node.type === "inlineCode" || node.type === "code") &&
    typeof node.value === "string" &&
    bounds
  ) {
    const valueBounds = codeValueBounds(answer, node, bounds);
    if (valueBounds && node.value) {
      const rawValue = answer.slice(valueBounds.start, valueBounds.end);
      if (node.type === "code" && rawValue !== node.value) {
        segments.push(
          ...codeLineSegments(answer, node.value, bounds)
        );
      } else {
        segments.push({
          ...valueBounds,
          mode: node.type === "inlineCode" ? "inline-code" : "literal",
          value: node.value,
        });
      }
    }
    return;
  }

  // HTML nodes are structure, not visible source text. Streamdown's sanitized
  // descendants are represented by neighboring Markdown text nodes.
  if (node.type === "html") return;

  for (const child of node.children || []) {
    collectVisibleSegments(answer, child, segments);
  }
}

const MARKDOWN_ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const CHARACTER_REFERENCE =
  /^&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/;

function decodeCharacterReference(reference: string) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = reference;
  return textarea.value;
}

function rawUnits(
  answer: string,
  segment: VisibleSegment
): VisibleUnit[] {
  const units: VisibleUnit[] = [];
  let cursor = segment.start;
  while (cursor < segment.end) {
    const rest = answer.slice(cursor, segment.end);
    if (
      segment.mode === "markdown-text" &&
      rest[0] === "\\" &&
      rest.length > 1
    ) {
      const escaped = String.fromCodePoint(rest.codePointAt(1) || 0);
      if (MARKDOWN_ESCAPABLE.test(escaped)) {
        units.push({
          value: escaped,
          start: cursor,
          end: cursor + 1 + escaped.length,
        });
        cursor += 1 + escaped.length;
        continue;
      }
    }

    if (segment.mode === "markdown-text" && rest[0] === "&") {
      const reference = CHARACTER_REFERENCE.exec(rest)?.[0];
      if (reference) {
        const decoded = decodeCharacterReference(reference);
        if (decoded !== reference) {
          for (const value of Array.from(decoded)) {
            units.push({
              value,
              start: cursor,
              end: cursor + reference.length,
            });
          }
          cursor += reference.length;
          continue;
        }
      }
    }

    if (
      segment.mode === "inline-code" &&
      (rest.startsWith("\r\n") ||
        rest.startsWith("\n") ||
        rest.startsWith("\r"))
    ) {
      const length = rest.startsWith("\r\n") ? 2 : 1;
      units.push({ value: " ", start: cursor, end: cursor + length });
      cursor += length;
      continue;
    }

    const value = String.fromCodePoint(answer.codePointAt(cursor) || 0);
    units.push({ value, start: cursor, end: cursor + value.length });
    cursor += value.length;
  }
  return units;
}

function segmentUnits(answer: string, segment: VisibleSegment): VisibleUnit[] {
  const units = rawUnits(answer, segment);
  const emitted = units.map((unit) => unit.value).join("");
  if (emitted === segment.value) return units;

  // Inline code removes one surrounding space in the CommonMark special case.
  // Slice the already source-mapped raw units instead of searching raw syntax.
  const exactStart = emitted.indexOf(segment.value);
  if (exactStart !== -1) {
    const exactEnd = exactStart + segment.value.length;
    const selected: VisibleUnit[] = [];
    let cursor = 0;
    for (const unit of units) {
      const next = cursor + unit.value.length;
      if (next > exactStart && cursor < exactEnd) selected.push(unit);
      cursor = next;
    }
    if (selected.map((unit) => unit.value).join("") === segment.value) {
      return selected;
    }
  }

  // Parser/render changes should fail closed for this leaf rather than map a
  // visible phrase into unrelated Markdown syntax.
  return [];
}

function buildVisibleAnswerMap(answer: string): VisibleAnswerMap {
  let tree: MarkdownNode;
  try {
    tree = fromMarkdown(answer, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as MarkdownNode;
  } catch {
    return {
      text: answer,
      startOffsets: Array.from({ length: answer.length + 1 }, (_, index) => index),
      endOffsets: Array.from({ length: answer.length + 1 }, (_, index) => index),
    };
  }

  const segments: VisibleSegment[] = [];
  collectVisibleSegments(answer, tree, segments);
  const units = segments.flatMap((segment) => segmentUnits(answer, segment));
  let text = "";
  const startOffsets: number[] = [];
  const endOffsets: number[] = [];

  for (const unit of units) {
    const visibleStart = text.length;
    text += unit.value;
    const visibleEnd = text.length;
    startOffsets[visibleStart] = unit.start;
    endOffsets[visibleEnd] = unit.end;

    // A code point can occupy two UTF-16 units. Its raw representation does too
    // unless Markdown encoded it, in which case there is no interior boundary.
    for (let offset = 1; offset < unit.value.length; offset++) {
      const rawOffset =
        unit.end - unit.start === unit.value.length
          ? unit.start + offset
          : unit.start;
      startOffsets[visibleStart + offset] = rawOffset;
      endOffsets[visibleStart + offset] = rawOffset;
    }
  }

  if (units.length > 0) {
    endOffsets[0] = units[0].start;
    startOffsets[text.length] = units[units.length - 1].end;
  }
  return { text, startOffsets, endOffsets };
}

function isIgnoredRendererText(node: Text) {
  const parent = node.parentElement;
  return Boolean(
    parent?.closest(
      [
        'button:not([data-streamdown="link"])',
        '[data-streamdown="code-block-header"]',
        '[data-streamdown="code-block-actions"]',
        '[data-streamdown="mermaid"]',
        '[data-footnotes] > [id$="footnote-label"]',
        '[data-streamdown="superscript"] [data-streamdown="link"]',
        '[data-footnote-ref]',
        '[data-footnote-backref]',
        '.data-footnote-backref',
      ].join(",")
    )
  );
}

function mapTextNodes(root: HTMLElement, answer: string): TextNodeMapping[] {
  const visible = buildVisibleAnswerMap(answer);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const mappings: TextNodeMapping[] = [];
  let visibleCursor = 0;
  let current: Node | null;

  while ((current = walker.nextNode())) {
    const node = current as Text;
    const rendered = node.data;
    if (!rendered || isIgnoredRendererText(node)) continue;

    let found = visible.text.indexOf(rendered, visibleCursor);
    let leadingWhitespace = 0;
    let trailingWhitespace = 0;
    let matched = rendered;
    if (found === -1) {
      matched = rendered.trim();
      if (!matched) continue;
      leadingWhitespace = rendered.length - rendered.trimStart().length;
      trailingWhitespace = rendered.length - rendered.trimEnd().length;
      found = visible.text.indexOf(matched, visibleCursor);
    }
    if (found === -1) continue;
    const end = found + matched.length;
    const coreStartOffsets = visible.startOffsets.slice(found, end + 1);
    const coreEndOffsets = visible.endOffsets.slice(found, end + 1);
    const rawStart = coreStartOffsets[0];
    const rawEnd = coreEndOffsets.at(-1);
    if (
      rawStart === undefined ||
      rawEnd === undefined ||
      !Number.isInteger(rawStart) ||
      !Number.isInteger(rawEnd)
    ) {
      continue;
    }
    const startOffsets = [
      ...Array.from({ length: leadingWhitespace }, () => rawStart),
      ...coreStartOffsets,
      ...Array.from({ length: trailingWhitespace }, () => rawEnd),
    ];
    const endOffsets = [
      ...Array.from({ length: leadingWhitespace }, () => rawStart),
      ...coreEndOffsets,
      ...Array.from({ length: trailingWhitespace }, () => rawEnd),
    ];
    if (
      startOffsets.length !== rendered.length + 1 ||
      endOffsets.length !== rendered.length + 1 ||
      startOffsets.some((offset) => !Number.isInteger(offset)) ||
      endOffsets.some((offset) => !Number.isInteger(offset))
    ) {
      continue;
    }

    visibleCursor = end;
    mappings.push({ node, startOffsets, endOffsets });
  }

  return mappings;
}

function isDescendantOrSelf(root: Node, candidate: Node) {
  return candidate === root || root.contains(candidate);
}

function firstMappedText(
  node: Node,
  mappingByNode: Map<Text, TextNodeMapping>
): TextNodeMapping | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return mappingByNode.get(node as Text) || null;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const mapping = mappingByNode.get(current as Text);
    if (mapping) return mapping;
  }
  return null;
}

function lastMappedText(
  node: Node,
  mappingByNode: Map<Text, TextNodeMapping>
): TextNodeMapping | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return mappingByNode.get(node as Text) || null;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let current: Node | null;
  let last: TextNodeMapping | null = null;
  while ((current = walker.nextNode())) {
    const mapping = mappingByNode.get(current as Text);
    if (mapping) last = mapping;
  }
  return last;
}

function mappingBoundary(
  mapping: TextNodeMapping,
  offset: number,
  bias: "start" | "end"
) {
  const offsets =
    bias === "start" ? mapping.startOffsets : mapping.endOffsets;
  const clamped = Math.max(0, Math.min(offset, offsets.length - 1));
  return offsets[clamped] ?? null;
}

function boundaryOffset(
  container: Node,
  offset: number,
  bias: "start" | "end",
  mappingByNode: Map<Text, TextNodeMapping>
): number | null {
  if (container.nodeType === Node.TEXT_NODE) {
    const mapping = mappingByNode.get(container as Text);
    return mapping ? mappingBoundary(mapping, offset, bias) : null;
  }

  const children = container.childNodes;
  if (bias === "start") {
    for (let index = Math.max(0, offset); index < children.length; index++) {
      const mapping = firstMappedText(children[index], mappingByNode);
      if (mapping) return mappingBoundary(mapping, 0, "start");
    }
    const fallback = lastMappedText(container, mappingByNode);
    return fallback
      ? mappingBoundary(fallback, fallback.startOffsets.length - 1, "start")
      : null;
  }

  for (
    let index = Math.min(offset, children.length) - 1;
    index >= 0;
    index--
  ) {
    const mapping = lastMappedText(children[index], mappingByNode);
    if (mapping) {
      return mappingBoundary(mapping, mapping.endOffsets.length - 1, "end");
    }
  }
  const fallback = firstMappedText(container, mappingByNode);
  return fallback ? mappingBoundary(fallback, 0, "end") : null;
}

function caretBoundaryAtPoint(clientX: number, clientY: number) {
  const modern = document.caretPositionFromPoint?.(clientX, clientY);
  if (modern) {
    return { container: modern.offsetNode, offset: modern.offset };
  }

  const legacyDocument = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const legacy = legacyDocument.caretRangeFromPoint?.(clientX, clientY);
  return legacy
    ? { container: legacy.startContainer, offset: legacy.startOffset }
    : null;
}

function domRangeForSpan(
  mappings: TextNodeMapping[],
  span: AnswerSpanRange
) {
  let startBoundary: { node: Text; offset: number } | null = null;
  let endBoundary: { node: Text; offset: number } | null = null;

  for (const mapping of mappings) {
    for (let offset = 0; offset < mapping.node.data.length; offset++) {
      const rawStart = mapping.startOffsets[offset];
      const rawEnd = mapping.endOffsets[offset + 1];
      if (
        rawStart === undefined ||
        rawEnd === undefined ||
        rawEnd <= span.start ||
        rawStart >= span.end
      ) {
        continue;
      }
      startBoundary ||= { node: mapping.node, offset };
      endBoundary = { node: mapping.node, offset: offset + 1 };
    }
  }

  if (!startBoundary || !endBoundary) return null;
  const range = document.createRange();
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  return range.toString().trim() ? range : null;
}

/**
 * Build the rendered-Markdown ↔ raw-answer mapping once for pointer hover and
 * click attribution. The ready answer is static, so reusing this map avoids
 * reparsing Markdown on every pointer movement.
 */
export function createAnswerDomMapper(
  root: HTMLElement,
  answer: string
): AnswerDomMapper | null {
  const mappings = mapTextNodes(root, answer);
  if (mappings.length === 0) return null;
  const mappingByNode = new Map(
    mappings.map((mapping) => [mapping.node, mapping])
  );

  return {
    offsetAtPoint(clientX, clientY) {
      const boundary = caretBoundaryAtPoint(clientX, clientY);
      if (!boundary || !isDescendantOrSelf(root, boundary.container)) {
        return null;
      }
      return boundaryOffset(
        boundary.container,
        boundary.offset,
        "start",
        mappingByNode
      );
    },
    rangeForSpan(span) {
      if (
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > answer.length
      ) {
        return null;
      }
      return domRangeForSpan(mappings, span);
    },
  };
}
