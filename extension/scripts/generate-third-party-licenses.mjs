// Regenerates ../THIRD-PARTY-LICENSES.md, the attribution notice shipped
// inside the Chrome Web Store package.
//
// The store ZIP distributes `sidepanel/panel.js`, a minified bundle. The
// minifier strips the per-file license headers that MIT, ISC, BSD, and
// Apache-2.0 all require to travel with the code, so the notice has to be
// restored somewhere in the distribution. This file is that somewhere.
//
// The package list is not guessed from package.json: it is the exact set of
// third-party modules Rollup actually emitted into the bundle, read back from
// the build's own module graph. A production dependency that never reaches the
// bundle (mermaid, katex, and the d3 stack, all reachable from streamdown but
// tree-shaken away) is not distributed and is not claimed here; a transitive
// dependency nobody declared but the bundler pulled in is.
//
// Run `npm run licenses` after any dependency change. CI regenerates and
// diffs, so a stale notice fails the build.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionRoot, "..");
const outputPath = join(repoRoot, "THIRD-PARTY-LICENSES.md");
const modulesDir = join(extensionRoot, "node_modules");

// Packages that ship code into the package without appearing in the JS module
// graph. Tailwind's own preflight and utility CSS is emitted verbatim into
// sidepanel/panel.css, so it is distributed even though it is a build-time
// dependency.
const ADDITIONAL_PACKAGES = new Map([
  ["tailwindcss", "Emitted into sidepanel/panel.css."],
]);

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

// Several Apache-2.0 packages ship only the short "Licensed under the Apache
// License, Version 2.0" header, which names the copyright holder but is not
// the license — and clause 4(a) requires giving recipients a copy of the
// license itself. Their header is kept (it carries the copyright line) and the
// full text is appended below it, from the canonical copy vendored beside this
// script.
const APACHE_FULL_TEXT_MARKER =
  "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION";
const apacheFullText = (
  await readFile(join(import.meta.dirname, "licenses", "apache-2.0.txt"), "utf8")
).replace(/\s+$/, "");

async function bundledPackageNames() {
  const result = await build({
    root: extensionRoot,
    configFile: join(extensionRoot, "vite.config.ts"),
    mode: "store",
    logLevel: "warn",
    build: { write: false, sourcemap: false },
  });

  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (bundle) => bundle.output ?? []
  );
  const names = new Set();
  for (const chunk of outputs) {
    if (chunk.type !== "chunk") continue;
    for (const [id, module] of Object.entries(chunk.modules)) {
      // A module Rollup kept in the graph but shook down to nothing is not
      // distributed and must not be claimed.
      if (!module.renderedLength) continue;
      const name = packageNameFromId(id);
      if (name) names.add(name);
    }
  }
  return names;
}

function packageNameFromId(id) {
  const marker = `${sep}node_modules${sep}`;
  const index = id.lastIndexOf(marker);
  if (index < 0) return null;
  const segments = id.slice(index + marker.length).split(sep);
  return segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

async function licenseTextFor(name) {
  const packageDir = join(modulesDir, ...name.split("/"));
  const entries = await readdir(packageDir);
  const candidates = entries.filter((entry) => LICENSE_FILE.test(entry)).sort();
  if (!candidates.length) return null;
  const text = await readFile(join(packageDir, candidates[0]), "utf8");
  return { file: candidates[0], text: text.replace(/\s+$/, "") };
}

function attributionOf(manifest) {
  const person = manifest.author;
  if (!person) return "";
  if (typeof person === "string") return person.replace(/\s*<[^>]*>/g, "").trim();
  return String(person.name || "").trim();
}

const names = new Set([
  ...(await bundledPackageNames()),
  ...ADDITIONAL_PACKAGES.keys(),
]);

const packages = [];
const gaps = [];
for (const name of [...names].sort()) {
  const manifest = JSON.parse(
    await readFile(join(modulesDir, ...name.split("/"), "package.json"), "utf8")
  );
  const license = await licenseTextFor(name);
  if (!license) {
    gaps.push(`${name}: no LICENSE file in node_modules/${name}`);
    continue;
  }
  if (!/copyright/i.test(license.text)) {
    // A license text with no copyright line cannot satisfy the "retain the
    // copyright notice" clause it is being quoted for. Refuse rather than
    // ship an attribution that attributes nothing.
    gaps.push(`${name}: ${license.file} carries no copyright line`);
    continue;
  }
  const spdx =
    typeof manifest.license === "string"
      ? manifest.license
      : manifest.license?.type || "see license text";
  let completedFrom = "";
  if (spdx === "Apache-2.0" && !license.text.includes(APACHE_FULL_TEXT_MARKER)) {
    license.text = `${license.text}\n\n${apacheFullText}`;
    completedFrom =
      "This package ships only the short Apache-2.0 header; its copyright " +
      "line is above and the full license text follows it.";
  }

  packages.push({
    name,
    version: manifest.version,
    spdx,
    completedFrom,
    homepage: manifest.homepage || "",
    author: attributionOf(manifest),
    note: ADDITIONAL_PACKAGES.get(name) || "",
    license,
  });
}

if (gaps.length) {
  throw new Error(
    "Cannot generate a complete third-party notice. Add the missing text by " +
      "hand to scripts/generate-third-party-licenses.mjs and re-run:\n  " +
      gaps.join("\n  ")
  );
}

const spdxCounts = new Map();
for (const entry of packages) {
  spdxCounts.set(entry.spdx, (spdxCounts.get(entry.spdx) || 0) + 1);
}
const spdxSummary = [...spdxCounts]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .map(([spdx, count]) => `${spdx} (${count})`)
  .join(", ");

const lines = [
  "# Third-party licenses",
  "",
  "<!-- Generated by extension/scripts/generate-third-party-licenses.mjs.",
  "     Run `npm run licenses` from extension/ to regenerate. -->",
  "",
  "Browse with TokenPath ships one minified side-panel bundle,",
  "`sidepanel/panel.js`, plus the generated `sidepanel/panel.css`. Minification",
  "removes the license headers those files' sources carry, so the notices are",
  "reproduced here in full and this file travels inside the Chrome Web Store",
  "package.",
  "",
  `The bundle embeds ${packages.length} third-party packages: ${spdxSummary}.`,
  "The list is read from the production build's own module graph, so a",
  "dependency that is declared but tree-shaken out of the bundle is not listed",
  "— it is not distributed.",
  "",
  "Everything below is the property of its respective copyright holders and is",
  "used under the terms reproduced with it.",
  "",
  "## Contents",
  "",
];

for (const entry of packages) {
  lines.push(`- [${entry.name} ${entry.version}](#${anchorFor(entry)}) — ${entry.spdx}`);
}
lines.push("");

for (const entry of packages) {
  lines.push(`## ${entry.name} ${entry.version}`);
  lines.push("");
  lines.push(`- License: ${entry.spdx}`);
  if (entry.author) lines.push(`- Author: ${entry.author}`);
  if (entry.homepage) lines.push(`- Homepage: ${entry.homepage}`);
  if (entry.note) lines.push(`- Note: ${entry.note}`);
  if (entry.completedFrom) lines.push(`- Note: ${entry.completedFrom}`);
  lines.push("");
  lines.push("```");
  lines.push(entry.license.text);
  lines.push("```");
  lines.push("");
}

function anchorFor(entry) {
  return `${entry.name} ${entry.version}`
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

await writeFile(outputPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
console.log(`Wrote THIRD-PARTY-LICENSES.md (${packages.length} packages)`);
