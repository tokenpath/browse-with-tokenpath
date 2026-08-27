import {
  CircleAlertIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  ListTreeIcon,
  MousePointer2Icon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  createAnswerDomMapper,
  type AnswerDomMapper,
} from "@/answer-selection";
import { Spinner } from "@/components/ui/spinner";
import type { PanelController, PanelMessage } from "@/controller";
import type { AnswerHighlightRegistry } from "@/lib/answer-highlights";
import { cn } from "@/lib/utils";

type AnswerComponents = NonNullable<
  ComponentProps<typeof MessageResponse>["components"]
>;

function openInNewTab(href: string) {
  window.open(href, "_blank", "noopener,noreferrer");
}

const ANSWER_COMPONENTS: AnswerComponents = {
  img: () => null,
  // Markdown link text gets a click affordance without nesting one anchor
  // inside another. The trailing icon is the keyboard-reachable anchor.
  a: ({ children, className, href, node: _node, title }) => (
    <span className="answer-link">
      <span
        className={className}
        data-streamdown="link"
        onClick={() => {
          if (!href || !window.getSelection()?.isCollapsed) return;
          openInNewTab(href);
        }}
        title={title || href}
      >
        {children}
      </span>
      {href && (
        <a
          aria-label={`Open link: ${href}`}
          className="answer-link-open"
          draggable={false}
          href={href}
          rel="noreferrer"
          target="_blank"
          title={`Open ${href}`}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </a>
      )}
    </span>
  ),
};

function samePhrase(
  first: TokenPathAttributionSpan | null,
  second: TokenPathAttributionSpan | null
) {
  return (
    first?.answer.start === second?.answer.start &&
    first?.answer.end === second?.answer.end
  );
}

function phraseKey(phrase: TokenPathAttributionSpan) {
  return `${phrase.answer.start}:${phrase.answer.end}`;
}

function phraseLabel(phrase: TokenPathAttributionSpan) {
  const text = phrase.answer.text.replace(/\s+/gu, " ").trim();
  return text.length > 68 ? `${text.slice(0, 67)}…` : text;
}

