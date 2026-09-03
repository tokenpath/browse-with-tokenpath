// Chat citation mode — the pure logic behind phrase-level source links in a
// ChatGPT or Claude answer.
//
// Three files are covered here, and all three are the real shipped sources:
// text-fragments.js (the `#:~:text=` directive), chat-sources.js (reading a
// cited page, packing several of them into the one document
// /v1/attributions takes, and mapping the returned spans back), and the
// offset helpers inside chat-citations.js, which are reached through the
// `__tokenpathChatCitationHooks` export the harness creates before the
// content script is evaluated.

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const TextFragments = require("../text-fragments.js");
// chat-sources.js reads TokenPathTextFragments from the global scope, exactly
// as it does in the service worker (importScripts) and in the content script
// (the manifest lists text-fragments.js first).
globalThis.TokenPathTextFragments = TextFragments;
const ChatSources = require("../chat-sources.js");

const CHAT_CITATIONS = readFileSync(
  join(__dirname, "..", "chat-citations.js"),
  "utf8"
);

// The content script only exports its helpers when a harness has already
// created the hook object; `withHooks: false` proves it stays inert on a page,
// where nothing defines it.
function loadChatCitations(withHooks = true) {
  const hooks = {};
  const sandbox = {
    Map,
    WeakMap,
    MutationObserver: class {
      observe() {}
      takeRecords() {
        return [];
      }
    },
    TokenPathChatSources: ChatSources,
    TokenPathTextFragments: TextFragments,
    chrome: {
      storage: {
        local: { get: () => Promise.resolve({}), set() {} },
        onChanged: { addListener() {} },
      },
      runtime: { sendMessage: () => Promise.resolve({ ok: true }) },
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout() {},
    clearTimeout() {},
  };
  if (withHooks) sandbox.__tokenpathChatCitationHooks = hooks;
  const context = vm.createContext(sandbox);
  context.globalThis = context;
  vm.runInContext(CHAT_CITATIONS, context);
  return { hooks, sandbox };
}

// A stand-in for a live Text node: piecesForSpan reads only `isConnected` and
// hands the node straight back, so the caller can wrap it.
function textNode(data, connected = true) {
  return { data, isConnected: connected, nodeType: 3 };
}

function buildMap(hooks, chunks) {
  const map = [];
  let text = "";
  for (const chunk of chunks) {
    const node = textNode(chunk);
    const { out, offsets } = hooks.normalizeNodeText(chunk);
    const start = text.length;
    text += out;
    map.push({ node, start, end: text.length, offsets });
  }
  return { text, map };
}

// --- text-fragments.js ------------------------------------------------------

test("a short unique target spends no context in ambiguous mode", () => {
  const document = "The first paragraph. The rate rose to 18% last year.";
  const start = document.indexOf("18%");
  const directive = TextFragments.build(document, start, start + 3, {
    context: "ambiguous",
  });
  assert.equal(directive, "18%25");
});

test("a repeated target takes prefix and suffix in ambiguous mode", () => {
  const document = "It rose 18% in June. Elsewhere it rose 18% again.";
  const start = document.indexOf("18%");
  const directive = TextFragments.build(document, start, start + 3, {
    context: "ambiguous",
    contextChars: 16,
  });
  assert.equal(directive, "It%20rose-,18%25,-in%20June.");
});

test("always-context is the default, and is what the PDF caller relies on", () => {
  const document = "Alpha beta gamma delta epsilon.";
  const start = document.indexOf("gamma");
  const directive = TextFragments.build(document, start, start + 5);
  assert.equal(directive, "Alpha%20beta-,gamma,-delta%20epsilon.");
});

test("a long target becomes textStart,textEnd", () => {
  const body = `Opening. ${"word ".repeat(60)}Closing.`;
  const directive = TextFragments.build(body, 0, body.length, {
    context: "ambiguous",
    fullTargetChars: 40,
    edgeChars: 20,
  });
  const parts = directive.split(",");
  assert.equal(parts.length, 2, directive);
  assert.ok(decodeURIComponent(parts[0]).startsWith("Opening."), parts[0]);
  assert.ok(decodeURIComponent(parts[1]).endsWith("Closing."), parts[1]);
});

test("directive parts never leak the text-fragment grammar", () => {
  const document = "a -,b,-c & d";
  const directive = TextFragments.build(document, 0, document.length, {
    context: "ambiguous",
  });
  // The whole target is one part: no unescaped comma or hyphen may survive.
  assert.equal(directive.split(",").length, 1, directive);
  assert.ok(!directive.includes("-"), directive);
});

test("a span that splits a surrogate pair grows to keep the pair whole", () => {
  const document = `before ${"\u{1F600}"} after`;
  const emojiStart = document.indexOf("\u{1F600}");
  const directive = TextFragments.build(document, emojiStart + 1, emojiStart + 2, {
    context: "ambiguous",
  });
  assert.equal(decodeURIComponent(directive), "\u{1F600}");
});

test("an out-of-range or whitespace-only span names no passage", () => {
  assert.equal(TextFragments.build("short", -1, 2), null);
  assert.equal(TextFragments.build("short", 2, 2), null);
  assert.equal(TextFragments.build("short", 0, 99), null);
  assert.equal(TextFragments.build("a   b", 1, 4), null);
});

test("a directive replaces an existing one and keeps a plain anchor", () => {
  assert.equal(
    TextFragments.withDirective("https://e.com/p#:~:text=old", "new"),
    "https://e.com/p#:~:text=new"
  );
  assert.equal(
    TextFragments.withDirective("https://e.com/p#section", "new"),
    "https://e.com/p#section:~:text=new"
  );
  assert.equal(
    TextFragments.withDirective("https://e.com/p", "new"),
    "https://e.com/p#:~:text=new"
  );
});

// --- chat-sources.js: cited URLs -------------------------------------------

test("a cited URL is canonicalized to the document it names", () => {
  assert.equal(
    ChatSources.normalizeSourceUrl(
      "https://example.com/a?utm_source=chatgpt.com&utm_medium=x&id=7#frag"
    ),
    "https://example.com/a?id=7"
  );
  assert.equal(
    ChatSources.normalizeSourceUrl("https://example.com/a?fbclid=1&gclid=2"),
    "https://example.com/a"
  );
  // The same page cited from two answers has to be one cache entry.
  assert.equal(
    ChatSources.normalizeSourceUrl("https://example.com/a?utm_source=chatgpt.com"),
    ChatSources.normalizeSourceUrl("https://example.com/a")
  );
});

test("only fetchable web pages survive normalization", () => {
  for (const rejected of [
    "javascript:alert(1)",
    "data:text/html,<b>x</b>",
    "chrome-extension://abc/page.html",
    "mailto:a@b.com",
    "/relative/only",
    "",
    null,
    42,
  ]) {
    assert.equal(ChatSources.normalizeSourceUrl(rejected), null, String(rejected));
  }
  assert.equal(
    ChatSources.normalizeSourceUrl("/docs/page", "https://example.com/chat"),
    "https://example.com/docs/page"
  );
});

test("credentials embedded in a cited URL are dropped", () => {
  assert.equal(
    ChatSources.normalizeSourceUrl("https://user:pass@example.com/a"),
    "https://example.com/a"
  );
});

// --- chat-sources.js: chips versus prose ----------------------------------

test("a citation chip's text is excluded but a prose link's text is kept", () => {
  const url = "https://www.reuters.com/world/story";
  for (const chip of ["1", "[2]", "(3)", " 1,2 ", "reuters.com", "Reuters", ""]) {
    assert.equal(ChatSources.isCitationChipText(chip, url), true, chip);
  }
  for (const prose of [
    "the agency's own filing",
    "rose sharply in June",
    "a long sentence fragment that happens to be a link in the answer text",
  ]) {
    assert.equal(ChatSources.isCitationChipText(prose, url), false, prose);
  }
});

test("a chip that pairs a label with its domain is still a chip", () => {
  assert.equal(
    ChatSources.isCitationChipText(
      "Reuters · reuters.com",
      "https://reuters.com/x"
    ),
    true
  );
  // A sentence that merely mentions the domain is prose, not a chip.
  assert.equal(
    ChatSources.isCitationChipText(
      "the reuters.com report described a longer sequence of events than the summary suggests",
      "https://reuters.com/x"
    ),
    false
  );
});

// --- chat-sources.js: readable text ---------------------------------------

test("readable text keeps the article and drops the page chrome", () => {
  const html = `<!doctype html><html><head>
      <title>T</title><style>.a{color:red}</style>
      <script>var leaked = "SCRIPTTEXT";</script>
    </head><body>
      <nav>Home About Contact</nav>
      <header>Site name</header>
      <article>
        <h1>Rates in June</h1>
        <p>The rate rose to 18&#37; last year&nbsp;&mdash; the largest jump
           on record.</p>
        <p>${"Filler prose to make this region substantial. ".repeat(12)}</p>
        <figcaption>Photo: someone</figcaption>
      </article>
      <aside>Related stories</aside>
      <footer>© 2026</footer>
    </body></html>`;
  const text = ChatSources.extractReadableText(html);
  assert.ok(!text.includes("SCRIPTTEXT"), text);
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("Home About Contact"));
  assert.ok(!text.includes("Related stories"));
  assert.ok(!text.includes("Photo: someone"));
  assert.ok(text.startsWith("Rates in June"), text.slice(0, 40));
  assert.ok(text.includes("rose to 18% last year — the largest jump on record."));
});

