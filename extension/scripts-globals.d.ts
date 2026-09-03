// Ambient globals for the build-free scripts checked by tsconfig.scripts.json.
//
// sidepanel/panel-logic.js publishes TokenPathPanelLogic as a top-level const
// for the plain <script> tags in sidepanel/panel.html, but its trailing
// `module.exports` guard makes TypeScript treat the file as a CommonJS module,
// so the const never reaches the checker's global scope. Declared loosely on
// purpose: the source of truth is panel-logic.js, and a hand-maintained shape
// here could drift without the compiler noticing.
declare const TokenPathPanelLogic: Record<string, (...args: any[]) => any>;

// text-fragments.js and chat-sources.js publish their objects as top-level
// consts for the plain <script>/content-script load order, and both end with a
// `module.exports` guard so the unit suite can require them directly. That
// guard makes TypeScript treat each file as a CommonJS module, so the const
// never reaches the checker's global scope. Declared loosely on purpose: the
// source of truth is the file itself.
declare const TokenPathTextFragments: Record<string, any>;
declare const TokenPathChatSources: Record<string, any>;

// background.js is a classic MV3 service worker; the DOM lib TypeScript loads
// for the rest of these files does not declare the worker global it uses to
// load the shared scripts above.
declare function importScripts(...urls: string[]): void;
