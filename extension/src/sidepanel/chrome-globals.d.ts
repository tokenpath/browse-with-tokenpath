interface TokenPathSummaryRequest {
  skip: boolean;
  maxOutputTokens?: number;
  prompt?: string;
  /** Which rung of the depth ladder this request represents. */
  depth?: "bullets" | "detailed" | "custom";
}

/** One Q/A pair lifted from an answer's suggestions tail block. */
interface TokenPathSuggestionCandidate {
  question: string;
  anchor: string;
}

/** A candidate whose anchor quote was found verbatim in the document. */
interface TokenPathGroundedSuggestion extends TokenPathSuggestionCandidate {
  start: number;
  end: number;
}

interface TokenPathAttributionRange {
  start: number;
  end: number;
  text: string;
}

interface TokenPathAttributionSpan {
  answer: TokenPathAttributionRange;
  source: TokenPathAttributionRange & { confidence: number };
}

interface TokenPathPanelLogicApi {
  MAX_SUGGESTION_CHIPS: number;
  MAX_SUMMARY_INSTRUCTIONS_CHARS: number;
  SUGGESTION_CANDIDATES: number;
  boundSummaryInstructions(text: string): string;
  buildSummaryRequest(
    text: string,
    options?: {
      preset?: string;
      customPrompt?: string | null;
    }
  ): TokenPathSummaryRequest;
  groundSuggestions(
    candidates: TokenPathSuggestionCandidate[],
    document: string
  ): TokenPathGroundedSuggestion[];
  attributionCoveredRegions(
    attributions: TokenPathAttributionSpan[] | null
  ): Array<[number, number]>;
  parseSuggestions(answer: string): {
    answer: string;
    candidates: TokenPathSuggestionCandidate[];
  };
  selectFixedLadderChip(state?: {
    hasSummary?: boolean;
    lastSummaryDepth?: string | null;
    defaultPreset?: string;
  }): "summarize" | "detailed" | null;
  selectSuggestions(
    candidates: TokenPathGroundedSuggestion[],
    options?: {
      attributions?: TokenPathAttributionSpan[] | null;
      max?: number;
    }
  ): TokenPathGroundedSuggestion[];
  stripSuggestionsBlock(answer: string): string;
  summaryPresetPrompt(preset: string): string;
  withSuggestionsTail(question: string): string;
  truncateCodePoints(text: string, maxCodePoints: number): string;
}

/**
 * "canceling" is still a paid month: the allowance is spendable until
 * `renewsAt`, which is when it ends rather than renews.
 */
type TokenPathSubscriptionStatus = "none" | "active" | "canceling";

interface TokenPathSubscription {
  status: TokenPathSubscriptionStatus;
  /** ISO 8601, or null when there is nothing to renew or end. */
  renewsAt: string | null;
  /** What is left of this month's allowance. */
  allowanceTokens: number;
  /** What a full month grants. */
  grantTokens: number;
  priceUsdCents: number;
}

interface TokenPathFailure extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | null;
}

interface TokenPathApi {
  Error: {
    new (
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown> | null
    ): TokenPathFailure;
    prototype: TokenPathFailure;
  };
  PLATFORM_URL: string;
  API_KEYS_URL: string;
  MAX_DOCUMENT_CHARS: number;
  SUBSCRIPTION_GRANT_TOKENS: number;
  SUBSCRIPTION_PRICE_USD_CENTS: number;
  SIGNUP_GRANT_TOKENS: number;
  getAuth(): Promise<{ key: string | null; baseUrl: string }>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  fetchCredits(): Promise<number>;
  /** A 404 resolves to a "none" plan rather than rejecting. */
  fetchSubscription(): Promise<TokenPathSubscription>;
  generate(input: {
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    maxOutputTokens?: number | null;
    onDelta?: (delta: string, accumulated: string) => void;
    signal?: AbortSignal;
  }): Promise<{
    answer: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      billed_tokens: number;
    };
    creditsRemaining: number | null;
  }>;
  attributions(input: {
    document: string;
    question: string;
    answer: string;
    signal?: AbortSignal;
  }): Promise<TokenPathAttributionSpan[]>;
}

declare const TokenPathPanelLogic: TokenPathPanelLogicApi;
declare const TokenPath: TokenPathApi;
declare function formatTokens(value: number | null): string;
/** Enabled for unpacked builds; disabled by the store packager. */
declare const __TOKENPATH_DEBUG_CASES_ENABLED__: boolean;

declare module "*.css";