test("a shell <main> falls back to the body", () => {
  const html = `<body><main><div id="root"></div></main>
    <div>${"Real prose that the page rendered server side. ".repeat(10)}</div>
    </body>`;
  const text = ChatSources.extractReadableText(html);
  assert.ok(text.startsWith("Real prose"), text.slice(0, 40));
});

test("an unclosed script never leaks its body as prose", () => {
  const text = ChatSources.extractReadableText(
    "<body><p>Kept.</p><script>var a = 1; leaked()"
  );
  assert.equal(text, "Kept.");
});

test("block structure survives as newlines and inline runs do not", () => {
  const text = ChatSources.extractReadableText(
    "<body><p>One</p><p>Two<br>Three</p><ul><li>A</li><li>B</li></ul>" +
      "<p>Four <em>and</em> five</p></body>"
  );
  assert.equal(text, "One\nTwo\nThree\nA\nB\nFour and five");
});

test("numeric and named entities decode, and broken ones stay literal", () => {
  const text = ChatSources.extractReadableText(
    "<body><p>&#8212; &mdash; &#x2014; &notanentity; &amp;amp; &#xD800;</p></body>"
  );
  assert.equal(text, "— — — &notanentity; &amp; &#xD800;");
});

test("a source is truncated on a whitespace boundary", () => {
  const html = `<body><p>${"alpha beta ".repeat(200)}</p></body>`;
  const text = ChatSources.extractReadableText(html, { maxChars: 100 });
  assert.ok(text.length <= 100, String(text.length));
  assert.ok(!/\s$/.test(text));
  assert.ok(text.endsWith("alpha") || text.endsWith("beta"), text.slice(-12));
});

