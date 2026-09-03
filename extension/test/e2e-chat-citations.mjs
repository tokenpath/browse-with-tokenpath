// Chat citation mode — browser coverage for the part that cannot be unit
// tested: finding the finished assistant message, extracting the answer the
// reader actually sees, and wrapping the attributed phrases back into a DOM
// that both apps re-render underneath us.
//
// The real shipped scripts run here, in the load order the manifest declares,
// against fixtures shaped like each app's DOM. Everything outside the page —
// the service worker's fetch and the TokenPath call — is replaced by a
// `chrome.runtime.sendMessage` stub that computes its answer spans from the
// answer string the content script sent, so a mistake in extraction shows up
// as a link on the wrong words rather than being masked by a fixed offset.

import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const vendored = join(__dirname, "_libs", "flat");
if (existsSync(vendored)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${vendored}:${process.env.LD_LIBRARY_PATH}`
    : vendored;
}

const read = (name) => readFileSync(join(__dirname, "..", name), "utf8");
// The manifest loads these three into one isolated world, in this order; the
// wrapper reproduces that single shared scope.
const BUNDLE = `(() => {\n${read("text-fragments.js")}\n${read(
  "chat-sources.js"
)}\n${read("chat-citations.js")}\n})()`;
const STYLES = read("chat-citations.css");

const SETTLE_MS = 1_000;
// Environments that cannot download Playwright's pinned Chromium (an offline
// or proxied machine with a system build already present) can point the suite
// at one: E2E_CHROMIUM_PATH=/path/to/chrome npm run test:e2e:chat
const LAUNCH_OPTIONS = process.env.E2E_CHROMIUM_PATH
  ? { executablePath: process.env.E2E_CHROMIUM_PATH }
  : {};
const failures = [];

function check(condition, description, detail) {
  if (condition) {
    console.log(`PASS: ${description}`);
    return;
  }
  failures.push(description);
  console.error(`FAIL: ${description}${detail ? `\n      ${detail}` : ""}`);
}

function equal(actual, expected, description) {
  check(
    actual === expected,
    description,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// --- Fixtures ---------------------------------------------------------------

const CHATGPT_ANSWER_HTML = `
  <div class="markdown">
    <p>The rate <strong>rose to 18%</strong> in June, according to the
      filing<a href="https://www.reuters.com/markets/rates?utm_source=chatgpt.com"
        target="_blank">reuters.com</a>.</p>
    <p>The programme covered 40,000 households in its first year<a
        href="https://example.org/programme?utm_source=chatgpt.com&amp;utm_medium=x">1</a>.</p>
  </div>
  <div class="flex">
    <button aria-label="Copy">Copy</button>
    <span aria-hidden="true">Regenerate</span>
  </div>`;

const CHATGPT_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ChatGPT</title><style>${STYLES}</style></head>
<body>
  <main>
    <article data-message-author-role="user"><div>What happened to the rate?</div></article>
    <article data-message-author-role="assistant" id="answer">${CHATGPT_ANSWER_HTML}</article>
  </main>
  <div id="composer"><button data-testid="stop-button">Stop</button></div>
</body></html>`;

const CLAUDE_FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Claude</title><style>${STYLES}</style></head>
<body>
  <main>
    <div data-testid="user-message">What happened to the rate?</div>
    <div data-is-streaming="true" id="wrapper">
      <div class="font-claude-message" id="answer">
        <p>The rate rose to 18% in June, according to the filing.</p>
        <p>The programme covered 40,000 households in its first year.</p>
        <cite><a href="https://www.reuters.com/markets/rates">reuters.com</a></cite>
      </div>
    </div>
  </main>
</body></html>`;

// The attributions the stubbed worker returns. Offsets are computed from the
// answer string the content script sent, which is the thing under test.
const PHRASES = [
  {
    phrase: "rose to 18% in",
    url: "https://www.reuters.com/markets/rates",
    passage: "the rate rose to 18% in June",
    confidence: 0.91,
  },
  {
    phrase: "40,000 households",
    url: "https://example.org/programme",
    passage: "covered 40,000 households",
    confidence: 0.74,
  },
];

async function installShim(page) {
  await page.evaluate((phrases) => {
    window.__tokenpathCalls = [];
    window.__tokenpathReply = null;
    const listeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          window.__tokenpathCalls.push(message);
          if (window.__tokenpathReply) return window.__tokenpathReply;
          const attributions = [];
          for (const entry of phrases) {
            const start = message.answer.indexOf(entry.phrase);
            if (start < 0) continue;
            attributions.push({
              answer: {
                start,
                end: start + entry.phrase.length,
                text: entry.phrase,
              },
              source: {
                url: entry.url,
                link: `${entry.url}#:~:text=${encodeURIComponent(entry.passage)}`,
                text: entry.passage,
                confidence: entry.confidence,
                start: 0,
                end: entry.passage.length,
                sourceIndex: 0,
              },
            });
          }
          return {
            ok: true,
            attributions,
            stats: {
              requested: message.urls.length,
              fetched: message.urls.length,
              spans: attributions.length,
            },
          };
        },
      },
      storage: {
        local: {
          get: async () => ({ ...(window.__tokenpathStored || {}) }),
          set: async (value) => {
            const previous = { ...(window.__tokenpathStored || {}) };
            window.__tokenpathStored = { ...previous, ...value };
            for (const listener of listeners) {
              listener(
                Object.fromEntries(
                  Object.entries(value).map(([key, newValue]) => [
                    key,
                    { newValue, oldValue: previous[key] },
                  ])
                ),
                "local"
              );
            }
          },
        },
        onChanged: { addListener: (listener) => listeners.push(listener) },
      },
    };
  }, PHRASES);
}

