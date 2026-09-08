// TokenPath — chat citation mode.
//
// ChatGPT and Claude end a sentence with a citation chip: it names a page, not
// the passage, and it does not say which part of the sentence the page
// supports. This script waits for an assistant message to finish, sends the
// answer and its cited URLs to the service worker, and turns the phrases
// TokenPath attributed into links that open the source at the supporting
// passage.
//
// Two invariants shape the code:
//
//  1. The answer string sent to TokenPath is built here, and the offsets that
//     come back index that exact string. So the same walk that builds the
//     string records, per text node, where each emitted character came from —
//     that map is the only thing that can turn a flat [start, end) span back
//     into a DOM Range across `<p>`, `<strong>`, `<code>`, and chips.
//  2. Both apps re-render freely. Every injected link can vanish at any time,
//     so a message's resolved attributions are cached by answer text and
//     re-applied from the cache; the API is called once per distinct answer.

(() => {
  const VERSION = "2026-09-03.1";

  // --- Host adapters --------------------------------------------------------
  //
  // Anchored on structure and data attributes, never on class names: the
  // class names in both apps are generated and churn between deploys.

  const ADAPTERS = [
    {
      id: "chatgpt",
      hosts: ["chatgpt.com", "chat.openai.com"],
      assistantSelector: '[data-message-author-role="assistant"]',
      userSelector: '[data-message-author-role="user"]',
      bodySelector: ".markdown, [data-message-content]",
      // The stop button is the app's own "still generating" signal. It
      // disappears the moment the turn ends, including when a turn ends in a
      // tool call rather than text.
      streamingSelector:
        '[data-testid="stop-button"], [aria-label="Stop streaming"], [aria-label="Stop generating"], .result-streaming',
      isMessageStreaming: () => false,
    },
    {
      id: "claude",
      hosts: ["claude.ai"],
      // `data-is-streaming` is Claude's own per-message flag, which is exactly
      // the signal this script needs; the others are fallbacks for a deploy
      // that drops it.
      assistantSelector:
        '[data-is-streaming], [data-testid="assistant-message"], .font-claude-message',
      userSelector: '[data-testid="user-message"]',
      bodySelector: ".font-claude-message",
      streamingSelector:
        '[data-is-streaming="true"], [aria-label="Stop response"]',
      isMessageStreaming: (message) =>
        message.closest('[data-is-streaming="true"]') != null,
    },
  ];

  // Wait for a message's subtree to stop changing before treating it as final.
  // Both apps pause mid-turn for tool calls, which is why the streaming signal
  // is checked as well: quiet alone is not finished.
  const SETTLE_MS = 1_000;
  // Both apps' streaming signals are selectors, and a selector can be wrong
  // after a deploy — a signal that never clears would defer every answer
  // forever. A message whose own subtree has not changed for this long is
  // finished whatever the indicator says.
  const STREAM_GIVE_UP_MS = 30_000;
  const PROCESSED_ATTR = "data-tokenpath-processed";
  const MESSAGE_KEY_ATTR = "data-tokenpath-message";
  const BADGE_ATTR = "data-tokenpath-badge";
  const LINK_CLASS = "tokenpath-attr";
  const STORAGE_KEY = "chatCitations";
  // One entry per distinct answer, so an edited or regenerated answer gets a
  // new one. Bounded: a long conversation must not grow this without limit.
  const MAX_CACHED_ANSWERS = 40;
  // Elements whose text is interface, not answer.
  const SKIP_TAGS = new Set([
    "BUTTON",
    "INPUT",
    "NOSCRIPT",
    "SCRIPT",
    "SELECT",
    "STYLE",
    "SVG",
    "TEXTAREA",
    "VIDEO",
  ]);
  const SKIP_ROLES = new Set([
    "button",
    "menu",
    "menubar",
    "menuitem",
    "tab",
    "tablist",
    "toolbar",
  ]);
  // Rendered Markdown, so block structure is tag structure.
  const BLOCK_TAGS = new Set([
    "ARTICLE",
    "BLOCKQUOTE",
    "DD",
    "DIV",
    "DL",
    "DT",
    "FIGURE",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "HR",
    "LI",
    "OL",
    "P",
    "PRE",
    "SECTION",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "UL",
  ]);

  const cache = new Map();
  // Set only from real page mutations, never from a scan, so "quiet since" is
  // always a fact about the app's own writes.
  const lastMutation = new WeakMap();
  // When a message was first seen, for messages that were already on screen
  // when this script loaded and have not changed since.
  const firstSeen = new WeakMap();
  let adapter = null;
  let observer = null;
  let settleTimer = null;
  // Our own injection mutates the message subtree. Without this the observer
  // would treat the injection as a fresh edit and rescan forever.
  let injecting = false;
  let enabled = true;
  let disabledHosts = [];

  function isEnabled() {
    return enabled && !disabledHosts.includes(location.hostname);
  }

  // --- Answer extraction ----------------------------------------------------

  function skipElement(element) {
    if (SKIP_TAGS.has(element.tagName)) return true;
    if (element.hasAttribute(BADGE_ATTR)) return true;
    if (element.getAttribute("aria-hidden") === "true") return true;
    const role = element.getAttribute("role");
    if (role && SKIP_ROLES.has(role)) return true;
    // A citation chip's visible text is a marker ("1", "reuters.com"), not
    // part of the sentence. An inline prose link is kept: dropping its words
    // would move every later offset off the text the reader sees.
    if (element.tagName === "A" && !element.classList.contains(LINK_CLASS)) {
      const href = element.getAttribute("href");
      if (href && TokenPathChatSources.isCitationChipText(
        element.textContent,
        absoluteUrl(href)
      )) {
        return true;
      }
    }
    return false;
  }

  /**
   * The answer string plus the map back to the DOM.
   *
   * Whitespace runs collapse to a single space and block boundaries become a
   * newline, so the string reads like the answer rather than like markup. Both
   * of those emit characters with no source node (a separator belongs to no
   * word); `piecesForSpan` clamps span ends onto mapped characters, exactly as
   * the page-capture path in content.js does.
   *
   * @param {Element} root
   * @returns {{ text: string, map: Array<{ node: Text, start: number, end: number, offsets: number[] }> }}
   */
  function extractAnswer(root) {
    const map = [];
    let text = "";
    let pendingBreak = false;

    const appendText = (node) => {
      const raw = node.data;
      if (!raw) return;
      if (!/\S/u.test(raw)) {
        // Whitespace between two inline elements still separates words.
        if (text && !pendingBreak && !/\s$/u.test(text)) text += " ";
        return;
      }
      if (text && pendingBreak) text += "\n";
      pendingBreak = false;
      let { out, offsets } = normalizeNodeText(raw);
      if ((!text || /\s$/u.test(text)) && out.startsWith(" ")) {
        out = out.slice(1);
        offsets = offsets.slice(1);
      }
      if (!out) return;
      const start = text.length;
      text += out;
      map.push({ node, start, end: text.length, offsets });
    };

    const walk = (parent, depth) => {
      if (depth > 64) return;
      for (let child = parent.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          appendText(/** @type {Text} */ (child));
          continue;
        }
        if (child.nodeType !== 1) continue;
        const element = /** @type {Element} */ (child);
        if (skipElement(element)) continue;
        if (element.tagName === "BR") {
          pendingBreak = true;
          continue;
        }
        const block = BLOCK_TAGS.has(element.tagName);
        if (block) pendingBreak = true;
        walk(element, depth + 1);
        if (block) pendingBreak = true;
      }
    };

    walk(root, 0);
    return { text, map };
  }

  /** Collapse whitespace runs, recording the source index of every character. */
  function normalizeNodeText(raw) {
    let out = "";
    const offsets = [];
    let inWhitespace = false;
    for (let i = 0; i < raw.length; i++) {
      const character = raw[i];
      if (/\s/u.test(character)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        out += " ";
        offsets.push(i);
        continue;
      }
      inWhitespace = false;
      out += character;
      offsets.push(i);
    }
    return { out, offsets };
  }

  /**
   * The per-text-node pieces of one flat answer span, in document order, or
   * null when the span cannot be resolved against the live DOM. A span that
   * begins or ends on an unmapped separator is clamped inward rather than
   * dropped.
   */
  function piecesForSpan(map, rawStart, rawEnd) {
    const start = Math.max(0, Math.trunc(rawStart));
    const end = Math.max(start, Math.trunc(rawEnd));
    if (end <= start) return null;
    const pieces = [];
    for (const entry of map) {
      if (entry.end <= start || entry.start >= end) continue;
      const from = Math.max(start, entry.start);
      const to = Math.min(end, entry.end);
      if (to <= from) continue;
      const nodeStart = entry.offsets[from - entry.start];
      const nodeEnd = entry.offsets[to - 1 - entry.start] + 1;
      if (!Number.isFinite(nodeStart) || !Number.isFinite(nodeEnd)) return null;
      if (!entry.node.isConnected) return null;
      pieces.push({ node: entry.node, start: nodeStart, end: nodeEnd });
    }
    return pieces.length ? pieces : null;
  }

  // --- Citation collection --------------------------------------------------

  function absoluteUrl(href) {
    try {
      return new URL(href, location.href).toString();
    } catch {
      return href;
    }
  }

  /**
   * The cited pages, most citation-like first, deduplicated by canonical URL.
   *
   * ChatGPT marks every citation with `utm_source=chatgpt.com`; Claude's chips
   * carry the URL on the anchor or on a data attribute, depending on the
   * deploy. Rather than pin one shape, anything in the message that resolves
   * to an off-site http(s) URL is a candidate, and the ones that look like
   * citations are taken first when the cap bites.
   */
  function collectCitations(message) {
    const marked = [];
    const plain = [];
    const seen = new Set();
    const add = (raw, isMarked) => {
      const url = TokenPathChatSources.normalizeSourceUrl(raw, location.href);
      if (!url) return;
      if (new URL(url).hostname === location.hostname) return;
      if (seen.has(url)) return;
      seen.add(url);
      (isMarked ? marked : plain).push(url);
    };

    for (const element of message.querySelectorAll("a[href], [data-url], [data-href]")) {
      if (element.classList.contains(LINK_CLASS)) continue;
      const href = element.getAttribute("href");
      const citation =
        (href && href.includes("utm_source=chatgpt.com")) ||
        looksLikeCitationContainer(element);
      for (const raw of [
        href,
        element.getAttribute("data-url"),
        element.getAttribute("data-href"),
      ]) {
        if (raw) add(raw, citation);
      }
    }
    return [...marked, ...plain].slice(0, TokenPathChatSources.MAX_SOURCES);
  }

  function looksLikeCitationContainer(element) {
    const container = element.closest("[data-testid], [data-citation], cite");
    if (!container) return false;
    if (container.tagName === "CITE") return true;
    if (container.hasAttribute("data-citation")) return true;
    return /citation|source|footnote/i.test(
      container.getAttribute("data-testid") || ""
    );
  }

  /** The user turn this answer replies to — TokenPath's `question`. */
  function questionFor(message) {
    let question = "";
    for (const candidate of document.querySelectorAll(adapter.userSelector)) {
      const position = candidate.compareDocumentPosition(message);
      // DOCUMENT_POSITION_FOLLOWING: the answer comes after this user turn.
      if (!(position & 4)) continue;
      const text = (candidate.textContent || "").replace(/\s+/gu, " ").trim();
      if (text) question = text;
    }
    // `/v1/attributions` requires a question. A conversation restored mid-way
    // can be missing the turn that produced the answer, and attribution
    // against the sources is still the useful thing to do.
    return question.slice(0, 4_000) || "What do the cited sources say?";
  }

  // --- Injection ------------------------------------------------------------

  /** Put our wrappers' text back so extraction sees the app's own DOM. */
  function unwrapInjected(root) {
    for (const anchor of [...root.querySelectorAll(`a.${LINK_CLASS}`)]) {
      const parent = anchor.parentNode;
      if (!parent) continue;
      while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
      parent.removeChild(anchor);
      parent.normalize();
    }
  }

  function wrapPiece(piece, attribution) {
    const { node } = piece;
    if (piece.start >= piece.end || piece.end > node.data.length) return false;
    let target = node;
    if (piece.end < node.data.length) target.splitText(piece.end);
    if (piece.start > 0) target = target.splitText(piece.start);
    const parent = target.parentNode;
    if (!parent) return false;

    const anchor = document.createElement("a");
    anchor.className = LINK_CLASS;
    anchor.href = attribution.source.link;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    const sourcePreview = TokenPathChatSources.hoverTitle(
      attribution.source.url,
      attribution.source.text
    );
    anchor.title = sourcePreview;
    // A native title tooltip is slow to appear and cannot be styled. Keep it
    // as a browser/accessibility fallback, and expose the same bounded text to
    // the injected stylesheet for an immediate evidence preview. "Matched
    // source" is deliberate: this is the passage TokenPath found in the
    // fetched page, not a claim about ChatGPT's private retrieval context.
    anchor.setAttribute(
      "data-tokenpath-source-preview",
      `Matched source: ${sourcePreview}`
    );
    anchor.setAttribute("data-tokenpath-confidence", String(
      Math.round(attribution.source.confidence * 100)
    ));
    parent.insertBefore(anchor, target);
    anchor.appendChild(target);
    return true;
  }

  /**
   * Wrap every attributed phrase, or report why nothing could be wrapped.
   *
   * All pieces are resolved against the intact map first and applied in
   * reverse document order: wrapping splits text nodes, and a later split
   * cannot disturb an earlier offset in the same node.
   */
  function applyAttributions(body, map, attributions) {
    const planned = [];
    for (const attribution of attributions) {
      const pieces = piecesForSpan(
        map,
        attribution.answer.start,
        attribution.answer.end
      );
      if (!pieces) continue;
      planned.push({ attribution, pieces });
    }
    if (!planned.length) return 0;

    injecting = true;
    let applied = 0;
    try {
      for (let index = planned.length - 1; index >= 0; index--) {
        const { attribution, pieces } = planned[index];
        let wrapped = false;
        for (let piece = pieces.length - 1; piece >= 0; piece--) {
          if (wrapPiece(pieces[piece], attribution)) wrapped = true;
        }
        if (wrapped) applied++;
      }
    } finally {
      // Drop the records our own writes queued, then resume.
      observer?.takeRecords();
      injecting = false;
    }
    return applied;
  }

  // --- Status badge ---------------------------------------------------------

  function renderBadge(message, stats) {
    injecting = true;
    try {
      let badge = message.querySelector(`[${BADGE_ATTR}]`);
      if (!badge) {
        badge = document.createElement("div");
        badge.setAttribute(BADGE_ATTR, "1");
        badge.className = "tokenpath-chat-badge";
        message.appendChild(badge);
      }
      badge.textContent = "";
      const label = document.createElement("span");
      label.className = "tokenpath-chat-badge-text";
      label.textContent = TokenPathChatSources.statusLabel(stats);
      badge.appendChild(label);
      if (stats.error || !stats.spans) {
        badge.appendChild(
          badgeButton("Retry", "Attribute this answer again", () => {
            message.removeAttribute(PROCESSED_ATTR);
            cache.delete(message.getAttribute(MESSAGE_KEY_ATTR) || "");
            void processMessage(message);
          })
        );
      }
      badge.appendChild(
        badgeButton(
          "Off",
          `Turn TokenPath citations off on ${location.hostname}`,
          disableForHost
        )
      );
    } finally {
      observer?.takeRecords();
      injecting = false;
    }
  }

  function badgeButton(text, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tokenpath-chat-badge-action";
    button.textContent = text;
    button.title = title;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  // --- Per-message pipeline -------------------------------------------------

  // Distinct answers get distinct cache entries; a re-render of the same
  // answer reuses its resolved attributions instead of spending a request.
  function answerKey(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  }

  function rememberResult(key, result) {
    cache.set(key, result);
    while (cache.size > MAX_CACHED_ANSWERS) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function messageBody(message) {
    return message.querySelector(adapter.bodySelector) || message;
  }

  async function processMessage(message) {
    if (!isEnabled() || !message.isConnected) return;
    message.setAttribute(PROCESSED_ATTR, "working");
    const body = messageBody(message);
    unwrapInjected(body);
    const { text, map } = extractAnswer(body);
    const key = answerKey(text);
    message.setAttribute(MESSAGE_KEY_ATTR, key);

    if (text.length < TokenPathChatSources.MIN_ANSWER_CHARS) {
      message.setAttribute(PROCESSED_ATTR, "skipped");
      return;
    }

    const cached = cache.get(key);
    if (cached) {
      finish(message, body, map, cached);
      return;
    }

    const urls = collectCitations(message);
    if (!urls.length) {
      const result = { attributions: [], stats: { requested: 0, fetched: 0 } };
      rememberResult(key, result);
      finish(message, body, map, result);
      return;
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "chat-citations-attribute",
        answer: text.slice(0, TokenPathChatSources.MAX_ANSWER_CHARS),
        question: questionFor(message),
        urls,
      });
    } catch {
      // An extension reload invalidates this context; the next page load
      // installs a fresh script rather than retrying into a dead port.
      message.setAttribute(PROCESSED_ATTR, "error");
      return;
    }
    if (!message.isConnected || !isEnabled()) return;

    const result = response?.ok
      ? {
          attributions: response.attributions || [],
          stats: response.stats || {},
        }
      : {
          attributions: [],
          stats: {
            requested: urls.length,
            fetched: 0,
            error: response?.error || "attribution failed",
          },
        };
    // A failure is not cached: Retry, or the next re-render, should be able to
    // reach a working backend.
    if (!result.stats.error) rememberResult(key, result);
    finish(message, body, map, result);
  }

  function finish(message, body, map, result) {
    const applied = applyAttributions(body, map, result.attributions);
    renderBadge(message, { ...result.stats, spans: applied });
    message.setAttribute(
      PROCESSED_ATTR,
      result.stats.error ? "error" : "done"
    );
  }

  /**
   * Re-apply cached attributions a re-render dropped, without a request.
   * Returns false when this message needs processing from scratch.
   */
  function reapply(message) {
    const key = message.getAttribute(MESSAGE_KEY_ATTR);
    const cached = key ? cache.get(key) : null;
    if (!cached) return false;
    const body = messageBody(message);
    const { text, map } = extractAnswer(body);
    // A changed answer — regenerated, edited, or a turn that resumed — is a
    // different answer, and gets processed again. An injected wrapper that
    // happened to split a whitespace run also reads as changed here; that
    // costs one more local pass, because processMessage unwraps first and
    // then hits this same cache entry, and never a second request.
    if (answerKey(text) !== key) return false;
    // Still intact, or nothing was linkable in the first place: either way
    // there is nothing to restore, and re-finishing on every scan would only
    // rewrite the same badge.
    if (body.querySelector(`a.${LINK_CLASS}`)) return true;
    if (!cached.attributions.length) return true;
    finish(message, body, map, cached);
    return true;
  }

  // --- Scanning -------------------------------------------------------------

  function conversationRoot() {
    return document.querySelector("main") || document.body;
  }

  function assistantMessages() {
    const root = conversationRoot();
    if (!root) return [];
    const candidates = [...root.querySelectorAll(adapter.assistantSelector)];
    // Claude's selectors nest (`[data-is-streaming]` wraps the message body).
    // Keep the outermost element of each message so the badge and the
    // processed marker have one stable home.
    return candidates.filter(
      (candidate) =>
        !candidates.some(
          (other) => other !== candidate && other.contains(candidate)
        )
    );
  }

  function isStreaming(message) {
    if (adapter.isMessageStreaming(message)) return true;
    return document.querySelector(adapter.streamingSelector) != null;
  }

  function scan() {
    if (!isEnabled()) return;
    const now = Date.now();
    let nextDelay = Infinity;
    for (const message of assistantMessages()) {
      if (!firstSeen.has(message)) firstSeen.set(message, now);
      const state = message.getAttribute(PROCESSED_ATTR);
      if (state === "working" || state === "error" || state === "skipped") {
        continue;
      }
      const quietSince = lastMutation.get(message) ?? firstSeen.get(message);
      const quietFor = now - quietSince;
      if (quietFor < SETTLE_MS) {
        nextDelay = Math.min(nextDelay, SETTLE_MS - quietFor);
        continue;
      }
      // Quiet is not finished: both apps pause mid-turn for tool calls, so the
      // app's own streaming signal has to be gone as well.
      if (isStreaming(message) && quietFor < STREAM_GIVE_UP_MS) {
        nextDelay = Math.min(nextDelay, SETTLE_MS);
        continue;
      }
      if (state === "done") {
        // A re-render dropped our wrappers, or the answer itself changed.
        if (reapply(message)) continue;
        message.removeAttribute(PROCESSED_ATTR);
      }
      void processMessage(message);
    }
    if (nextDelay !== Infinity) schedule(nextDelay);
  }

  function schedule(delay) {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      settleTimer = null;
      scan();
    }, Math.max(50, delay));
  }

  function onMutations(records) {
    if (injecting) return;
    const now = Date.now();
    let touched = false;
    for (const record of records) {
      const target =
        record.target.nodeType === 1
          ? /** @type {Element} */ (record.target)
          : record.target.parentElement;
      if (!target) continue;
      const message = target.closest(adapter.assistantSelector);
      if (message) {
        lastMutation.set(message, now);
        // A message skipped for being too short can still grow — a turn that
        // resumed after a tool call, or one this script gave up waiting for.
        // An error is deliberately not cleared: retrying it on every
        // re-render would spend a request each time. That is what Retry is
        // for. (This script's own attributes are not observed, so writing
        // one here cannot feed back into the observer.)
        if (message.getAttribute(PROCESSED_ATTR) === "skipped") {
          message.removeAttribute(PROCESSED_ATTR);
        }
        touched = true;
        continue;
      }
      // A new turn — or a whole conversation swapped in by the router — shows
      // up as a mutation on the container rather than on any message. Every
      // other mutation on the page is somebody else's business.
      if (record.type !== "childList") continue;
      for (const added of record.addedNodes) {
        if (added.nodeType !== 1) continue;
        const element = /** @type {Element} */ (added);
        if (
          element.matches?.(adapter.assistantSelector) ||
          element.querySelector?.(adapter.assistantSelector)
        ) {
          touched = true;
        }
      }
    }
    if (touched) schedule(SETTLE_MS);
  }

  function clearInjections() {
    injecting = true;
    try {
      for (const message of document.querySelectorAll(`[${PROCESSED_ATTR}]`)) {
        unwrapInjected(message);
        message.querySelector(`[${BADGE_ATTR}]`)?.remove();
        message.removeAttribute(PROCESSED_ATTR);
        message.removeAttribute(MESSAGE_KEY_ATTR);
      }
    } finally {
      observer?.takeRecords();
      injecting = false;
    }
  }

  function disableForHost() {
    const host = location.hostname;
    if (!disabledHosts.includes(host)) disabledHosts = [...disabledHosts, host];
    clearInjections();
    void chrome.storage.local.set({
      [STORAGE_KEY]: { enabled, disabledHosts },
    });
  }

  function readPreference(value) {
    enabled = value?.enabled !== false;
    disabledHosts = Array.isArray(value?.disabledHosts)
      ? value.disabledHosts.filter((host) => typeof host === "string")
      : [];
  }

  // --- Install --------------------------------------------------------------

  function install() {
    observer = new MutationObserver(onMutations);
    // The document, not the conversation container: both apps replace that
    // container when their router moves between conversations, which would
    // leave an observer attached to a detached node. `onMutations` filters,
    // and attribute changes are deliberately not observed — the processed
    // markers this script writes are attributes.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[STORAGE_KEY]) return;
      readPreference(changes[STORAGE_KEY].newValue);
      if (isEnabled()) scan();
      else clearInjections();
    });

    chrome.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        readPreference(stored?.[STORAGE_KEY]);
        if (isEnabled()) scan();
      })
      .catch(() => scan());
  }

  const hostname = typeof location === "undefined" ? "" : location.hostname;
  adapter =
    ADAPTERS.find((candidate) => candidate.hosts.includes(hostname)) || null;
  const testing =
    globalThis.__tokenpathChatCitationHooks &&
    typeof globalThis.__tokenpathChatCitationHooks === "object";

  if (testing) {
    // The unit suite evaluates this file for its offset helpers; nothing is
    // observed and no message is processed. A real page never defines this.
    Object.assign(globalThis.__tokenpathChatCitationHooks, {
      answerKey,
      extractAnswer,
      normalizeNodeText,
      piecesForSpan,
      setAdapter: (id) => {
        adapter = ADAPTERS.find((candidate) => candidate.id === id) || null;
      },
    });
  } else if (
    adapter &&
    typeof document !== "undefined" &&
    typeof window !== "undefined" &&
    // Both apps run the conversation in the top-level document; an iframe
    // here is an embed, a preview, or an ad.
    window.top === window &&
    globalThis.__tokenpathChatCitations !== VERSION
  ) {
    globalThis.__tokenpathChatCitations = VERSION;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", install, { once: true });
    } else {
      install();
    }
  }
})();
