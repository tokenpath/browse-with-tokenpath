// TokenPath — chat citation mode: source handling and span mapping.
//
// Everything here is pure: it takes strings in and returns strings, offsets,
// and plain records. The service worker owns the network (chat-citations.js
// runs in a page world and cannot fetch a cited origin), and the content
// script owns the DOM. This file is the piece both sides agree on, which is
// what makes the offset arithmetic testable without a browser.
//
// The shape of the problem: /v1/attributions attributes one answer against
// ONE document, and a chat answer cites several pages. So the cited pages are
// packed into a single document with a header line per source, each source's
// text region recorded, and every returned source span mapped back to the
// page it landed in. A span that straddles two sources — or lands in a header
// rather than in prose — is dropped rather than guessed at.

const TokenPathChatSources = (() => {
  // Enough sources to cover a normal web-cited answer while bounding fetch
  // time and packed-document size.
  const MAX_SOURCES = 10;
  // Per source. Ten of these plus headers stay inside MAX_DOCUMENT_CHARS.
  const MAX_SOURCE_CHARS = 32_000;
  // The attribution endpoint's document ceiling (sidepanel/tokenpath.js caps
  // captured page text at the same number). Packing stops before it rather
  // than letting the request fail.
  const MAX_DOCUMENT_CHARS = 400_000;
  // A chat answer is prose, not a document. Anything longer than this is not
  // a finished answer being cited; it is a transcript, and attributing it
  // would spend a large request on a page the user is not reading.
  const MAX_ANSWER_CHARS = 24_000;
  const MIN_ANSWER_CHARS = 40;
  // A slice smaller than this is not worth a header and a request slot.
  const MIN_PACKED_SOURCE_CHARS = 200;
  // Fetched HTML above this is not an article. Reading further only costs
  // memory: the readability pass keeps at most MAX_SOURCE_CHARS anyway.
  const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
  const HOVER_PASSAGE_CHARS = 120;
  // A cited web page is not a document TokenPath extracted, so a fragment has
  // to match text the browser lays out. Short targets match far more often,
  // and context is spent only where the target repeats.
  const FRAGMENT_OPTIONS = {
    contextChars: 24,
    edgeChars: 40,
    fullTargetChars: 120,
    context: "ambiguous",
  };

  const SOURCE_HEADER_PREFIX = "=== Source ";
  // Query parameters that identify who sent the traffic rather than which
  // document is being addressed. `utm_source=chatgpt.com` is the marker
  // ChatGPT appends to every citation, so stripping it is what makes the same
  // page cited from two answers one cache entry.
  const TRACKING_PARAMETERS = ["fbclid", "gclid", "mc_cid", "mc_eid"];
  // Whole elements whose text is chrome rather than content. `nav`, `header`,
  // `footer`, and `aside` are the readability-style trim; the rest never
  // contain prose a claim could be grounded in.
  const DROPPED_ELEMENTS = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "math",
    "iframe",
    "object",
    "embed",
    "canvas",
    "form",
    "select",
    "button",
    "nav",
    "header",
    "footer",
    "aside",
    "figcaption",
    "dialog",
  ];
  // A `<main>` or `<article>` shorter than this is a teaser or a card, not the
  // page's content; fall back to the body instead of attributing against it.
  const MIN_MAIN_REGION_CHARS = 400;
  const CONTENT_TYPE_PATTERN = /^\s*(?:text\/html|application\/xhtml\+xml)\b/i;

  const NAMED_ENTITIES = new Map([
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", '"'],
    ["apos", "'"],
    ["nbsp", " "],
    ["ndash", "–"],
    ["mdash", "—"],
    ["lsquo", "‘"],
    ["rsquo", "’"],
    ["ldquo", "“"],
    ["rdquo", "”"],
    ["hellip", "…"],
    ["middot", "·"],
    ["bull", "•"],
    ["deg", "°"],
    ["euro", "€"],
    ["pound", "£"],
    ["yen", "¥"],
    ["cent", "¢"],
    ["copy", "©"],
    ["reg", "®"],
    ["trade", "™"],
    ["times", "×"],
    ["divide", "÷"],
    ["plusmn", "±"],
    ["frac12", "½"],
    ["frac14", "¼"],
    ["frac34", "¾"],
    ["prime", "′"],
    ["Prime", "″"],
    ["laquo", "«"],
    ["raquo", "»"],
    ["shy", ""],
    ["zwj", "\u200d"],
    ["zwnj", "\u200c"],
  ]);

  /**
   * Canonical form of a cited URL: the identity of the document, with the
   * sender stripped. Returns null for anything that is not a fetchable page,
   * which is also what keeps `javascript:`, `data:`, and extension URLs out
   * of the worker's fetch list.
   *
   * @param {unknown} rawUrl
   * @param {string} [base] resolve a relative href against this page URL
   */
  function normalizeSourceUrl(rawUrl, base) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
    let url;
    try {
      url = base ? new URL(rawUrl, base) : new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;

    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith("utm_") || TRACKING_PARAMETERS.includes(lower)) {
        url.searchParams.delete(key);
      }
    }
    // A fragment names a position inside one document, and the position this
    // feature cares about is the attributed passage, which it writes itself.
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  }

  /**
   * True when an anchor is a citation chip rather than prose. A chip's visible
   * text is a marker — a number, a bare domain, a source title — so its text
   * must not become part of the answer string that offsets index into. An
   * inline prose link is kept: dropping its words would shift every later
   * offset away from the sentence the reader sees.
   */
  function isCitationChipText(rawText, rawUrl) {
    const text = String(rawText || "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!text) return true;
    // Reference markers: "1", "[2]", "(3)", "1,2".
    if (/^[\s\d[\]().,;·•-]+$/u.test(text)) return true;
    let host = "";
    try {
      host = new URL(String(rawUrl)).hostname.replace(/^www\./i, "");
    } catch {
      host = "";
    }
    if (!host) return false;
    const lower = text.toLowerCase();
    // A chip labels its source; prose does not repeat the hostname it links.
    if (lower === host || lower === `www.${host}`) return true;
    const label = host.split(".")[0];
    if (label && lower === label) return true;
    // "nytimes.com +3", "Reuters · reuters.com"
    return text.length <= 48 && lower.includes(host);
  }

  /**
   * Readability-style plain text for one fetched page.
   *
   * A service worker has no DOMParser, so this is a tag-level pass rather than
   * a tree walk: drop the elements whose text is never content, prefer the
   * page's own main region when it is substantial, turn block boundaries into
   * newlines, then strip tags and decode entities. The result is the exact
   * string TokenPath receives and indexes, so it is also the string every
   * text fragment is cut from.
   *
   * @param {unknown} rawHtml
   * @param {{ maxChars?: number }} [options]
   */
  function extractReadableText(rawHtml, options = {}) {
    if (typeof rawHtml !== "string" || !rawHtml) return "";
    const maxChars =
      Number.isInteger(options.maxChars) && options.maxChars > 0
        ? options.maxChars
        : MAX_SOURCE_CHARS;

    let work = rawHtml.replace(/<!--[\s\S]*?-->/g, " ");
    work = work.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, " ");
    for (const name of DROPPED_ELEMENTS) work = dropElement(work, name);
    work = mainRegion(work);

    // Source formatting is not document structure: a paragraph wrapped across
    // three lines in the HTML is one line of prose. Collapse every raw
    // whitespace run first, then let the block tags put the newlines back.
    work = work.replace(/\s+/g, " ");
    work = work.replace(/<(?:br|hr)\b[^<>]*>/gi, "\n");
    work = work.replace(
      /<\/?(?:p|div|section|article|main|li|ul|ol|dl|dd|dt|tr|table|thead|tbody|h[1-6]|blockquote|pre|figure|address|details|summary)\b[^<>]*>/gi,
      "\n"
    );
    work = work.replace(/<\/?(?:td|th)\b[^<>]*>/gi, " ");
    // Only strip things shaped like tags: a stray `<` in prose stays prose.
    work = work.replace(/<\/?[a-zA-Z][^<>]*>/g, "");
    work = decodeEntities(work);
    return truncateText(normalizeWhitespace(work), maxChars);
  }

  /**
   * Pack fetched sources into the single document /v1/attributions takes.
   *
   * @param {Array<{ url: string, text: string, title?: string }>} sources
   * @param {{ maxChars?: number }} [options]
   * @returns {{
   *   document: string,
   *   regions: Array<{
   *     index: number, url: string, title: string,
   *     start: number, end: number, text: string,
   *   }>,
   * }}
   */
  function packSources(sources, options = {}) {
    const maxChars =
      Number.isInteger(options.maxChars) && options.maxChars > 0
        ? options.maxChars
        : MAX_DOCUMENT_CHARS;
    const regions = [];
    let text = "";
    for (const source of Array.isArray(sources) ? sources : []) {
      const url = typeof source?.url === "string" ? source.url : "";
      const body = normalizeWhitespace(String(source?.text || ""));
      if (!url || !body) continue;
      if (regions.length >= MAX_SOURCES) break;

      const header = `${SOURCE_HEADER_PREFIX}${regions.length + 1}: ${url} ===\n`;
      // Every source needs its header, its text, and the blank line that
      // separates it from the next one. A source that cannot fit whole is
      // truncated on a whitespace boundary; one with no room at all is left
      // out entirely, and the caller reports it as dropped.
      const available = maxChars - text.length - header.length - 2;
      if (available < MIN_PACKED_SOURCE_CHARS) break;
      const kept = truncateText(body, Math.min(available, MAX_SOURCE_CHARS));
      if (!kept) continue;

      if (text) text += "\n";
      text += header;
      const start = text.length;
      text += kept;
      regions.push({
        index: regions.length,
        url,
        title: typeof source?.title === "string" ? source.title : "",
        start,
        end: text.length,
        text: kept,
      });
      text += "\n";
    }
    return { document: text, regions };
  }

  /** The region a source span lies wholly inside, or null. */
  function regionForSpan(regions, start, end) {
    for (const region of Array.isArray(regions) ? regions : []) {
      if (start >= region.start && end <= region.end) return region;
    }
    return null;
  }

  /**
   * Turn validated /v1/attributions spans into per-source citation links.
   *
   * Answer offsets pass straight through — they index the exact answer string
   * the content script extracted. Source offsets are rebased onto the page
   * they landed in, because that page, not the packed document, is what a
   * click opens.
   *
   * @param {{
   *   spans?: Array<{
   *     answer: { start: number, end: number, text: string },
   *     source: { start: number, end: number, text: string, confidence: number },
   *   }>,
   *   regions?: Array<{ index: number, url: string, title: string, start: number, end: number, text: string }>,
   * }} input
   */
  function resolveAttributions({ spans, regions } = {}) {
    const resolved = [];
    for (const span of Array.isArray(spans) ? spans : []) {
      const answer = span?.answer;
      const source = span?.source;
      if (!answer || !source) continue;
      const region = regionForSpan(regions, source.start, source.end);
      // A span that straddles two packed sources, or that landed in a header
      // line, names no single page. Dropping it costs one link; guessing
      // would put a claim's grounding on the wrong document.
      if (!region) continue;

      const localStart = source.start - region.start;
      const localEnd = source.end - region.start;
      const link = sourceLink(region, localStart, localEnd);
      if (!link) continue;
      resolved.push({
        answer: { start: answer.start, end: answer.end, text: answer.text },
        source: {
          url: region.url,
          link,
          sourceIndex: region.index,
          start: localStart,
          end: localEnd,
          text: source.text,
          confidence: source.confidence,
        },
      });
    }
    // The API returns ordered, non-overlapping answer spans and the client
    // validates that, so this only ever has to defend against a future
    // relaxation of the contract: on an overlap, the stronger span wins.
    return dropOverlaps(resolved);
  }

  /** The source URL with a text fragment aimed at the attributed passage. */
  function sourceLink(region, localStart, localEnd) {
    if (!region?.url) return null;
    const directive = TokenPathTextFragments.build(
      region.text,
      localStart,
      localEnd,
      FRAGMENT_OPTIONS
    );
    if (!directive) return region.url;
    return TokenPathTextFragments.withDirective(region.url, directive);
  }

  /** Hover text: which page, and the passage the phrase was matched to. */
  function hoverTitle(url, passage) {
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./i, "");
    } catch {
      // Keep the raw value; it is only ever shown, never parsed again.
    }
    const clean = TokenPathTextFragments.normalize(passage);
    if (!clean) return host;
    const clipped =
      clean.length <= HOVER_PASSAGE_CHARS
        ? clean
        : `${TokenPathTextFragments.edge(clean, "start", HOVER_PASSAGE_CHARS)}…`;
    return `${host} — “${clipped}”`;
  }

  /**
   * The badge line under a processed message. It has to say what happened to
   * the sources as well as what was linked: "no spans" from nine good sources
   * is a different answer from "no spans" from nine paywalls.
   *
   * @param {{
   *   requested?: number, fetched?: number, spans?: number,
   *   error?: string | null,
   * }} stats
   */
  function statusLabel(stats = {}) {
    if (stats.error) return `TokenPath: ${stats.error}`;
    const requested = Number(stats.requested) || 0;
    const fetched = Number(stats.fetched) || 0;
    const spans = Number(stats.spans) || 0;
    if (!requested) return "TokenPath: no web sources cited";
    if (!fetched) {
      return requested === 1
        ? "TokenPath: couldn't read the cited page"
        : `TokenPath: couldn't read any of ${requested} cited pages`;
    }
    const sources = `${fetched}/${requested} sources`;
    if (!spans) return `TokenPath: ${sources} · no linked phrases`;
    return `TokenPath: ${sources} · ${spans} ${
      spans === 1 ? "phrase" : "phrases"
    }`;
  }

  /** True when a fetched response is HTML this pass can read. */
  function isReadableContentType(contentType) {
    return CONTENT_TYPE_PATTERN.test(String(contentType || ""));
  }

  // --- internals ------------------------------------------------------------

  function dropOverlaps(spans) {
    const ordered = [...spans].sort(
      (left, right) => left.answer.start - right.answer.start
    );
    const kept = [];
    for (const span of ordered) {
      const previous = kept[kept.length - 1];
      if (previous && span.answer.start < previous.answer.end) {
        if (span.source.confidence > previous.source.confidence) {
          kept[kept.length - 1] = span;
        }
        continue;
      }
      kept.push(span);
    }
    return kept;
  }

  // Remove `<name>…</name>` including nested repeats, plus any self-closing or
  // orphaned opener. Bounded: malformed markup must not loop.
  function dropElement(html, name) {
    const paired = new RegExp(
      `<${name}\\b[^<>]*>[\\s\\S]*?<\\/${name}\\s*>`,
      "gi"
    );
    let work = html;
    for (let pass = 0; pass < 4; pass++) {
      const next = work.replace(paired, " ");
      if (next === work) break;
      work = next;
    }
    // An unclosed `<script>`/`<style>` would otherwise leak its body as prose.
    if (name === "script" || name === "style" || name === "template") {
      work = work.replace(new RegExp(`<${name}\\b[^<>]*>[\\s\\S]*$`, "i"), " ");
    }
    return work.replace(new RegExp(`<\\/?${name}\\b[^<>]*>`, "gi"), " ");
  }

  // Prefer the page's own content region, and only when it is substantial:
  // a short `<main>` is a shell around client-rendered content, and its text
  // is navigation.
  function mainRegion(html) {
    let best = "";
    for (const name of ["article", "main"]) {
      const pattern = new RegExp(
        `<${name}\\b[^<>]*>([\\s\\S]*?)<\\/${name}\\s*>`,
        "gi"
      );
      let match;
      while ((match = pattern.exec(html))) {
        if (match[1].length > best.length) best = match[1];
      }
    }
    if (visibleLength(best) >= MIN_MAIN_REGION_CHARS) return best;
    const body = /<body\b[^<>]*>([\s\S]*)<\/body\s*>/i.exec(html);
    return body ? body[1] : html;
  }

  // Cheap proxy for "is there prose in here": tag text does not count.
  function visibleLength(html) {
    return html.replace(/<\/?[a-zA-Z][^<>]*>/g, " ").replace(/\s+/g, " ").trim()
      .length;
  }

  function decodeEntities(value) {
    return value.replace(
      /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
      (match, body) => {
        if (body[0] === "#") {
          const code =
            body[1] === "x" || body[1] === "X"
              ? Number.parseInt(body.slice(2), 16)
              : Number.parseInt(body.slice(1), 10);
          if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
            return match;
          }
          // Surrogate halves are not characters; a lone one would corrupt the
          // string TokenPath indexes.
          if (code >= 0xd800 && code <= 0xdfff) return match;
          try {
            return String.fromCodePoint(code);
          } catch {
            return match;
          }
        }
        const named = NAMED_ENTITIES.get(body);
        return named === undefined ? match : named;
      }
    );
  }

  // Collapse horizontal whitespace, keep paragraph structure to at most one
  // blank line, and drop the empty lines stripped tags leave behind.
  function normalizeWhitespace(value) {
    return value
      .replace(/\r\n?/g, "\n")
      // `[^\S\n]` is every whitespace character except a newline, so this
      // also folds NBSP and the narrow spaces web pages pad numbers with.
      .replace(/[^\S\n]+/g, " ")
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // One newline per block boundary, matching the page-capture path in
      // content.js: an opening and a closing tag both emit one.
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  // Truncate on a whitespace boundary where there is one nearby, and never
  // between the halves of a surrogate pair.
  function truncateText(value, maxChars) {
    if (value.length <= maxChars) return value;
    let end = maxChars;
    if (
      end > 0 &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--;
    }
    const clipped = value.slice(0, end);
    const boundary = Math.max(
      clipped.lastIndexOf("\n"),
      clipped.lastIndexOf(" ")
    );
    // Only honour a boundary in the last tenth; a document with no whitespace
    // at all (CJK) keeps the hard cut.
    return (
      boundary > end - Math.max(64, Math.floor(maxChars / 10))
        ? clipped.slice(0, boundary)
        : clipped
    ).trim();
  }

  return {
    MAX_SOURCES,
    MAX_SOURCE_CHARS,
    MAX_SOURCE_BYTES,
    MAX_DOCUMENT_CHARS,
    MAX_ANSWER_CHARS,
    MIN_ANSWER_CHARS,
    FRAGMENT_OPTIONS,
    extractReadableText,
    hoverTitle,
    isCitationChipText,
    isReadableContentType,
    normalizeSourceUrl,
    packSources,
    regionForSpan,
    resolveAttributions,
    sourceLink,
    statusLabel,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TokenPathChatSources;
}
