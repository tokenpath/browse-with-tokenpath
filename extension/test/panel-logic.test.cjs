const assert = require("assert");
const Logic = require("../sidepanel/panel-logic.js");

const textWithWords = (count) =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

for (const count of [1, 10, 24]) {
  const request = Logic.buildSummaryRequest(textWithWords(count));
  assert.strictEqual(request.skip, true, `${count} words should skip auto-summary`);
}
console.log("PASS: already-short selections skip model summarization");

// One prompt, one ceiling. TokenPath caps `max_output_tokens` at 2048 and
// bills generation from the input text alone, so every summary asks for the
// whole ceiling; concision is the prompt's job, not the ceiling's.
const summary = Logic.buildSummaryRequest(textWithWords(25));
assert.strictEqual(summary.skip, false);
assert.strictEqual(summary.maxOutputTokens, 2_048);
assert.match(summary.prompt, /exactly 3 concise Markdown bullet points/);
assert.match(summary.prompt, /most important takeaway first/);
assert.match(summary.prompt, /one sentence/);
assert.match(summary.prompt, /Finish the summary cleanly/);
assert.match(summary.prompt, /Do not add a title/);
// "exactly 3" is deliberate: a range makes models drift to its upper bound and
// makes the panel's height jump between summaries.
assert.doesNotMatch(summary.prompt, /2-4|2-3|4-6|8-12/);

// The request no longer varies by length tier or by source kind — a video
// transcript, a page, and a long CJK article all get the same prompt and the
// same ceiling.
const large = Logic.buildSummaryRequest(textWithWords(500));
assert.deepStrictEqual(large, summary);
const transcript = Logic.buildSummaryRequest(
  `Transcript. ${textWithWords(400)}`
);
assert.strictEqual(transcript.maxOutputTokens, summary.maxOutputTokens);
assert.strictEqual(transcript.prompt, summary.prompt);
// A transcript short enough to be already concise still skips generation.
assert.strictEqual(
  Logic.buildSummaryRequest("A very short transcript.").skip,
  true
);
console.log("PASS: every summary uses one 2048-token ceiling and one prompt");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.strictEqual(cjk.prompt, summary.prompt);
console.log("PASS: long CJK selections do not bypass summarization");

// A CJK article has no word spaces, so its paragraph breaks are the only
// whitespace: counting tokens would call a 5,000-character page ten "words".
const cjkParagraph = "这是一个用于验证中文文章摘要行为的段落".repeat(26);
const cjkArticle = Array.from({ length: 10 }, () => cjkParagraph).join("\n");
assert.ok(cjkArticle.length > 4_000);
assert.ok(cjkArticle.trim().match(/\S+/g).length <= Logic.SHORT_SELECTION_WORDS);
const cjkArticleSummary = Logic.buildSummaryRequest(cjkArticle);
assert.strictEqual(cjkArticleSummary.skip, false);
assert.strictEqual(cjkArticleSummary.maxOutputTokens, 2_048);

// Japanese and Korean use the same character-aware path.
for (const long of [
  "これは日本語の長い記事です。".repeat(12) + "\n" + "段落が変わります。".repeat(12),
  "이것은 한국어로 된 긴 기사입니다.".repeat(8) + "\n" + "문단이 바뀝니다.".repeat(8),
]) {
  assert.strictEqual(Logic.buildSummaryRequest(long).skip, false, long.slice(0, 8));
}

// Genuinely short CJK stays "already concise", including across paragraphs.
assert.strictEqual(Logic.buildSummaryRequest("这是一个很短的段落。\n第二段也很短。").skip, true);
assert.strictEqual(Logic.buildSummaryRequest("短い。\nとても短い。").skip, true);

// Mixed text that is mostly Latin keeps the word-count cutoff.
const latinWithCjk = `${textWithWords(20)} 漢字 ${textWithWords(3)}`;
assert.strictEqual(Logic.buildSummaryRequest(latinWithCjk).skip, true);
assert.strictEqual(
  Logic.buildSummaryRequest(`${textWithWords(60)} 漢字`).skip,
  false
);
console.log("PASS: multi-paragraph CJK articles use the character-aware cutoff");

assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 3), "ab🙂");
assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 4), "ab🙂c");
console.log("PASS: document limits never split emoji surrogate pairs");

// ---------------------------------------------------------------------------
// Summary presets, custom instructions, and the suggestions tail
// ---------------------------------------------------------------------------

