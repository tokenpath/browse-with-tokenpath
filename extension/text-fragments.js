// TokenPath — Chrome text-fragment directives (`#:~:text=`).
//
// Both source surfaces that TokenPath cannot script directly need the same
// thing: given the exact text of a document and a resolved [start, end) span
// inside it, produce a directive that lands the browser on that passage.
// Chrome's native PDF viewer uses it (background.js), and so does a cited web
// page opened from a chat answer (chat-sources.js) — the page is a third-party
// tab we never own, so the fragment is the only pointer available.
//
// The defaults reproduce the PDF caller's long-standing behaviour exactly.
// A caller that cannot afford a strict match asks for `context: "ambiguous"`,
// which spends prefix/suffix only on a target that occurs more than once.

const TOKENPATH_FRAGMENT_CONTEXT_CHARS = 64;
const TOKENPATH_FRAGMENT_EDGE_CHARS = 96;
const TOKENPATH_FRAGMENT_FULL_TARGET_CHARS = 240;

const TokenPathTextFragments = {
  CONTEXT_CHARS: TOKENPATH_FRAGMENT_CONTEXT_CHARS,
  EDGE_CHARS: TOKENPATH_FRAGMENT_EDGE_CHARS,
  FULL_TARGET_CHARS: TOKENPATH_FRAGMENT_FULL_TARGET_CHARS,

  /**
   * Build the directive body for `#:~:text=`, or null when the span cannot
   * name a passage (empty, out of range, whitespace only).
   *
   * @param {string} documentText the exact text the span indexes
   * @param {number} rawStart UTF-16 start offset, inclusive
   * @param {number} rawEnd UTF-16 end offset, exclusive
   * @param {{
   *   contextChars?: number,
   *   edgeChars?: number,
   *   fullTargetChars?: number,
   *   context?: "always" | "ambiguous",
   * }} [options]
   */
  build(documentText, rawStart, rawEnd, options = {}) {
    const text = String(documentText || "");
    if (
      !text ||
      !Number.isInteger(rawStart) ||
      !Number.isInteger(rawEnd) ||
      rawStart < 0 ||
      rawEnd <= rawStart ||
      rawEnd > text.length
    ) {
      return null;
    }

    const contextChars = positiveCount(
      options.contextChars,
      TOKENPATH_FRAGMENT_CONTEXT_CHARS
    );
    const edgeChars = positiveCount(
      options.edgeChars,
      TOKENPATH_FRAGMENT_EDGE_CHARS
    );
    const fullTargetChars = positiveCount(
      options.fullTargetChars,
      TOKENPATH_FRAGMENT_FULL_TARGET_CHARS
    );

    let start = rawStart;
    let end = rawEnd;
    if (
      isLowSurrogate(text.charCodeAt(start)) &&
      isHighSurrogate(text.charCodeAt(start - 1))
    ) {
      start--;
    }
    if (
      isHighSurrogate(text.charCodeAt(end - 1)) &&
      isLowSurrogate(text.charCodeAt(end))
    ) {
      end++;
    }
    while (start < end && /\s/u.test(text[start])) start++;
    while (end > start && /\s/u.test(text[end - 1])) end--;
    const target = this.normalize(this.safeSlice(text, start, end));
    if (!target) return null;

    const wantsContext =
      options.context === "ambiguous"
        ? occursMoreThanOnce(this.normalize(text), target)
        : true;
    const prefix = wantsContext
      ? this.edge(
          this.safeSlice(text, Math.max(0, start - contextChars * 2), start),
          "end",
          contextChars
        )
      : "";
    const suffix = wantsContext
      ? this.edge(
          this.safeSlice(
            text,
            end,
            Math.min(text.length, end + contextChars * 2)
          ),
          "start",
          contextChars
        )
      : "";
    const targetCodePoints = Array.from(target);
    const textStart =
      targetCodePoints.length <= fullTargetChars
        ? target
        : this.edge(target, "start", edgeChars);
    const textEnd =
      targetCodePoints.length <= fullTargetChars
        ? ""
        : this.edge(target, "end", edgeChars);

    return (
      (prefix ? `${this.encodePart(prefix)}-,` : "") +
      this.encodePart(textStart) +
      (textEnd ? `,${this.encodePart(textEnd)}` : "") +
      (suffix ? `,-${this.encodePart(suffix)}` : "")
    );
  },

  /** Slice without ever splitting a surrogate pair. */
  safeSlice(value, rawStart, rawEnd) {
    let start = Math.max(0, rawStart);
    let end = Math.min(value.length, rawEnd);
    if (
      isLowSurrogate(value.charCodeAt(start)) &&
      isHighSurrogate(value.charCodeAt(start - 1))
    ) {
      start--;
    }
    if (
      isHighSurrogate(value.charCodeAt(end - 1)) &&
      isLowSurrogate(value.charCodeAt(end))
    ) {
      end++;
    }
    return value.slice(start, end);
  },

  normalize(value) {
    return (
      String(value || "")
        // Soft/zero-width separators are commonly injected into extracted PDF
        // text and into web markup. Keep ZWNJ/ZWJ: unlike those separators,
        // they can be meaningful parts of Persian text and emoji sequences.
        .replace(/[\u00ad\u200b\u2060\ufeff]/gu, "")
        .replace(/\s+/gu, " ")
        .trim()
    );
  },

  /** Clip `value` to one edge, preferring whole words where there are any. */
  edge(value, edge, maxCharacters = TOKENPATH_FRAGMENT_CONTEXT_CHARS) {
    const clean = this.normalize(value);
    if (!clean) return "";
    const codePoints = Array.from(clean);
    if (codePoints.length <= maxCharacters) return clean;

    const clipped =
      edge === "end"
        ? codePoints.slice(-maxCharacters).join("")
        : codePoints.slice(0, maxCharacters).join("");
    // Prefer whole words, but keep the clipped text for scripts without spaces.
    if (!/\s/u.test(clipped)) return clipped;
    return edge === "end"
      ? clipped.replace(/^\S+\s+/u, "")
      : clipped.replace(/\s+\S*$/u, "");
  },

  encodePart(value) {
    // Text-fragment commas and `-,` / `,-` pairs are structural. Encode every
    // punctuation character that encodeURIComponent leaves unescaped so source
    // prose cannot accidentally become part of the directive grammar.
    return encodeURIComponent(value).replace(
      /[!'()*-]/g,
      (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
    );
  },

  /** Replace any existing text directive on `rawUrl` with `directive`. */
  withDirective(rawUrl, directive) {
    const base = this.withoutDirective(rawUrl);
    return base.includes("#")
      ? `${base}:~:text=${directive}`
      : `${base}#:~:text=${directive}`;
  },

  withoutDirective(rawUrl) {
    const hashIndex = rawUrl.indexOf("#");
    if (hashIndex < 0) return rawUrl;
    const directiveIndex = rawUrl.indexOf(":~:", hashIndex + 1);
    if (directiveIndex < 0) return rawUrl;
    const base = rawUrl.slice(0, directiveIndex);
    return base.endsWith("#") ? base.slice(0, -1) : base;
  },
};

function positiveCount(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

// A second occurrence is enough to know the bare target is ambiguous; the
// scan stops there rather than counting every repeat in a long document.
function occursMoreThanOnce(haystack, needle) {
  if (!needle) return false;
  const first = haystack.indexOf(needle);
  if (first < 0) return false;
  return haystack.indexOf(needle, first + 1) >= 0;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = TokenPathTextFragments;
}
