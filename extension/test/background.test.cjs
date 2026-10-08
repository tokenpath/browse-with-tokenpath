const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const vm = require("vm");

const calls = [];
let clickHandler;
let actionClickHandler;
let installedHandler;
let runtimeMessageHandler;
let autoCommitTabUpdates = true;
let detectedContentType = "text/html";
let pendingTabCommit = null;
let sendMessageImpl = () => Promise.resolve({ text: "Fable 5", error: null });
// The in-place URL rewrite is the only injection that carries `args`; every
// other executeScript in background.js probes the tab's MIME type.
const isUrlRewrite = (options) =>
  typeof options?.func === "function" &&
  String(options.func).includes("replaceState");
const defaultExecuteScript = (options) =>
  isUrlRewrite(options)
    ? Promise.resolve([{ result: true }])
    : Promise.resolve(
        options?.func ? [{ result: detectedContentType }] : undefined
      );
let executeScriptImpl = defaultExecuteScript;
const tabUpdateListeners = new Set();
const tabRemovedListeners = new Set();
const tabUrls = new Map();
const sessionStore = new Map();
const localStore = new Map([["tokenpathKey", "tp-test-key"]]);
// Every fetch the worker makes in chat citation mode: the cited pages, and
// the TokenPath attribution call. Each test sets what it needs.
const fetchCalls = [];
let fetchImpl = () => Promise.reject(new Error("no fetch stub installed"));
const contextMenuItems = new Map([
  [
    "tldr-capture",
    {
      id: "tldr-capture",
      title: "TLDR",
      contexts: ["selection"],
    },
  ],
]);

const manifest = JSON.parse(
  readFileSync(join(__dirname, "..", "manifest.json"), "utf8")
);
// Page capture rides the declared all-frames content script; the blanket
// <all_urls> host permission is deliberate — it is what keeps tab.url visible
// to tabs.query/tabs.onUpdated outside a gesture (per-page chat restore,
// navigation invalidation, stale-seed checks) and covers the side panel's
// credentialed full-PDF fetch, and the content script already carries the
// identical install warning. TokenPath network access is separately
// constrained by the base-URL allowlist in sidepanel/tokenpath.js, whose
// origins must stay in lockstep with the API host permissions here.
assert(
  manifest.content_scripts.some((script) =>
    script.matches.includes("<all_urls>")
  ),
  "automatic tab capture requires the content script on ordinary web pages"
);
assert.deepStrictEqual(
  manifest.host_permissions,
  [
    "<all_urls>",
    "https://api.tokenpath.ai/*",
    "https://api-staging.tokenpath.ai/*",
    "http://localhost:8000/*",
    "http://127.0.0.1:8000/*",
  ],
  "host permissions: deliberate <all_urls> plus allowlisted TokenPath origins"
);

function emitTabCommit(tabId, url) {
  tabUrls.set(tabId, url);
  for (const listener of tabUpdateListeners) {
    listener(tabId, { url }, { id: tabId, url });
  }
}

function dispatchRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      const keepAlive = runtimeMessageHandler(message, {}, resolve);
      assert.strictEqual(
        keepAlive,
        true,
        `${message.type} must keep the runtime response channel open`
      );
    } catch (error) {
      reject(error);
    }
  });
}

const chrome = {
  runtime: {
    onInstalled: {
      addListener(handler) {
        installedHandler = handler;
      },
    },
    onMessage: {
      addListener(handler) {
        runtimeMessageHandler = handler;
      },
    },
    sendMessage(message) {
      calls.push(["runtime.sendMessage", message]);
      return Promise.resolve();
    },
  },
  action: {
    onClicked: {
      addListener(handler) {
        actionClickHandler = handler;
      },
    },
  },
  contextMenus: {
    create(options, callback) {
      calls.push(["contextMenus.create", options]);
      if (contextMenuItems.has(options.id)) {
        chrome.runtime.lastError = { message: "Duplicate menu item ID" };
      } else {
        contextMenuItems.set(options.id, { ...options });
      }
      callback?.();
      delete chrome.runtime.lastError;
    },
    update(id, options, callback) {
      calls.push(["contextMenus.update", id, options]);
      if (!contextMenuItems.has(id)) {
        chrome.runtime.lastError = { message: "Menu item not found" };
      } else {
        contextMenuItems.set(id, {
          ...contextMenuItems.get(id),
          ...options,
        });
      }
      callback();
      delete chrome.runtime.lastError;
    },
    remove(id, callback) {
      calls.push(["contextMenus.remove", id]);
      if (!contextMenuItems.delete(id)) {
        chrome.runtime.lastError = { message: "Menu item not found" };
      }
      callback();
      delete chrome.runtime.lastError;
    },
    onClicked: {
      addListener(handler) {
        clickHandler = handler;
      },
    },
  },
  sidePanel: {
    setPanelBehavior() {
      return Promise.resolve();
    },
    setOptions(options) {
      calls.push(["sidePanel.setOptions", options]);
      return Promise.resolve();
    },
    // Deliberately never resolves: capture must not wait for panel animation.
    open(options) {
      calls.push(["sidePanel.open", options]);
      return new Promise(() => {});
    },
  },
  tabs: {
    sendMessage(tabId, message, options) {
      calls.push(["tabs.sendMessage", tabId, message, options]);
      return sendMessageImpl(tabId, message, options);
    },
    update(tabId, properties) {
      calls.push(["tabs.update", tabId, properties]);
      if (autoCommitTabUpdates) {
        Promise.resolve().then(() => emitTabCommit(tabId, properties.url));
      } else {
        pendingTabCommit = () => emitTabCommit(tabId, properties.url);
      }
      return Promise.resolve({ id: tabId, pendingUrl: properties.url });
    },
    reload(tabId) {
      calls.push(["tabs.reload", tabId]);
      return Promise.resolve();
    },
    get(tabId) {
      calls.push(["tabs.get", tabId]);
      return Promise.resolve({ id: tabId, url: tabUrls.get(tabId) });
    },
    onUpdated: {
      addListener(listener) {
        tabUpdateListeners.add(listener);
      },
      removeListener(listener) {
        tabUpdateListeners.delete(listener);
      },
    },
    onRemoved: {
      addListener(listener) {
        tabRemovedListeners.add(listener);
      },
    },
  },
  scripting: {
    executeScript(options) {
      calls.push(["scripting.executeScript", options]);
      return executeScriptImpl(options);
    },
    insertCSS() {
      calls.push(["scripting.insertCSS"]);
      return Promise.resolve();
    },
  },
  storage: {
    // sidepanel/tokenpath.js reads the key and base URL from here; the worker
    // imports that client for chat citation mode.
    local: {
      get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Promise.resolve(
          Object.fromEntries(
            requested
              .filter((key) => localStore.has(key))
              .map((key) => [key, localStore.get(key)])
          )
        );
      },
      set(value) {
        for (const [key, stored] of Object.entries(value)) {
          localStore.set(key, stored);
        }
        return Promise.resolve();
      },
      remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          localStore.delete(key);
        }
        return Promise.resolve();
      },
    },
    // Backed by a real store: the applied-PDF-URL short-circuit has to survive
    // a service-worker restart, which is what makes it worth persisting.
    session: {
      get(keys) {
        calls.push(["storage.session.get", keys]);
        const requested = Array.isArray(keys) ? keys : [keys];
        return Promise.resolve(
          Object.fromEntries(
            requested
              .filter((key) => sessionStore.has(key))
              .map((key) => [key, sessionStore.get(key)])
          )
        );
      },
      set(value) {
        calls.push(["storage.session.set", value]);
        for (const [key, stored] of Object.entries(value)) {
          sessionStore.set(key, stored);
        }
        return Promise.resolve();
      },
      remove(keys) {
        calls.push(["storage.session.remove", keys]);
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          sessionStore.delete(key);
        }
        return Promise.resolve();
      },
    },
  },
};