const detailed = Logic.buildSummaryRequest(textWithWords(300), {
  preset: "detailed",
});
assert.strictEqual(detailed.skip, false);
assert.strictEqual(detailed.depth, "detailed");
// Same ceiling as every other generation path: output is free.
assert.strictEqual(detailed.maxOutputTokens, 2_048);
assert.match(detailed.prompt, /thorough, structured summary/);
assert.match(detailed.prompt, /main claims/);
assert.match(detailed.prompt, /supporting\s+details, evidence/);
assert.match(detailed.prompt, /qualifications, caveats/);
assert.match(detailed.prompt, /conclusions, recommendations/);
// The suffix is shared with the 3-bullet preset, never replaced by it.
assert.ok(
  detailed.prompt.endsWith(
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a " +
      "preamble, an explanation, or a closing comment."
  )
);
assert.doesNotMatch(detailed.prompt, /exactly 3 concise Markdown bullet/);
// An unknown preset falls back to the 3-bullet default rather than guessing.
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(300), { preset: "wat" }).prompt,
  Logic.buildSummaryRequest(textWithWords(300)).prompt
);
// A short source still skips generation whatever the preset says.
assert.strictEqual(
  Logic.buildSummaryRequest("Three words only", { preset: "detailed" }).skip,
  true
);
console.log("PASS: the Detailed preset is a distinct prompt at the same ceiling");

const customInstructions =
  "List every dollar figure in the text with the sentence it came from.";
const custom = Logic.buildSummaryRequest(textWithWords(300), {
  preset: "detailed",
  customPrompt: customInstructions,
});
// Custom instructions replace the preset's wording — and only that.
assert.strictEqual(custom.depth, "custom");
assert.ok(custom.prompt.startsWith(customInstructions));
assert.doesNotMatch(custom.prompt, /thorough, structured summary/);
assert.doesNotMatch(custom.prompt, /exactly 3 concise Markdown bullet/);
assert.match(custom.prompt, /Finish the summary cleanly/);
// Whitespace-only custom instructions are not a customization.
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(300), { customPrompt: "   \n " })
    .depth,
  "bullets"
);
// The stored value is bounded on read, not merely on write.
const overlong = "x".repeat(Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS + 500);
assert.strictEqual(
  Logic.boundSummaryInstructions(overlong).length,
  Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS
);
const boundedCustom = Logic.buildSummaryRequest(textWithWords(300), {
  customPrompt: overlong,
});
assert.strictEqual(
  boundedCustom.prompt.length,
  Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS +
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a preamble, an explanation, or a closing comment."
      .length
);
assert.ok(
  Logic.summaryPresetPrompt("detailed").includes("thorough, structured summary")
);
assert.strictEqual(
  Logic.summaryPresetPrompt("bullets"),
  Logic.summaryPresetPrompt("anything else")
);
console.log("PASS: custom instructions replace the preset, never the suffix");

// The tail is appended after the question or prompt+suffix, for every path.
for (const question of [
  custom.prompt,
  detailed.prompt,
  "What did the author conclude?",
]) {
  const tailed = Logic.withSuggestionsTail(question);
  assert.ok(tailed.startsWith(question));
  assert.match(tailed, /<<<SUGGESTIONS/);
  assert.match(tailed, /SUGGESTIONS>>>/);
  assert.match(tailed, /exactly 4 Q\/A pairs/);
  assert.match(tailed, /verbatim quote of at most 10 words/);
}
assert.strictEqual(Logic.SUGGESTION_CANDIDATES, 4);
assert.strictEqual(Logic.MAX_SUGGESTION_CHIPS, 2);
console.log("PASS: every generation path can append the same suggestions tail");

// ---------------------------------------------------------------------------
// Suggestions tail parsing
// ---------------------------------------------------------------------------

const wellFormed = Logic.parseSuggestions(
  "- The report says revenue grew.\n" +
    "- It also names three risks.\n\n" +
    "<<<SUGGESTIONS\n" +
    "Q: What were the three named risks?\n" +
    'A: "supply concentration, currency exposure, and hiring"\n' +
    "Q: How large was the dividend?\n" +
    'A: "a dividend of $1.24 per share"\n' +
    "SUGGESTIONS>>>\n"
);
assert.strictEqual(
  wellFormed.answer,
  "- The report says revenue grew.\n- It also names three risks."
);
assert.ok(!wellFormed.answer.includes("SUGGESTIONS"));
assert.deepStrictEqual(wellFormed.candidates, [
  {
    question: "What were the three named risks?",
    anchor: "supply concentration, currency exposure, and hiring",
  },
  {
    question: "How large was the dividend?",
    anchor: "a dividend of $1.24 per share",
  },
]);

// No block at all: the answer is untouched and nothing is suggested.
const plain = Logic.parseSuggestions("A perfectly ordinary answer.");
assert.strictEqual(plain.answer, "A perfectly ordinary answer.");
assert.deepStrictEqual(plain.candidates, []);

