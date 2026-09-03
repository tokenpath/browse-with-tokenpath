import { memo } from "react";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { AnswerResponse } from "@/components/panel/answer-response";
import { Spinner } from "@/components/ui/spinner";
import type { PanelController, PanelMessage } from "@/controller";
import type { AnswerHighlightRegistry } from "@/lib/answer-highlights";
import type { SavedAttributionCase } from "@/saved-attribution-cases";
import { cn } from "@/lib/utils";

export const ChatMessage = memo(function ChatMessage({
  animateClickHint,
  controller,
  highlights,
  message,
  savedCase,
  savedCasesEnabled,
}: {
  animateClickHint: boolean;
  controller: PanelController;
  highlights: AnswerHighlightRegistry;
  message: PanelMessage;
  savedCase?: SavedAttributionCase;
  savedCasesEnabled: boolean;
}) {
  const isNote = message.kind === "note";
  const isError = message.kind === "error";

  return (
    <Message
      className={cn(isNote && "max-w-full", isError && "message-error")}
      from={message.role}
    >
      <MessageContent
        className={cn(
          isNote &&
            "w-full rounded-lg border border-dashed border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground",
          isError &&
            "w-full rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-destructive"
        )}
      >
        {message.kind === "answer" ? (
          <AnswerResponse
            animateClickHint={animateClickHint}
            controller={controller}
            highlights={highlights}
            message={message}
            savedCase={savedCase}
            savedCasesEnabled={savedCasesEnabled}
          />
        ) : (
          <div className="whitespace-pre-wrap break-words">
            {message.text}
            {message.link && (
              <a
                className="ml-1 font-medium underline underline-offset-2"
                href={message.link.href}
                rel="noreferrer"
                target="_blank"
              >
                {message.link.label}
              </a>
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  );
});

export function ThinkingMessage() {
  return (
    <Message from="assistant">
      <MessageContent className="text-muted-foreground">
        <div className="flex items-center gap-2 text-xs" role="status">
          <Spinner className="size-3.5" />
          <span>Thinking…</span>
        </div>
      </MessageContent>
    </Message>
  );
}