const source = readFileSync(join(__dirname, "..", "background.js"), "utf8");
// MV3 suspends an idle service worker within about 30 seconds and re-runs this
// file on the next event, so "start a fresh worker over the same session
// storage" is an ordinary occurrence, not an exotic one.
function startWorker() {
  const context = vm.createContext({
    AbortController,
    TextDecoder,
    TextEncoder,
    chrome,
    console: { error() {}, warn() {} },
    Date,
    Promise,
    Math,
    URL,
    URLSearchParams,
    clearTimeout,
    setTimeout,
    fetch(input, init) {
      fetchCalls.push([String(input), init]);
      return fetchImpl(String(input), init);
    },
  });
  context.globalThis = context;
  // The real worker loads the shared text-fragment helpers, the chat source
  // logic, and the TokenPath client with importScripts, in this order. Run
  // them in the same context so the suite exercises the same globals the
  // worker sees rather than a stand-in.
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(readFileSync(join(__dirname, "..", file), "utf8"), context, {
        filename: file,
      });
    }
  };
  vm.runInContext(source, context, { filename: "background.js" });
  // A top-level `const` in a classic script — imported or not — is a global
  // lexical binding, not a property of the global object, in a worker exactly
  // as in this sandbox. background.js reads them by name; the suite has to ask
  // the context for them.
  context.importedGlobals = vm.runInContext(
    "({ TokenPath, TokenPathChatSources, TokenPathTextFragments })",
    context
  );
  return context;
}
const sandbox = startWorker();

assert.ok(clickHandler, "context-menu listener registered");
assert.ok(actionClickHandler, "toolbar-action listener registered");
assert.ok(runtimeMessageHandler, "runtime PDF listener registered");
assert.ok(installedHandler, "context-menu installer registered");