export function AnswerResponse({
  animateClickHint,
  controller,
  highlights,
  message,
}: {
  animateClickHint: boolean;
  controller: PanelController;
  highlights: AnswerHighlightRegistry;
  message: PanelMessage;
}) {
  const answerRoot = useRef<HTMLDivElement>(null);
  const mapper = useRef<AnswerDomMapper | null>(null);
  const phraseRanges = useRef(new Map<string, Range>());
  const phraseButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const sourcesToggle = useRef<HTMLButtonElement>(null);
  const sourcesId = useId();
  const [hoveredPhrase, setHoveredPhrase] =
    useState<TokenPathAttributionSpan | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activePhraseIndex, setActivePhraseIndex] = useState(0);
  const phrases = useMemo(() => {
    const attribution = message.attribution;
    if (
      message.answerStatus !== "ready" ||
      attribution?.status !== "ready" ||
      !attribution.spans ||
      !message.text
    ) {
      return [];
    }
    return attribution.spans;
  }, [message.answerStatus, message.attribution, message.text]);

  useEffect(() => {
    const root = answerRoot.current;
    setHoveredPhrase(null);
    setSourcesOpen(false);
    setActivePhraseIndex(0);
    if (!root || phrases.length === 0) {
      mapper.current = null;
      phraseRanges.current = new Map();
      highlights.release(message.id);
      return;
    }

    const nextMapper = createAnswerDomMapper(root, message.text);
    mapper.current = nextMapper;
    const ranges = new Map<string, Range>();
    for (const phrase of phrases) {
      const range = nextMapper?.rangeForSpan(phrase.answer);
      if (range) ranges.set(phraseKey(phrase), range);
    }
    phraseRanges.current = ranges;
    highlights.setAvailable(message.id, [...ranges.values()]);

    return () => {
      mapper.current = null;
      phraseRanges.current = new Map();
      highlights.release(message.id);
    };
  }, [highlights, message.id, message.text, phrases]);

  useEffect(() => {
    const range = hoveredPhrase
      ? phraseRanges.current.get(phraseKey(hoveredPhrase))
      : null;
    highlights.setHovered(message.id, range ? [range] : []);
  }, [highlights, hoveredPhrase, message.id]);

  const revealPhrase = useCallback(
    (phrase: TokenPathAttributionSpan) => {
      if (!message.source || !message.attribution) return;
      void controller.onAttributionClick(
        phrase.source.start,
        phrase.source.end,
        message.source,
        message.attribution.document
      );
    },
    [controller, message.attribution, message.source]
  );
  const phraseAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const offset = mapper.current?.offsetAtPoint(clientX, clientY);
      if (offset == null) return null;
      return (
        phrases.find(
          (phrase) =>
            offset >= phrase.answer.start && offset < phrase.answer.end
        ) || null
      );
    },
    [phrases]
  );
  const updateHoveredPhrase = useCallback(
    (next: TokenPathAttributionSpan | null) => {
      setHoveredPhrase((current) =>
        samePhrase(current, next) ? current : next
      );
    },
    []
  );
  const focusPhrase = useCallback((index: number) => {
    setActivePhraseIndex(index);
    phraseButtons.current[index]?.focus();
  }, []);
  const closeSources = useCallback(() => {
    setSourcesOpen(false);
    setHoveredPhrase(null);
    sourcesToggle.current?.focus();
  }, []);

  useEffect(() => {
    if (!sourcesOpen) return;
    phraseButtons.current[0]?.focus();
    setActivePhraseIndex(0);
  }, [sourcesOpen]);

  return (
    <div
      className={cn(
        "selectable-answer",
        animateClickHint && phrases.length > 0 && "is-click-intro",
        hoveredPhrase && "has-attribution-hover"
      )}
      data-answer-status={message.answerStatus}
      data-has-click-targets={phrases.length > 0}
    >
      <div
        data-answer-content=""
        onClick={(event) => {
          if (
            message.answerStatus !== "ready" ||
            !window.getSelection()?.isCollapsed ||
            (event.target instanceof Element &&
              event.target.closest(".answer-link"))
          ) {
            return;
          }
          const phrase = phraseAtPoint(event.clientX, event.clientY);
          if (!phrase) return;
          revealPhrase(phrase);
        }}
        onPointerLeave={() => updateHoveredPhrase(null)}
        onPointerMove={(event) => {
          if (
            message.answerStatus !== "ready" ||
            !window.getSelection()?.isCollapsed ||
            (event.target instanceof Element &&
              event.target.closest(".answer-link"))
          ) {
            updateHoveredPhrase(null);
            return;
          }
          updateHoveredPhrase(phraseAtPoint(event.clientX, event.clientY));
        }}
        ref={answerRoot}
      >
        <MessageResponse
          components={ANSWER_COMPONENTS}
          mode={message.answerStatus === "streaming" ? "streaming" : "static"}
          parseIncompleteMarkdown={message.answerStatus === "streaming"}
          skipHtml
          urlTransform={(url, key) => {
            if (key === "src") return null;
            return /^(https?:|mailto:)/i.test(url) ? url : null;
          }}
        >
          {message.text}
        </MessageResponse>
      </div>

      {message.answerStatus === "attributing" && (
        <div className="answer-attribution-status" role="status">
          <Spinner className="size-3" />
          <span>Mapping this answer to the source…</span>
        </div>
      )}

      {message.answerStatus === "ready" && phrases.length > 0 && (
        <div className="answer-attribution-row">
          <div
            className={cn(
              "answer-attribution-guide",
              animateClickHint && "is-animated"
            )}
          >
            <MousePointer2Icon aria-hidden="true" />
            <span>
              Click an underlined phrase
              <span className="answer-attribution-detail">
                {" "}
                to reveal its source
              </span>
            </span>
          </div>
          <button
            aria-controls={sourcesId}
            aria-expanded={sourcesOpen}
            className={cn(
              "answer-sources-toggle",
              sourcesOpen && "is-open"
            )}
            onClick={() => {
              if (sourcesOpen) closeSources();
              else setSourcesOpen(true);
            }}
            ref={sourcesToggle}
            title="List every phrase in this answer that has a source"
            type="button"
          >
            <ListTreeIcon aria-hidden="true" />
            <span>Sources</span>
            <span className="answer-sources-count">{phrases.length}</span>
          </button>
        </div>
      )}

      {message.answerStatus === "ready" && phrases.length > 0 && (
        <div className="answer-sources" hidden={!sourcesOpen} id={sourcesId}>
          <div
            aria-label="Attributed phrases in this answer"
            aria-orientation="vertical"
            className="answer-sources-list"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSources();
              } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                event.preventDefault();
                focusPhrase((activePhraseIndex + 1) % phrases.length);
              } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                event.preventDefault();
                focusPhrase(
                  (activePhraseIndex - 1 + phrases.length) % phrases.length
                );
              } else if (event.key === "Home") {
                event.preventDefault();
                focusPhrase(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusPhrase(phrases.length - 1);
              }
            }}
            role="toolbar"
          >
            {phrases.map((phrase, index) => (
              <button
                className="answer-source-phrase"
                key={phraseKey(phrase)}
                onClick={() => revealPhrase(phrase)}
                onFocus={() => {
                  setActivePhraseIndex(index);
                  updateHoveredPhrase(phrase);
                }}
                onPointerEnter={() => updateHoveredPhrase(phrase)}
                ref={(element) => {
                  phraseButtons.current[index] = element;
                }}
                tabIndex={index === activePhraseIndex ? 0 : -1}
                type="button"
              >
                <span aria-hidden="true" className="answer-source-index">
                  {index + 1}
                </span>
                <span className="answer-source-text">
                  {phraseLabel(phrase)}
                </span>
              </button>
            ))}
          </div>
          <p className="answer-sources-help">
            Arrow keys move between phrases. Enter highlights the source on the
            page.
          </p>
        </div>
      )}

      {message.incomplete && (
        <div className="answer-attribution-status answer-attribution-partial">
          <CircleDashedIcon className="size-3" />
          <span>Answer incomplete — no sources for a partial answer.</span>
        </div>
      )}

      {message.answerStatus === "unavailable" && !message.incomplete && (
        <div className="answer-attribution-status answer-attribution-error">
          <CircleAlertIcon className="size-3" />
          <span>
            Source map unavailable
            {message.attribution?.error ? (
              <span className="answer-attribution-reason">
                {" — "}
                {message.attribution.error}
              </span>
            ) : null}
          </span>
        </div>
      )}
    </div>
  );
}
