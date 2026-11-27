import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import {
  formatStarAiQuota,
  formatStarAiRequestCount,
} from "@pi-desktop/shared";
import { AnchoredMenu } from "./settings/AnchoredMenu";
import { TooltipButton } from "./ui";
import { IconArrowUpRight, IconRefresh } from "./icons";
import type { AppState } from "../stores/app-store";
import { useStarAiBalance } from "../hooks/use-star-ai-balance";

export function StarAiBalanceControl({
  open,
  setOpen,
  showToast,
}: {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  showToast: AppState["showToast"];
}) {
  const { t, i18n } = useTranslation("starAi");
  const {
    hasStarAiProvider,
    snapshot,
    loading,
    openingTopUp,
    error,
    refresh,
    openTopUp,
  } = useStarAiBalance();

  if (!hasStarAiProvider && !snapshot) {
    return null;
  }

  const locale = i18n.language || undefined;
  const remainingDisplay = snapshot
    ? formatStarAiQuota(snapshot.remainQuota, snapshot.currency, locale)
    : "…";
  const recent24hDisplay = snapshot
    ? formatStarAiQuota(snapshot.recent24hQuota, snapshot.currency, locale)
    : "—";
  const historyDisplay = snapshot
    ? formatStarAiQuota(snapshot.usedQuota, snapshot.currency, locale)
    : "—";
  const requestCountDisplay = snapshot
    ? t("balanceRequestCountUnit", {
        count: formatStarAiRequestCount(snapshot.requestCount, locale),
      })
    : "—";
  const depleted = snapshot !== null && snapshot.remainQuota <= 0;

  const handleTopUp = async () => {
    setOpen(false);
    try {
      await openTopUp();
    } catch (cause) {
      const code = (cause as { code?: string } | null)?.code;
      showToast(
        code === "STARAI_LOGIN_REQUIRED" ? t("required") : t("balanceTopUpError"),
        { variant: "error" },
      );
    }
  };

  return (
    <AnchoredMenu
      className="footer-star-ai-balance"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="star-ai-balance-popover"
      label={t("balanceTitle")}
      role="dialog"
      align="start"
      side="top"
      initialFocus="none"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`footer-star-ai-balance-btn${open ? " active" : ""}${depleted ? " is-depleted" : ""}`}
          tooltip={t("balanceTriggerTooltip")}
          ariaLabel={`${t("balancePrefix")} ${remainingDisplay}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
        >
          <span className="footer-star-ai-balance-brand">
            {t("balancePrefix")}
          </span>
          <span className="footer-star-ai-balance-amount">
            {remainingDisplay}
          </span>
        </TooltipButton>
      )}
    >
      <div className="star-ai-balance-header">
        <div className="star-ai-balance-heading">
          <span className="star-ai-balance-title">
            {t("balanceTitle")}
          </span>
          {snapshot?.account.name ? (
            <span className="star-ai-balance-account">
              {snapshot.account.name}
            </span>
          ) : null}
        </div>
        <TooltipButton
          type="button"
          className={`icon-btn icon-btn-square star-ai-balance-refresh${loading ? " is-spinning" : ""}`}
          tooltip={t("balanceRefresh")}
          ariaLabel={t("balanceRefresh")}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <IconRefresh size={13} aria-hidden="true" />
        </TooltipButton>
      </div>

      <div className="star-ai-balance-hero">
        <span className="star-ai-balance-label">
          {t("balanceRemaining")}
        </span>
        <strong
          className={`star-ai-balance-hero-value${depleted ? " is-depleted" : ""}`}
        >
          {snapshot ? remainingDisplay : loading ? t("balanceLoading") : "—"}
        </strong>
      </div>

      <div className="star-ai-balance-grid">
        <div className="star-ai-balance-stat star-ai-balance-stat-wide">
          <span className="star-ai-balance-label">
            {t("balanceRecent24h")}
          </span>
          <strong className="star-ai-balance-stat-value">
            {recent24hDisplay}
          </strong>
        </div>
        <div className="star-ai-balance-stat">
          <span className="star-ai-balance-label">
            {t("balanceHistoryUsage")}
          </span>
          <strong className="star-ai-balance-stat-value">
            {historyDisplay}
          </strong>
        </div>
        <div className="star-ai-balance-stat">
          <span className="star-ai-balance-label">
            {t("balanceRequestCount")}
          </span>
          <strong className="star-ai-balance-stat-value">
            {requestCountDisplay}
          </strong>
        </div>
      </div>

      {error ? (
        <div className="star-ai-balance-error" role="status">
          {t("balanceLoadError")}
        </div>
      ) : null}

      <div className="star-ai-balance-footer">
        <button
          type="button"
          className="star-ai-balance-topup-btn"
          disabled={openingTopUp}
          onClick={() => void handleTopUp()}
        >
          <span>{openingTopUp ? t("balanceTopUpOpening") : t("balanceTopUp")}</span>
          <IconArrowUpRight size={14} aria-hidden="true" />
        </button>
      </div>
    </AnchoredMenu>
  );
}
