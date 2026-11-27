import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ComputerCapabilities,
  ComputerConsentDecision,
  ComputerConsentRequest,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, OverlayBackdrop, portalOverlay } from "../../components/ui";
import { computerUseApi } from "./computer-use-api";
import "../../styles/computer-use.css";

function isOsPermissionReady(caps: ComputerCapabilities): boolean {
  if (caps.platform !== "darwin" || caps.backend !== "macos-ax") return true;
  if (caps.accessibility !== "granted") return false;
  if (caps.applicationAccessibility !== undefined && caps.applicationAccessibility !== "granted") {
    return false;
  }
  return true;
}

async function enableComputerUseSetting(): Promise<void> {
  const current = useAppStore.getState().settings ?? (await api.getSettings());
  if (current.computerUse?.enabled === true) return;
  const next = {
    ...current,
    computerUse: {
      ...(current.computerUse ?? {}),
      enabled: true,
    },
  };
  await api.setSettings(next);
  useAppStore.setState({ settings: next });
}

function ConsentDialogSurface({
  request,
  onRespond,
}: {
  request: ComputerConsentRequest;
  onRespond: (decision: ComputerConsentDecision) => void;
}) {
  const { t } = useTranslation();
  const denyButton = useRef<HTMLButtonElement | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const [liveCaps, setLiveCaps] = useState<ComputerCapabilities>(request.capabilities);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const settled = useRef(false);
  useBlockingOverlay();

  const finish = useCallback(
    (decision: ComputerConsentDecision) => {
      if (settled.current) return;
      settled.current = true;
      onRespond(decision);
    },
    [onRespond],
  );

  const recheckCapabilities = useCallback(async () => {
    try {
      const next = await computerUseApi.capabilities();
      if (settled.current) return null;
      setLiveCaps(next);
      if (isOsPermissionReady(next)) {
        await enableComputerUseSetting();
        finish("approved");
      }
      return next;
    } catch {
      return null;
    }
  }, [finish]);

  useEffect(() => {
    settled.current = false;
    setLiveCaps(request.capabilities);
    setBusy(false);
    setWaiting(false);
    setErrorText(null);

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => denyButton.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish("denied");
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeIndex = Array.from(focusable).indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [request, finish]);

  // While waiting for macOS System Settings toggle, poll & listen on focus/visibility
  // so granting Accessibility immediately resumes the pending tool call.
  useEffect(() => {
    if (!waiting) return;
    let polling = false;
    const triggerCheck = () => {
      if (polling || settled.current) return;
      polling = true;
      void recheckCapabilities().finally(() => {
        polling = false;
      });
    };
    const onFocus = () => triggerCheck();
    const onVisibility = () => {
      if (!document.hidden) triggerCheck();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (!document.hidden) triggerCheck();
    }, 1_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [waiting, recheckCapabilities]);

  const handleApprove = async () => {
    if (busy || settled.current) return;
    setBusy(true);
    setErrorText(null);
    try {
      await enableComputerUseSetting();
      if (isOsPermissionReady(liveCaps)) {
        finish("approved");
        return;
      }
      const next = await computerUseApi.requestPermission();
      if (settled.current) return;
      setLiveCaps(next);
      if (isOsPermissionReady(next)) {
        finish("approved");
        return;
      }
      setWaiting(true);
    } catch (error) {
      if (settled.current) return;
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : null;
      setErrorText(
        code
          ? t("computerUse.permissionRequestFailed", { code })
          : t("computerUse.consent.enableFailed"),
      );
    } finally {
      if (!settled.current) setBusy(false);
    }
  };

  const osReady = isOsPermissionReady(liveCaps);
  const appGrantedBackendMissing =
    liveCaps.applicationAccessibility === "granted" && liveCaps.accessibility !== "granted";
  const needsBoth = request.reason === "enable-and-os-permission";
  const needsOsOnly = request.reason === "os-permission";

  const title = needsOsOnly ? t("computerUse.consent.osPermissionTitle") : t("computerUse.consent.title");
  const primaryLabel = waiting
    ? t("computerUse.consent.recheckNow")
    : osReady
      ? t("computerUse.consent.allowAndEnable")
      : needsBoth
        ? t("computerUse.consent.allowAndAuthorize")
        : t("computerUse.consent.authorizeNow");

  return portalOverlay(
    <OverlayBackdrop
      className="overlay computer-consent-overlay"
      role="presentation"
      onClick={() => finish("denied")}
    >
      <div
        ref={dialog}
        className="dialog computer-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="computer-consent-title"
        aria-describedby="computer-consent-description"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="computer-consent-heading">
          <h2 id="computer-consent-title">{title}</h2>
          <p id="computer-consent-description">{t("computerUse.consent.subtitle")}</p>
        </div>

        {request.instruction ? (
          <div className="computer-consent-task">
            <span className="computer-consent-task-label">{t("computerUse.consent.taskLabel")}</span>
            <span className="computer-consent-task-body">{request.instruction}</span>
          </div>
        ) : null}

        <div className="computer-consent-status">
          <div className="computer-use-platform-status">
            <Badge tone="neutral">{liveCaps.backend}</Badge>
            <Badge tone={osReady ? "neutral" : "warning"}>
              {t(`computerUse.permission.${liveCaps.applicationAccessibility ?? liveCaps.accessibility}`)}
            </Badge>
          </div>

          {waiting ? (
            <p className="computer-consent-note" role="status">
              {t("computerUse.consent.osPermissionWaiting")}
            </p>
          ) : null}

          {appGrantedBackendMissing ? (
            <p className="computer-use-status-error" role="status">
              {t("computerUse.backendPermissionMissing")}
            </p>
          ) : null}

          {errorText ? (
            <p className="computer-use-status-error" role="status">
              {errorText}
            </p>
          ) : null}
        </div>

        <p className="computer-consent-note">{t("computerUse.consent.safetyNote")}</p>

        <div className="computer-consent-actions">
          <Button
            ref={denyButton}
            type="button"
            variant="ghost"
            onClick={() => finish("denied")}
          >
            {t("computerUse.consent.deny")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            aria-busy={busy}
            onClick={() => {
              if (waiting) {
                void recheckCapabilities();
              } else {
                void handleApprove();
              }
            }}
          >
            {primaryLabel}
          </Button>
        </div>
      </div>
    </OverlayBackdrop>,
  );
}

export function ComputerConsentDialog() {
  const [request, setRequest] = useState<ComputerConsentRequest | null>(null);
  const activeRequest = useRef<ComputerConsentRequest | null>(null);

  const respond = useCallback((decision: ComputerConsentDecision) => {
    const current = activeRequest.current;
    if (!current) return;
    activeRequest.current = null;
    setRequest(null);
    void computerUseApi.respondConsent(current.requestId, decision).catch((error: unknown) => {
      console.error("Failed to respond to computer-use consent dialog", error);
    });
  }, []);

  useEffect(() => {
    const unsubscribeRequest = computerUseApi.onConsentRequest((next) => {
      activeRequest.current = next;
      setRequest(next);
    });
    const unsubscribeDismiss = computerUseApi.onConsentDismiss((requestId) => {
      if (activeRequest.current?.requestId !== requestId) return;
      activeRequest.current = null;
      setRequest(null);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeDismiss();
      activeRequest.current = null;
    };
  }, []);

  return request ? <ConsentDialogSurface request={request} onRespond={respond} /> : null;
}