// A block the stream never closed is a garbled tail, not content.
const truncated = Logic.parseSuggestions(
  'The answer body.\n\n<<<SUGGESTIONS\nQ: What else?\nA: "the quote'
);
assert.strictEqual(truncated.answer, "The answer body.");
assert.deepStrictEqual(truncated.candidates, []);

// The same is true of a delta that stopped part-way through the marker.
assert.strictEqual(
  Logic.stripSuggestionsBlock("Body text.\n\n<<<SUGG"),
  "Body text."
);
assert.strictEqual(Logic.stripSuggestionsBlock("Body text.\n\n<<<"), "Body text.");
// Ordinary prose that merely contains angle brackets is never truncated.
assert.strictEqual(Logic.stripSuggestionsBlock("a < b"), "a < b");
assert.strictEqual(
  Logic.stripSuggestionsBlock("Use <div> and <<"),
  "Use <div> and <<"
);

// Malformed pairs are dropped individually; the block still parses.
const malformed = Logic.parseSuggestions(
  "Body.\n<<<SUGGESTIONS\n" +
    "Q: A question with no anchor\n" +
    "Q: A question that does have one\n" +
    'A: "the anchor"\n' +
    'A: "an anchor with no question"\n' +
    "not a pair at all\n" +
    "SUGGESTIONS>>>"
);
assert.strictEqual(malformed.answer, "Body.");
assert.deepStrictEqual(malformed.candidates, [
  { question: "A question that does have one", anchor: "the anchor" },
]);

// Several blocks: the last one is authoritative and every one is stripped.
const multiple = Logic.parseSuggestions(
  'First part.\n<<<SUGGESTIONS\nQ: Early question?\nA: "early anchor"\nSUGGESTIONS>>>\n' +
    'Second part.\n<<<SUGGESTIONS\nQ: Late question?\nA: "late anchor"\nSUGGESTIONS>>>'
);
assert.strictEqual(multiple.answer, "First part.\n\nSecond part.");
assert.ok(!multiple.answer.includes("SUGGESTIONS"));
assert.deepStrictEqual(multiple.candidates, [
  { question: "Late question?", anchor: "late anchor" },
]);

// A nested opener inside a block is inert text, and nothing leaks out.
const nested = Logic.parseSuggestions(
  'Body.\n<<<SUGGESTIONS\n<<<SUGGESTIONS\nQ: Nested question?\nA: "nested anchor"\nSUGGESTIONS>>>\nSUGGESTIONS>>>'
);
assert.ok(!nested.answer.includes("SUGGESTIONS"));
assert.strictEqual(nested.answer, "Body.");
assert.deepStrictEqual(nested.candidates, [
  { question: "Nested question?", anchor: "nested anchor" },
]);

// CJK, emoji, curly quotes, and bulleted lines all round-trip.
const unicode = Logic.parseSuggestions(
  "答案正文。\n<<<SUGGESTIONS\n" +
    "- Q: 作者提到了哪三个风险？\n" +
    "- A: “供应链集中、汇率波动与招聘”\n" +
    "**Q: Which emoji did the post use? 🎓**\n" +
    "A: 'the graduation cap 🎓 in the headline'\n" +
    "SUGGESTIONS>>>"
);
assert.strictEqual(unicode.answer, "答案正文。");
assert.deepStrictEqual(unicode.candidates, [
  { question: "作者提到了哪三个风险？", anchor: "供应链集中、汇率波动与招聘" },
  {
    question: "Which emoji did the post use? 🎓",
    anchor: "the graduation cap 🎓 in the headline",
  },
]);

// A model that echoes the template's angle-bracket placeholders is unwrapped.
assert.deepStrictEqual(
  Logic.parseSuggestions(
    'Body.\n<<<SUGGESTIONS\nQ: <What is the deadline?>\nA: <"before 5pm on Friday">\nSUGGESTIONS>>>'
  ).candidates,
  [{ question: "What is the deadline?", anchor: "before 5pm on Friday" }]
);
console.log("PASS: the suggestions tail is parsed and never rendered");

// ---------------------------------------------------------------------------
// Gate one: the anchor quote must exist verbatim in the captured document
// ---------------------------------------------------------------------------

const groundDocument =
  "The board approved the plan.\nRevenue grew\n   by  eleven percent\n" +
  "across the quarter. 供应链集中 remained the largest risk 🎓 overall.";