async function linkReport(page) {
  return page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a.tokenpath-attr")];
    return {
      count: anchors.length,
      texts: anchors.map((anchor) => anchor.textContent),
      hrefs: anchors.map((anchor) => anchor.getAttribute("href")),
      titles: anchors.map((anchor) => anchor.getAttribute("title")),
      targets: anchors.map((anchor) => anchor.getAttribute("target")),
      rels: anchors.map((anchor) => anchor.getAttribute("rel")),
      badge:
        document
          .querySelector(".tokenpath-chat-badge .tokenpath-chat-badge-text")
          ?.textContent || "",
      // The reader's own text must be unchanged by the injection.
      answerText: document.getElementById("answer").textContent,
      calls: window.__tokenpathCalls.length,
      sent: window.__tokenpathCalls[0] || null,
    };
  });
}

async function run() {
  const browser = await chromium.launch(LAUNCH_OPTIONS);
  const context = await browser.newContext();

  await context.route("https://chatgpt.com/**", (route) =>
    route.fulfill({ body: CHATGPT_FIXTURE, contentType: "text/html" })
  );
  await context.route("https://claude.ai/**", (route) =>
    route.fulfill({ body: CLAUDE_FIXTURE, contentType: "text/html" })
  );

  try {
    await chatgptSuite(context);
    await claudeSuite(context);
  } finally {
    await browser.close();
  }
}

