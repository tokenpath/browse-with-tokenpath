// Pure helpers shared by the side-panel UI and its unit tests.

const TokenPathPanelLogic = (() => {
  const SHORT_SELECTION_WORDS = 24;
  // `maxOutputTokens` is headroom, not a target — the prompt controls length.
  // TokenPath's `/v1/generate` caps `max_output_tokens` at 2048 and bills
  // generation from the input text alone, so a lower ceiling saves nothing and
  // only risks cutting an answer off mid-sentence. Every generation path —
  // summaries and ordinary turns, page, PDF, selection, or video transcript —
  // asks for the whole ceiling.
  const SUMMARY_MAX_OUTPUT_TOKENS = 2_048;
  // "exactly 3", not "2-4": a range makes models drift to the upper bound and
  // makes the 360px panel's height jump between summaries.
  const SUMMARY_PROMPT =
    "Summarize the given text as exactly 3 concise Markdown bullet points. " +
    "Put the single most important takeaway first. Keep each bullet to one " +
    "sentence. Include only what someone needs to understand the source " +
    "quickly.";
  // The second preset. "Detailed" is not "longer": it is a different shape —
  // named sections over the claims, the evidence behind them, the limits the
  // source itself states, and where it lands — so the extra tokens buy
  // structure a reader can scan rather than a padded paragraph.
  const DETAILED_SUMMARY_PROMPT =
    "Write a thorough, structured summary of the given text. Open with one " +
    "short paragraph naming what the source is and its central claim. Then " +
    "use short Markdown section headings with bullet points under each, " +
    "covering: the main claims and what each one asserts; the supporting " +
    "details, evidence, examples, or figures behind them; the " +
    "qualifications, caveats, counterarguments, or limits the source itself " +
    "states; and the conclusions, recommendations, or open questions it ends " +
    "on. Keep every point traceable to something the source actually says, " +
    "prefer its own specific language over generic phrasing, and omit a " +
    "section the source does not address rather than padding it.";
  const SUMMARY_PROMPT_SUFFIX =
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a " +
    "preamble, an explanation, or a closing comment.";
  // Custom instructions replace the preset, never the suffix or the tail.
  // Bounded so a pasted document cannot become the prompt.
  const MAX_SUMMARY_INSTRUCTIONS_CHARS = 2_000;

  // Follow-up suggestions ride along on the answer's own generation call.
  // Generation is billed from the input text, so asking for them here is
  // free; a second call would re-pay for the whole document.
  const SUGGESTIONS_OPEN = "<<<SUGGESTIONS";
  const SUGGESTIONS_CLOSE = "SUGGESTIONS>>>";
  const SUGGESTION_CANDIDATES = 4;
  const MAX_SUGGESTION_CHIPS = 2;
  const SUGGESTIONS_TAIL =
    "\n\nAfter your answer is complete, and only then, append one block in " +
    "exactly this format:\n" +
    SUGGESTIONS_OPEN +
    "\n" +
    "Q: a question strictly answerable from the provided text, about " +
    "material this answer did not already cover\n" +
    'A: "a verbatim quote of at most 10 words from the provided text that ' +
    'the answer to that question would cite"\n' +
    SUGGESTIONS_CLOSE +
    "\n" +
    `Give exactly ${SUGGESTION_CANDIDATES} Q/A pairs inside that block, ` +
    "alternating Q then A, one per line. Copy every quote character for " +
    "character from the provided text. Write nothing after the closing " +
    SUGGESTIONS_CLOSE +
    " marker, and never mention this block in your answer.";

  function words(text) {
    return String(text || "").trim().match(/\S+/g) || [];
  }

  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const CJK_GLOBAL_RE = new RegExp(CJK_RE.source, "gu");

  // CJK prose has no word spaces, so whitespace tokens measure paragraphs
  // rather than words: a 5,000-character article split into ten paragraphs
  // counts as ten "words" and would look already concise. Judge the script
  // itself instead of trusting the token count.
  function isCjkDominant(text) {
    const dense = text.replace(/\s+/gu, "");
    if (!dense) return false;
    const cjk = dense.match(CJK_GLOBAL_RE);
    return !!cjk && cjk.length * 2 > Array.from(dense).length;
  }

  function measure(text) {
    const clean = String(text || "").trim();
    const wordList = words(clean);
    const codePoints = Array.from(clean);
    const characterMode =
      isCjkDominant(clean) || (wordList.length <= 1 && CJK_RE.test(clean));
    return {
      clean,
      wordList,
      codePoints,
      characterMode,
      units: characterMode ? codePoints.length : wordList.length,
    };
  }

  function boundSummaryInstructions(text) {
    // Defensive on read as well as on write: a hand-edited localStorage value
    // must not become an unbounded prompt.
    return String(text || "").slice(0, MAX_SUMMARY_INSTRUCTIONS_CHARS);
  }

  /** The editable half of the prompt for a preset, with no suffix or tail. */
  function summaryPresetPrompt(preset) {
    return preset === "detailed" ? DETAILED_SUMMARY_PROMPT : SUMMARY_PROMPT;
  }

  /**
   * @param {string} text captured source
   * @param {{preset?: string, customPrompt?: string|null}} [options]
   */
  function buildSummaryRequest(text, options = {}) {
    const source = measure(text);
    const shortLimit = source.characterMode ? 48 : SHORT_SELECTION_WORDS;
    if (source.units <= shortLimit) {
      return { skip: true };
    }

    const custom = boundSummaryInstructions(options.customPrompt).trim();
    const preset = options.preset === "detailed" ? "detailed" : "bullets";
    return {
      skip: false,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      // Custom instructions replace the preset's wording and nothing else:
      // the suffix still lands after them, and so does the suggestions tail.
      prompt: (custom || summaryPresetPrompt(preset)) + SUMMARY_PROMPT_SUFFIX,
      depth: custom ? "custom" : preset,
    };
  }

  /**
   * The tail every generation path appends after its question — summaries and
   * ordinary turns alike. It is never editable and never part of the question
   * sent to attribution.
   */
  function withSuggestionsTail(question) {
    return String(question == null ? "" : question) + SUGGESTIONS_TAIL;
  }

  function suggestionsBlockPattern() {
    // A fresh instance per call: a shared /g regex carries lastIndex.
    return /<<<SUGGESTIONS[\s\S]*?SUGGESTIONS>>>/g;
  }

  const SUGGESTION_QUOTE_PAIRS = [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"],
    ["'", "'"],
    ["«", "»"],
    ["「", "」"],
    ["„", "“"],
    ["<", ">"],
  ];

  function unwrapSuggestionText(value) {
    let text = String(value || "").trim();
    for (let pass = 0; pass < 3; pass++) {
      const pair = SUGGESTION_QUOTE_PAIRS.find(
        ([open, close]) =>
          text.length >= open.length + close.length + 1 &&
          text.startsWith(open) &&
          text.endsWith(close)
      );
      if (!pair) break;
      text = text.slice(pair[0].length, text.length - pair[1].length).trim();
    }
    return text;
  }

  function parseSuggestionsBlock(block) {
    const body = block.slice(
      SUGGESTIONS_OPEN.length,
      block.length - SUGGESTIONS_CLOSE.length
    );
    const candidates = [];
    let question = null;
    for (const rawLine of body.split(/\r?\n/)) {
      // Tolerate a model that bullets or bolds the lines; reject anything else.
      const line = rawLine
        .trim()
        .replace(/^[-*+]\s+/u, "")
        .replace(/^\*\*([\s\S]*)\*\*$/u, "$1")
        .trim();
      const asked = /^Q\s*[:.：]\s*([\s\S]+)$/u.exec(line);
      if (asked) {
        question = unwrapSuggestionText(asked[1]).slice(0, 240);
        continue;
      }
      const anchored = /^A\s*[:.：]\s*([\s\S]+)$/u.exec(line);
      if (!anchored) continue;
      const anchor = unwrapSuggestionText(anchored[1]);
      if (question && anchor) candidates.push({ question, anchor });
      question = null;
    }
    return candidates;
  }

  /**
   * Remove every suggestions block from an answer — plus a block the stream
   * cut off mid-way, which would otherwise be rendered as a garbled tail.
   * This runs on streaming deltas as well as on the terminal answer, so the
   * marker is never visible and never reaches attribution or the cache.
   */
  function stripSuggestionsBlock(answer) {
    const original = String(answer == null ? "" : answer);
    let value = original.replace(suggestionsBlockPattern(), "");
    // A nested or duplicated block can leave a closing marker behind. It is a
    // deliberately exotic string, so removing a stray one costs nothing and
    // keeps the marker out of the rendered answer.
    value = value.split(SUGGESTIONS_CLOSE).join("");
    const unterminated = value.lastIndexOf(SUGGESTIONS_OPEN);
    if (unterminated !== -1) {
      value = value.slice(0, unterminated);
    } else {
      // A delta may end part-way through the opening marker. Require at least
      // "<<<" so ordinary prose is never truncated.
      for (
        let length = Math.min(SUGGESTIONS_OPEN.length - 1, value.length);
        length >= 3;
        length--
      ) {
        const tail = value.slice(value.length - length);
        if (SUGGESTIONS_OPEN.startsWith(tail)) {
          value = value.slice(0, value.length - length);
          break;
        }
      }
    }
    // An answer that carried no block is returned byte for byte: the terminal
    // `done.answer` is canonical, and trimming it would desynchronize the
    // displayed text from the string sent to attribution.
    return value === original ? original : value.replace(/\s+$/u, "");
  }

  /**
   * Split a generated answer into the text to display, persist, and attribute,
   * and the follow-up candidates its tail block proposed. A malformed or
   * absent block yields no candidates and never garbles the answer.
   */
  function parseSuggestions(answer) {
    const text = String(answer == null ? "" : answer);
    const blocks = text.match(suggestionsBlockPattern()) || [];
    return {
      answer: stripSuggestionsBlock(text),
      // The last block wins: a model that restates the format mid-answer has
      // its final list taken as the real one.
      candidates: blocks.length
        ? parseSuggestionsBlock(blocks[blocks.length - 1])
        : [],
    };
  }

  /**
   * Collapse Unicode whitespace runs to single spaces while remembering where
   * every surviving character came from. The captured document already
   * collapses whitespace per text node but inserts block separators, so an
   * anchor quote spanning a block boundary only matches after both sides are
   * normalized the same way.
   */
  function normalizeWhitespaceWithMap(text) {
    const value = String(text || "");
    let normalized = "";
    const map = [];
    let index = 0;
    while (index < value.length) {
      if (/\s/u.test(value[index])) {
        let end = index;
        while (end < value.length && /\s/u.test(value[end])) end++;
        map.push(index);
        normalized += " ";
        index = end;
        continue;
      }
      map.push(index);
      normalized += value[index];
      index++;
    }
    map.push(value.length);
    return { text: normalized, map };
  }

  function findAnchorRange(anchor, normalizedDocument) {
    const needle = normalizeWhitespaceWithMap(anchor).text.trim();
    if (!needle) return null;
    const at = normalizedDocument.text.indexOf(needle);
    if (at === -1) return null;
    return {
      start: normalizedDocument.map[at],
      end: normalizedDocument.map[at + needle.length],
    };
  }

  /**
   * Gate one: a candidate survives only if its anchor quote appears verbatim
   * in the captured document, case-sensitively, once whitespace is collapsed
   * on both sides. Fail-closed — a fabricated quote drops the whole candidate.
   */
  function groundSuggestions(candidates, document) {
    const normalized = normalizeWhitespaceWithMap(document);
    const grounded = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const question = String(candidate?.question || "").trim();
      const anchor = String(candidate?.anchor || "").trim();
      if (!question || !anchor) continue;
      const key = question.toLowerCase();
      if (seen.has(key)) continue;
      const range = findAnchorRange(anchor, normalized);
      if (!range) continue;
      seen.add(key);
      grounded.push({
        question,
        anchor,
        start: range.start,
        end: range.end,
      });
    }
    return grounded;
  }

  function mergeRegions(regions) {
    const sorted = regions
      .filter(
        ([start, end]) =>
          Number.isFinite(start) && Number.isFinite(end) && end > start
      )
      .sort((first, second) => first[0] - second[0]);
    const merged = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
        continue;
      }
      merged.push([start, end]);
    }
    return merged;
  }

  /** The union of document regions the answer's returned spans cite. */
  function attributionCoveredRegions(attributions) {
    if (!Array.isArray(attributions)) return [];
    return mergeRegions(
      attributions.map((attribution) => [
        attribution?.source?.start,
        attribution?.source?.end,
      ])
    );
  }


  function distanceOutsideRegions(candidate, regions) {
    if (!regions.length) return 0;
    let best = Infinity;
    for (const [start, end] of regions) {
      if (candidate.start < end && start < candidate.end) return 0;
      const gap =
        candidate.start >= end ? candidate.start - end : start - candidate.end;
      if (gap < best) best = gap;
    }
    return Number.isFinite(best) ? best : 0;
  }

  function anchorCenter(candidate) {
    return (candidate.start + candidate.end) / 2;
  }

  /**
   * Gate two: rank grounded candidates by how far their anchors sit outside
   * the regions the answer already drew from, and by how far apart they are
   * from each other. Without attributions this degrades to a positional spread
   * biased toward the later part of the document, which the summary of a long
   * page is least likely to have reached.
   *
   * @param {Array} candidates output of groundSuggestions
   * @param {{attributions?: Array|null, max?: number}} [options]
   */
  function selectSuggestions(candidates, options = {}) {
    const pool = (Array.isArray(candidates) ? candidates : []).filter(
      (candidate) =>
        candidate &&
        Number.isFinite(candidate.start) &&
        Number.isFinite(candidate.end)
    );
    const max = Number.isInteger(options.max)
      ? options.max
      : MAX_SUGGESTION_CHIPS;
    if (pool.length === 0 || max <= 0) return [];

    const regions = options.attributions
      ? attributionCoveredRegions(options.attributions)
      : [];
    const base = (candidate) =>
      regions.length
        ? distanceOutsideRegions(candidate, regions)
        : // No coverage information: position alone, which prefers later
          // material over the opening the summary certainly used.
          candidate.start;

    // Landing inside a region the answer already drew on disqualifies a
    // candidate outright — spread never buys a slot back for one. Only when
    // every candidate overlaps does the whole pool come back into play.
    const outside = regions.length
      ? pool.filter((candidate) => distanceOutsideRegions(candidate, regions) > 0)
      : pool;
    const chosen = [];
    const remaining = (outside.length ? outside : pool).slice();
    while (chosen.length < max && remaining.length) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      let bestStart = -Infinity;
      for (let index = 0; index < remaining.length; index++) {
        const candidate = remaining[index];
        const separation = chosen.length
          ? Math.min(
              ...chosen.map((picked) =>
                Math.abs(anchorCenter(candidate) - anchorCenter(picked))
              )
            )
          : 0;
        const score = base(candidate) + separation;
        if (
          score > bestScore ||
          (score === bestScore && candidate.start > bestStart)
        ) {
          bestScore = score;
          bestStart = candidate.start;
          bestIndex = index;
        }
      }
      chosen.push(remaining.splice(bestIndex, 1)[0]);
    }
    return chosen;
  }

  /**
   * The depth ladder's fixed first chip. Slot 1 offers the next depth this
   * chat has not reached; generated candidates fill whatever is left.
   *
   * @returns {"summarize"|"detailed"|null}
   */
  function selectFixedLadderChip({
    hasSummary = false,
    lastSummaryDepth = null,
    defaultPreset = "bullets",
  } = {}) {
    if (!hasSummary) return "summarize";
    // Detailed is the deepest rung, and custom instructions replace the
    // ladder's wording entirely — neither has a deeper step to offer.
    if (lastSummaryDepth === "detailed" || lastSummaryDepth === "custom") {
      return null;
    }
    if (defaultPreset === "detailed" || defaultPreset === "custom") return null;
    return "detailed";
  }

  // TokenPath's limits use Unicode code points; String#slice uses UTF-16 code
  // units. Avoid splitting a surrogate pair at the document limit.
  function truncateCodePoints(text, maxCodePoints) {
    const value = String(text || "");
    if (!Number.isFinite(maxCodePoints) || maxCodePoints < 0) return value;
    let codePoints = 0;
    let codeUnits = 0;
    while (codeUnits < value.length && codePoints < maxCodePoints) {
      const point = value.codePointAt(codeUnits);
      codeUnits += point > 0xffff ? 2 : 1;
      codePoints++;
    }
    return value.slice(0, codeUnits);
  }

  return {
    MAX_SUGGESTION_CHIPS,
    MAX_SUMMARY_INSTRUCTIONS_CHARS,
    SHORT_SELECTION_WORDS,
    SUGGESTION_CANDIDATES,
    boundSummaryInstructions,
    buildSummaryRequest,
    groundSuggestions,
    attributionCoveredRegions,
    parseSuggestions,
    selectFixedLadderChip,
    selectSuggestions,
    stripSuggestionsBlock,
    summaryPresetPrompt,
    truncateCodePoints,
    withSuggestionsTail,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TokenPathPanelLogic;
}