const grounded = Logic.groundSuggestions(
  [
    { question: "How much did revenue grow?", anchor: "grew by eleven percent" },
    { question: "Fabricated?", anchor: "revenue fell by nine percent" },
    { question: "Wrong case?", anchor: "The Board Approved" },
    { question: "CJK anchor?", anchor: "供应链集中" },
    { question: "Emoji anchor?", anchor: "largest risk 🎓" },
    { question: "", anchor: "the board approved" },
    { question: "No anchor?", anchor: "" },
  ],
  groundDocument
);
assert.deepStrictEqual(
  grounded.map((candidate) => candidate.question),
  ["How much did revenue grow?", "CJK anchor?", "Emoji anchor?"]
);
// The whitespace-collapsed match still reports offsets into the real document.
const growth = grounded[0];
assert.strictEqual(
  groundDocument.slice(growth.start, growth.end),
  "grew\n   by  eleven percent"
);
const emojiAnchor = grounded[2];
assert.strictEqual(
  groundDocument.slice(emojiAnchor.start, emojiAnchor.end),
  "largest risk 🎓"
);
// A quote that only differs by line breaks and runs of spaces still matches.
assert.strictEqual(
  Logic.groundSuggestions(
    [{ question: "Across?", anchor: "percent   across\n\nthe quarter" }],
    groundDocument
  ).length,
  1
);
// Duplicate questions collapse to one candidate.
assert.strictEqual(
  Logic.groundSuggestions(
    [
      { question: "Same?", anchor: "the plan" },
      { question: "same?", anchor: "Revenue grew" },
    ],
    groundDocument
  ).length,
  1
);
console.log("PASS: a fabricated anchor quote drops its whole candidate");

// ---------------------------------------------------------------------------
// Gate two: coverage ranking against returned attribution spans
// ---------------------------------------------------------------------------

const coverageDocument =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";

const coverageAttributions = [
  {
    answer: { start: 0, end: 3, text: "one" },
    source: {
      start: 0,
      end: coverageDocument.indexOf("delta") - 1,
      text: coverageDocument.slice(0, coverageDocument.indexOf("delta") - 1),
      confidence: 0.9,
    },
  },
];
assert.deepStrictEqual(
  Logic.attributionCoveredRegions(coverageAttributions),
  [[0, coverageDocument.indexOf("delta") - 1]]
);

const at = (word) => ({
  start: coverageDocument.indexOf(word),
  end: coverageDocument.indexOf(word) + word.length,
});
const coverageCandidates = [
  { question: "Covered opening?", ...at("beta") },
  { question: "Just outside?", ...at("epsilon") },
  { question: "Far end?", ...at("xi") },
  { question: "Middle?", ...at("iota") },
];
const ranked = Logic.selectSuggestions(coverageCandidates, {
  attributions: coverageAttributions,
});
assert.strictEqual(ranked.length, 2);
// The anchor inside the region the answer already used never wins a slot.
assert.ok(!ranked.some((candidate) => candidate.question === "Covered opening?"));
// Farthest from the covered region first.
assert.strictEqual(ranked[0].question, "Far end?");
// The second slot goes to an anchor that is both outside the covered region
// and well away from the first pick.
assert.ok(
  Math.abs(ranked[1].start - ranked[0].start) >
    coverageDocument.indexOf("iota") - coverageDocument.indexOf("epsilon")
);
// Never more than two chips, and never more than there are candidates.
assert.strictEqual(
  Logic.selectSuggestions(coverageCandidates.slice(0, 1), {
    attributions: coverageAttributions,
  }).length,
  1
);
assert.deepStrictEqual(Logic.selectSuggestions([], {}), []);

// Without attributions the fallback spreads positionally, biased later.
const spread = Logic.selectSuggestions(coverageCandidates, {});
assert.strictEqual(spread.length, 2);
assert.strictEqual(spread[0].question, "Far end?");
assert.ok(spread[1].start < spread[0].start);
console.log("PASS: coverage ranking prefers material the answer did not use");

// ---------------------------------------------------------------------------
// The depth ladder's fixed first chip
// ---------------------------------------------------------------------------

assert.strictEqual(
  Logic.selectFixedLadderChip({ hasSummary: false }),
  "summarize"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: false,
    defaultPreset: "detailed",
  }),
  "summarize"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "bullets",
    defaultPreset: "bullets",
  }),
  "detailed"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "detailed",
    defaultPreset: "bullets",
  }),
  null
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "bullets",
    defaultPreset: "detailed",
  }),
  null
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "custom",
    defaultPreset: "custom",
  }),
  null
);
assert.strictEqual(Logic.selectFixedLadderChip(), "summarize");
console.log("PASS: the depth ladder offers only the rung this chat has not used");

console.log("\nAll panel-logic assertions passed.");