(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    contextMenuItems.has("tldr-capture"),
    false,
    "startup must remove the legacy standalone TLDR item"
  );
  assert.ok(
    calls.some(
      ([name, id]) =>
        name === "contextMenus.remove" && id === "tldr-capture"
    ),
    "legacy menu migration runs on service-worker startup"
  );
  assert.strictEqual(
    calls.some(([name]) => name === "contextMenus.removeAll"),
    false,
    "menu migration must never race startup by removing every item"
  );

  const expectedMenus = [
    ["tokenpath-chat", "Chat with TokenPath", undefined],
  ];
  for (const [id, title, parentId] of expectedMenus) {
    const item = contextMenuItems.get(id);
    assert.ok(item, `${id} is created on service-worker startup`);
    assert.strictEqual(item.title, title);
    assert.strictEqual(item.parentId, parentId);
    assert.deepStrictEqual(Array.from(item.contexts || []), [
      "selection",
      "page",
      "frame",
    ]);
  }
  for (const legacyId of [
    "tldr-capture",
    "TokenPath",
    "tokenpath-tldr",
    "tokenpath-simplify",
    "tokenpath-ask",
  ]) {
    assert.strictEqual(
      contextMenuItems.has(legacyId),
      false,
      `${legacyId} is removed from the visible context menu`
    );
  }

  const reinstallStart = calls.length;
  installedHandler();
  await new Promise((resolve) => setImmediate(resolve));
  const reinstallCalls = calls.slice(reinstallStart);
  assert.deepStrictEqual(
    reinstallCalls
      .filter(([name]) => name === "contextMenus.update")
      .map(([, id]) => id),
    expectedMenus.map(([id]) => id),
    "onInstalled idempotently upserts the complete menu tree"
  );
  assert.strictEqual(
    reinstallCalls.some(([name]) => name === "contextMenus.create"),
    false,
    "onInstalled does not duplicate an existing menu tree"
  );
  assert.strictEqual(
    reinstallCalls.some(([name]) => name === "contextMenus.remove"),
    false,
    "legacy migration runs once per service-worker lifetime"
  );
  console.log("PASS: startup migrates and idempotently upserts the TokenPath menu tree");

  sendMessageImpl = (_tabId, message) =>
    Promise.resolve(
      message.type === "capture-page"
        ? { text: "Toolbar article", error: null }
        : { text: "", error: "unexpected capture mode" }
  );
  const toolbarStart = calls.length;
  await actionClickHandler({
    id: 40,
    windowId: 3,
    url: "https://example.com/toolbar-article",
  });
  const toolbarCalls = calls.slice(toolbarStart);
  assert.ok(
    toolbarCalls.some(([name]) => name === "sidePanel.open"),
    "toolbar click opens the side panel"
  );
  const panelOptionsIndex = toolbarCalls.findIndex(
    ([name, options]) =>
      name === "sidePanel.setOptions" &&
      options?.tabId === 40 &&
      options.enabled === true &&
      options.path === "sidepanel/panel.html?tabId=40"
  );
  assert.ok(
    panelOptionsIndex >= 0 &&
      panelOptionsIndex <
        toolbarCalls.findIndex(([name]) => name === "sidePanel.open"),
    "the panel is enabled for the clicked tab only, before it opens"
  );
  assert.ok(
    calls.some(
      ([name, options]) =>
        name === "sidePanel.setOptions" &&
        options?.tabId == null &&
        options?.enabled === false
    ),
    "the window-wide panel stays disabled"
  );
  const toolbarCapture = toolbarCalls.find(
    ([name, tabId, message]) =>
      name === "tabs.sendMessage" &&
      tabId === 40 &&
      message?.type === "capture-page"
  );
  assert.ok(toolbarCapture, "toolbar click captures the active page");
  assert.strictEqual(toolbarCapture[2].forceFullPage, true);
  assert.strictEqual(toolbarCapture[3].frameId, 0);
  const toolbarSeed = toolbarCalls.find(
    ([name]) => name === "storage.session.set"
  )[1]["seed:40"];
  assert.strictEqual(toolbarSeed.captureMode, "full-page");
  assert.strictEqual(toolbarSeed.intent, "summarize");
  assert.strictEqual(toolbarSeed.text, "Toolbar article");
  assert.ok(
    toolbarCalls.findIndex(([name]) => name === "sidePanel.open") <
      toolbarCalls.findIndex(([name]) => name === "tabs.sendMessage"),
    "toolbar capture must not wait for the side panel"
  );
  console.log("PASS: toolbar click captures the page and starts a summary");

  tabUrls.set(40, "https://example.com/activated-tab");
  const silentCaptureStart = calls.length;
  const silentCaptureResponse = await dispatchRuntimeMessage({
    type: "capture-tab-for-chat",
    tabId: 40,
  });
  const silentCaptureCalls = calls.slice(silentCaptureStart);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(silentCaptureResponse)),
    { ok: true }
  );
  assert.strictEqual(
    silentCaptureCalls.some(([name]) => name === "sidePanel.open"),
    false,
    "an already-open panel must not be opened again during tab activation"
  );
  assert.strictEqual(
    silentCaptureCalls.find(
      ([name]) => name === "tabs.sendMessage"
    )[2].forceFullPage,
    true
  );
  console.log("PASS: an explicit chat action captures the full page");

  const clearStart = calls.length;
  const clearTabResponse = await dispatchRuntimeMessage({
    type: "clear-tab-highlights",
    tabId: 40,
  });
  const clearTabCalls = calls.slice(clearStart);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(clearTabResponse)),
    { ok: true }
  );
  const clearTabMessage = clearTabCalls.find(
    ([name, tabId, message]) =>
      name === "tabs.sendMessage" &&
      tabId === 40 &&
      message?.type === "clear-highlight"
  );
  assert.ok(clearTabMessage, "Clear broadcasts to the active tab");
  assert.strictEqual(
    clearTabMessage[3],
    undefined,
    "Clear must not be limited to one remembered frame"
  );
  console.log("PASS: Clear broadcasts across the active tab");

  const parentClickStart = calls.length;
  await clickHandler(
    { menuItemId: "TokenPath", frameId: 0, selectionText: "ignored" },
    { id: 41, windowId: 3, url: "https://example.com/" }
  );
  assert.strictEqual(
    calls.length,
    parentClickStart,
    "the TokenPath parent menu is non-actionable"
  );

  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 7,
      selectionText: "Fable 5",
    },
    { id: 42, windowId: 3, url: "https://mail.google.com/mail/u/0/" }
  );

  const openIndex = calls.findIndex(
    ([name, options]) =>
      name === "sidePanel.open" && options?.tabId === 42
  );
  const injectionIndex = calls.findIndex(
    ([name, options]) =>
      name === "scripting.executeScript" && options?.target?.tabId === 42
  );
  const captureIndex = calls.findIndex(
    ([name, tabId]) => name === "tabs.sendMessage" && tabId === 42
  );
  const storeIndex = calls.findIndex(
    ([name, value]) => name === "storage.session.set" && value?.["seed:42"]
  );
  assert.ok(
    injectionIndex >= 0 && injectionIndex < openIndex,
    "exact-frame injection begins before opening the panel"
  );
  assert.ok(openIndex >= 0 && captureIndex > openIndex);
  assert.ok(storeIndex > captureIndex, "captured seed stored without awaiting panel open");

  const capture = calls[captureIndex];
  assert.strictEqual(capture[1], 42);
  assert.strictEqual(capture[2].type, "capture-selection");
  assert.strictEqual(capture[2].selectionText, "Fable 5");
  assert.ok(capture[2].captureId);
  assert.strictEqual(capture[3].frameId, 7);

  const storedObject = calls[storeIndex][1];
  const seed = storedObject["seed:42"];
  assert.strictEqual(
    Object.keys(storedObject).length,
    1,
    "one seed key per tab, replaced whole by the next capture"
  );
  assert.ok(
    Number.isInteger(seed.seededAt) && seed.seededAt >= seed.capturedAt,
    "the seed is stamped so a late panel can expire it"
  );
  assert.strictEqual(seed.frameId, 7);
  assert.strictEqual(seed.windowId, 3);
  assert.strictEqual(seed.url, "https://mail.google.com/mail/u/0/");
  assert.strictEqual(seed.intent, "summarize");
  assert.strictEqual(seed.captureMode, "selection");
  assert.ok(seed.captureId);
  const runtimeCapture = calls.find(
    ([name, message]) =>
      name === "runtime.sendMessage" &&
      message?.type === "selection-captured" &&
      message?.captureId === seed.captureId
  )?.[1];
  assert.strictEqual(runtimeCapture?.url, seed.url);
  assert.strictEqual(runtimeCapture?.intent, "summarize");
  console.log("PASS: selection capture does not wait for side-panel opening");
  console.log("PASS: Gmail/nested-frame capture preserves the originating frame");
  console.log("PASS: content injection begins before panel focus can hide selection");

  let retryAttempt = 0;
  sendMessageImpl = () => {
    retryAttempt += 1;
    if (retryAttempt === 1) {
      return Promise.reject(new Error("Receiving end does not exist"));
    }
    return Promise.resolve({ text: "Substack selection", error: null });
  };
  const retryStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 0,
      selectionText: "Substack selection",
    },
    { id: 43, windowId: 3, url: "https://example.substack.com/p/post" }
  );
  const retryCalls = calls.slice(retryStart);
  assert.strictEqual(
    retryCalls.filter(([name]) => name === "tabs.sendMessage").length,
    2,
    "capture retries once after exact-frame injection completes"
  );
  assert.strictEqual(
    retryCalls.find(([name]) => name === "storage.session.set")[1]["seed:43"]
      .text,
    "Substack selection"
  );
  console.log("PASS: already-open Substack tabs retry capture after injection");

  let contentRetryAttempt = 0;
  sendMessageImpl = () => {
    contentRetryAttempt += 1;
    if (contentRetryAttempt === 1) {
      return Promise.resolve({
        text: "",
        error: "The page changed before the selection could be captured.",
      });
    }
    return Promise.resolve({ text: "Recovered selection", error: null });
  };
  const contentRetryStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 0,
      selectionText: "Recovered selection",
    },
    { id: 44, windowId: 3, url: "https://example.substack.com/p/post" }
  );
  const contentRetryCalls = calls.slice(contentRetryStart);
  assert.strictEqual(
    contentRetryCalls.filter(([name]) => name === "tabs.sendMessage").length,
    2,
    "content-level capture errors retry once after injection"
  );
  assert.strictEqual(
    contentRetryCalls.find(([name]) => name === "storage.session.set")[1][
      "seed:44"
    ].text,
    "Recovered selection"
  );
  console.log("PASS: a stale page-changed response is retried after injection");

  const pending = [];
  sendMessageImpl = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const storageStart = calls.length;
  const older = clickHandler(
    { menuItemId: "tokenpath-tldr", frameId: 0, selectionText: "older" },
    { id: 99, windowId: 3, url: "https://x.com/home" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(pending.length, 1);
  const newer = clickHandler(
    { menuItemId: "tokenpath-tldr", frameId: 0, selectionText: "newer" },
    { id: 99, windowId: 3, url: "https://x.com/home" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(pending.length, 2);
  pending[1]({ text: "newer", error: null });
  await newer;
  pending[0]({ text: "older", error: null });
  await older;

  const racedSeeds = calls
    .slice(storageStart)
    .filter(([name]) => name === "storage.session.set")
    .map(([, value]) => value["seed:99"]);
  assert.deepStrictEqual(
    racedSeeds.map((seed) => seed.text),
    ["newer"],
    "a slow older extraction must not replace the newer click"
  );
  assert.ok(
    racedSeeds.every((seed) => Number.isInteger(seed.seededAt)),
    "every stored seed carries its write timestamp"
  );
  console.log("PASS: out-of-order extraction completion keeps the newest click");

  const mimeResolvers = [];
  executeScriptImpl = (options) =>
    options?.func
      ? new Promise((resolve) => {
          mimeResolvers.push(resolve);
        })
      : Promise.resolve();
  sendMessageImpl = () =>
    Promise.resolve({
      text: "newer full-page context",
      error: null,
      captureMode: "full-page",
    });
  const mimeRaceStart = calls.length;
  const olderMimeCapture = clickHandler(
    { menuItemId: "tokenpath-tldr", frameId: 4 },
    { id: 100, windowId: 3, url: "https://example.com/race" }
  );
  const newerMimeCapture = clickHandler(
    { menuItemId: "tokenpath-ask", frameId: 8 },
    { id: 100, windowId: 3, url: "https://example.com/race" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(mimeResolvers.length, 2);
  mimeResolvers[1]([{ result: "text/html" }]);
  await newerMimeCapture;
  mimeResolvers[0]([{ result: "text/html" }]);
  await olderMimeCapture;
  executeScriptImpl = defaultExecuteScript;

  const mimeRaceCalls = calls.slice(mimeRaceStart);
  const mimeRaceMessages = mimeRaceCalls.filter(
    ([name]) => name === "tabs.sendMessage"
  );
  assert.strictEqual(
    mimeRaceMessages.length,
    1,
    "an older MIME probe must not overwrite the newer frame extraction"
  );
  assert.strictEqual(mimeRaceMessages[0][3].frameId, 8);
  const mimeRaceSeeds = mimeRaceCalls
    .filter(([name]) => name === "storage.session.set")
    .map(([, value]) => value["seed:100"]);
  assert.strictEqual(mimeRaceSeeds.length, 1);
  assert.strictEqual(mimeRaceSeeds[0].intent, "ask");
  assert.strictEqual(mimeRaceSeeds[0].frameId, 8);
  assert.strictEqual(mimeRaceSeeds[0].captureMode, "full-page");
  console.log("PASS: a stale MIME probe cannot replace a newer page capture");

  const pdfCaptureStart = calls.length;
  detectedContentType = "application/pdf";
  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 4,
      frameUrl:
        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      pageUrl: "https://example.com/reports/dummy.pdf",
      selectionText: "  Dummy PDF file  ",
    },
    {
      id: 120,
      windowId: 3,
      url: "https://example.com/reports/dummy.pdf",
    }
  );
  detectedContentType = "text/html";
  const pdfCaptureCalls = calls.slice(pdfCaptureStart);
  assert.strictEqual(
    pdfCaptureCalls.some(
      ([name, options]) =>
        name === "scripting.executeScript" &&
        options?.files?.includes("content.js")
    ),
    false,
    "the protected native PDF viewer must not receive a content-script injection"
  );
  assert.strictEqual(
    pdfCaptureCalls.some(([name]) => name === "tabs.sendMessage"),
    false,
    "PDF capture must use contextMenus.selectionText directly"
  );
  const pdfSeed = pdfCaptureCalls.find(
    ([name]) => name === "storage.session.set"
  )[1]["seed:120"];
  assert.strictEqual(pdfSeed.text, "Dummy PDF file");
  assert.strictEqual(pdfSeed.sourceType, "chrome-pdf");
  assert.strictEqual(pdfSeed.url, "https://example.com/reports/dummy.pdf");
  console.log("PASS: Chrome PDF selections bypass protected viewer injection");

  detectedContentType = "application/pdf";
  const modernPdfCaptureStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tokenpath-simplify",
      frameId: 6,
      // Modern OOPIF PDF context menus can report the original PDF URL here
      // instead of the protected viewer extension URL.
      frameUrl: "https://example.com/reports/modern.pdf",
      pageUrl: "https://example.com/reports/modern.pdf",
      selectionText: "Modern PDF selection",
    },
    {
      id: 121,
      windowId: 3,
      url: "https://example.com/reports/modern.pdf",
    }
  );
  detectedContentType = "text/html";
  const modernPdfCaptureCalls = calls.slice(modernPdfCaptureStart);
  assert.strictEqual(
    modernPdfCaptureCalls.some(([name]) => name === "tabs.sendMessage"),
    false,
    "modern PDF capture must not depend on its OOPIF frame URL"
  );
  const modernPdfSeed = modernPdfCaptureCalls.find(
    ([name]) => name === "storage.session.set"
  )[1]["seed:121"];
  assert.strictEqual(modernPdfSeed.text, "Modern PDF selection");
  assert.strictEqual(modernPdfSeed.sourceType, "chrome-pdf");
  assert.strictEqual(modernPdfSeed.intent, "simplify");
  console.log("PASS: modern OOPIF PDFs are detected by top-level MIME type");

  detectedContentType = "application/pdf";
  const fullPdfCaptureStart = calls.length;
  const fullPdfCapture = clickHandler(
    {
      menuItemId: "tokenpath-ask",
      frameId: 0,
      frameUrl:
        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      pageUrl: "https://example.com/reports/full.pdf",
      selectionText: "",
    },
    {
      id: 123,
      windowId: 3,
      url: "https://example.com/reports/full.pdf",
    }
  );
  assert.strictEqual(
    calls
      .slice(fullPdfCaptureStart)
      .some(([name]) => name === "sidePanel.open"),
    true,
    "full-PDF capture must open the side panel in the context-menu gesture"
  );
  await fullPdfCapture;
  detectedContentType = "text/html";
  const fullPdfCaptureCalls = calls.slice(fullPdfCaptureStart);
  assert.strictEqual(
    fullPdfCaptureCalls.some(([name]) => name === "tabs.sendMessage"),
    false,
    "full-PDF capture must not message the protected viewer"
  );
  const fullPdfSeed = fullPdfCaptureCalls.find(
    ([name]) => name === "storage.session.set"
  )[1]["seed:123"];
  assert.strictEqual(fullPdfSeed.sourceType, "chrome-pdf");
  assert.strictEqual(fullPdfSeed.captureMode, "full-pdf");
  assert.strictEqual(fullPdfSeed.intent, "ask");
  assert.strictEqual(fullPdfSeed.text, "");
  assert.strictEqual(fullPdfSeed.error, null);
  assert.strictEqual(
    fullPdfSeed.url,
    "https://example.com/reports/full.pdf"
  );
  const fullPdfRuntimeCapture = fullPdfCaptureCalls.find(
    ([name, message]) =>
      name === "runtime.sendMessage" &&
      message?.type === "selection-captured" &&
      message?.captureId === fullPdfSeed.captureId
  )?.[1];
  assert.strictEqual(fullPdfRuntimeCapture?.captureMode, "full-pdf");
  assert.strictEqual(fullPdfRuntimeCapture?.intent, "ask");
  assert.strictEqual(fullPdfRuntimeCapture?.error, null);
  console.log("PASS: no-selection PDFs hand full-document capture to the panel");

  const fullPageActions = [
    ["tokenpath-tldr", "summarize"],
    ["tokenpath-simplify", "simplify"],
    ["tokenpath-ask", "ask"],
  ];
  for (const [index, [menuItemId, intent]] of fullPageActions.entries()) {
    const pageText = `Whole frame article for ${intent}`;
    sendMessageImpl = (_tabId, message) =>
      Promise.resolve(
        message.type === "capture-page"
          ? {
              text: pageText,
              error: null,
              truncated: intent === "simplify",
            }
          : {
              text: "stale page selection",
              error: null,
            }
      );
    const tabId = 124 + index;
    const fullPageCaptureStart = calls.length;
    await clickHandler(
      {
        menuItemId,
        frameId: 13,
        pageUrl: `https://example.com/article/${intent}`,
      },
      {
        id: tabId,
        windowId: 3,
        url: `https://example.com/article/${intent}`,
      }
    );
    const fullPageCaptureCalls = calls.slice(fullPageCaptureStart);
    const fullPageMessages = fullPageCaptureCalls.filter(
      ([name]) => name === "tabs.sendMessage"
    );
    assert.strictEqual(
      fullPageMessages.length,
      1,
      `${intent} should capture the page exactly once`
    );
    assert.strictEqual(fullPageMessages[0][1], tabId);
    assert.strictEqual(fullPageMessages[0][2].type, "capture-page");
    assert.strictEqual(fullPageMessages[0][2].forceFullPage, false);
    assert.ok(fullPageMessages[0][2].captureId);
    assert.strictEqual(fullPageMessages[0][2].selectionText, undefined);
    assert.strictEqual(fullPageMessages[0][3].frameId, 13);
    assert.ok(
      fullPageCaptureCalls.findIndex(
        ([name]) => name === "sidePanel.open"
      ) <
        fullPageCaptureCalls.findIndex(
          ([name]) => name === "tabs.sendMessage"
        ),
      "the full-page capture must not wait for the side panel"
    );

    const fullPageSeed = fullPageCaptureCalls.find(
      ([name]) => name === "storage.session.set"
    )[1][`seed:${tabId}`];
    assert.strictEqual(fullPageSeed.sourceType, "page");
    assert.strictEqual(fullPageSeed.captureMode, "full-page");
    assert.strictEqual(fullPageSeed.frameId, 13);
    assert.strictEqual(fullPageSeed.intent, intent);
    assert.strictEqual(fullPageSeed.text, pageText);
    assert.strictEqual(fullPageSeed.error, null);
    assert.strictEqual(
      fullPageSeed.truncated,
      intent === "simplify"
    );
    const fullPageRuntimeCapture = fullPageCaptureCalls.find(
      ([name, message]) =>
        name === "runtime.sendMessage" &&
        message?.type === "selection-captured" &&
        message?.captureId === fullPageSeed.captureId
    )?.[1];
    assert.strictEqual(
      fullPageRuntimeCapture?.captureMode,
      "full-page"
    );
    assert.strictEqual(fullPageRuntimeCapture?.intent, intent);
    assert.strictEqual(fullPageRuntimeCapture?.text, pageText);
  }
  console.log(
    "PASS: no-selection HTML actions capture the full originating frame"
  );

  sendMessageImpl = () =>
    Promise.resolve({
      captureMode: "selection",
      text: "Exact context-menu selection",
      error: null,
      truncated: false,
    });
  const omittedHintStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 5,
      pageUrl: "https://example.com/omitted-selection-hint",
    },
    {
      id: 130,
      windowId: 3,
      url: "https://example.com/omitted-selection-hint",
    }
  );
  const omittedHintSeed = calls
    .slice(omittedHintStart)
    .find(([name]) => name === "storage.session.set")[1]["seed:130"];
  assert.strictEqual(omittedHintSeed.captureMode, "selection");
  assert.strictEqual(omittedHintSeed.text, "Exact context-menu selection");
  assert.strictEqual(omittedHintSeed.frameId, 5);
  console.log(
    "PASS: an exact contextmenu Range beats an omitted selectionText hint"
  );

  sendMessageImpl = () => Promise.reject(new Error("Protected PDF frame"));
  const embeddedPdfStart = calls.length;
  await clickHandler(
    {
      menuItemId: "tokenpath-tldr",
      frameId: 8,
      frameUrl:
        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      pageUrl: "https://example.com/article-with-embed",
      selectionText: "Embedded PDF selection",
    },
    {
      id: 122,
      windowId: 3,
      url: "https://example.com/article-with-embed",
    }
  );
  const embeddedPdfCalls = calls.slice(embeddedPdfStart);
  const embeddedPdfSeed = embeddedPdfCalls.find(
    ([name]) => name === "storage.session.set"
  )[1]["seed:122"];
  assert.strictEqual(embeddedPdfSeed.sourceType, "page");
  assert.strictEqual(embeddedPdfSeed.text, "");
  assert.ok(embeddedPdfSeed.error);
  console.log("PASS: embedded PDFs never navigate their outer HTML tab");

  tabUrls.set(120, "https://example.com/reports/dummy.pdf");
  const pdfHighlightStart = calls.length;
  const highlightResponse = await dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 6,
    end: 9,
  });
  assert.strictEqual(highlightResponse?.ok, true);
  const highlightCalls = calls.slice(pdfHighlightStart);
  const rewrite = highlightCalls.find(
    ([name, options]) => name === "scripting.executeScript" && isUrlRewrite(options)
  );
  assert.strictEqual(
    rewrite?.[1]?.args?.[0],
    "https://example.com/reports/dummy.pdf#:~:text=Dummy-,PDF,-file"
  );
  assert.strictEqual(
    highlightCalls.some(([name]) => name === "tabs.update"),
    false,
    "a PDF fragment is replaced in place, never navigated: tabs.update would " +
      "add a Back entry for every attribution click"
  );
  assert.strictEqual(
    highlightCalls.filter(([name]) => name === "tabs.reload").length,
    1,
    "the single reload is what makes Chrome apply the text fragment"
  );
  assert.ok(
    highlightCalls.findIndex(([name]) => name === "tabs.reload") >
      highlightCalls.findIndex(
        ([name, options]) =>
          name === "scripting.executeScript" && isUrlRewrite(options)
      ),
    "the URL must carry the directive before the viewer reloads"
  );
  assert.strictEqual(
    sessionStore.get("pdfApplied:120"),
    "https://example.com/reports/dummy.pdf#:~:text=Dummy-,PDF,-file",
    "the applied URL is persisted, not held in worker memory"
  );
  console.log("PASS: PDF attribution builds contextual native text fragments");
  console.log("PASS: PDF highlights replace the URL in place and reload once");

  const repeatedHighlightStart = calls.length;
  const repeatedHighlightResponse = await dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 6,
    end: 9,
  });
  assert.strictEqual(repeatedHighlightResponse?.ok, true);
  assert.strictEqual(
    calls
      .slice(repeatedHighlightStart)
      .some(([name]) => name === "tabs.update" || name === "tabs.reload"),
    false,
    "clicking the already-active PDF attribution must not reload again"
  );
  console.log("PASS: repeated PDF attribution is an immediate no-op");

  // The tab's own URL reads back without the directive Chrome consumed, so the
  // short-circuit has only the stored record to go on — and that record has to
  // outlive the worker that wrote it.
  tabUrls.set(120, "https://example.com/reports/dummy.pdf");
  startWorker();
  const restartedHighlightStart = calls.length;
  const restartedHighlightResponse = await dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 6,
    end: 9,
  });
  assert.strictEqual(restartedHighlightResponse?.ok, true);
  assert.strictEqual(
    calls
      .slice(restartedHighlightStart)
      .some(([name]) => name === "tabs.reload"),
    false,
    "a suspended service worker must not reload an already-applied fragment"
  );
  console.log("PASS: the applied-fragment short-circuit survives suspension");

  let resolveRewrite = null;
  executeScriptImpl = (options) => {
    if (!isUrlRewrite(options)) return defaultExecuteScript(options);
    return new Promise((resolve) => {
      resolveRewrite = () => resolve([{ result: true }]);
    });
  };
  const cancelledHighlightStart = calls.length;
  const cancelledHighlight = dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 0,
    end: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resolveRewrite, "a replacement PDF URL is pending");
  const cancelResponse = await dispatchRuntimeMessage({
    type: "cancel-pdf-source-operation",
    tabId: 120,
  });
  assert.strictEqual(cancelResponse?.ok, true);
  resolveRewrite();
  resolveRewrite = null;
  const cancelledHighlightResponse = await cancelledHighlight;
  assert.strictEqual(cancelledHighlightResponse?.ok, false);
  assert.strictEqual(
    calls
      .slice(cancelledHighlightStart)
      .some(([name]) => name === "tabs.reload"),
    false,
    "a cancelled PDF operation must never perform its late reload"
  );
  console.log("PASS: cancelled PDF attribution cannot reload late");

  // Restricted tabs reject injection. The fallback is the old behaviour: a
  // real navigation, waited out, then one reload.
  executeScriptImpl = (options) =>
    isUrlRewrite(options)
      ? Promise.reject(new Error("Cannot access contents of the page"))
      : defaultExecuteScript(options);
  autoCommitTabUpdates = false;
  const fallbackStart = calls.length;
  const fallbackHighlight = dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 0,
    end: 5,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const beforeCommit = calls.slice(fallbackStart);
  assert.strictEqual(
    beforeCommit.find(([name]) => name === "tabs.update")?.[2]?.url,
    "https://example.com/reports/dummy.pdf#:~:text=Dummy,-PDF%20file"
  );
  assert.strictEqual(
    beforeCommit.some(([name]) => name === "tabs.reload"),
    false,
    "PDF reload must wait until the text-fragment URL commits"
  );
  assert.ok(pendingTabCommit, "PDF URL commit is being observed");
  pendingTabCommit();
  pendingTabCommit = null;
  const fallbackResponse = await fallbackHighlight;
  assert.strictEqual(fallbackResponse?.ok, true);
  const afterCommit = calls.slice(fallbackStart);
  assert.ok(
    afterCommit.findIndex(([name]) => name === "tabs.reload") >
      afterCommit.findIndex(([name]) => name === "tabs.update"),
    "committed text-fragment navigation reloads the native PDF viewer"
  );
  console.log("PASS: uninjectable PDF tabs fall back to navigate-then-reload");
  console.log("PASS: PDF highlight reload waits for URL commit");

  executeScriptImpl = defaultExecuteScript;
  autoCommitTabUpdates = true;
  tabUrls.set(120, "https://example.com/reports/dummy.pdf");

  const reservedText = "before A-B, C&D #100% wow! ('yes') *done* after";
  const reservedStart = reservedText.indexOf("A-B");
  const reservedEnd = reservedText.indexOf(" after");
  const reservedDirective = sandbox.buildPdfTextFragment(
    reservedText,
    reservedStart,
    reservedEnd
  );
  assert.ok(reservedDirective.includes("before-,"));
  assert.ok(reservedDirective.includes("%2D"));
  assert.ok(reservedDirective.includes("%2C"));
  assert.ok(reservedDirective.includes("%26"));
  assert.ok(reservedDirective.includes("%23"));
  assert.ok(reservedDirective.includes("%25"));
  assert.ok(reservedDirective.includes("%21"));
  assert.ok(reservedDirective.includes("%28"));
  assert.ok(reservedDirective.includes("%29"));
  assert.ok(reservedDirective.includes("%2A"));
  assert.strictEqual(
    (reservedDirective.match(/-,/g) || []).length,
    1,
    "only the structural prefix separator stays unescaped"
  );
  assert.strictEqual(
    (reservedDirective.match(/,-/g) || []).length,
    1,
    "only the structural suffix separator stays unescaped"
  );

  const unicodeText = "導入 👩‍💻\r\n改善 結論";
  const unicodeStart = unicodeText.indexOf("👩");
  const unicodeEnd = unicodeText.indexOf(" 結論");
  const unicodeDirective = sandbox.buildPdfTextFragment(
    unicodeText,
    unicodeStart,
    unicodeEnd
  );
  assert.ok(
    unicodeDirective.includes("%E2%80%8D"),
    "meaningful emoji ZWJ must survive PDF fragment normalization"
  );
  assert.ok(
    !unicodeDirective.includes("%0D") && !unicodeDirective.includes("%0A"),
    "PDF fragment whitespace is normalized"
  );
  const splitBoundaryPrefix = `${"x".repeat(9)}👩${"y".repeat(126)}`;
  const splitBoundaryText = `${splitBoundaryPrefix} target`;
  assert.ok(
    sandbox.importedGlobals.TokenPathTextFragments.safeSlice(
      splitBoundaryText,
      10,
      splitBoundaryPrefix.length + 1
    ).startsWith("👩"),
    "bounded context must not split an emoji surrogate pair"
  );

  const longTarget = Array.from(
    { length: 120 },
    (_, index) => `word${index}`
  ).join(" ");
  const longDirective = sandbox.buildPdfTextFragment(
    `prefix ${longTarget} suffix`,
    7,
    7 + longTarget.length
  );
  assert.ok(
    longDirective.length < 650,
    "long source spans use bounded start/end fragments"
  );
  assert.ok(
    longDirective.split(",-")[0].split(",").length >= 3,
    "long source spans include separate start and end text"
  );
  assert.strictEqual(
    sandbox.buildPdfTextFragment("short", -1, 2),
    null
  );
  assert.strictEqual(
    sandbox.withTextFragment(
      "https://example.com/report.pdf#page=4&zoom=125:~:text=old",
      "new"
    ),
    "https://example.com/report.pdf#page=4&zoom=125:~:text=new"
  );
  console.log("PASS: PDF fragments bound long spans and encode source grammar");
  console.log("PASS: PDF fragments preserve Unicode shaping and normalize lines");

  // An implicit clear — panel close, a replaced capture, a cleared chat — only
  // cleans the URL. The user did not ask for their PDF to be reloaded, and a
  // reload would throw the viewer back to page 1.
  const quietClearStart = calls.length;
  const quietClearResponse = await dispatchRuntimeMessage({
    type: "clear-pdf-source-highlight",
    tabId: 120,
    url:
      "https://example.com/reports/dummy.pdf#page=1:~:text=Dummy-,PDF,-file",
  });
  assert.strictEqual(quietClearResponse?.ok, true);
  const quietClearCalls = calls.slice(quietClearStart);
  assert.strictEqual(
    quietClearCalls.find(
      ([name, options]) =>
        name === "scripting.executeScript" && isUrlRewrite(options)
    )?.[1]?.args?.[0],
    "https://example.com/reports/dummy.pdf#page=1",
    "clearing a PDF highlight preserves ordinary PDF anchors"
  );
  assert.strictEqual(
    quietClearCalls.some(
      ([name]) => name === "tabs.reload" || name === "tabs.update"
    ),
    false,
    "closing the panel must not navigate or reload the PDF tab"
  );
  console.log("PASS: an implicit PDF clear performs no tab navigation");

  // The explicit "Clear highlight" button is the documented exception: Chrome
  // offers no way to unpaint a text fragment short of loading the file again.
  const buttonClearStart = calls.length;
  const buttonClearResponse = await dispatchRuntimeMessage({
    type: "clear-pdf-source-highlight",
    tabId: 120,
    url:
      "https://example.com/reports/dummy.pdf#page=1:~:text=Dummy-,PDF,-file",
    reload: true,
  });
  assert.strictEqual(buttonClearResponse?.ok, true);
  const buttonClearCalls = calls.slice(buttonClearStart);
  assert.strictEqual(
    buttonClearCalls.find(
      ([name, options]) =>
        name === "scripting.executeScript" && isUrlRewrite(options)
    )?.[1]?.args?.[0],
    "https://example.com/reports/dummy.pdf#page=1"
  );
  assert.strictEqual(
    buttonClearCalls.filter(([name]) => name === "tabs.reload").length,
    1,
    "an explicit clear repaints the viewer, even though the URL is already bare"
  );
  assert.strictEqual(
    buttonClearCalls.some(([name]) => name === "tabs.update"),
    false
  );
  console.log("PASS: only the explicit Clear button reloads a PDF");

  for (const listener of tabRemovedListeners) listener(120, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(
    sessionStore.has("pdfApplied:120"),
    false,
    "a closed tab must not leave a recycled id an applied-URL record"
  );
  console.log("PASS: closing a tab drops its applied-PDF-URL record");
  tabUrls.set(120, "https://example.com/reports/dummy.pdf");

  tabUrls.set(120, "https://example.com/another-page");
  const stalePdfStart = calls.length;
  const stalePdfResponse = await dispatchRuntimeMessage({
    type: "highlight-pdf-source",
    tabId: 120,
    url: "https://example.com/reports/dummy.pdf",
    document: "Dummy PDF file",
    start: 6,
    end: 9,
  });
  assert.strictEqual(stalePdfResponse?.ok, false);
  assert.strictEqual(
    calls
      .slice(stalePdfStart)
      .some(
        ([name, options]) =>
          name === "tabs.update" ||
          (name === "scripting.executeScript" && isUrlRewrite(options))
      ),
    false,
    "a stale PDF panel must never navigate or rewrite its old document"
  );
  console.log("PASS: stale PDF attribution cannot restore a departed tab");


  // --- Chat citation mode ---------------------------------------------------
  //
  // One message from the chat content script has to become: a read of each
  // cited page, one packed attribution request, and per-source links back.

  const CITED_PAGE = (body) =>
    `<html><head><title>Cited page</title></head><body><article><p>${body}</p>` +
    `<p>${"Filler prose so the article region is substantial. ".repeat(12)}</p>` +
    `</article></body></html>`;

  function htmlResponse(body) {
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (/content-type/i.test(name) ? "text/html; charset=utf-8" : null) },
      body: null,
      text: () => Promise.resolve(CITED_PAGE(body)),
    };
  }

  let attributionRequests = [];
  let attributionSpansFor = () => [];
  fetchImpl = (url, init) => {
    if (url.startsWith("https://api.tokenpath.ai/")) {
      const payload = JSON.parse(init.body);
      attributionRequests.push(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            offset_encoding: "utf-16",
            spans: attributionSpansFor(payload),
          }),
      });
    }
    if (url === "https://a.example/one") {
      return Promise.resolve(htmlResponse("Alpha reports the rate rose to 18% in June."));
    }
    if (url === "https://b.example/two") {
      return Promise.resolve(htmlResponse("Beta says the programme covered 40,000 households."));
    }
    if (url === "https://e.example/streamed") {
      // The real path reads response.body in chunks, and a chunk boundary can
      // fall inside a multi-byte character.
      const bytes = new TextEncoder().encode(CITED_PAGE("Gamma measured 3°C warming."));
      const split = bytes.indexOf(0xc2);
      const chunks = [bytes.slice(0, split + 1), bytes.slice(split + 1)];
      let index = 0;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        body: {
          getReader: () => ({
            read: () =>
              Promise.resolve(
                index < chunks.length
                  ? { done: false, value: chunks[index++] }
                  : { done: true, value: undefined }
              ),
            cancel: () => Promise.resolve(),
          }),
        },
      });
    }
    if (url === "https://c.example/paywall") {
      return Promise.resolve({ ok: false, status: 403, headers: { get: () => null } });
    }
    return Promise.reject(new TypeError("Failed to fetch"));
  };

  const CHAT_ANSWER =
    "The rate rose to 18% in June, and the programme covered 40,000 households.";
  attributionSpansFor = (payload) => {
    const spanFor = (answerText, sourceText, confidence) => {
      const answerStart = payload.answer.indexOf(answerText);
      const sourceStart = payload.document.indexOf(sourceText);
      return {
        answer: {
          start: answerStart,
          end: answerStart + answerText.length,
          text: answerText,
        },
        source: {
          start: sourceStart,
          end: sourceStart + sourceText.length,
          text: sourceText,
          confidence,
        },
      };
    };
    return [
      spanFor("18%", "18% in June", 0.9),
      spanFor("40,000 households", "40,000 households", 0.8),
    ];
  };

  const chatFetchStart = fetchCalls.length;
  const chatResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: CHAT_ANSWER,
    question: "What happened to the rate in June?",
    urls: [
      "https://a.example/one?utm_source=chatgpt.com",
      "https://a.example/one",
      "https://b.example/two",
      "https://c.example/paywall",
      "javascript:alert(1)",
    ],
  });
  assert.strictEqual(chatResult.ok, true);
  assert.deepStrictEqual({ ...chatResult.stats }, {
    requested: 3,
    fetched: 2,
    spans: 2,
  });
  assert.strictEqual(
    fetchCalls
      .slice(chatFetchStart)
      .filter(([url]) => url === "https://a.example/one").length,
    1,
    "the same page cited twice in one answer is read once"
  );
  assert.strictEqual(
    fetchCalls.slice(chatFetchStart).some(([, init]) => init.credentials !== "omit" && init.method !== "POST"),
    false,
    "a cited third-party page is read without the user's cookies"
  );
  assert.strictEqual(attributionRequests.length, 1, "one request per message");
  assert.strictEqual(attributionRequests[0].offset_encoding, "utf-16");
  assert.strictEqual(attributionRequests[0].answer, CHAT_ANSWER);
  assert.ok(
    attributionRequests[0].document.includes("=== Source 1: https://a.example/one ===") &&
      attributionRequests[0].document.includes("=== Source 2: https://b.example/two ==="),
    "both readable sources are packed into the one attributed document"
  );
  assert.ok(
    !attributionRequests[0].document.includes("c.example/paywall"),
    "a source that could not be read is dropped rather than sent empty"
  );
  assert.deepStrictEqual(
    [...chatResult.attributions].map((attribution) => [
      attribution.answer.text,
      attribution.source.url,
    ]),
    [
      ["18%", "https://a.example/one"],
      ["40,000 households", "https://b.example/two"],
    ]
  );
  assert.ok(
    chatResult.attributions[1].source.link.startsWith(
      "https://b.example/two#:~:text="
    ),
    chatResult.attributions[1].source.link
  );
  assert.strictEqual(
    decodeURIComponent(
      chatResult.attributions[1].source.link.split("#:~:text=")[1]
    ),
    "40,000 households",
    "a source link points at the passage, not just the page"
  );
  console.log("PASS: chat citations pack cited pages into one attribution call");

  const warmFetchStart = fetchCalls.length;
  attributionRequests = [];
  const warmResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: `${CHAT_ANSWER} A second answer in the same conversation.`,
    question: "And after that?",
    urls: ["https://a.example/one", "https://b.example/two"],
  });
  assert.strictEqual(warmResult.ok, true);
  assert.strictEqual(
    fetchCalls
      .slice(warmFetchStart)
      .filter(([url]) => !url.startsWith("https://api.tokenpath.ai/")).length,
    0,
    "a later answer citing the same pages spends no further reads"
  );
  console.log("PASS: cited pages are cached for the worker's lifetime");

  attributionRequests = [];
  attributionSpansFor = () => [];
  const streamedResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: CHAT_ANSWER,
    question: "How much warming?",
    urls: ["https://e.example/streamed"],
  });
  assert.strictEqual(streamedResult.ok, true);
  assert.ok(
    attributionRequests[0].document.includes("Gamma measured 3°C warming."),
    "a streamed body decodes across chunk boundaries"
  );
  console.log("PASS: a cited page read in chunks decodes whole characters");

  const noSourceResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: CHAT_ANSWER,
    question: "What happened?",
    urls: ["javascript:alert(1)", "not a url"],
  });
  assert.strictEqual(noSourceResult.ok, true);
  assert.strictEqual([...noSourceResult.attributions].length, 0);
  assert.deepStrictEqual({ ...noSourceResult.stats }, {
    requested: 0,
    fetched: 0,
    spans: 0,
  });

  const unreadableResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: CHAT_ANSWER,
    question: "What happened?",
    urls: ["https://c.example/paywall", "https://d.example/offline"],
  });
  assert.strictEqual(unreadableResult.ok, true);
  assert.deepStrictEqual({ ...unreadableResult.stats }, {
    requested: 2,
    fetched: 0,
    spans: 0,
  });
  assert.strictEqual([...unreadableResult.attributions].length, 0);
  console.log("PASS: unreadable or absent sources report instead of attributing");

  const shortResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: "Yes.",
    question: "Did it?",
    urls: ["https://a.example/one"],
  });
  assert.strictEqual(shortResult.ok, false);

  localStore.delete("tokenpathKey");
  const disconnectedResult = await dispatchRuntimeMessage({
    type: "chat-citations-attribute",
    answer: CHAT_ANSWER,
    question: "What happened?",
    urls: ["https://a.example/one"],
  });
  assert.strictEqual(disconnectedResult.ok, false);
  assert.strictEqual(
    disconnectedResult.error,
    "connect TokenPath in the side panel",
    "a missing key is a wording the badge can show, not a bare failure"
  );
  localStore.set("tokenpathKey", "tp-test-key");
  console.log("PASS: chat citation failures come back as badge wording");

  console.log("\nAll background assertions passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
