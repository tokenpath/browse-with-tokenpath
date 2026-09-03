# Tests

The suite has pure/unit coverage for offset math, summary policy, page-chat URL
identity, and background capture orchestration, plus Playwright integration
coverage for the side panel and the real content script.

From `extension/`, build the packaged panel and run everything:

```bash
npm install
npm run setup:test # first run on a machine
npm test
```

`npm test` is `npm run check` (typecheck, the `checkJs` pass over the build-free
scripts, and the Vite build) followed by the unit suite and both browser suites
(`test:e2e` and `test:e2e:chat`).
`setup:test` installs Chromium and runs `setup-libs.sh`, which is a no-op
outside Debian/Ubuntu — running it on macOS is safe and does nothing.

CI additionally verifies that the committed `sidepanel/panel.js` and
`sidepanel/panel.css` match a fresh build of `src/`. A change under
`src/sidepanel/` that is committed without its rebuilt bundle fails the build.

## Unit suite

```bash
npm run test:unit
```

This is a glob over `test/*.test.cjs`, so a new file is picked up by adding it.
The files today:

- **`roundtrip.test.cjs`** evaluates the real `content.js` in a `vm` sandbox and
  drives the helpers it exports through `globalThis.__tokenpathTestHooks`,
  which the harness creates before evaluation — the script stays inert on a
  real page, which the suite also asserts. It checks canonical extraction
  offsets against raw DOM offsets, including synthetic block separators,
  headings, and exact sub-sentence ranges without sentence expansion.
- **`panel-logic.test.cjs`** checks the 24-word concise-source cutoff, the
  absence of a low summary output cap, code-point-safe truncation around emoji,
  and CJK-dominant handling. It also
  covers the follow-up suggestions protocol: the Detailed preset and bounded
  custom instructions replacing the preset but never the shared suffix; the
  tail appended after every question; parsing a well-formed block, an absent
  one, malformed pairs, several blocks, a nested opener, a stream cut off
  mid-block or mid-marker, and CJK, emoji, curly-quoted, and bulleted lines;
  the verbatim anchor gate including whitespace-collapse and case sensitivity;
  coverage ranking against returned attribution spans plus the positional fallback;
  and the depth ladder's fixed-chip rule.
- **`controller-urls.test.cjs`** pins page identity: a plain `#section` anchor, a
  `:~:text=` directive, and PDF `#page`/`#zoom` anchors all keep one document
  and one page-chat key, while a different path or query string does not. It
  also covers tracking-parameter stripping and the agreement between the cache
  key and the navigation guard.
- **`api-clients.test.cjs`** exercises TokenPath's named generation SSE across
  byte-fragmented Unicode, terminal and error events, malformed/incomplete
  streams, caller cancellation, canonical `done.answer`, HTTP error details,
  resolved-span validation, UTF-16/emoji bounds, and cancellation or timeout
  while a response body is still arriving.
- **`pdf-text-extractor.test.cjs`** verifies fragment-free credentialed PDF
  downloads, signature and 50 MiB limits, strict native-viewer reply binding,
  Unicode-safe 400,000-character truncation, scan/timeout/abort failures, and
  unconditional hidden-viewer cleanup.
- **`chat-citations.test.cjs`** covers chat citation mode's pure logic against
  the real shipped files: `#:~:text=` directives (ambiguous-only context, long
  targets as `textStart,textEnd`, surrogate-safe bounds, escaped fragment
  grammar), canonical cited URLs (`utm_*` and tracking parameters stripped,
  non-HTTP schemes and embedded credentials rejected), the chip-versus-prose
  test, the readability pass (page chrome dropped, a shell `<main>` falling back
  to the body, an unclosed `<script>`, entity decoding, block newlines,
  boundary-safe truncation), packing several cited pages into one document with
  regions that slice back exactly, and mapping the returned spans back —
  including the confidence threshold, a span in a header or across two sources,
  overlap resolution, badge wording, and hover text. It also drives the offset
  helpers inside `chat-citations.js` through its `__tokenpathChatCitationHooks`
  export (which the harness creates before evaluation, proving the script stays
  inert on a real page): whitespace collapse with per-character source indexes,
  single-node and element-crossing spans, detached nodes, and answer keys.
- **`background.test.cjs`** holds `chrome.sidePanel.open()` unresolved and proves
  that capture still proceeds immediately. It also verifies exact-frame warm
  injection, retries for missing receivers and stale “page changed” responses,
  Gmail or nested-frame routing, click-order race handling, seed metadata
  (including `capturedAt` and `seededAt`), and startup migration from the older
  context-menu items to the single **Chat with TokenPath** item. Native-PDF
  coverage includes legacy and modern OOPIF detection, direct context-menu
  capture, full-document descriptor routing for no-selection clicks,
  exact-frame full-page HTML routing, bounded/contextual text-fragment encoding
  (including Unicode and reserved grammar), URL-commit-before-reload ordering,
  and clearing highlights without losing ordinary PDF anchors. Chat citation
  mode is covered end to end through the worker's message handler: the same page
  cited twice is read once, cookies are never sent to a cited page, unreadable
  sources are dropped rather than sent empty, both readable sources are packed
  into one `/v1/attributions` call, per-source links point at the passage, a
  streamed body decodes across chunk boundaries, warm reads spend no second
  fetch, and every failure comes back as wording the badge can show.