test("only HTML content types are read", () => {
  assert.equal(ChatSources.isReadableContentType("text/html; charset=utf-8"), true);
  assert.equal(ChatSources.isReadableContentType("application/xhtml+xml"), true);
  assert.equal(ChatSources.isReadableContentType("application/pdf"), false);
  assert.equal(ChatSources.isReadableContentType("image/png"), false);
  assert.equal(ChatSources.isReadableContentType(null), false);
});

// --- chat-sources.js: packing and span mapping ----------------------------

test("packed regions slice back to each source's own text exactly", () => {
  const sources = [
    { url: "https://a.example/1", text: "Alpha source text." },
    { url: "https://b.example/2", text: "Beta source text." },
  ];
  const { document, regions } = ChatSources.packSources(sources);
  assert.equal(regions.length, 2);
  for (const region of regions) {
    assert.equal(document.slice(region.start, region.end), region.text);
  }
  assert.ok(document.includes("=== Source 1: https://a.example/1 ==="));
  assert.ok(document.includes("=== Source 2: https://b.example/2 ==="));
  assert.equal(regions[0].url, "https://a.example/1");
  assert.equal(regions[1].index, 1);
});

test("packing stops at the source cap and at the document ceiling", () => {
  const many = Array.from({ length: 25 }, (_, index) => ({
    url: `https://e.example/${index}`,
    text: `Source ${index} text.`,
  }));
  assert.equal(
    ChatSources.packSources(many).regions.length,
    ChatSources.MAX_SOURCES
  );

  const long = Array.from({ length: 4 }, (_, index) => ({
    url: `https://e.example/${index}`,
    text: "x ".repeat(400),
  }));
  const capped = ChatSources.packSources(long, { maxChars: 1_200 });
  assert.ok(capped.document.length <= 1_200, String(capped.document.length));
  assert.ok(capped.regions.length >= 1 && capped.regions.length < 4);
  for (const region of capped.regions) {
    assert.equal(capped.document.slice(region.start, region.end), region.text);
  }
});

