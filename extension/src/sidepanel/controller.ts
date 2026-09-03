import { extractPdfText } from "@/pdf-text-extractor";
import {
  clearAll,
  deletePageChat,
  pageChatKey,
  pageContentSignificantlyChanged,
  readPageChat,
  sameDocumentUrl,
  writePageChat,
} from "@/chat-cache";
import {
  buildSavedAttributionCasesExport,
  deleteSavedAttributionCase,
  readSavedAttributionCases,
  writeSavedAttributionCase,
  type SavedAttributionCase,
} from "@/saved-attribution-cases";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
/** The two shipped summary shapes, plus the one the user wrote themselves. */
export type SummaryPreset = "bullets" | "detailed";
export type SummaryDepth = SummaryPreset | "custom";
// Why the click happened. Only the toolbar's "summarize" asks the panel to
// start a summary by itself; a context-menu capture is an "ask" and waits.
export type CaptureIntent = "summarize" | "simplify" | "ask";
export type SourceType = "page" | "chrome-pdf";
// "video-transcript" is a full-document capture whose document is the video's
// subtitle transcript rather than the page's rendered text. Its highlight
// route is still the content script — the frame owns the transcript-offset to
// timestamp cue table and answers an attributed span by seeking the player —
// so it stays a "page" SourceType.
export type CaptureMode =
  | "selection"
  | "full-page"
  | "full-pdf"
  | "video-transcript";
export type ContextSourceType = "selection" | "page" | "pdf" | "video";
export type ContextStatus = "idle" | "reading" | "ready" | "error";

export interface SelectionSeed {
  type?: string;
  captureId?: string | null;
  capturedAt?: number;
  seededAt?: number;
  tabId?: number | null;
  windowId?: number | null;
  frameId?: number;
  captureMode?: CaptureMode;
  intent?: CaptureIntent;
  sourceType?: SourceType;
  url?: string | null;
  text?: string;
  error?: string;
  truncated?: boolean;
  transcriptUnavailable?: boolean;
}

export interface HighlightSource {
  tabId: number | null;
  frameId: number;
  captureId: string | null;
  contextVersion: number;
  sourceType: SourceType;
  url: string | null;
}

interface ActiveHighlight {
  id: string;
  source: HighlightSource;
}

export type AnswerStatus =
  | "streaming"
  | "attributing"
  | "ready"
  | "unavailable";

export interface MessageAttribution {
  document: string;
  question: string;
  status: "loading" | "ready" | "error";
  spans?: TokenPathAttributionSpan[];
  error?: string;
}

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "answer" | "note" | "error";
  text: string;
  answerStatus?: AnswerStatus;
  attribution?: MessageAttribution;
  incomplete?: boolean;
  source?: HighlightSource;
  link?: {
    label: string;
    href: string;
  };
  /**
   * The follow-up questions finally chosen for this answer. Optional and
   * additive: an older cached record simply has none, and the anchors and
   * rejected candidates behind them are never written to the cache.
   */
  suggestions?: string[];
  /** Set on an answer produced by the summary pathway; drives the ladder. */
  summaryDepth?: SummaryDepth;
  /** Links a chat answer to its durable, user-saved debugging record. */
  savedCaseId?: string;
}

/** Persisted panel preferences. Every read is defensive. */
export interface PanelSettings {
  autoSummarize: boolean;
  summaryPreset: SummaryPreset;
  suggestFollowUps: boolean;
  /** null until the user edits the instructions; then it replaces the preset. */
  customSummaryPrompt: string | null;
}

export interface PanelSnapshot {
  /**
   * What is left of the Browse subscription's monthly allowance, formatted for
   * the header badge; null whenever there is no subscription to spend, which
   * is when the badge falls back to the credit balance.
   */
  allowanceText: string | null;
  authBusy: boolean;
  authError: string | null;
  busy: boolean;
  connected: boolean;
  contextError: string | null;
  contextLabel: string;
  contextStatus: ContextStatus;
  contextText: string;
  creditsText: string | null;
  hasContext: boolean;
  messages: PanelMessage[];
  notice: string | null;
  resolvedTheme: ResolvedTheme;
  savedCases: SavedAttributionCase[];
  savedCasesEnabled: boolean;
  savedCasesOpen: boolean;
  settings: PanelSettings;
  settingsOpen: boolean;
  sourceType: ContextSourceType;
  /** null until the first successful read; a 404 backend reports "none". */
  subscription: TokenPathSubscription | null;
  themePreference: ThemePreference;
  toast: string | null;
  toastSeq: number;
}

// Every message of one context shares the same captured document, and that
// document can be 400,000 characters. The cached record stores each distinct
// document once and has its messages reference it by index.
interface CachedMessageAttribution {
  documentIndex: number;
  question: string;
  status: MessageAttribution["status"];
  spans?: TokenPathAttributionSpan[];
  error?: string;
}

type CachedPanelMessage = Omit<PanelMessage, "attribution"> & {
  attribution?: CachedMessageAttribution;
};

interface CachedPageChat {
  version: 2;
  context: string;
  contextLabel: string;
  captureMode: CaptureMode;
  sourceType: SourceType;
  documents: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  messages: CachedPanelMessage[];
}

const CACHE_FORMAT_VERSION = 2;
const THEME_KEY = "tokenpath-theme";
const AUTO_SUMMARIZE_KEY = "tokenpath-auto-summarize";
const SUMMARY_PRESET_KEY = "tokenpath-summary-preset";
const SUGGEST_FOLLOWUPS_KEY = "tokenpath-suggest-followups";
const SUMMARY_INSTRUCTIONS_KEY = "tokenpath-summary-instructions";
const MAX_GENERATE_INPUT_CHARS = 420_000;
const MAX_GENERATE_MESSAGES = 50;
// TokenPath caps `max_output_tokens` at 2048 and bills generation from the
// input text alone, so a smaller ceiling buys nothing and only risks cutting an
// answer off. Every turn — summary or question, page, PDF, selection, or video
// transcript — asks for the whole ceiling.
const CHAT_OUTPUT_TOKENS = 2_048;
// Tokenizer counts can disagree with the sampler's stop by one, so treat "one
// short of the ceiling" as having reached it.
const OUTPUT_LIMIT_TOLERANCE_TOKENS = 1;
// A capture the panel never consumed outlives the click that produced it. Two
// minutes covers a slow side-panel open without replaying yesterday's page.
const MAX_SEED_AGE_MS = 120_000;

function websiteBaseUrl(pageUrl?: string | null) {
  if (!pageUrl || pageUrl.length > 16_384) return "the current webpage";
  try {
    const parsed = new URL(pageUrl);
    const origin = new URL(parsed.origin);
    return origin.protocol === "http:" || origin.protocol === "https:"
      ? origin.origin
      : "the current webpage";
  } catch {
    return "the current webpage";
  }
}

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // The panel can still follow the OS theme if storage is unavailable.
  }
  return "system";
}

function readStoredString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // The panel still works on its defaults if storage is unavailable.
    return null;
  }
}

function writeStoredString(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // The preference still applies for the lifetime of this panel.
  }
}

/**
 * Both switches default on, so a first-run panel behaves like the shipped
 * one-click summary. Anything that is not the exact "off" token is treated as
 * on rather than trusted as a boolean.
 */
function readBooleanPreference(key: string, fallback: boolean) {
  const stored = readStoredString(key);
  if (stored === "on") return true;
  if (stored === "off") return false;
  return fallback;
}