## Browser integration

```bash
npm run test:e2e
```

`e2e.mjs` loads representative fixtures, injects the real scripts behind a small
Chrome API shim, and drives capture → optional streaming generation → cached
server-selected spans → phrase click or **Sources** list →
source-offset highlight. It covers:

- side-panel bootstrap while `/credits` never resolves; a capture that waits
  instead of generating; the **Summarize** starter sending the one 3-bullet
  prompt and the single 2048-token ceiling that every generation path uses,
  with no length control anywhere in the panel and nothing persisting the
  preference key it used to write;
  the already-concise note suppressing the starter; a messages-only TokenPath
  `/v1/generate` request, split named SSE events, one TokenPath attribution call
  per answer with no threshold or explicit spans; exact raw-answer mapping
  across inline/fenced and indented code, link labels, bold delimiters, block crossings, decoded entities,
  footnote definitions, hidden link destinations/image alt text, repeated text,
  and Unicode; serialized disconnect/key removal so a late delete cannot race a
  reconnect; collapsed-by-default source text with accessible expansion,
  automatic recollapse on replacement, always-visible capture errors,
  narrow-panel layout, system/light/dark theme switching, UTF-16 attribution
  across emoji, stale-seed rejection, and routing
  the resolved source range to the original tab and frame;
- stopping a streaming answer and keeping the partial text marked incomplete,
  plus the keyboard path through the **Sources** list;
- delayed auth cleanup after a newer capture, out-of-order credit reads, rapid
  attribution-click responses, and content-script highlight ownership, proving
  stale async work cannot write into or clear newer UI state, plus side-panel
  teardown cleanup for owned page and PDF highlights;
- native-PDF panel routing through the background worker, reuse of the normal
  generation/attribution path, same-document text-fragment and viewer-anchor
  updates, explicit clearing, and genuine-navigation invalidation without
  bouncing the tab back to the old PDF;
- full-PDF reading state, hidden native-viewer extraction, normal
  generation/attribution reuse, and replacement races where a newer capture aborts
  the old read and ignores its delayed viewer reply;
- full-page rendered-text capture that ignores a stale selection, includes
  visible non-selectable text, excludes hidden/script/style text, safely caps a
  surrogate-boundary prefix, and preserves repeated-phrase attribution after a
  DOM replacement;
- **Page-reload attribution recovery**: a refreshed tab throws away the content
  script's node map, and the highlight still resolves from the cached document's
  quote and bounded context — while a genuinely changed or removed passage fails
  instead of highlighting the wrong text;
- a Gmail-shaped nested scroll pane whose complete message subtree is replaced
  between capture and highlight, including repeated text and inline elements;
- a WhatsApp-shaped selection spanning link-preview text and a later image
  caption beneath a non-selectable app shell, including metadata exclusion,
  subtree replacement, unrelated message hydration, exact serialized-message
  recovery despite duplicate captions, changed-target rejection, and selection
  cleanup;
- a dynamic SSR article whose subtree hydrates after capture, including an
  unrelated lead edit, a duplicate target outside the article, and exact
  clicked-span recovery beneath the article heading;
- generalized semantic-scope recovery across split and merged text nodes,
  inserted or removed wrappers that change synthetic block separators,
  DOM Ranges that omit those generated separators, and same-node edits outside
  the clicked span;
- repeated target text reordered within one article, including quote-context
  disambiguation from context outside a whole-node selection, rejection of
  indistinguishable candidates, rejection of mutations inside the actual
  target (including ZWJ removal), and no fallback jump to a surviving duplicate
  when the originally attributed occurrence changes;
- duplicated generic element IDs falling back to page-level contextual
  disambiguation instead of trusting the first invalid-ID match;
- rejection after query route identity changes, and *acceptance* across
  fragment-only changes, which are scroll position rather than a new document;
- exact Range capture when Chrome's flattened selection hint omits an invisible
  character, followed by clearing the native page selection without losing
  later attribution highlighting;
- a Substack-shaped late-injection selection spanning header and body, including
  CSS-uppercase dates, `user-select:none` reaction controls, and a visibly
  rendered `aria-hidden` ancestor;
- current X Article DraftJS selectors and blocks, repeated text, and a full
  article subtree rerender; and
- X post identity across detach and reorder when another post contains the same
  text, plus rejection of a connected React Text node whose contents changed.

**Auto-summary, follow-ups, and Settings** is a self-contained suite with its
own browser and counters. It drives a toolbar capture through an automatic
summary whose single generation call also carries the suggestions tail, and
checks that the tail block reaches neither the rendered answer nor the attribution
request, that a fabricated anchor quote and one quoting the passage the answer
already used both lose their slot, that the depth ladder takes slot one, that
clicking a generated chip asks it as an ordinary turn and refreshes the row,
that the detailed rung sends the second preset without echoing a question, that
a restored chat shows its saved chips without spending, and that each setting
behaves: follow-ups off hides the row, automatic summaries off captures without
spending and replaces the **Summarize** starter with a summarize chip, and
custom instructions reach generation with the suffix and tail after them and
reset in one tap.

