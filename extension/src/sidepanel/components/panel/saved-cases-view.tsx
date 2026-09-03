import {
  ArrowLeftIcon,
  DownloadIcon,
  FileWarningIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PanelController, PanelSnapshot } from "@/controller";
import type { SavedAttributionCase } from "@/saved-attribution-cases";

function sourceHost(url: string | null) {
  if (!url) return "Unknown source";
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function savedTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function responseLabel(savedCase: SavedAttributionCase) {
  if (savedCase.attributionResponse.status === "error") return "Failed";
  const count = savedCase.attributionResponse.spans.length;
  return `${count} ${count === 1 ? "span" : "spans"}`;
}

function SavedCaseCard({
  controller,
  savedCase,
}: {
  controller: PanelController;
  savedCase: SavedAttributionCase;
}) {
  const [draft, setDraft] = useState(savedCase.note);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const noteChanged = draft !== savedCase.note;

  useEffect(() => setDraft(savedCase.note), [savedCase.note]);

  return (
    <article className="saved-case-card">
      <div className="saved-case-meta">
        <span className="saved-case-marker">case</span>
        <time dateTime={savedCase.savedAt}>{savedTime(savedCase.savedAt)}</time>
        <span aria-label={`Attribution response: ${responseLabel(savedCase)}`}>
          {responseLabel(savedCase)}
        </span>
      </div>
      <p className="saved-case-answer">
        {savedCase.attributionRequest.body.answer}
      </p>
      {savedCase.source.url ? (
        <a
          className="saved-case-source"
          href={savedCase.source.url}
          rel="noreferrer"
          target="_blank"
          title={savedCase.source.url}
        >
          {sourceHost(savedCase.source.url)}
        </a>
      ) : (
        <span className="saved-case-source">{savedCase.source.label}</span>
      )}
      <label
        className="saved-case-note-label"
        htmlFor={`case-note-${savedCase.id}`}
      >
        Note
      </label>
      <textarea
        className="saved-case-note"
        id={`case-note-${savedCase.id}`}
        maxLength={4_000}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder="What looked wrong or could be improved?"
        rows={3}
        value={draft}
      />
      <div className="saved-case-actions">
        {confirmingDelete ? (
          <div
            aria-label="Confirm deletion"
            className="saved-case-delete-confirm"
            role="group"
          >
            <span>Delete this case?</span>
            <button
              className="saved-case-delete"
              onClick={() => void controller.deleteSavedCase(savedCase.id)}
              type="button"
            >
              Delete
            </button>
            <button onClick={() => setConfirmingDelete(false)} type="button">
              Keep
            </button>
          </div>
        ) : (
          <button
            aria-label="Delete this saved debug case"
            className="saved-case-icon-action"
            onClick={() => setConfirmingDelete(true)}
            title="Delete case"
            type="button"
          >
            <Trash2Icon aria-hidden="true" />
          </button>
        )}
        <button
          className="saved-case-save-note"
          disabled={!noteChanged}
          onClick={() =>
            void controller.updateSavedCaseNote(savedCase.id, draft)
          }
          type="button"
        >
          Save note
        </button>
      </div>
    </article>
  );
}

export function SavedCasesView({
  controller,
  snapshot,
}: {
  controller: PanelController;
  snapshot: PanelSnapshot;
}) {
  const backButton = useRef<HTMLButtonElement>(null);
  const cases = snapshot.savedCases;
  const summary = useMemo(() => {
    const ready = cases.filter(
      (savedCase) => savedCase.attributionResponse.status === "ready"
    ).length;
    const failed = cases.length - ready;
    return failed > 0 ? `${ready} mapped · ${failed} failed` : `${ready} mapped`;
  }, [cases]);

  useEffect(() => backButton.current?.focus(), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      controller.closeSavedCases();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  return (
    <section
      aria-label="Saved debug cases"
      className="saved-cases-view min-h-0"
      id="saved-cases"
    >
      <div className="saved-cases-heading">
        <div className="settings-title">
          <button
            aria-label="Back to the conversation"
            className="settings-back"
            onClick={controller.closeSavedCases}
            ref={backButton}
            title="Back to the conversation"
            type="button"
          >
            <ArrowLeftIcon aria-hidden="true" />
          </button>
          <div>
            <h2>Saved cases</h2>
            {cases.length > 0 && <p>{summary}</p>}
          </div>
        </div>
        <button
          className="saved-cases-export"
          disabled={cases.length === 0}
          onClick={controller.exportSavedCases}
          type="button"
        >
          <DownloadIcon aria-hidden="true" />
          <span>Export JSON</span>
        </button>
      </div>

      <div className="saved-cases-privacy">
        <FileWarningIcon aria-hidden="true" />
        <span>
          Exports include the captured source text, question, answer, and source
          map.
        </span>
      </div>

      {cases.length === 0 ? (
        <div className="saved-cases-empty">
          <span className="saved-case-marker">case</span>
          <h3>No saved cases yet</h3>
          <p>
            Use “Save case” under an answer after its sources finish mapping.
          </p>
        </div>
      ) : (
        <div className="saved-cases-list">
          {cases.map((savedCase) => (
            <SavedCaseCard
              controller={controller}
              key={savedCase.id}
              savedCase={savedCase}
            />
          ))}
        </div>
      )}
    </section>
  );
}