test("a source with no readable text takes no slot", () => {
  const { regions } = ChatSources.packSources([
    { url: "https://a.example/1", text: "" },
    { url: "", text: "orphaned" },
    { url: "https://b.example/2", text: "Kept." },
  ]);
  assert.deepEqual(
    regions.map((region) => region.url),
    ["https://b.example/2"]
  );
});

function twoSourceFixture() {
  return ChatSources.packSources([
    {
      url: "https://a.example/one",
      text: "Alpha reports the rate rose to 18% in June.",
    },
    {
      url: "https://b.example/two",
      text: "Beta says the programme covered 40,000 households.",
    },
  ]);
}

test("each answer span is linked to the page its source span landed in", () => {
  const { document, regions } = twoSourceFixture();
  const first = document.indexOf("18%");
  const second = document.indexOf("40,000 households");
  const resolved = ChatSources.resolveAttributions({
    regions,
    spans: [
      {
        answer: { start: 10, end: 13, text: "18%" },
        source: {
          start: first,
          end: first + 3,
          text: "18%",
          confidence: 0.9,
        },
      },
      {
        answer: { start: 30, end: 47, text: "40,000 households" },
        source: {
          start: second,
          end: second + 17,
          text: "40,000 households",
          confidence: 0.7,
        },
      },
    ],
  });
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].source.url, "https://a.example/one");
  assert.equal(resolved[1].source.url, "https://b.example/two");
  // Source offsets are rebased onto the page a click opens, not the packed
  // document TokenPath saw.
  assert.equal(
    regions[0].text.slice(resolved[0].source.start, resolved[0].source.end),
    "18%"
  );
  assert.ok(
    resolved[0].source.link.startsWith("https://a.example/one#:~:text="),
    resolved[0].source.link
  );
  assert.equal(
    decodeURIComponent(resolved[1].source.link.split("#:~:text=")[1]),
    "40,000 households"
  );
  assert.equal(resolved[0].answer.start, 10);
});

test("a span below the confidence threshold is not linked", () => {
  const { document, regions } = twoSourceFixture();
  const start = document.indexOf("18%");
  const span = {
    answer: { start: 0, end: 3, text: "18%" },
    source: { start, end: start + 3, text: "18%", confidence: 0.2 },
  };
  assert.equal(
    ChatSources.resolveAttributions({ regions, spans: [span] }).length,
    0
  );
  assert.equal(
    ChatSources.resolveAttributions({
      regions,
      spans: [span],
      minConfidence: 0.1,
    }).length,
    1
  );
});

test("a span in a header, or across two sources, names no page and is dropped", () => {
  const { document, regions } = twoSourceFixture();
  const headerStart = document.indexOf("=== Source 2");
  const straddleStart = regions[0].end - 4;
  const resolved = ChatSources.resolveAttributions({
    regions,
    spans: [
      {
        answer: { start: 0, end: 5, text: "first" },
        source: {
          start: headerStart,
          end: headerStart + 12,
          text: document.slice(headerStart, headerStart + 12),
          confidence: 0.95,
        },
      },
      {
        answer: { start: 6, end: 12, text: "second" },
        source: {
          start: straddleStart,
          end: regions[1].start + 4,
          text: document.slice(straddleStart, regions[1].start + 4),
          confidence: 0.95,
        },
      },
    ],
  });
  assert.deepEqual(resolved, []);
});

test("overlapping answer spans keep the stronger source", () => {
  const { document, regions } = twoSourceFixture();
  const weak = document.indexOf("18%");
  const strong = document.indexOf("40,000");
  const resolved = ChatSources.resolveAttributions({
    regions,
    spans: [
      {
        answer: { start: 0, end: 20, text: "-".repeat(20) },
        source: { start: weak, end: weak + 3, text: "18%", confidence: 0.5 },
      },
      {
        answer: { start: 10, end: 30, text: "-".repeat(20) },
        source: {
          start: strong,
          end: strong + 6,
          text: "40,000",
          confidence: 0.95,
        },
      },
    ],
  });
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].source.url, "https://b.example/two");
});

