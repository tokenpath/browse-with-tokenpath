import { ArrowLeftIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  isSubscribed,
  planDate,
  planTerms,
  type PanelController,
  type PanelSnapshot,
  type SummaryPreset,
} from "@/controller";
import { cn } from "@/lib/utils";

function planLine(snapshot: PanelSnapshot) {
  const subscription = snapshot.subscription;
  if (isSubscribed(subscription)) {
    const date = planDate(subscription.renewsAt);
    if (!date) return "Browse subscription";
    // A canceling subscription still has this month; that date is its end.
    return subscription.status === "canceling"
      ? `Browse subscription · ends ${date}`
      : `Browse subscription · renews ${date}`;
  }
  const { price, grant } = planTerms(subscription);
  return `${price}/month gives this extension ${grant} tokens a month, then credits.`;
}

function SettingSwitch({
  checked,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  id: string;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn("setting-switch", checked && "is-on")}
      id={id}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span aria-hidden="true" className="setting-switch-knob" />
    </button>
  );
}

const PRESETS: Array<{ value: SummaryPreset; label: string }> = [
  { value: "bullets", label: "3 bullets" },
  { value: "detailed", label: "Detailed" },
];

export function SettingsView({
  controller,
  snapshot,
}: {
  controller: PanelController;
  snapshot: PanelSnapshot;
}) {
  const settings = snapshot.settings;
  const isCustomized = settings.customSummaryPrompt != null;
  const instructionsId = useId();
  const backButton = useRef<HTMLButtonElement>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // The field is preloaded with whatever prompt is actually in force, so the
  // user edits the real instructions rather than an empty box.
  const activePrompt =
    settings.customSummaryPrompt ??
    TokenPathPanelLogic.summaryPresetPrompt(settings.summaryPreset);
  const [draft, setDraft] = useState(activePrompt);

  // Reset and a preset change both change what "the active prompt" means.
  useEffect(() => {
    setDraft(activePrompt);
  }, [activePrompt]);

  // Opening the view puts focus somewhere inside it, so Escape and Tab both
  // behave; the gear gets focus back when the view closes.
  useEffect(() => {
    backButton.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      controller.closeSettings();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controller]);

  return (
    <section
      aria-label="Settings"
      className="settings-view min-h-0"
      id="settings"
    >
      <div className="settings-title">
        <button
          aria-label="Back to the conversation"
          className="settings-back"
          id="settings-back"
          onClick={controller.closeSettings}
          ref={backButton}
          title="Back to the conversation"
          type="button"
        >
          <ArrowLeftIcon aria-hidden="true" />
        </button>
        <h2>Settings</h2>
      </div>

      <div className="setting">
        <div className="setting-row">
          <div className="setting-copy">
            <div className="setting-name" id="setting-auto-summarize-label">
              Summarize new pages automatically
            </div>
            <p className="setting-desc">
              When you open TokenPath on a page without a saved chat, summarize
              it right away.
            </p>
          </div>
          <SettingSwitch
            checked={settings.autoSummarize}
            id="setting-auto-summarize"
            label="Summarize new pages automatically"
            onChange={controller.setAutoSummarize}
          />
        </div>
      </div>

      <div className="setting">
        <div className="setting-name">Default summary</div>
        <div className="preset-group" role="group" aria-label="Default summary">
          {PRESETS.map((preset) => (
            <button
              aria-pressed={!isCustomized && settings.summaryPreset === preset.value}
              className={cn(
                "preset-option",
                !isCustomized &&
                  settings.summaryPreset === preset.value &&
                  "is-selected"
              )}
              disabled={isCustomized}
              id={`setting-preset-${preset.value}`}
              key={preset.value}
              onClick={() => controller.setSummaryPreset(preset.value)}
              title={
                isCustomized
                  ? "Custom instructions replace the preset"
                  : `Use the ${preset.label} summary by default`
              }
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>
        <p className="setting-desc" id="setting-preset-desc">
          {isCustomized
            ? "Custom instructions replace the preset."
            : "Applies to automatic summaries and the Summarize action."}
        </p>
      </div>

      <div className="setting">
        <div className="setting-row">
          <div className="setting-copy">
            <div className="setting-name" id="setting-chat-citations-label">
              Cite sources in ChatGPT and Claude
            </div>
            <p className="setting-desc">
              When an answer on chatgpt.com or claude.ai cites the web, link
              its phrases to the passage each one came from. Any single site
              you switch off from the answer itself comes back on with this.
            </p>
          </div>
          <SettingSwitch
            checked={settings.chatCitations}
            id="setting-chat-citations"
            label="Cite sources in ChatGPT and Claude"
            onChange={controller.setChatCitations}
          />
        </div>
      </div>

      <div className="setting">
        <div className="setting-row">
          <div className="setting-copy">
            <div className="setting-name">Suggest follow-up questions</div>
            <p className="setting-desc">
              Show two suggested questions under each answer.
            </p>
          </div>
          <SettingSwitch
            checked={settings.suggestFollowUps}
            id="setting-suggest-followups"
            label="Suggest follow-up questions"
            onChange={controller.setSuggestFollowUps}
          />
        </div>
      </div>

      <div className="setting">
        <button
          aria-controls={instructionsId}
          aria-expanded={instructionsOpen}
          className="setting-disclosure"
          id="setting-instructions-toggle"
          onClick={() => setInstructionsOpen((open) => !open)}
          type="button"
        >
          <ChevronRightIcon aria-hidden="true" />
          <span className="setting-name">Summary instructions</span>
          {isCustomized && (
            <span className="setting-badge" id="setting-instructions-badge">
              Customized
            </span>
          )}
        </button>
        <div hidden={!instructionsOpen} id={instructionsId}>
          <textarea
            aria-label="Summary instructions"
            className="setting-textarea"
            id="setting-instructions"
            maxLength={TokenPathPanelLogic.MAX_SUMMARY_INSTRUCTIONS_CHARS}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              controller.setSummaryInstructions(event.currentTarget.value);
            }}
            rows={6}
            spellCheck={false}
            value={draft}
          />
          <div className="setting-actions">
            <p className="setting-caveat">
              Instructions that pull answers away from the source text can
              weaken source mapping.
            </p>
            <button
              className="setting-reset"
              disabled={!isCustomized}
              id="setting-instructions-reset"
              onClick={() => {
                controller.resetSummaryInstructions();
                // Put the preset's text back in the same tap rather than
                // waiting for the effect below to notice the change.
                setDraft(
                  TokenPathPanelLogic.summaryPresetPrompt(
                    settings.summaryPreset
                  )
                );
              }}
              title="Restore the default instructions for the selected preset"
              type="button"
            >
              <RotateCcwIcon aria-hidden="true" />
              <span>Reset</span>
            </button>
          </div>
          <p className="setting-desc">
            TokenPath always appends its own formatting rules and the follow-up
            request after your text.
          </p>
        </div>
      </div>

      <div className="setting" id="setting-plan">
        <div className="setting-name">Plan</div>
        <p className="setting-desc" id="setting-plan-value">
          {planLine(snapshot)}
        </p>
        <a
          className="setting-link"
          href={TokenPath.PLATFORM_URL}
          id="setting-plan-link"
          rel="noreferrer"
          target="_blank"
        >
          Manage at platform.tokenpath.ai
        </a>
      </div>

      <p className="setting-note" id="settings-credit-note">
        Automatic summaries spend credits like any question. Pages you have
        already chatted with reopen their saved chat instead — nothing is
        re-summarized.
      </p>
    </section>
  );
}