### Chat citation mode

```bash
npm run test:e2e:chat
```

`e2e-chat-citations.mjs` is a self-contained browser suite for the part of chat
citation mode that cannot be unit tested. It serves ChatGPT-shaped and
Claude-shaped fixtures from their real origins (so `location.hostname` matches
the declared content script), evaluates the three real scripts in the load order
the manifest declares, and stubs only what lives outside the page — the
`chrome.runtime.sendMessage` reply computes its answer spans *from the answer
string the content script sent*, so a mistake in extraction shows up as a link
on the wrong words instead of being hidden behind a fixed offset. It covers a
still-streaming answer being left alone (ChatGPT's stop button, Claude's
`data-is-streaming`), the answer string excluding citation chips and interface
text, cited URLs collected with their tracking parameters stripped, the
preceding user turn becoming the question, a phrase crossing a `<strong>`
boundary wrapped exactly across two nodes with one shared target, safe link
attributes and hover text, the badge wording, a re-render re-applying from cache
without a second request, **Off** clearing every injection and persisting the
per-host switch, a later answer ignored while the site is off, one badge per
message where Claude's selectors nest, a failure reporting in the badge and
recovering through **Retry**, and an answer edited in place being attributed
again rather than answered from the cache keyed by the old text.

An environment that cannot download Playwright's pinned Chromium can point the
suite at an existing build:

```bash
E2E_CHROMIUM_PATH=/path/to/chrome npm run test:e2e:chat
```

### Live public sites

The checks against real third-party pages (Example, Wikipedia, GNU, MDN, Hacker
News, a live Substack post, a live X profile and post) are **skipped by
default** — third-party markup and network availability change independently of
this extension. Run them explicitly:

```bash
E2E_LIVE_SITES=1 npm run test:e2e
```

CI runs them on a nightly schedule, and on demand through the workflow's
`live_sites` dispatch input. The deterministic fixtures above always run, on
every push and pull request, and a fixture failure sets a nonzero exit code.

To run both levels:

```bash
npm test
```

## Linux browser dependencies

Headless Chromium may need `libgbm.so.1` and `libwayland-server.so.0`.
`setup-libs.sh` downloads and extracts them without root into `_libs/flat/`, and
`e2e.mjs` adds that directory to `LD_LIBRARY_PATH`. On macOS, Windows, or
non-apt Linux the script prints a skip line and exits 0. If system installation
is available, `npx playwright install-deps chromium` is the standard
alternative.

## Still manual

The tests mock rather than launch a packaged Chrome extension, so a final
load-unpacked pass should verify the real entry points: the context menu offers
exactly one item, **Chat with TokenPath**, on a selection and on a page with no
selection, and the toolbar icon captures the current tab and summarizes it.
Confirm that a context-menu capture generates nothing on its own, that a
toolbar click on a page with a saved chat reopens that chat without spending
anything, that the **Summarize** starter runs a summary, that a short source
shows the “Already concise” note instead (with no starter beside it), and that
**Stop** during a stream leaves the partial answer marked incomplete. Confirm
too that a real model returns a usable suggestions block often enough to be
worth the tail, that no marker text is ever visible mid-stream, and that the
Settings gear, its switches, the Detailed preset, and custom instructions all
behave against the live API.

The pass should also verify the side panel, TokenPath HTTP/authentication flow,
streamed Markdown, both ways into attribution (clicking an underlined phrase
and the **Sources** list by keyboard), ordinary answer selection remaining inert,
nested Gmail scrolling, detached-DOM
unique remapping, chat restore after leaving and returning to a page, working
attribution after a page refresh, and searchable-PDF selection or full-document
capture/highlight/clear behavior. Check that **Clear chat** affects only the
current page and that **Disconnect** clears every saved chat.

Chat citation mode needs a manual pass against the real apps, because their
DOM is the one thing no fixture can pin: on `chatgpt.com` and on `claude.ai`,
ask a question that triggers web search, and confirm that the answer is left
alone while it streams, that phrases become underlined a second or two after it
finishes, that clicking one opens the cited page scrolled to the passage, that
the badge's source count matches the chips on screen, that **Retry** and **Off**
behave, and that the Settings switch turns the mode off on both sites and back
on. Worth checking too that an answer with no citations, and a chat with an
uploaded file, are both left completely untouched.

Restricted pages such as `chrome://` remain unavailable to content scripts by
design; PDFs are handled separately through Chrome's native viewer. The PDF pass
should use a top-level searchable file, first invoke TokenPath without a
selection and confirm that the hidden-copy read leaves the visible viewer
untouched, then confirm that the native viewer finds an attributed span
(including a repeated phrase with context). Inspect Back/Clear behavior because
Chrome records fragment navigation in session history. An embedded PDF should
remain unsupported without navigating or reloading its outer page.