async function chatgptSuite(context) {
  const page = await context.newPage();
  await page.goto("https://chatgpt.com/c/1");
  await installShim(page);
  await page.evaluate(BUNDLE);

  // The stop button is still in the DOM: the turn is not finished, however
  // quiet the message subtree is.
  await page.waitForTimeout(SETTLE_MS + 400);
  const streaming = await linkReport(page);
  equal(streaming.count, 0, "a still-streaming answer is left alone");
  equal(streaming.calls, 0, "a still-streaming answer spends no request");

  await page.evaluate(() => {
    document.querySelector('[data-testid="stop-button"]').remove();
    // Finishing a turn is itself a mutation; nothing else would wake the
    // observer on a page whose stop button simply disappeared.
    document.querySelector("#answer .markdown p").append(document.createTextNode(""));
  });
  await page.waitForSelector("a.tokenpath-attr", { timeout: 6_000 });
  const linked = await linkReport(page);

  equal(linked.calls, 1, "one attribution request per finished answer");
  check(
    linked.sent.answer.includes("The rate rose to 18% in June, according to the filing."),
    "the answer sent is the prose the reader sees"
  );
  check(
    !linked.sent.answer.includes("reuters.com") &&
      !linked.sent.answer.includes("Copy") &&
      !linked.sent.answer.includes("Regenerate"),
    "citation chips and interface text are not part of the answer",
    linked.sent.answer
  );
  equal(
    linked.sent.question,
    "What happened to the rate?",
    "the preceding user turn becomes TokenPath's question"
  );
  check(
    linked.sent.urls.includes("https://www.reuters.com/markets/rates") &&
      linked.sent.urls.includes("https://example.org/programme"),
    "cited URLs are collected with their tracking parameters stripped",
    JSON.stringify(linked.sent.urls)
  );

  // "rose to 18% in" starts inside the <strong> and ends in the text node
  // after it, so it becomes two wrappers pointing at the same passage; the
  // second phrase sits in one node and becomes one.
  equal(linked.count, 3, "every piece of every attributed phrase is wrapped");
  equal(
    linked.texts.slice(0, 2).join(""),
    "rose to 18% in",
    "a phrase crossing element boundaries is wrapped exactly"
  );
  equal(linked.texts[2], "40,000 households", "a whole-phrase link is exact");
  check(
    linked.hrefs
      .slice(0, 2)
      .every((href) => href === linked.hrefs[0] && href.includes("#:~:text=")),
    "each piece links to the same source passage",
    JSON.stringify(linked.hrefs)
  );
  check(
    linked.hrefs[2].startsWith("https://example.org/programme#:~:text="),
    "the second phrase links into its own source",
    linked.hrefs[2]
  );
  check(
    linked.targets.every((target) => target === "_blank") &&
      linked.rels.every((rel) => rel === "noopener noreferrer"),
    "source links open safely in a new tab"
  );
  check(
    linked.titles[0].startsWith("reuters.com — “"),
    "hover text names the site and the passage",
    linked.titles[0]
  );
  check(
    linked.answerText.includes("The rate rose to 18% in June"),
    "injection does not alter the words on screen"
  );
  equal(
    linked.badge,
    "TokenPath: 2/2 sources · 2 phrases",
    "the badge reports sources read and phrases linked"
  );

  // A React re-render replaces the message body and takes our wrappers with
  // it. The cached result has to come back without a second request.
  await page.evaluate(() => {
    const body = document.querySelector("#answer .markdown");
    body.innerHTML = body.innerHTML.replace(
      /<a class="tokenpath-attr"[^>]*>(.*?)<\/a>/g,
      "$1"
    );
  });
  await page.waitForFunction(
    () => document.querySelectorAll("a.tokenpath-attr").length === 3,
    null,
    { timeout: 6_000 }
  );
  const reapplied = await linkReport(page);
  equal(reapplied.calls, 1, "a re-render re-applies from cache, spending nothing");
  equal(
    reapplied.texts.slice(0, 2).join(""),
    "rose to 18% in",
    "re-applied links land on the same phrase"
  );

  // Turning the feature off for this site has to leave the page as the app
  // rendered it.
  await page.evaluate(() => {
    [...document.querySelectorAll(".tokenpath-chat-badge-action")]
      .find((button) => button.textContent === "Off")
      .click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll("a.tokenpath-attr").length === 0,
    null,
    { timeout: 6_000 }
  );
  const disabled = await page.evaluate(() => ({
    badges: document.querySelectorAll(".tokenpath-chat-badge").length,
    processed: document.querySelectorAll("[data-tokenpath-processed]").length,
    stored: window.__tokenpathStored,
    text: document.getElementById("answer").textContent,
  }));
  equal(disabled.badges, 0, "turning the site off removes the badge too");
  equal(disabled.processed, 0, "turning the site off clears the processed marks");
  check(
    disabled.stored.chatCitations.disabledHosts.includes("chatgpt.com"),
    "the per-host switch is persisted for the next page load",
    JSON.stringify(disabled.stored)
  );
  check(
    disabled.text.includes("The rate rose to 18% in June"),
    "an answer left alone still reads exactly as the app rendered it"
  );

  // A message appended after the switch is off must stay untouched.
  await page.evaluate(() => {
    const message = document.createElement("article");
    message.setAttribute("data-message-author-role", "assistant");
    message.innerHTML =
      '<div class="markdown"><p>A second answer that also covered 40,000 households ' +
      'and cites <a href="https://example.org/programme">a source</a>.</p></div>';
    document.querySelector("main").append(message);
  });
  await page.waitForTimeout(SETTLE_MS + 400);
  const afterDisable = await linkReport(page);
  equal(afterDisable.count, 0, "a new answer is ignored while the site is off");
  equal(afterDisable.calls, 1, "an ignored answer spends no request");

  await page.close();
}

async function claudeSuite(context) {
  const page = await context.newPage();
  await page.goto("https://claude.ai/chat/1");
  await installShim(page);
  await page.evaluate(BUNDLE);

  await page.waitForTimeout(SETTLE_MS + 400);
  const streaming = await linkReport(page);
  equal(streaming.count, 0, "Claude: data-is-streaming defers the answer");

  await page.evaluate(() => {
    document.getElementById("wrapper").setAttribute("data-is-streaming", "false");
    document.querySelector("#answer p").append(document.createTextNode(""));
  });
  await page.waitForSelector("a.tokenpath-attr", { timeout: 6_000 });
  const linked = await linkReport(page);
  equal(linked.calls, 1, "Claude: one request for the finished answer");
  check(
    !linked.sent.answer.includes("reuters.com"),
    "Claude: a citation chip's label is not part of the answer",
    linked.sent.answer
  );
  check(
    linked.sent.urls.includes("https://www.reuters.com/markets/rates"),
    "Claude: the chip's URL is collected as a source",
    JSON.stringify(linked.sent.urls)
  );
  equal(linked.count, 2, "Claude: both phrases are linked");
  equal(linked.texts[1], "40,000 households", "Claude: link text is exact");
  check(
    // The badge belongs to the outermost message element, so nesting
    // selectors must not produce two of them.
    (await page.evaluate(
      () => document.querySelectorAll(".tokenpath-chat-badge").length
    )) === 1,
    "Claude: nested message selectors still produce one badge"
  );

  // A failed attribution says so, keeps the answer intact, and offers Retry.
  await page.evaluate(() => {
    window.__tokenpathReply = { ok: false, error: "rate limited — retry shortly" };
    const message = document.createElement("div");
    message.className = "font-claude-message";
    message.innerHTML =
      '<p>A second answer that also covered 40,000 households, per ' +
      '<a href="https://example.org/programme">the filing</a>.</p>';
    document.querySelector("main").append(message);
  });
  await page.waitForFunction(
    () => document.querySelectorAll(".tokenpath-chat-badge").length === 2,
    null,
    { timeout: 6_000 }
  );
  const failed = await page.evaluate(() => {
    const badges = [...document.querySelectorAll(".tokenpath-chat-badge")];
    const last = badges[badges.length - 1];
    return {
      text: last.querySelector(".tokenpath-chat-badge-text").textContent,
      actions: [...last.querySelectorAll("button")].map(
        (button) => button.textContent
      ),
      links: document.querySelectorAll("a.tokenpath-attr").length,
    };
  });
  equal(
    failed.text,
    "TokenPath: rate limited — retry shortly",
    "a failure is reported in the badge"
  );
  check(
    failed.actions.includes("Retry") && failed.actions.includes("Off"),
    "a failed message offers Retry",
    JSON.stringify(failed.actions)
  );
  equal(failed.links, 2, "a failure leaves the earlier answer's links alone");

  await page.evaluate(() => {
    window.__tokenpathReply = null;
    const badges = [...document.querySelectorAll(".tokenpath-chat-badge")];
    [...badges[badges.length - 1].querySelectorAll("button")]
      .find((button) => button.textContent === "Retry")
      .click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll("a.tokenpath-attr").length === 3,
    null,
    { timeout: 6_000 }
  );
  check(true, "Retry attributes the message again and links it");

  // Regenerating an answer in place changes it, so the cache keyed by answer
  // text must not answer for it.
  const beforeEdit = await page.evaluate(() => window.__tokenpathCalls.length);
  await page.evaluate(() => {
    const messages = [...document.querySelectorAll(".font-claude-message")];
    const paragraph = messages[messages.length - 1].querySelector("p");
    paragraph.append(
      document.createTextNode(" A revision covered 40,000 households again.")
    );
  });
  await page.waitForFunction(
    (previous) => window.__tokenpathCalls.length > previous,
    beforeEdit,
    { timeout: 6_000 }
  );
  const edited = await page.evaluate(() => ({
    calls: window.__tokenpathCalls.length,
    last: window.__tokenpathCalls[window.__tokenpathCalls.length - 1].answer,
  }));
  equal(edited.calls, beforeEdit + 1, "a changed answer is attributed again");
  check(
    edited.last.includes("A revision covered 40,000 households again."),
    "the re-attributed answer is the edited text, not the cached one",
    edited.last
  );

  await page.close();
}

await run();

if (failures.length) {
  console.error(`\n${failures.length} chat citation check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log("\nAll chat citation browser checks passed.");
}
