// Exercise the shipped local bundle and actual store ZIP, including panel
// teardown/recreation (all JS state is lost, while IndexedDB persists).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundleFiles = ["panel.js", "panel.css"];
const localBefore = await Promise.all(
  bundleFiles.map((file) => readFile(join(root, "sidepanel", file)))
);
execFileSync(process.execPath, [join(root, "scripts/package-extension.mjs")], {
  cwd: root,
  stdio: "pipe",
});
for (const [index, file] of bundleFiles.entries()) {
  assert.deepEqual(await readFile(join(root, "sidepanel", file)), localBefore[index],
    `store packaging must leave the unpacked ${file} unchanged`);
}

const extracted = await mkdtemp(join(tmpdir(), "tokenpath-debug-build-test-"));
const { version } = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
let browser;
try {
  execFileSync("unzip", ["-q", join(root, "dist", `browse-with-tokenpath-${version}.zip`), "-d", extracted]);
  browser = await chromium.launch({ args: ["--no-sandbox"] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const event = { addListener() {}, removeListener() {} };
    const storage = { get: async () => ({}), set: async () => {}, remove: async () => {} };
    window.chrome = {
      runtime: { onMessage: event, sendMessage: async () => ({ ok: true }) },
      tabs: { query: async () => [], onUpdated: event, onRemoved: event },
      storage: { local: storage, session: storage, onChanged: event },
    };
    window.__openedDatabases = [];
    const open = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      window.__openedDatabases.push(args[0]);
      return open(...args);
    };
  });
  const localUrl = pathToFileURL(join(root, "sidepanel/panel.html")).href;
  let page = await context.newPage();
  await page.goto(localUrl);
  await page.waitForFunction(() => window.__openedDatabases.includes("tokenpath-saved-attribution-cases"));
  await page.locator("#saved-cases-toggle").waitFor();
  // The main panel e2e tests Save case; seed a record here to focus this
  // regression on restoring an existing database across bundle/reload changes.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("tokenpath-saved-attribution-cases", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("cases", "readwrite");
      transaction.objectStore("cases").put({
        schemaVersion: 1, id: "reload-case", note: "Keep this debugging evidence",
        savedAt: "2026-09-07T12:00:00Z", updatedAt: "2026-09-07T12:00:00Z",
        source: { url: "https://example.com", label: "Reload fixture", sourceType: "page" },
        attributionRequest: { method: "POST", path: "/v1/attributions", body: {
          document: "Source text", question: "Question", answer: "Answer",
        } },
        attributionResponse: { status: "ready", offsetEncoding: "utf-16", spans: [] },
      });
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  await page.close();
  page = await context.newPage();
  await page.goto(localUrl);
  await page.getByRole("button", { name: "Saved debug cases (1)", exact: true }).click();
  assert.equal(await page.locator(".saved-case-note").inputValue(), "Keep this debugging evidence");
  await page.reload();
  await page.getByRole("button", { name: "Saved debug cases (1)", exact: true }).click();
  assert.equal(await page.locator(".saved-case-note").inputValue(), "Keep this debugging evidence");

  await page.goto(pathToFileURL(join(extracted, "sidepanel/panel.html")).href);
  await page.locator("#tokenpath-key").waitFor();
  assert.equal(await page.locator("#saved-cases-toggle").count(), 0);
  assert.equal(await page.evaluate(() => window.__openedDatabases.includes("tokenpath-saved-attribution-cases")), false);
  console.log("PASS: debug tools and saved cases survive reopening/reload; store ZIP disables them and leaves local bundles unchanged");
} finally {
  await browser?.close();
  await rm(extracted, { recursive: true, force: true });
}
