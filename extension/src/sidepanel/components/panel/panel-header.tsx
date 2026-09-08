import {
  BookmarkIcon,
  EraserIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  Trash2Icon,
} from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { PanelController, PanelSnapshot } from "@/controller";
import { cn } from "@/lib/utils";

function TokenPathWordmark() {
  return (
    <span aria-hidden="true" className="tokenpath-wordmark">
      <span className="tokenpath-wordmark-token">token</span>
      <span className="tokenpath-wordmark-path">path</span>
    </span>
  );
}

function ThemeIcon({ snapshot }: { snapshot: PanelSnapshot }) {
  if (snapshot.themePreference === "system") {
    return <MonitorIcon className="size-3.5" />;
  }
  return snapshot.resolvedTheme === "dark" ? (
    <MoonIcon className="size-3.5" />
  ) : (
    <SunIcon className="size-3.5" />
  );
}

function nextThemeLabel(snapshot: PanelSnapshot) {
  const next = {
    system: "light",
    light: "dark",
    dark: "system",
  }[snapshot.themePreference];
  return `Theme: ${snapshot.themePreference}. Switch to ${next}.`;
}

export function PanelHeader({
  controller,
  savedCasesButtonRef,
  settingsButtonRef,
  snapshot,
}: {
  controller: PanelController;
  savedCasesButtonRef?: RefObject<HTMLButtonElement | null>;
  settingsButtonRef?: RefObject<HTMLButtonElement | null>;
  snapshot: PanelSnapshot;
}) {
  const chatIsEmpty = snapshot.messages.every(
    (message) => message.kind === "note"
  );
  // A subscription is what the extension spends first, so the badge shows what
  // is left of it and keeps the credit balance — the fallback once the
  // allowance runs out — as the tooltip's second line. Without a subscription
  // the badge is the credit balance, exactly as before.
  const badgeText = snapshot.allowanceText ?? snapshot.creditsText;
  const badgeTitle = snapshot.allowanceText
    ? "Browse subscription allowance left this month" +
      (snapshot.creditsText ? `\nThen ${snapshot.creditsText} in credits` : "")
    : "TokenPath tokens remaining";

  return (
    <header className="panel-header flex h-12 shrink-0 items-center justify-between px-3.5">
      <div className="brand-lockup">
        <a
          aria-label="Visit TokenPath (opens in a new tab)"
          className="tokenpath-wordmark-link"
          href="https://tokenpath.ai"
          rel="noopener noreferrer"
          target="_blank"
        >
          <TokenPathWordmark />
        </a>
        <span aria-hidden="true" className="brand-divider">
          /
        </span>
        <span className="product-name" title="Browse with TokenPath">
          Chat
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="token-badge"
          hidden={!badgeText}
          id="credits"
          title={badgeTitle}
        >
          {badgeText}
        </span>
        <Button
          aria-label={nextThemeLabel(snapshot)}
          id="theme-toggle"
          onClick={controller.cycleTheme}
          size="icon-xs"
          title={nextThemeLabel(snapshot)}
          variant="ghost"
        >
          <ThemeIcon snapshot={snapshot} />
        </Button>
        {snapshot.savedCasesEnabled && (
          <Button
            aria-controls="saved-cases"
            aria-expanded={snapshot.savedCasesOpen}
            aria-label={`Saved debug cases (${snapshot.savedCases.length})`}
            className={cn(
              "header-saved-cases",
              snapshot.savedCasesOpen && "bg-accent text-accent-foreground"
            )}
            id="saved-cases-toggle"
            onClick={controller.toggleSavedCases}
            ref={savedCasesButtonRef}
            size="icon-xs"
            title="Saved debug cases"
            variant="ghost"
          >
            <BookmarkIcon className="size-3.5" />
            {snapshot.savedCases.length > 0 && (
              <span className="header-saved-count">
                {snapshot.savedCases.length}
              </span>
            )}
          </Button>
        )}
        <Button
          aria-controls="settings"
          aria-expanded={snapshot.settingsOpen}
          aria-label={snapshot.settingsOpen ? "Close settings" : "Open settings"}
          className={cn(
            snapshot.settingsOpen && "bg-accent text-accent-foreground"
          )}
          id="settings-toggle"
          onClick={controller.toggleSettings}
          ref={settingsButtonRef}
          size="icon-xs"
          title={snapshot.settingsOpen ? "Close settings" : "Settings"}
          variant="ghost"
        >
          <SettingsIcon className="size-3.5" />
        </Button>
        <Button
          aria-label="Clear source highlight"
          className="gap-1.5 px-2"
          id="clear-hl"
          onClick={controller.clearHighlights}
          size="sm"
          title="Clear source highlight"
          variant="outline"
        >
          <EraserIcon className="size-3.5" />
          <span className="hidden min-[470px]:inline">Clear highlight</span>
        </Button>
        <Button
          aria-label="Clear chat for this page"
          className="gap-1.5 px-2"
          disabled={snapshot.busy || chatIsEmpty}
          id="clear-chat"
          onClick={() => void controller.clearConversation()}
          size="sm"
          title="Clear chat for this page"
          variant="outline"
        >
          <Trash2Icon className="size-3.5" />
          <span className="hidden min-[470px]:inline">Clear chat</span>
        </Button>
      </div>
    </header>
  );
}