test("the badge says what happened to the sources, not just to the spans", () => {
  assert.equal(
    ChatSources.statusLabel({ requested: 9, fetched: 7, spans: 23 }),
    "TokenPath: 7/9 sources · 23 phrases"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 2, fetched: 2, spans: 1 }),
    "TokenPath: 2/2 sources · 1 phrase"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 3, fetched: 3, spans: 0 }),
    "TokenPath: 3/3 sources · no linked phrases"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 4, fetched: 0 }),
    "TokenPath: couldn't read any of 4 cited pages"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 1, fetched: 0 }),
    "TokenPath: couldn't read the cited page"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 0 }),
    "TokenPath: no web sources cited"
  );
  assert.equal(
    ChatSources.statusLabel({ requested: 2, fetched: 2, error: "rate limited" }),
    "TokenPath: rate limited"
  );
});

test("hover text names the site and quotes the supporting passage", () => {
  assert.equal(
    ChatSources.hoverTitle("https://www.example.com/a", "  The rate\nrose.  "),
    "example.com — “The rate rose.”"
  );
  const long = ChatSources.hoverTitle(
    "https://example.com/a",
    "word ".repeat(80)
  );
  assert.ok(long.endsWith("…”"), long.slice(-8));
  assert.ok(long.length < 160, String(long.length));
});

// --- chat-citations.js: answer offsets ------------------------------------

test("the content script stays inert until a harness asks for its helpers", () => {
  const { sandbox } = loadChatCitations(false);
  assert.equal(sandbox.__tokenpathChatCitationHooks, undefined);
  const { hooks } = loadChatCitations(true);
  assert.equal(typeof hooks.piecesForSpan, "function");
});

test("whitespace runs collapse and every kept character keeps its source index", () => {
  const { hooks } = loadChatCitations();
  const { out, offsets } = hooks.normalizeNodeText("  the\n\trate  rose ");
  assert.equal(out, " the rate rose ");
  assert.equal(offsets.length, out.length);
  // Every emitted character indexes back to the raw node data: a kept
  // character to itself, a collapsed run to its first whitespace character.
  const raw = "  the\n\trate  rose ";
  for (let index = 0; index < out.length; index++) {
    const source = raw[offsets[index]];
    if (out[index] === " ") assert.match(source, /\s/);
    else assert.equal(source, out[index]);
  }
});

test("a span inside one text node resolves to that node's raw offsets", () => {
  const { hooks } = loadChatCitations();
  const { text, map } = buildMap(hooks, ["The rate rose to 18% in June."]);
  const start = text.indexOf("18%");
  const pieces = hooks.piecesForSpan(map, start, start + 3);
  assert.equal(pieces.length, 1);
  assert.equal(
    pieces[0].node.data.slice(pieces[0].start, pieces[0].end),
    "18%"
  );
});

test("a span crossing element boundaries resolves to one piece per node", () => {
  const { hooks } = loadChatCitations();
  const { text, map } = buildMap(hooks, ["the rate rose ", "sharply", " in June"]);
  const start = text.indexOf("rose");
  const end = text.indexOf(" in June");
  const pieces = hooks.piecesForSpan(map, start, end);
  assert.equal(pieces.length, 2);
  assert.equal(
    pieces.map((piece) => piece.node.data.slice(piece.start, piece.end)).join(""),
    "rose sharply"
  );
});

test("a span whose node has been detached resolves to nothing", () => {
  const { hooks } = loadChatCitations();
  const { text, map } = buildMap(hooks, ["the rate rose sharply"]);
  map[0].node.isConnected = false;
  assert.equal(hooks.piecesForSpan(map, 0, text.length), null);
});

test("an empty or reversed span resolves to nothing", () => {
  const { hooks } = loadChatCitations();
  const { map } = buildMap(hooks, ["the rate rose"]);
  assert.equal(hooks.piecesForSpan(map, 5, 5), null);
  assert.equal(hooks.piecesForSpan(map, 9, 4), null);
  assert.equal(hooks.piecesForSpan(map, 99, 120), null);
});

test("an answer key changes with the answer and not with a re-render", () => {
  const { hooks } = loadChatCitations();
  const answer = "The rate rose to 18% in June, according to the filing.";
  assert.equal(hooks.answerKey(answer), hooks.answerKey(answer));
  assert.notEqual(hooks.answerKey(answer), hooks.answerKey(`${answer} `));
  assert.notEqual(
    hooks.answerKey(answer),
    hooks.answerKey(answer.replace("18%", "19%"))
  );
});