function readPanelSettings(): PanelSettings {
  const preset = readStoredString(SUMMARY_PRESET_KEY);
  const custom = TokenPathPanelLogic.boundSummaryInstructions(
    readStoredString(SUMMARY_INSTRUCTIONS_KEY) || ""
  );
  return {
    autoSummarize: readBooleanPreference(AUTO_SUMMARIZE_KEY, true),
    summaryPreset: preset === "detailed" ? "detailed" : "bullets",
    suggestFollowUps: readBooleanPreference(SUGGEST_FOLLOWUPS_KEY, true),
    customSummaryPrompt: custom.trim() ? custom : null,
  };
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

/**
 * A canceling subscription is still a paid month: its allowance is spendable
 * until the date it ends, so it counts as subscribed everywhere the allowance
 * does.
 */
export function isSubscribed(
  subscription: TokenPathSubscription | null
): subscription is TokenPathSubscription {
  return (
    subscription != null &&
    (subscription.status === "active" || subscription.status === "canceling")
  );
}

/** A date the user recognizes, or nothing rather than a guess. */
export function planDate(iso: string | null) {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "$7" from 700. The plan is priced in whole dollars today. */
function formatPlanPrice(cents: number) {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

/**
 * The two numbers every "you could subscribe" string needs. Copy is written
 * before any subscription has been read — Settings opens while disconnected,
 * and a 402 can arrive first — so both fall back to the shipped plan.
 */
export function planTerms(subscription: TokenPathSubscription | null) {
  return {
    price: formatPlanPrice(
      subscription?.priceUsdCents ?? TokenPath.SUBSCRIPTION_PRICE_USD_CENTS
    ),
    grant: formatTokens(
      subscription?.grantTokens ?? TokenPath.SUBSCRIPTION_GRANT_TOKENS
    ),
  };
}

export class PanelController {
  private listeners = new Set<() => void>();
  private snapshot: PanelSnapshot;
  private earlyCaptures: SelectionSeed[] = [];
  private tabId: number | null = null;
  private windowId: number | null = null;
  private frameId = 0;
  private captureId: string | null = null;
  private capturedAt = 0;
  private sourceBaseUrl = "the current webpage";
  private sourceType: SourceType = "page";
  private captureMode: CaptureMode = "selection";
  // A toolbar capture asks for a summary the moment its context is live. The
  // request belongs to the context that was captured, so it carries the
  // contextVersion it was made under: a tab switch or a newer capture between
  // request and run must not summarize a different document.
  private autoSummaryRequested = false;
  private autoSummaryContextVersion = -1;
  private sourceUrl: string | null = null;
  private context = "";
  private history: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];
  private invalidated = false;
  private contextVersion = 0;
  private authEpoch = 0;
  private creditsEpoch = 0;
  private availableTokens: number | null = null;
  private subscriptionEpoch = 0;
  private highlightEpoch = 0;
  private highlightedTarget: ActiveHighlight | null = null;
  private pendingPdfHighlight: ActiveHighlight | null = null;
  private pdfReloadNoticeShown = false;
  private pendingSubmission: string | null = null;
  private messageSequence = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private mediaQuery: MediaQueryList | null = null;
  private activeTurnController: AbortController | null = null;
  private activeTurnCleanup: (() => void) | null = null;
  private activeTurnMessageId: string | null = null;
  private activePdfExtractionController: AbortController | null = null;
  private attributionControllers = new Map<string, AbortController>();
  private navigationEpoch = 0;
  // Grounded follow-up candidates awaiting their answer's attributions. Kept off
  // the message — and therefore out of the cache — because only the two
  // finally chosen questions are worth restoring.
  private suggestionCandidates = new Map<
    string,
    TokenPathGroundedSuggestion[]
  >();
  private savingCaseMessageIds = new Set<string>();

  constructor() {
    const themePreference = readThemePreference();
    const resolvedTheme = resolveTheme(themePreference);
    this.snapshot = {
      allowanceText: null,
      authBusy: false,
      authError: null,
      busy: false,
      connected: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      creditsText: null,
      hasContext: false,
      messages: [],
      notice: null,
      resolvedTheme,
      savedCases: [],
      savedCasesEnabled: __TOKENPATH_DEBUG_CASES_ENABLED__,
      savedCasesOpen: false,
      settings: readPanelSettings(),
      settingsOpen: false,
      sourceType: "page",
      subscription: null,
      themePreference,
      toast: null,
      toastSeq: 0,
    };
    this.applyTheme(resolvedTheme);
    this.watchSystemTheme();

    // This must happen synchronously, before init() performs even its first
    // await. A newly opened side panel can otherwise miss a fast capture.
    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  async init() {
    this.watchTab();
    const authReady = this.initAuth();
    const savedCasesReady = __TOKENPATH_DEBUG_CASES_ENABLED__
      ? this.loadSavedCases()
      : Promise.resolve();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    this.tabId = tab?.id ?? null;
    this.windowId = tab?.windowId ?? null;
    this.sourceBaseUrl = websiteBaseUrl(tab?.url);

    const earlyCapture = this.earlyCaptures
      .filter(
        (message) =>
          this.windowId == null ||
          message.windowId == null ||
          message.windowId === this.windowId
      )
      .sort(
        (left, right) =>
          (Number(right.capturedAt) || 0) -
          (Number(left.capturedAt) || 0)
      )[0];
    this.earlyCaptures = [];
    let seeded = earlyCapture ? this.applySeed(earlyCapture) : false;
    if (this.tabId != null && !seeded) {
      const key = this.seedKey(this.tabId);
      const stored = await chrome.storage.session.get(key);
      const seed = stored[key] as SelectionSeed | undefined;
      if (seed) {
        // The seed is keyed only by tab, so it can describe a document the tab
        // has since left. Only a URL that is known on both sides can prove a
        // mismatch; the age bound covers the rest, measured from the
        // background's write time (seededAt) so a slow extraction is not
        // penalized for the gap between click and write.
        const liveUrl = tab?.url || null;
        const seedTime = Number(seed.seededAt ?? seed.capturedAt);
        const stale =
          (Boolean(liveUrl) &&
            Boolean(seed.url) &&
            !sameDocumentUrl(seed.url, liveUrl)) ||
          (Number.isFinite(seedTime) &&
            Date.now() - seedTime > MAX_SEED_AGE_MS);
        if (!stale) seeded = this.applySeed(seed);
        void chrome.storage.session.remove?.(key);
      }
    }

    if (!seeded && this.tabId != null) {
      this.sourceUrl = tab?.url || null;
      this.sourceBaseUrl = websiteBaseUrl(this.sourceUrl);
      const restored = await this.restorePageChat(
        null,
        this.contextVersion,
        false
      );
      if (!restored) this.prepareUncapturedPage();
    }

    await Promise.all([authReady, savedCasesReady]);
    // A seed that arrived before auth finished has a context but nothing it is
    // allowed to spend yet; this is where a toolbar summary catches up.
    this.maybeRunAutoSummary();
  }

  connect = async (tokenPathKey: string) => {
    const cleanTokenPathKey = tokenPathKey.trim();
    if (this.snapshot.authBusy) return false;
    const authEpoch = ++this.authEpoch;
    this.update({ authBusy: true, authError: null });

    try {
      // The auth form is only reachable while disconnected, and its submit is
      // disabled until a key is typed, so a blank key with nothing saved is
      // unreachable. A saved-but-unverified key re-verifies through the same
      // request as a freshly pasted one.
      if (cleanTokenPathKey) await TokenPath.setKey(cleanTokenPathKey);
      if (authEpoch !== this.authEpoch) return false;
      const creditsEpoch = this.beginCreditsObservation();
      const credits = await TokenPath.fetchCredits();
      if (authEpoch !== this.authEpoch) return false;
      this.updateCredits(credits, creditsEpoch);
      this.setConnected(true);
      // Not awaited: the key is already validated, and the badge can fall back
      // to credits for the moment this read takes.
      void this.refreshSubscription();
      this.update({ authError: null });
      this.maybeRunAutoSummary();
      return true;
    } catch (error) {
      if (authEpoch !== this.authEpoch) return false;
      if (
        error instanceof TokenPath.Error &&
        (error.status === 401 || error.status === 403)
      ) {
        await TokenPath.clearKey().catch(() => undefined);
        if (authEpoch !== this.authEpoch) return false;
        this.setConnected(false);
        this.update({
          authError:
            "The TokenPath key was rejected. Copy a fresh tpk_… key from platform.tokenpath.ai.",
        });
      } else {
        this.setConnected(false);
        this.update({
          authError:
            error instanceof Error ? error.message : "Couldn't reach TokenPath.",
        });
      }
      return false;
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  };

  disconnect = async () => {
    const authEpoch = ++this.authEpoch;
    this.cancelActiveWork();
    this.setConnected(false);
    this.update({ authBusy: true, authError: null });
    // Disconnecting removes the account's footprint on this machine, and the
    // cached chats hold captured page and PDF text, not just the key.
    await clearAll().catch(() => undefined);
    try {
      await TokenPath.clearKey();
    } catch {
      if (authEpoch === this.authEpoch) {
        this.update({
          authError: "Couldn't remove the saved TokenPath key. Try again.",
        });
      }
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  };

  submit = (text: string) => {
    const clean = text.trim();
    if (!clean || this.snapshot.busy || !this.snapshot.connected) {
      if (!this.snapshot.connected) {
        this.showToast("Connect TokenPath to start chatting.");
      }
      return false;
    }
    if (!this.context || this.invalidated) {
      void this.captureForSubmission(clean);
      return true;
    }
    void this.runTurn(clean, { echoUser: true });
    return true;
  };

  private async captureForSubmission(text: string) {
    if (this.tabId == null) return;
    this.pendingSubmission = text;
    this.update({
      busy: true,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "reading",
      contextText: "Reading this page…",
      notice: null,
      sourceType: "page",
    });
    const result = await chrome.runtime
      .sendMessage({ type: "capture-tab-for-chat", tabId: this.tabId })
      .catch(() => ({ ok: false }));
    if (result?.ok === false && this.pendingSubmission === text) {
      this.pendingSubmission = null;
      this.update({
        busy: false,
        contextStatus: "error",
        contextText: "",
        contextError: "TokenPath couldn't access this page.",
      });
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "TokenPath couldn't access this page.",
      });
    }
  }

  clearHighlights = () => {
    if (
      this.sourceType === "chrome-pdf" &&
      !this.highlightedTarget &&
      !this.pendingPdfHighlight
    ) {
      return;
    }
    if (this.sourceType !== "chrome-pdf" && this.tabId != null) {
      this.highlightEpoch++;
      this.highlightedTarget = null;
      void chrome.runtime
        .sendMessage({
          type: "clear-tab-highlights",
          tabId: this.tabId,
        })
        .then((result) => {
          if (result?.ok !== false) this.showToast("Highlights cleared.");
        })
        .catch(() => undefined);
      return;
    }
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    const fallback =
      pendingPdfHighlight?.source ||
      (this.tabId == null
        ? null
        : {
            tabId: this.tabId,
            frameId: this.frameId,
            captureId: this.captureId,
            contextVersion: this.contextVersion,
            sourceType: this.sourceType,
            url: this.sourceUrl,
          });
    // The one PDF clear allowed to reload: the user asked for the highlight to
    // go away, and Chrome offers no other way to unpaint a text fragment.
    void this.clearActiveHighlight(fallback, true);
  };

  // The side panel was occluded (another tab took the window's panel slot, or
  // Chrome hid it). Page highlights are cheap to re-apply, so they still go;
  // a PDF highlight stays exactly as it is, because clearing it would have to
  // reload the user's document behind their back. It remains owned, so the
  // "Clear highlight" button still works when the panel comes back.
  handlePanelHidden = () => {
    if (this.sourceType === "chrome-pdf") return;
    this.clearHighlights();
  };

  // Stops the request in flight without touching the conversation or the
  // captured context. Whatever the answer had already streamed stays visible,
  // marked incomplete.
  cancelTurn = () => {
    const turnController = this.activeTurnController;
    if (!turnController) return false;
    const messageId = this.activeTurnMessageId;
    // Dropping the cleanup is what separates a cancel from an invalidation:
    // the question and its partial answer both survive.
    this.activeTurnCleanup = null;
    turnController.abort();
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    if (message) {
      if (message.text.trim()) {
        this.updateMessage(message.id, {
          answerStatus: "unavailable",
          attribution: undefined,
          incomplete: true,
        });
      } else {
        // An empty answer bubble carries nothing worth keeping.
        this.removeMessage(message.id);
      }
    }
    this.showToast("Stopped.");
    return true;
  };

  // Runs the summary pathway against the live context. `depth` is the ladder's
  // "Give me a detailed summary" chip asking for one rung deeper than the
  // preference; without it the saved preset (or custom instructions) decides.
  runSummary = ({ depth }: { depth?: SummaryPreset } = {}) => {
    if (this.snapshot.busy) return false;
    if (!this.snapshot.connected) {
      this.showToast("Connect TokenPath to start chatting.");
      return false;
    }
    if (!this.context || this.invalidated) {
      // The only caller is the empty-state starter, which falls back to
      // submit() and captures the page — a toast here would flash a failure
      // over a path that is about to succeed.
      return false;
    }
    const settings = this.snapshot.settings;
    const summary = TokenPathPanelLogic.buildSummaryRequest(this.context, {
      preset: depth || settings.summaryPreset,
      // An explicit ladder request overrides custom instructions: the user
      // just asked for the detailed shape by name.
      customPrompt: depth ? null : settings.customSummaryPrompt,
    });
    if (summary.skip) {
      this.addMessage({
        kind: "note",
        role: "assistant",
        text:
          this.captureMode === "full-pdf"
            ? "Already concise — ask anything about this PDF."
            : this.captureMode === "video-transcript"
              ? "Already concise — ask anything about this video."
              : this.captureMode === "full-page"
                ? "Already concise — ask anything about this page."
                : "Already concise — ask anything about this selection.",
      });
      return true;
    }
    void this.runTurn(summary.prompt || "", {
      echoUser: false,
      maxOutputTokens: summary.maxOutputTokens,
      summaryDepth: (summary.depth as SummaryDepth) || "bullets",
    });
    return true;
  };

  clearConversation = async () => {
    const key = pageChatKey(this.sourceUrl);
    if (key) await deletePageChat(key).catch(() => undefined);
    this.history = [];
    this.setAutoSummaryRequest(false);
    this.cancelActiveWork();
    this.cancelHighlightAndClear();
    this.update({
      busy: false,
      messages: [],
      notice: null,
    });
    this.showToast("Chat cleared for this page.");
  };

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.cancelActiveWork();
    void this.persistCurrentPageChat();
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    // Starting the message here is enough: Chrome owns its delivery even
    // though the side-panel document is being torn down.
    void this.clearActiveHighlight(pendingPdfHighlight?.source || null);
  };

  cycleTheme = () => {
    const next: Record<ThemePreference, ThemePreference> = {
      system: "light",
      light: "dark",
      dark: "system",
    };
    const themePreference = next[this.snapshot.themePreference];
    const resolvedTheme = resolveTheme(themePreference);
    try {
      localStorage.setItem(THEME_KEY, themePreference);
    } catch {
      // Theme still applies for the lifetime of this panel.
    }
    this.applyTheme(resolvedTheme);
    this.update({ themePreference, resolvedTheme });
  };

  openSettings = () =>
    this.update({ savedCasesOpen: false, settingsOpen: true });

  closeSettings = () => this.update({ settingsOpen: false });

  toggleSettings = () =>
    this.update({
      savedCasesOpen: false,
      settingsOpen: !this.snapshot.settingsOpen,
    });

  openSavedCases = () =>
    this.update({ savedCasesOpen: true, settingsOpen: false });

  closeSavedCases = () => this.update({ savedCasesOpen: false });

  toggleSavedCases = () =>
    this.update({
      savedCasesOpen:
        this.snapshot.savedCasesEnabled && !this.snapshot.savedCasesOpen,
      settingsOpen: false,
    });

  saveAttributionCase = async (messageId: string) => {
    if (!this.snapshot.savedCasesEnabled) return null;
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    const existing = message?.savedCaseId
      ? this.snapshot.savedCases.find(
          (savedCase) => savedCase.id === message.savedCaseId
        )
      : null;
    if (existing) return existing;
    if (
      !message?.attribution ||
      !message.text ||
      message.attribution.status === "loading"
    ) {
      this.showToast("Wait for source mapping to finish before saving.");
      return null;
    }
    if (this.savingCaseMessageIds.has(messageId)) return null;
    this.savingCaseMessageIds.add(messageId);

    const timestamp = new Date().toISOString();
    const id = globalThis.crypto?.randomUUID?.() ??
      `case-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const savedCase: SavedAttributionCase = {
      schemaVersion: 1,
      id,
      savedAt: timestamp,
      updatedAt: timestamp,
      note: "",
      source: {
        url: message.source?.url ?? this.sourceUrl,
        label: this.snapshot.contextLabel,
        sourceType: message.source?.sourceType ?? this.sourceType,
      },
      attributionRequest: {
        method: "POST",
        path: "/v1/attributions",
        body: {
          document: message.attribution.document,
          question: message.attribution.question,
          answer: message.text,
        },
      },
      attributionResponse:
        message.attribution.status === "ready"
          ? {
              status: "ready",
              offsetEncoding: "utf-16",
              spans: message.attribution.spans || [],
            }
          : {
              status: "error",
              error:
                message.attribution.error || "Source attribution failed.",
            },
    };

    try {
      await writeSavedAttributionCase(savedCase);
      this.update({
        savedCases: [savedCase, ...this.snapshot.savedCases],
      });
      this.updateMessage(messageId, { savedCaseId: id });
      void this.persistCurrentPageChat();
      this.showToast("Debug case saved.");
      return savedCase;
    } catch {
      this.showToast("Couldn't save this debug case.");
      return null;
    } finally {
      this.savingCaseMessageIds.delete(messageId);
    }
  };

  updateSavedCaseNote = async (id: string, note: string) => {
    const current = this.snapshot.savedCases.find(
      (savedCase) => savedCase.id === id
    );
    if (!current) return false;
    const updated: SavedAttributionCase = {
      ...current,
      note: note.slice(0, 4_000),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeSavedAttributionCase(updated);
      this.update({
        savedCases: this.snapshot.savedCases.map((savedCase) =>
          savedCase.id === id ? updated : savedCase
        ),
      });
      this.showToast("Case note saved.");
      return true;
    } catch {
      this.showToast("Couldn't save the case note.");
      return false;
    }
  };

  deleteSavedCase = async (id: string) => {
    try {
      await deleteSavedAttributionCase(id);
      this.update({
        messages: this.snapshot.messages.map((message) =>
          message.savedCaseId === id
            ? { ...message, savedCaseId: undefined }
            : message
        ),
        savedCases: this.snapshot.savedCases.filter(
          (savedCase) => savedCase.id !== id
        ),
      });
      void this.persistCurrentPageChat();
      this.showToast("Debug case deleted.");
      return true;
    } catch {
      this.showToast("Couldn't delete this debug case.");
      return false;
    }
  };

  exportSavedCases = () => {
    if (this.snapshot.savedCases.length === 0) return false;
    try {
      const payload = buildSavedAttributionCasesExport(
        this.snapshot.savedCases
      );
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `tokenpath-debug-cases-${payload.exportedAt.slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.showToast(
        `Exported ${payload.cases.length} debug ${payload.cases.length === 1 ? "case" : "cases"}.`
      );
      return true;
    } catch {
      this.showToast("Couldn't export saved debug cases.");
      return false;
    }
  };

  private async loadSavedCases() {
    try {
      this.update({ savedCases: await readSavedAttributionCases() });
    } catch {
      // Chat remains usable if IndexedDB is unavailable. The first attempted
      // save reports the storage failure in context.
    }
  }

  private updateSettings(patch: Partial<PanelSettings>) {
    this.update({ settings: { ...this.snapshot.settings, ...patch } });
  }

  setAutoSummarize = (autoSummarize: boolean) => {
    writeStoredString(AUTO_SUMMARIZE_KEY, autoSummarize ? "on" : "off");
    this.updateSettings({ autoSummarize });
    // Deliberately not retroactive: the toolbar click that opened this page
    // was already answered by waiting, and turning the switch on should
    // change the next page rather than spend on this one behind the user.
  };

  setSummaryPreset = (summaryPreset: SummaryPreset) => {
    const next: SummaryPreset =
      summaryPreset === "detailed" ? "detailed" : "bullets";
    writeStoredString(SUMMARY_PRESET_KEY, next);
    this.updateSettings({ summaryPreset: next });
  };

  setSuggestFollowUps = (suggestFollowUps: boolean) => {
    writeStoredString(SUGGEST_FOLLOWUPS_KEY, suggestFollowUps ? "on" : "off");
    this.updateSettings({ suggestFollowUps });
  };

  /** Empty or whitespace-only instructions are a reset, not a customization. */
  setSummaryInstructions = (text: string) => {
    const bounded = TokenPathPanelLogic.boundSummaryInstructions(text);
    const customSummaryPrompt = bounded.trim() ? bounded : null;
    writeStoredString(SUMMARY_INSTRUCTIONS_KEY, customSummaryPrompt);
    this.updateSettings({ customSummaryPrompt });
  };

  resetSummaryInstructions = () => this.setSummaryInstructions("");

  onAttributionClick = async (
    start: number,
    end: number,
    source: HighlightSource,
    documentText = this.context,
    // The wider passage that supports the same selection. Only a video
    // transcript uses it, to start playback where the discussion begins
    // rather than mid-sentence on the cited phrase; the cited span itself is
    // always [start, end).
    supportedRange: { contextStart?: number; contextEnd?: number } = {}
  ) => {
    if (
      source.tabId == null ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      return;
    }

    const epoch = ++this.highlightEpoch;
    const highlightId = [
      source.captureId || "capture",
      source.contextVersion,
      epoch,
    ].join(":");
    const replacingPdfHighlight =
      source.sourceType === "chrome-pdf" &&
      this.highlightedTarget?.source.sourceType === "chrome-pdf";
    // A PDF text-fragment navigation replaces the previous fragment itself.
    // Clearing first would reload the PDF twice for one attribution click.
    // Keep ownership until the replacement succeeds so Clear still works if
    // Chrome rejects the new navigation.
    if (!replacingPdfHighlight) {
      await this.clearActiveHighlight();
    }
    if (!this.isCurrentHighlight(source, epoch)) return;

    if (source.sourceType === "chrome-pdf") {
      this.pendingPdfHighlight = { id: highlightId, source };
      // Chrome applies a `#:~:text=` directive only while the PDF viewer
      // loads, so every PDF attribution costs one reload. Say so once per
      // panel session rather than letting the reload look like a bug.
      if (!this.pdfReloadNoticeShown) {
        this.pdfReloadNoticeShown = true;
        this.showToast("Chrome reloads the PDF to highlight a source.");
      }
    }
    try {
      const response =
        source.sourceType === "chrome-pdf"
          ? await chrome.runtime.sendMessage({
              type: "highlight-pdf-source",
              tabId: source.tabId,
              url: source.url,
              document: documentText,
              start,
              end,
              highlightId,
            })
          : await chrome.tabs.sendMessage(
              source.tabId,
              {
                type: "highlight",
                start,
                end,
                contextStart: supportedRange.contextStart,
                contextEnd: supportedRange.contextEnd,
                document: documentText,
                captureId: source.captureId,
                highlightId,
              },
              { frameId: source.frameId }
            );
      if (!this.isCurrentHighlight(source, epoch)) {
        // A late DOM response owns a distinct CSS highlight and can safely
        // clear itself. PDF text fragments have no ownership identifier; a
        // late clear could erase a newer PDF highlight.
        if (source.sourceType !== "chrome-pdf") {
          await this.clearHighlightTarget(source, highlightId);
        }
        return;
      }
      if (!(response as { ok?: boolean } | undefined)?.ok) {
        this.showToast(
          source.sourceType === "chrome-pdf"
            ? "Couldn't locate that text in the PDF."
            : "Couldn't locate that text in the page."
        );
        return;
      }
      this.highlightedTarget = { id: highlightId, source };
    } catch {
      if (this.isCurrentHighlight(source, epoch)) {
        this.showToast(
          source.sourceType === "chrome-pdf"
            ? "PDF not reachable (it may have navigated)."
            : "Page not reachable (it may have navigated)."
          );
      }
    } finally {
      if (this.pendingPdfHighlight?.id === highlightId) {
        this.pendingPdfHighlight = null;
      }
    }
  };

  private update(patch: Partial<PanelSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private handleRuntimeMessage = (message: SelectionSeed) => {
    if (message?.type !== "selection-captured") return;
    if (this.windowId == null) {
      this.earlyCaptures.push(message);
      return;
    }
    if (
      message.windowId != null &&
      message.windowId !== this.windowId
    ) {
      return;
    }
    if (message.tabId != null && message.tabId !== this.tabId) return;
    if (this.applySeed(message) && message.tabId != null) {
      void chrome.storage.session.remove?.(this.seedKey(message.tabId));
    }
  };

  private seedKey(tabId: number) {
    return `seed:${tabId}`;
  }

  private applySeed(seed: SelectionSeed) {
    if (seed.captureId && seed.captureId === this.captureId) return false;
    if (
      Number.isFinite(seed.capturedAt) &&
      Number(seed.capturedAt) < this.capturedAt
    ) {
      return false;
    }

    this.cancelHighlightAndClear();
    this.cancelActiveWork();
    this.captureId = seed.captureId || null;
    this.capturedAt = Number(seed.capturedAt) || Date.now();
    this.tabId = seed.tabId ?? this.tabId;
    this.frameId = Number.isInteger(seed.frameId) ? Number(seed.frameId) : 0;
    this.sourceType =
      seed.sourceType === "chrome-pdf" ? "chrome-pdf" : "page";
    this.captureMode =
      this.sourceType === "chrome-pdf"
        ? seed.captureMode === "full-pdf"
          ? "full-pdf"
          : "selection"
        : seed.captureMode === "full-page"
          ? "full-page"
          : seed.captureMode === "video-transcript"
            ? "video-transcript"
            : "selection";
    this.sourceUrl = seed.url || null;
    this.sourceBaseUrl = websiteBaseUrl(seed.url);
    this.contextVersion++;
    // A capture supersedes any navigation or tab activation still awaiting its
    // own persist, which would otherwise resume and clobber this context.
    this.navigationEpoch++;
    // Recorded against the version this capture just took, so the pending
    // request cannot outlive the context it was made for.
    this.setAutoSummaryRequest(seed.intent === "summarize");
    this.history = [];
    const contextLabel =
      this.captureMode === "full-pdf"
        ? "Entire PDF"
        : this.captureMode === "video-transcript"
          ? "Video transcript"
          : this.captureMode === "full-page"
            ? "Entire page"
            : this.sourceType === "chrome-pdf"
              ? "Selected from PDF"
              : "Selected from page";

    if (seed.error) {
      this.setAutoSummaryRequest(false);
      const pendingSubmission = this.pendingSubmission;
      this.pendingSubmission = null;
      this.context = "";
      this.update({
        busy: false,
        contextError: "There’s no readable text on this page yet.",
        contextLabel,
        contextStatus: "error",
        contextText: "",
        hasContext: false,
        sourceType: this.contextSourceType(),
        messages: pendingSubmission
          ? [
              ...this.snapshot.messages,
              {
                id: `message-${++this.messageSequence}`,
                kind: "note",
                role: "assistant",
                text:
                  "There’s no readable text on this page yet. If it’s still " +
                  "loading, wait a moment and try again.",
              },
            ]
          : [],
        notice: null,
      });
      return true;
    }
    if (this.captureMode === "full-pdf") {
      this.beginFullPdfCapture(contextLabel);
      return true;
    }
    if (!seed.text) {
      this.setAutoSummaryRequest(false);
      this.context = "";
      this.update({
        busy: false,
        contextError: "No text was captured.",
        contextLabel,
        contextStatus: "error",
        contextText: "No text was captured.",
        hasContext: false,
        messages: [],
        notice: null,
        sourceType: this.contextSourceType(),
      });
      return true;
    }

    this.activateContext(seed.text, contextLabel, seed.truncated === true, {
      transcriptUnavailable: seed.transcriptUnavailable === true,
    });
    return true;
  }

  private contextSourceType(): ContextSourceType {
    if (this.captureMode === "video-transcript") return "video";
    return this.captureMode === "full-pdf"
      ? "pdf"
      : this.captureMode === "full-page"
        ? "page"
        : "selection";
  }

  private beginFullPdfCapture(contextLabel: string) {
    const sourceUrl = this.sourceUrl;
    if (!sourceUrl) {
      this.setAutoSummaryRequest(false);
      this.context = "";
      this.update({
        busy: false,
        contextError: "The PDF URL is no longer available.",
        contextLabel,
        contextStatus: "error",
        contextText: "The PDF URL is no longer available.",
        hasContext: false,
        messages: [],
        notice: null,
        sourceType: this.contextSourceType(),
      });
      return;
    }

    const extractionController = new AbortController();
    this.activePdfExtractionController = extractionController;
    const captureId = this.captureId;
    const contextVersion = this.contextVersion;
    this.context = "";
    this.invalidated = false;
    this.update({
      busy: true,
      contextError: null,
      contextLabel,
      contextStatus: "reading",
      contextText: "Reading the full PDF…",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: this.contextSourceType(),
    });

    void extractPdfText(sourceUrl, {
      signal: extractionController.signal,
    })
      .then(({ text, truncated }) => {
        if (
          extractionController.signal.aborted ||
          this.activePdfExtractionController !== extractionController ||
          captureId !== this.captureId ||
          contextVersion !== this.contextVersion
        ) {
          return;
        }
        this.activePdfExtractionController = null;
        this.activateContext(text, contextLabel, truncated);
      })
      .catch((error: unknown) => {
        if (
          extractionController.signal.aborted ||
          this.activePdfExtractionController !== extractionController ||
          captureId !== this.captureId ||
          contextVersion !== this.contextVersion
        ) {
          return;
        }
        this.activePdfExtractionController = null;
        this.setAutoSummaryRequest(false);
        this.context = "";
        const contextError =
          error instanceof Error
            ? error.message
            : "Couldn't read the text in this PDF.";
        this.update({
          busy: false,
          contextError,
          contextLabel,
          contextStatus: "error",
          contextText: contextError,
          hasContext: false,
          messages: [],
          notice: null,
          sourceType: this.contextSourceType(),
        });
      });
  }

  private activateContext(
    text: string,
    contextLabel: string,
    truncated = false,
    { transcriptUnavailable = false }: { transcriptUnavailable?: boolean } = {}
  ) {
    this.context = text;
    this.invalidated = false;
    const contextVersion = this.contextVersion;
    this.update({
      busy: false,
      contextError: null,
      contextLabel,
      contextStatus: "ready",
      contextText: text,
      hasContext: true,
      messages: [],
      notice: null,
      sourceType: this.contextSourceType(),
    });
    const pendingSubmission = this.pendingSubmission;
    this.pendingSubmission = null;
    // Notes persist with the chat, so a re-capture restores them; match on a
    // stable prefix (counts drift between captures of a dynamic page) instead
    // of stacking a duplicate.
    const addNoteOnce = (notePrefix: string, text: string) => {
      if (
        this.snapshot.messages.some(
          (message) =>
            message.kind === "note" && message.text.startsWith(notePrefix)
        )
      ) {
        return;
      }
      this.addMessage({ kind: "note", role: "assistant", text });
    };
    const addTruncationNote = () => {
      if (!truncated) return;
      const sourceName =
        this.captureMode === "full-pdf"
          ? "PDF"
          : this.captureMode === "video-transcript"
            ? "transcript"
            : "page";
      const capturedCharacters = Array.from(text).length;
      const notePrefix = `This ${sourceName} is very long`;
      addNoteOnce(
        notePrefix,
        `${notePrefix}, so TokenPath is using its first ` +
          `${capturedCharacters.toLocaleString()} characters.`
      );
    };
    // A video whose captions could not be read is captured as ordinary page
    // text. Saying so is the difference between "attribution is broken" and
    // "this video has no subtitles".
    const addTranscriptFallbackNote = () => {
      if (!transcriptUnavailable) return;
      const notePrefix = "This video has no subtitles";
      addNoteOnce(
        notePrefix,
        `${notePrefix} TokenPath can read, so it captured the page text ` +
          "instead. Answers won't jump to a timestamp."
      );
    };

    // The restore replaces the whole message list, so the note has to wait for
    // it. Adding the note first would leave it visible only until the cached
    // chat arrived.
    //
    // A toolbar click takes this same path rather than skipping ahead to the
    // summary. Skipping it would overwrite this page's saved conversation with
    // an empty one and pay for a summary the user already has: a restored chat
    // already answers "summarize this page", so it cancels the pending request
    // and spends nothing.
    void this.restorePageChat(text, contextVersion, true).then((restored) => {
      if (contextVersion !== this.contextVersion) return;
      addTranscriptFallbackNote();
      addTruncationNote();
      if (restored) this.setAutoSummaryRequest(false);
      else void this.persistCurrentPageChat();
      if (pendingSubmission) {
        // A question the user typed supersedes a queued toolbar summary, which
        // would otherwise stay pending and fire on a later reconnect.
        this.setAutoSummaryRequest(false);
        void this.runTurn(pendingSubmission, { echoUser: true });
      }
      this.maybeRunAutoSummary();
    });
  }

  private setAutoSummaryRequest(requested: boolean) {
    this.autoSummaryRequested = requested;
    this.autoSummaryContextVersion = requested ? this.contextVersion : -1;
  }

  // Runs the pending toolbar summary once — and only once — everything it
  // needs is true: a connected panel, a live context that is still the one the
  // request was made against, and no turn already in flight. A disconnected
  // panel keeps the request pending without spending anything; connect() and
  // init() retry it.
  private maybeRunAutoSummary() {
    // "Summarize new pages automatically" off means a toolbar click opens the
    // panel with its capture and waits, exactly like a context-menu capture.
    // Drop the request rather than holding it: a later toggle should change
    // the next page, not silently spend on the one already on screen.
    if (this.autoSummaryRequested && !this.snapshot.settings.autoSummarize) {
      this.setAutoSummaryRequest(false);
      return;
    }
    if (
      !this.autoSummaryRequested ||
      this.autoSummaryContextVersion !== this.contextVersion ||
      !this.snapshot.connected ||
      this.snapshot.busy ||
      !this.context ||
      this.invalidated
    ) {
      return;
    }
    this.setAutoSummaryRequest(false);
    this.runSummary();
  }

  private async initAuth() {
    const authEpoch = ++this.authEpoch;
    // Clean up the temporary two-provider build's obsolete secret.
    await chrome.storage.local.remove("openrouterKey").catch(() => undefined);
    const tokenPathAuth = await TokenPath.getAuth();
    if (authEpoch !== this.authEpoch) return;

    const connected = Boolean(tokenPathAuth.key);
    this.setConnected(connected);
    if (!connected) return;

    void this.refreshSubscription();
    const creditsEpoch = this.beginCreditsObservation();
    void TokenPath.fetchCredits()
      .then((credits) => {
        if (authEpoch === this.authEpoch && this.snapshot.connected) {
          this.updateCredits(credits, creditsEpoch);
        }
      })
      .catch(async (error) => {
        if (
          authEpoch === this.authEpoch &&
          error instanceof TokenPath.Error &&
          (error.status === 401 || error.status === 403)
        ) {
          await TokenPath.clearKey().catch(() => undefined);
          if (authEpoch !== this.authEpoch) return;
          this.setConnected(false);
          this.update({
            authError:
              "Your saved TokenPath key was rejected — paste a new one.",
          });
        }
      });
  }

  private setConnected(connected: boolean) {
    if (!connected) this.availableTokens = null;
    this.update({
      allowanceText: connected ? this.snapshot.allowanceText : null,
      connected,
      creditsText: connected ? this.snapshot.creditsText : null,
      subscription: connected ? this.snapshot.subscription : null,
    });
    if (connected) this.maybeRunAutoSummary();
  }

  private beginCreditsObservation() {
    return ++this.creditsEpoch;
  }

  private beginSubscriptionObservation() {
    return ++this.subscriptionEpoch;
  }

  private updateSubscription(
    subscription: TokenPathSubscription,
    subscriptionEpoch = this.beginSubscriptionObservation()
  ) {
    if (subscriptionEpoch !== this.subscriptionEpoch) return;
    this.update({
      allowanceText: isSubscribed(subscription)
        ? `${formatTokens(subscription.allowanceTokens)} this month`
        : null,
      subscription,
    });
  }

  /**
   * The allowance is spent by the same requests credits are, so it is read
   * wherever the balance is — and sequenced the same way, so a slow read
   * cannot replace a newer one.
   */
  private async refreshSubscription() {
    const authEpoch = this.authEpoch;
    const subscriptionEpoch = this.beginSubscriptionObservation();
    try {
      const subscription = await TokenPath.fetchSubscription();
      if (authEpoch === this.authEpoch && this.snapshot.connected) {
        this.updateSubscription(subscription, subscriptionEpoch);
      }
    } catch {
      // The badge keeps what it last knew. A rejected key is reported by the
      // credit read that runs beside this one, and a backend that does not
      // serve the endpoint yet resolves to "none" rather than throwing.
    }
  }

  private updateCredits(
    availableTokens: number | null,
    creditsEpoch = this.beginCreditsObservation()
  ) {
    if (
      availableTokens == null ||
      creditsEpoch !== this.creditsEpoch
    ) {
      return;
    }
    // Kept as a number too: an out-of-tokens message has to know whether the
    // balance behind the allowance is actually empty, not just how to print it.
    this.availableTokens = availableTokens;
    this.update({ creditsText: `${formatTokens(availableTokens)} tokens` });
  }

  private async runTurn(
    userText: string,
    {
      echoUser,
      maxOutputTokens,
      summaryDepth,
    }: {
      echoUser: boolean;
      maxOutputTokens?: number;
      summaryDepth?: SummaryDepth;
    }
  ) {
    if (!this.snapshot.connected) {
      this.showToast("Connect TokenPath to start chatting.");
      return;
    }
    // Both paths land on the same ceiling; the summary pathway simply names
    // the one it built its prompt against.
    const outputTokens = maxOutputTokens ?? CHAT_OUTPUT_TOKENS;

    const historyEntry = echoUser
      ? ({ role: "user", content: userText } as const)
      : null;
    const userMessage = echoUser
      ? this.addMessage({ kind: "text", role: "user", text: userText })
      : null;
    if (historyEntry) this.history.push(historyEntry);

    const context = this.context;
    const contextVersion = this.contextVersion;
    const turnAuthEpoch = this.authEpoch;
    const history = [
      ...this.history,
      ...(echoUser
        ? []
        : [{ role: "user" as const, content: userText }]),
    ];
    // Suggestions ride along on this call or not at all: a second generate
    // request would re-pay for the whole document to produce them.
    const wantsSuggestions = this.snapshot.settings.suggestFollowUps;
    const turn = this.buildTurnRequest(context, history, wantsSuggestions);
    const turnController = new AbortController();
    this.activeTurnController?.abort();
    this.activeTurnController = turnController;
    const assistant = this.addMessage({
      answerStatus: "streaming",
      attribution: {
        document: turn.document,
        question: turn.attributionQuestion,
        status: "loading",
      },
      kind: "answer",
      role: "assistant",
      source: {
        tabId: this.tabId,
        frameId: this.frameId,
        captureId: this.captureId,
        contextVersion,
        sourceType: this.sourceType,
        url: this.sourceUrl,
      },
      summaryDepth,
      text: "",
    });
    this.activeTurnMessageId = assistant.id;
    const cleanupCancelledTurn = () => {
      if (contextVersion !== this.contextVersion) return;
      this.removeMessage(assistant.id);
      if (userMessage) this.removeMessage(userMessage.id);
      if (historyEntry) this.removeHistoryEntry(historyEntry);
    };
    this.activeTurnCleanup = cleanupCancelledTurn;
    this.update({ busy: true });

    try {
      const result = await TokenPath.generate({
        messages: turn.messages,
        maxOutputTokens: outputTokens,
        signal: turnController.signal,
        onDelta: (_delta, accumulated) => {
          if (
            turnController.signal.aborted ||
            this.activeTurnController !== turnController ||
            contextVersion !== this.contextVersion
          ) {
            return;
          }
          // The tail block is stripped from every delta too, so the marker is
          // never on screen — not even for the frame it takes to arrive.
          this.updateMessage(assistant.id, {
            text: TokenPathPanelLogic.stripSuggestionsBlock(accumulated),
          });
        },
      });
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }

      // The suggestions block is peeled off before anything else sees the
      // answer: the displayed text, the conversation history, the cached
      // record, and the attribution request all get the answer without it.
      const parsed = TokenPathPanelLogic.parseSuggestions(result.answer);
      const answer = parsed.answer;
      if (!answer.trim()) {
        throw new TokenPath.Error(
          502,
          "empty_response",
          "TokenPath returned an empty answer."
        );
      }
      this.suggestionCandidates.set(
        assistant.id,
        wantsSuggestions
          ? TokenPathPanelLogic.groundSuggestions(
              parsed.candidates,
              turn.document
            )
          : []
      );

      if (!echoUser) {
        this.history.push({ role: "user", content: userText });
      }
      this.history.push({ role: "assistant", content: answer });
      if (
        turnAuthEpoch === this.authEpoch &&
        this.snapshot.connected &&
        result.creditsRemaining != null
      ) {
        this.updateCredits(result.creditsRemaining);
      }
      this.updateMessage(assistant.id, {
        answerStatus: "attributing",
        attribution: {
          document: turn.document,
          question: turn.attributionQuestion,
          status: "loading",
        },
        text: answer,
      });
      // The answer stopped because it ran out of room, not because the model
      // was done. Unlike a Stop or a broken stream, every word of it is real
      // text the model wrote, so it stays a normal answer and is still
      // attributed — the note only explains why it may end mid-thought.
      if (this.reachedOutputLimit(result.usage, outputTokens)) {
        this.addMessage({
          kind: "note",
          role: "assistant",
          text: this.outputLimitNoteText(echoUser),
        });
      }
      void this.loadAttributions(assistant.id, contextVersion);
    } catch (error) {
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      const partialAnswer =
        error instanceof TokenPath.Error &&
        typeof error.details?.partialAnswer === "string"
          ? error.details.partialAnswer
          : "";
      const failure = await this.generationFailureMessage(error);
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      if (partialAnswer.trim()) {
        // The stream delivered real text before it broke. Keep it, marked
        // incomplete, and report the failure alongside it. Attribution is
        // deliberately skipped: attributing a truncated answer would map
        // text the model never finished.
        this.updateMessage(assistant.id, {
          answerStatus: "unavailable",
          attribution: undefined,
          incomplete: true,
          text: partialAnswer,
        });
        this.addMessage({ ...failure, kind: "note" });
        return;
      }
      if (historyEntry) this.removeHistoryEntry(historyEntry);
      this.removeMessage(assistant.id);
      this.addMessage(failure);
    } finally {
      if (this.activeTurnController === turnController) {
        this.activeTurnController = null;
        this.activeTurnCleanup = null;
        this.activeTurnMessageId = null;
        this.update({ busy: false });
        void this.persistCurrentPageChat();
      }
    }
  }

  // TokenPath's terminal event carries no finish reason, so the only evidence
  // that generation was cut short is that it produced every token it was
  // allowed.
  private reachedOutputLimit(
    usage: { output_tokens?: number } | undefined,
    requestedTokens: number
  ) {
    const produced = usage?.output_tokens;
    return (
      Number.isInteger(produced) &&
      Number.isInteger(requestedTokens) &&
      requestedTokens > 0 &&
      (produced as number) >= requestedTokens - OUTPUT_LIMIT_TOLERANCE_TOKENS
    );
  }

  // The ceiling is TokenPath's own maximum, so there is no longer room to
  // offer, only a narrower question or a continuation.
  private outputLimitNoteText(echoUser: boolean) {
    const subject = echoUser ? "This answer" : "This summary";
    return (
      `${subject} reached the maximum answer length, so it may end ` +
      "abruptly. Ask a narrower question, or ask for the rest."
    );
  }

  private async generationFailureMessage(
    error: unknown
  ): Promise<Omit<PanelMessage, "id">> {
    if (!(error instanceof TokenPath.Error)) {
      return {
        kind: "error",
        role: "assistant",
        text: "Something went wrong generating an answer.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      await this.rejectSavedTokenPathKey(
        "Your TokenPath key was rejected — paste a new one."
      );
      return {
        kind: "error",
        role: "assistant",
        text: "Your TokenPath key was rejected. Reconnect to continue.",
      };
    }
    if (error.status === 402) {
      const funds = await this.observeInsufficientFunds(error);
      if (funds.state === "unsubscribed") {
        const { price, grant } = planTerms(this.snapshot.subscription);
        return {
          kind: "error",
          role: "assistant",
          text:
            "Your TokenPath account has insufficient credits for this " +
            `request. Subscribe for ${price}/month — ${grant} tokens ` +
            "monthly — or top up credits. ",
          link: {
            label: "Manage at platform.tokenpath.ai →",
            href: TokenPath.PLATFORM_URL,
          },
        };
      }
      if (funds.state === "allowance-exhausted") {
        const renews = planDate(funds.subscription.renewsAt);
        return {
          kind: "error",
          role: "assistant",
          text:
            "Your monthly allowance is used up, and there are no credits " +
            (renews
              ? `behind it. It renews on ${renews} — or top up credits to keep going now. `
              : "behind it. Top up credits to keep going before it renews. "),
          link: {
            label: "Top up at platform.tokenpath.ai →",
            href: TokenPath.PLATFORM_URL,
          },
        };
      }
      return {
        kind: "error",
        role: "assistant",
        text: "Your TokenPath account has insufficient credits for this request. ",
        link: {
          label: "Top up at platform.tokenpath.ai →",
          href: TokenPath.PLATFORM_URL,
        },
      };
    }
    if (error.status === 429) {
      return {
        kind: "error",
        role: "assistant",
        text: "TokenPath is rate-limiting requests — try again in a few seconds.",
      };
    }
    return {
      kind: "error",
      role: "assistant",
      text: error.message || "TokenPath generation failed.",
    };
  }

  private addMessage(message: Omit<PanelMessage, "id">) {
    const next: PanelMessage = {
      ...message,
      id: `message-${++this.messageSequence}`,
    };
    this.update({ messages: [...this.snapshot.messages, next] });
    return next;
  }

  private updateMessage(id: string, patch: Partial<PanelMessage>) {
    let found = false;
    const messages = this.snapshot.messages.map((message) => {
      if (message.id !== id) return message;
      found = true;
      return { ...message, ...patch };
    });
    if (found) this.update({ messages });
    return found;
  }

  private removeMessage(id: string) {
    const messages = this.snapshot.messages.filter(
      (message) => message.id !== id
    );
    if (messages.length !== this.snapshot.messages.length) {
      this.update({ messages });
    }
  }

  private removeHistoryEntry(entry: {
    role: "user" | "assistant";
    content: string;
  }) {
    const index = this.history.indexOf(entry);
    if (index !== -1) this.history.splice(index, 1);
  }

  private buildTurnRequest(
    context: string,
    messages: Array<{
      role: "user" | "assistant";
      content: string;
    }>,
    // The tail is appended to the outgoing user message only. The attribution
    // transcript, which is also stored with the chat, keeps the clean request
    // exactly as the user (or the summary prompt) asked it.
    withSuggestions = false
  ) {
    const lastUserIndex = messages
      .map((message) => message.role)
      .lastIndexOf("user");
    const question =
      lastUserIndex === -1
        ? "Summarize the selected text."
        : messages[lastUserIndex].content;
    const boundedQuestion = TokenPathPanelLogic.truncateCodePoints(
      question,
      10_000
    );
    const systemInstructions =
      `You are given some text from ${this.sourceBaseUrl}. ` +
      "Answer the user's question using the given text as the source of " +
      "truth. Do not invent details that the source does not support. If the " +
      "captured text is too limited to answer meaningfully, say so plainly " +
      "instead of producing a generic explanation.\n\n" +
      "When the user asks for a summary:\n" +
      "- Start with the source's central thesis or purpose in concrete terms.\n" +
      "- Preserve the important claims, recommendations, reasons, examples, " +
      "qualifications, and conclusions needed to understand the source.\n" +
      "- For list or how-to content, retain the distinct takeaways and explain " +
      "what each one means; do not collapse them into vague prose.\n" +
      "- Prefer specific language from the source over generic phrases such " +
      "as 'the text discusses' or 'a specific entity.'\n" +
      "- Make the result useful to someone who has not read the source.\n\n" +
      "Formatting:\n" +
      "- Use concise Markdown.\n" +
      "- Prefer bullet points when they make the answer easier to scan.\n" +
      "- Use a Markdown table when the information is naturally tabular or " +
      "when comparing multiple items.\n" +
      "- Do not force bullets or tables when a short paragraph is clearer.";
    const systemPrefix = `${systemInstructions}\n\nGiven text:\n`;
    const maxSystemChars = Math.max(
      systemPrefix.length + 2,
      MAX_GENERATE_INPUT_CHARS - boundedQuestion.length
    );
    const document = this.fitDocumentToPrompt(
      context,
      systemPrefix,
      maxSystemChars
    );
    const system = systemPrefix + JSON.stringify(document);

    let remainingChars =
      MAX_GENERATE_INPUT_CHARS - system.length - boundedQuestion.length;
    const priorMessages = messages
      .slice(0, Math.max(0, lastUserIndex))
      .filter((message) => message.content && message.content.trim())
      .slice(-(MAX_GENERATE_MESSAGES - 2));
    const boundedPrior: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];
    for (
      let index = priorMessages.length - 1;
      index >= 0 && remainingChars > 0;
      index--
    ) {
      const content = TokenPathPanelLogic.truncateCodePoints(
        priorMessages[index].content,
        Math.min(10_000, remainingChars)
      );
      if (!content) continue;
      boundedPrior.unshift({ role: priorMessages[index].role, content });
      remainingChars -= content.length;
    }

    // The attribution service caps `question` at 10,000 characters, while
    // boundedPrior is sized against the far larger generation budget — a chat
    // with a few real turns would overflow the cap and 422 every attribution
    // request. Compose inside the cap by priority: the current request always
    // survives, then the generator instructions, then as much conversation
    // history as fits, newest turns first (restored to chronological order).
    const ATTRIBUTION_QUESTION_MAX_CHARS = 10_000;
    const SECTION_SEPARATOR = "\n\n";
    const currentSection = `Current user request:\n${boundedQuestion}`;
    const instructionsSection = `Instructions given to the generator:\n${systemInstructions}`;
    const HISTORY_HEADING = "Conversation history given to the generator:\n";
    const sections: string[] = [];
    let attributionBudget =
      ATTRIBUTION_QUESTION_MAX_CHARS - currentSection.length;
    if (
      attributionBudget -
        (instructionsSection.length + SECTION_SEPARATOR.length) >=
      0
    ) {
      sections.push(instructionsSection);
      attributionBudget -=
        instructionsSection.length + SECTION_SEPARATOR.length;
    }
    const historyBlocks: string[] = [];
    let historyBudget =
      attributionBudget - (HISTORY_HEADING.length + SECTION_SEPARATOR.length);
    for (let index = boundedPrior.length - 1; index >= 0; index--) {
      const block = `${
        boundedPrior[index].role === "user" ? "User" : "Assistant"
      }:\n${boundedPrior[index].content}`;
      const cost =
        block.length + (historyBlocks.length ? SECTION_SEPARATOR.length : 0);
      if (cost > historyBudget) break;
      historyBlocks.unshift(block);
      historyBudget -= cost;
    }
    if (historyBlocks.length) {
      sections.push(HISTORY_HEADING + historyBlocks.join(SECTION_SEPARATOR));
    }
    sections.push(currentSection);
    const attributionQuestion = TokenPathPanelLogic.truncateCodePoints(
      sections.join(SECTION_SEPARATOR),
      ATTRIBUTION_QUESTION_MAX_CHARS
    );

    return {
      document,
      attributionQuestion,
      messages: [
        { role: "system" as const, content: system },
        ...boundedPrior,
        {
          role: "user" as const,
          content: withSuggestions
            ? TokenPathPanelLogic.withSuggestionsTail(boundedQuestion)
            : boundedQuestion,
        },
      ],
    };
  }

  private fitDocumentToPrompt(
    context: string,
    systemPrefix: string,
    maxSystemChars: number
  ) {
    const codePoints = Array.from(context).slice(
      0,
      TokenPath.MAX_DOCUMENT_CHARS
    );
    let low = 0;
    let high = codePoints.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = codePoints.slice(0, middle).join("");
      const promptLength =
        systemPrefix.length + JSON.stringify(candidate).length;
      if (promptLength <= maxSystemChars) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  private async loadAttributions(messageId: string, contextVersion: number) {
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    const attribution = message?.attribution;
    if (!message || !attribution || !message.text) return;

    const controller = new AbortController();
    this.attributionControllers.set(messageId, controller);
    try {
      const spans = await TokenPath.attributions({
        document: attribution.document,
        question: attribution.question,
        answer: message.text,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        this.attributionControllers.get(messageId) !== controller ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      this.updateMessage(messageId, {
        answerStatus: "ready",
        attribution: {
          ...attribution,
          spans,
          status: "ready",
        },
      });
      // The turn spent the allowance before it spent credits, so both are
      // re-read once the answer is fully attributed.
      void this.refreshSubscription();
      const creditsAuthEpoch = this.authEpoch;
      const creditsEpoch = this.beginCreditsObservation();
      void TokenPath.fetchCredits()
        .then((credits) => {
          if (
            creditsAuthEpoch === this.authEpoch &&
            this.snapshot.connected
          ) {
            this.updateCredits(credits, creditsEpoch);
          }
        })
        .catch(() => undefined);
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.attributionControllers.get(messageId) !== controller ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      const detail = await this.attributionFailureMessage(error);
      this.updateMessage(messageId, {
        answerStatus: "unavailable",
        attribution: {
          ...attribution,
          error: detail,
          status: "error",
        },
      });
    } finally {
      if (this.attributionControllers.get(messageId) === controller) {
        this.attributionControllers.delete(messageId);
      }
      // Attribution is the second gate's input, so the chips are chosen here —
      // whether it arrived or failed. A failure falls back to the positional
      // spread rather than dropping the suggestions entirely.
      if (contextVersion === this.contextVersion) {
        this.finalizeSuggestions(messageId);
      }
      void this.persistCurrentPageChat();
    }
  }

  /**
   * Turn this answer's surviving candidates into at most two chips. Only the
   * question text is kept: anchors and rejected candidates are working state,
   * and a restored chat re-shows chips without re-deriving them.
   */
  private finalizeSuggestions(messageId: string) {
    const candidates = this.suggestionCandidates.get(messageId);
    this.suggestionCandidates.delete(messageId);
    if (!candidates || candidates.length === 0) return;
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    if (!message) return;
    const attribution = message.attribution;
    const selected = TokenPathPanelLogic.selectSuggestions(candidates, {
      attributions:
        attribution?.status === "ready" ? attribution.spans || null : null,
    });
    if (selected.length === 0) return;
    this.updateMessage(messageId, {
      suggestions: selected.map((candidate) => candidate.question),
    });
  }

  private async persistCurrentPageChat() {
    const key = pageChatKey(this.sourceUrl);
    if (
      !key ||
      !this.context ||
      // Disconnect wipes the local cache as part of removing the account's
      // footprint; a disconnected panel must not write the in-memory chat
      // straight back on dispose or tab switch.
      !this.snapshot.connected ||
      this.snapshot.busy
    ) {
      return;
    }
    const documents: string[] = [];
    const documentIndexes = new Map<string, number>();
    const messages = this.snapshot.messages.map((message) => {
      const attribution = message.attribution;
      let cachedAttribution: CachedMessageAttribution | undefined;
      if (attribution) {
        let documentIndex = documentIndexes.get(attribution.document);
        if (documentIndex === undefined) {
          documentIndex = documents.length;
          documents.push(attribution.document);
          documentIndexes.set(attribution.document, documentIndex);
        }
        cachedAttribution = {
          documentIndex,
          question: attribution.question,
          status: attribution.status,
          spans: attribution.spans,
          error: attribution.error,
        };
      }
      return {
        ...message,
        attribution: cachedAttribution,
        source: message.source ? { ...message.source } : undefined,
      };
    });
    const value: CachedPageChat = {
      version: CACHE_FORMAT_VERSION,
      context: this.context,
      contextLabel: this.snapshot.contextLabel,
      captureMode: this.captureMode,
      sourceType: this.sourceType,
      documents,
      history: this.history.map((message) => ({ ...message })),
      messages,
    };
    await writePageChat(key, value).catch(() => undefined);
  }

  private async restorePageChat(
    capturedText: string | null,
    expectedContextVersion: number,
    hasFreshCapture: boolean
  ) {
    const key = pageChatKey(this.sourceUrl);
    if (!key) return false;
    const record = await readPageChat<CachedPageChat>(key).catch(() => null);
    if (
      !record ||
      record.value.version !== CACHE_FORMAT_VERSION ||
      expectedContextVersion !== this.contextVersion
    ) {
      return false;
    }

    const cached = record.value;
    // A fresh capture of a different mode — a selection over a saved
    // full-page chat, or the reverse — is a new conversation subject, not
    // evidence the page changed. Leave the saved record alone; it is only
    // replaced once the user actually sends a turn from the new context.
    if (hasFreshCapture && cached.captureMode !== this.captureMode) {
      return false;
    }
    if (
      capturedText &&
      pageContentSignificantlyChanged(cached.context, capturedText)
    ) {
      await deletePageChat(key).catch(() => undefined);
      if (expectedContextVersion !== this.contextVersion) return false;
      this.update({
        notice:
          "This page has changed significantly since the saved chat. " +
          "TokenPath started a fresh chat with the current content.",
      });
      return false;
    }

    this.context = capturedText || cached.context;
    this.history = cached.history.map((message) => ({ ...message }));
    this.captureMode = cached.captureMode;
    this.sourceType = cached.sourceType;
    this.invalidated = !hasFreshCapture;
    this.messageSequence = Math.max(
      this.messageSequence,
      ...cached.messages.map((message) => {
        const match = /^message-(\d+)$/.exec(message.id);
        return match ? Number(match[1]) : 0;
      })
    );
    const documents = Array.isArray(cached.documents) ? cached.documents : [];
    let normalizedCachedAttribution = false;
    const messages: PanelMessage[] = cached.messages.map((message) => {
      const attributionWasInterrupted =
        message.kind === "answer" &&
        (message.answerStatus === "attributing" ||
          message.attribution?.status === "loading");
      if (attributionWasInterrupted) normalizedCachedAttribution = true;
      const cachedAttribution = message.attribution;
      const attributionUsesLegacyHeatmap =
        cachedAttribution?.status === "ready" &&
        !Array.isArray(cachedAttribution.spans);
      if (attributionUsesLegacyHeatmap) normalizedCachedAttribution = true;
      // A record whose shared document is missing keeps its answer text; only
      // its source map is lost, exactly like an interrupted attribution.
      const document = cachedAttribution
        ? documents[cachedAttribution.documentIndex]
        : undefined;
      const attributionIsUsable =
        cachedAttribution != null && typeof document === "string";
      return {
        ...message,
        answerStatus:
          attributionWasInterrupted ||
          attributionUsesLegacyHeatmap ||
          (cachedAttribution != null && !attributionIsUsable)
            ? ("unavailable" as const)
            : message.answerStatus,
        attribution: attributionIsUsable
          ? {
              document: document as string,
              question: cachedAttribution.question,
              spans: cachedAttribution.spans,
              ...(attributionWasInterrupted || attributionUsesLegacyHeatmap
                ? {
                    error:
                      attributionUsesLegacyHeatmap
                        ? "This saved answer uses the previous source-map format. Ask again to refresh its sources."
                        : "Source mapping was interrupted when you left this page.",
                    status: "error" as const,
                  }
                : {
                    error: cachedAttribution.error,
                    status: cachedAttribution.status,
                  }),
            }
          : undefined,
        source: message.source
          ? {
              ...message.source,
              tabId: this.tabId,
              frameId: hasFreshCapture
                ? this.frameId
                : message.source.frameId,
              captureId: hasFreshCapture
                ? this.captureId
                : message.source.captureId,
              contextVersion: this.contextVersion,
              sourceType: this.sourceType,
              url: this.sourceUrl,
            }
          : undefined,
      };
    });
    this.update({
      busy: false,
      contextError: null,
      contextLabel: cached.contextLabel,
      contextStatus: "ready",
      contextText: this.context,
      hasContext: true,
      messages,
      notice: null,
      sourceType: this.contextSourceType(),
    });
    if (normalizedCachedAttribution) {
      void this.persistCurrentPageChat();
    }
    return true;
  }

  private async attributionFailureMessage(error: unknown) {
    if (!(error instanceof TokenPath.Error)) {
      return "Source attribution failed for this answer.";
    }
    if (error.status === 401 || error.status === 403) {
      await this.rejectSavedTokenPathKey(
        "Your TokenPath key was rejected — paste a new one."
      );
      return "TokenPath rejected the saved key. Reconnect to map this answer.";
    }
    if (error.status === 402) {
      const funds = await this.observeInsufficientFunds(error);
      if (funds.state === "unsubscribed") {
        const { price, grant } = planTerms(this.snapshot.subscription);
        return (
          "TokenPath credits are insufficient, so this answer has no source " +
          `map. Subscribe for ${price}/month — ${grant} tokens monthly — or ` +
          "top up credits at platform.tokenpath.ai."
        );
      }
      if (funds.state === "allowance-exhausted") {
        return (
          "Your monthly allowance is used up, so this answer has no source " +
          "map. Top up credits, or wait for the allowance to renew."
        );
      }
      return "TokenPath credits are insufficient, so this answer has no source map.";
    }
    if (error.status === 429) {
      return "TokenPath is rate-limiting attribution. Try again shortly.";
    }
    return error.message || "Source attribution failed for this answer.";
  }

  private async rejectSavedTokenPathKey(authError: string) {
    const authEpoch = ++this.authEpoch;
    this.setConnected(false);
    this.update({ authBusy: true, authError });
    try {
      await TokenPath.clearKey();
    } catch {
      // Keep the provider disconnected even if extension storage is unavailable.
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  }

  private async refreshCredits() {
    const authEpoch = this.authEpoch;
    const creditsEpoch = this.beginCreditsObservation();
    try {
      const credits = await TokenPath.fetchCredits();
      if (
        authEpoch === this.authEpoch &&
        this.snapshot.connected
      ) {
        this.updateCredits(credits, creditsEpoch);
      }
    } catch {
      // The authoritative request error is already visible to the user.
    }
  }

  /**
   * A 402 says the request could not be paid for, but not out of which pool.
   * Re-read both before wording anything: whether there is a subscription, and
   * whether its allowance and the credits behind it are both gone, is the whole
   * difference between the three things there are to say.
   */
  private async observeInsufficientFunds(error: TokenPathFailure) {
    const available = error.details?.available_tokens;
    if (Number.isInteger(available) && (available as number) >= 0) {
      this.updateCredits(available as number);
    } else {
      await this.refreshCredits();
    }
    await this.refreshSubscription();

    const subscription = this.snapshot.subscription;
    if (!isSubscribed(subscription)) return { state: "unsubscribed" } as const;
    // Only both pools being empty is the allowance story. A subscriber who
    // still has tokens somewhere was refused for another reason, and gets the
    // plain insufficient-credits message rather than a wrong explanation.
    return subscription.allowanceTokens === 0 && this.availableTokens === 0
      ? ({ state: "allowance-exhausted", subscription } as const)
      : ({ state: "insufficient-credits" } as const);
  }

  private isCurrentHighlight(source: HighlightSource, epoch: number) {
    return (
      epoch === this.highlightEpoch &&
      source.contextVersion === this.contextVersion &&
      (this.invalidated || source.captureId === this.captureId)
    );
  }

  private clearHighlightTarget(
    target: HighlightSource | null,
    highlightId: string | null = null,
    // Only the explicit "Clear highlight" button passes true. Chrome can
    // unpaint a PDF text fragment only by loading the document again, so every
    // other clear settles for a clean URL and leaves the paint alone.
    reloadPdf = false
  ) {
    if (!target || target.tabId == null) return Promise.resolve();
    if (target.sourceType === "chrome-pdf") {
      return chrome.runtime
        .sendMessage({
          type: "clear-pdf-source-highlight",
          tabId: target.tabId,
          url: target.url,
          highlightId,
          reload: reloadPdf,
        })
        .then(() => undefined)
        .catch(() => undefined);
    }
    return chrome.tabs
      .sendMessage(
        target.tabId,
        {
          type: "clear-highlight",
          captureId: target.captureId || null,
          highlightId,
        },
        { frameId: target.frameId }
      )
      .then(() => undefined)
      .catch(() => undefined);
  }

  private async clearActiveHighlight(
    fallback: HighlightSource | null = null,
    reloadPdf = false
  ) {
    const active = this.highlightedTarget;
    this.highlightedTarget = null;
    await this.clearHighlightTarget(
      active?.source || fallback,
      active?.id || null,
      reloadPdf
    );
  }

  private cancelHighlightAndClear() {
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    void this.clearActiveHighlight(pendingPdfHighlight?.source || null);
  }

  // Drops highlight ownership without sending anything that could touch the
  // source tab. Used wherever the panel is leaving a document behind rather
  // than being asked to clean it up: a PDF clear reaches the tab, and the
  // user did not ask for their PDF to be disturbed.
  private cancelHighlightWithoutClearing() {
    this.highlightEpoch++;
    this.pendingPdfHighlight = null;
    this.highlightedTarget = null;
    if (this.sourceType === "chrome-pdf" && this.tabId != null) {
      // Not a tab operation: it only invalidates a navigation this panel may
      // still have in flight in the worker.
      void chrome.runtime
        .sendMessage({
          type: "cancel-pdf-source-operation",
          tabId: this.tabId,
        })
        .catch(() => undefined);
    }
  }

  private cancelActiveWork() {
    // Candidates whose answer never finished being attributed are working
    // state for a turn that is going away.
    this.suggestionCandidates.clear();
    const wasExtractingPdf = Boolean(this.activePdfExtractionController);
    this.activePdfExtractionController?.abort();
    this.activePdfExtractionController = null;
    const cleanupTurn = this.activeTurnCleanup;
    this.activeTurnController?.abort();
    this.activeTurnController = null;
    this.activeTurnCleanup = null;
    cleanupTurn?.();
    for (const [messageId, controller] of this.attributionControllers) {
      controller.abort();
      const message = this.snapshot.messages.find(
        (candidate) => candidate.id === messageId
      );
      if (message?.attribution?.status === "loading") {
        this.updateMessage(messageId, {
          answerStatus: "unavailable",
          attribution: {
            ...message.attribution,
            error: "Source attribution was cancelled.",
            status: "error",
          },
        });
      }
    }
    this.attributionControllers.clear();
    if (this.snapshot.busy) {
      this.update({
        busy: false,
        ...(wasExtractingPdf && !this.context
          ? {
              contextError: "PDF reading was cancelled.",
              contextStatus: "error" as const,
              contextText: "PDF reading was cancelled.",
            }
          : {}),
      });
    }
  }

  private watchTab() {
    chrome.tabs.onActivated?.addListener((activeInfo) => {
      if (
        activeInfo.tabId === this.tabId &&
        activeInfo.windowId === this.windowId
      ) {
        return;
      }
      void this.handleTabActivation(activeInfo.tabId, activeInfo.windowId);
    });
    chrome.tabs.onUpdated.addListener((id, changeInfo) => {
      if (id !== this.tabId || !changeInfo.url) return;
      // A fragment-only change is scroll position, not navigation: a plain
      // "#section" anchor, our own ":~:text=" attribution directive, and the
      // native PDF viewer's #page/#zoom parameters all leave the captured
      // document — and therefore the chat — intact.
      if (sameDocumentUrl(changeInfo.url, this.sourceUrl)) return;
      void this.handlePageNavigation(changeInfo.url);
    });
    chrome.tabs.onRemoved.addListener((id) => {
      if (id === this.tabId) this.invalidate("The tab was closed.", false);
    });
  }

  private async handleTabActivation(tabId: number, windowId: number) {
    const navigationEpoch = ++this.navigationEpoch;
    await this.persistCurrentPageChat();
    if (navigationEpoch !== this.navigationEpoch) return;

    // Switching tabs is not a request to touch the tab being left behind. A
    // PDF clear used to navigate that tab, which reloaded the PDF — and reset
    // its viewer to page 1 — every time the user glanced at another tab.
    if (this.sourceType === "chrome-pdf") {
      this.cancelHighlightWithoutClearing();
    } else {
      this.cancelHighlightAndClear();
    }
    this.cancelActiveWork();
    this.invalidated = true;
    this.context = "";
    this.history = [];
    // The pending toolbar summary belonged to the tab being left behind.
    this.setAutoSummaryRequest(false);
    this.contextVersion++;
    this.tabId = tabId;
    this.windowId = windowId;
    this.frameId = 0;
    this.captureId = null;
    this.captureMode = "selection";
    this.update({
      busy: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (
      !tab ||
      navigationEpoch !== this.navigationEpoch ||
      tabId !== this.tabId
    ) {
      return;
    }
    this.sourceUrl = tab.url || null;
    this.sourceBaseUrl = websiteBaseUrl(this.sourceUrl);
    const restored = await this.restorePageChat(
      null,
      this.contextVersion,
      false
    );
    if (!restored && navigationEpoch === this.navigationEpoch) {
      this.prepareUncapturedPage();
    }
  }

  private async handlePageNavigation(url: string) {
    const navigationEpoch = ++this.navigationEpoch;
    await this.persistCurrentPageChat();
    if (navigationEpoch !== this.navigationEpoch) return;
    this.invalidate("", false);
    this.sourceUrl = url;
    this.sourceBaseUrl = websiteBaseUrl(url);
    this.captureId = null;
    this.contextVersion++;
    const restored = await this.restorePageChat(
      null,
      this.contextVersion,
      false
    );
    if (!restored && navigationEpoch === this.navigationEpoch) {
      this.prepareUncapturedPage();
    }
  }

  private prepareUncapturedPage() {
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.setAutoSummaryRequest(false);
    this.pendingSubmission = null;
    this.update({
      busy: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });
  }

  private invalidate(reason: string, clearHighlight = true) {
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.setAutoSummaryRequest(false);
    this.contextVersion++;
    if (clearHighlight) {
      this.cancelHighlightAndClear();
    } else {
      // The source tab has already left the captured document (or no longer
      // exists), so there is nothing of ours left to clean up there.
      this.cancelHighlightWithoutClearing();
    }
    this.cancelActiveWork();
    this.update({
      busy: false,
      contextError: reason || null,
      contextLabel: "Current page",
      contextStatus: reason ? "error" : "idle",
      contextText: reason,
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });
  }

  private showToast(text: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    // The sequence number lets the view re-announce a repeated identical
    // toast, which an unchanged text node would silently swallow.
    this.update({ toast: text, toastSeq: this.snapshot.toastSeq + 1 });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.update({ toast: null });
    }, 2600);
  }

  private watchSystemTheme() {
    this.mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    this.mediaQuery?.addEventListener("change", () => {
      if (this.snapshot.themePreference !== "system") return;
      const resolvedTheme = systemTheme();
      this.applyTheme(resolvedTheme);
      this.update({ resolvedTheme });
    });
  }

  private applyTheme(theme: ResolvedTheme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
}
