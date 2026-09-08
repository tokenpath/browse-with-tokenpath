import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(join(extensionRoot, "manifest.json"), "utf8")
);
const archiveName = `browse-with-tokenpath-${manifest.version}.zip`;
const distDir = join(extensionRoot, "dist");
const archivePath = join(distDir, archiveName);

// Fixed archive timestamp. Info-ZIP writes DOS date/time from each entry's
// local-time mtime, so the child process also runs with TZ=UTC. Together with
// -X, -D, and a sorted entry list, the printed SHA-256 is re-derivable from
// the same sources on any machine.
const ARCHIVE_TIMESTAMP = new Date("2020-01-01T00:00:00Z");

const runtimeFiles = [
  "background.js",
  "chat-citations.css",
  "chat-citations.js",
  "chat-sources.js",
  "content.css",
  "content.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "sidepanel/panel.css",
  "sidepanel/panel.html",
  "sidepanel/panel.js",
  "sidepanel/panel-logic.js",
  "sidepanel/tokenpath.js",
  "text-fragments.js",
];

// Files that ship in the package but live outside the extension directory,
// mapped source -> archive path. The bundled side panel is minified, which
// strips the license headers MIT, ISC, BSD, and Apache-2.0 all require to
// travel with the code, so the notice has to ride along in the ZIP itself.
const repoRootFiles = new Map([
  ["THIRD-PARTY-LICENSES.md", "THIRD-PARTY-LICENSES.md"],
]);

// manifest.json cannot carry comments, so the host-permission policy lives
// here.
//
// The store package deliberately keeps the blanket <all_urls> host permission.
// The declared <all_urls> content script already carries the identical "read
// and change all your data on all websites" install warning and store review
// weight, so dropping the host permission gains nothing user-visible — and it
// breaks features that genuinely depend on it:
//   * `tabs.Tab.url` visibility outside a gesture (Chrome omits `url` from
//     `tabs.query`/`tabs.onUpdated` without host access), which per-page chat
//     restore, navigation invalidation, and stale-seed checks all read;
//   * the credentialed full-PDF download in src/sidepanel/pdf-text-extractor.ts
//     (cross-origin fetch from the side panel comes from host_permissions;
//     activeTab does not cover it);
//   * `chrome.scripting` injection into tabs that predate an extension reload,
//     when no fresh gesture has occurred (automatic capture on tab switch).
// Network access to TokenPath itself is separately constrained by the
// base-URL allowlist in sidepanel/tokenpath.js.
const STORE_HOST_PERMISSIONS = ["<all_urls>", "https://api.tokenpath.ai/*"];
const DEVELOPMENT_HOST_PERMISSIONS = [
  "https://api-staging.tokenpath.ai/*",
  "http://localhost:8000/*",
  "http://127.0.0.1:8000/*",
];

function storeHostPermissions(declared) {
  if (!Array.isArray(declared)) {
    throw new Error(
      'manifest.json "host_permissions" must be an array; refusing to guess ' +
        "what the store package should request."
    );
  }

  const known = new Set([
    ...STORE_HOST_PERMISSIONS,
    ...DEVELOPMENT_HOST_PERMISSIONS,
  ]);
  const unexpected = declared.filter((permission) => !known.has(permission));
  if (unexpected.length) {
    throw new Error(
      `Unrecognized host permission(s) in manifest.json: ${unexpected.join(
        ", "
      )}\n` +
        "Add each one to STORE_HOST_PERMISSIONS or " +
        "DEVELOPMENT_HOST_PERMISSIONS in scripts/package-extension.mjs and " +
        "update the store listing's permission justifications. Refusing to " +
        "ship an undocumented host permission."
    );
  }

  const missing = STORE_HOST_PERMISSIONS.filter(
    (permission) => !declared.includes(permission)
  );
  if (missing.length) {
    throw new Error(
      `manifest.json is missing required host permission(s): ${missing.join(
        ", "
      )}`
    );
  }

  // Development endpoints stay available to unpacked local builds only.
  return [...STORE_HOST_PERMISSIONS];
}

function requireZip() {
  const probe = spawnSync("zip", ["-v"], { encoding: "utf8" });
  if (probe.error?.code === "ENOENT" || probe.status === null) {
    throw new Error(
      "The `zip` command was not found on PATH. Install Info-ZIP " +
        "(macOS: preinstalled or `brew install zip`; Debian/Ubuntu: " +
        "`sudo apt-get install zip`) and re-run `npm run package:store`."
    );
  }
}

requireZip();
const hostPermissions = storeHostPermissions(manifest.host_permissions);
const stagingDir = await mkdtemp(join(tmpdir(), "tokenpath-extension-"));

try {
  for (const relativePath of runtimeFiles) {
    const destination = join(stagingDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(extensionRoot, relativePath), destination);
  }

  // Never replace the unpacked panel with a build that hides its debug tools.
  // Compile the store variant in staging, including for direct/CI packaging.
  await build({
    root: extensionRoot,
    configFile: join(extensionRoot, "vite.config.ts"),
    mode: "store",
    build: { outDir: join(stagingDir, "sidepanel"), emptyOutDir: false },
  });

  for (const [sourcePath, archivePath] of repoRootFiles) {
    const destination = join(stagingDir, archivePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(extensionRoot, "..", sourcePath), destination);
  }

  manifest.host_permissions = hostPermissions;
  await writeFile(
    join(stagingDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );

  // Sorted entries + normalized mtimes keep the archive byte-identical across
  // runs and machines.
  const archiveEntries = [
    ...runtimeFiles,
    ...repoRootFiles.values(),
    "manifest.json",
  ].sort();
  for (const relativePath of archiveEntries) {
    await utimes(
      join(stagingDir, relativePath),
      ARCHIVE_TIMESTAMP,
      ARCHIVE_TIMESTAMP
    );
  }

  await mkdir(distDir, { recursive: true });
  await rm(archivePath, { force: true });
  // -X drops uid/gid and platform extra fields (and macOS __MACOSX entries),
  // -D omits directory entries, and the explicit sorted list fixes entry order.
  const result = spawnSync(
    "zip",
    ["-q", "-X", "-D", archivePath, ...archiveEntries],
    {
      cwd: stagingDir,
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC" },
    }
  );
  if (result.error?.code === "ENOENT") {
    throw new Error("The `zip` command was not found on PATH.");
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || "zip failed");
  }
  const digest = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  console.log(`Created dist/${basename(archivePath)}`);
  console.log(`Store host_permissions: ${hostPermissions.join(", ")}`);
  console.log(`SHA-256 ${digest}`);
} finally {
  await rm(stagingDir, { recursive: true, force: true });
}
