import type {
  StarAiCurrencyConfig,
  StarAiCurrencyDisplayType,
} from "./types/providers.js";

const VALID_DISPLAY_TYPES = new Set<StarAiCurrencyDisplayType>([
  "USD",
  "CNY",
  "TOKENS",
  "CUSTOM",
]);

export const DEFAULT_STARAI_CURRENCY_CONFIG: StarAiCurrencyConfig = {
  quotaPerUnit: 500_000,
  displayInCurrency: true,
  quotaDisplayType: "CNY",
  usdExchangeRate: 1,
  customCurrencySymbol: "¤",
  customCurrencyExchangeRate: 1,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function normalizeStarAiCurrencyConfig(
  raw?: Partial<StarAiCurrencyConfig> | Record<string, unknown> | null,
): StarAiCurrencyConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_STARAI_CURRENCY_CONFIG };
  }
  const source = raw as Record<string, unknown>;
  const rawDisplayType = source.quotaDisplayType ?? source.quota_display_type;
  const displayInCurrencyRaw =
    source.displayInCurrency ?? source.display_in_currency;
  const displayInCurrency =
    typeof displayInCurrencyRaw === "boolean"
      ? displayInCurrencyRaw
      : DEFAULT_STARAI_CURRENCY_CONFIG.displayInCurrency;
  let quotaDisplayType: StarAiCurrencyDisplayType =
    typeof rawDisplayType === "string" &&
    VALID_DISPLAY_TYPES.has(rawDisplayType as StarAiCurrencyDisplayType)
      ? (rawDisplayType as StarAiCurrencyDisplayType)
      : DEFAULT_STARAI_CURRENCY_CONFIG.quotaDisplayType;
  if (!displayInCurrency) {
    quotaDisplayType = "TOKENS";
  }
  const rawCustomSymbol =
    source.customCurrencySymbol ?? source.custom_currency_symbol;
  const customCurrencySymbol =
    typeof rawCustomSymbol === "string" && rawCustomSymbol.trim()
      ? rawCustomSymbol.trim()
      : DEFAULT_STARAI_CURRENCY_CONFIG.customCurrencySymbol;

  return {
    quotaPerUnit: positiveNumber(
      source.quotaPerUnit ?? source.quota_per_unit,
      DEFAULT_STARAI_CURRENCY_CONFIG.quotaPerUnit,
    ),
    displayInCurrency,
    quotaDisplayType,
    usdExchangeRate: positiveNumber(
      source.usdExchangeRate ?? source.usd_exchange_rate,
      DEFAULT_STARAI_CURRENCY_CONFIG.usdExchangeRate,
    ),
    customCurrencySymbol,
    customCurrencyExchangeRate: positiveNumber(
      source.customCurrencyExchangeRate ?? source.custom_currency_exchange_rate,
      DEFAULT_STARAI_CURRENCY_CONFIG.customCurrencyExchangeRate,
    ),
  };
}

function formatDecimalAmount(amount: number, locale?: string): string {
  const abs = Math.abs(amount);
  if (abs === 0) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  }
  if (abs >= 1) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(abs);
  }
  const clamped = abs < 0.0001 ? 0.0001 : abs;
  const rounded = Number(clamped.toFixed(4));
  const fractionDigits = rounded >= 0.01 ? 2 : 4;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.max(fractionDigits, 4),
  }).format(rounded);
}

/**
 * Format raw StarAI quota units into the configured currency or token string.
 * Matches StarAI's billing unit math (`quota / quotaPerUnit * exchangeRate`)
 * while rendering CNY with `￥` for the compact StarAI balance surface.
 */
export function formatStarAiQuota(
  quota: number,
  currency?: StarAiCurrencyConfig | null,
  locale?: string,
): string {
  const config = normalizeStarAiCurrencyConfig(currency);
  const safeQuota = Number.isFinite(quota) ? quota : 0;

  if (!config.displayInCurrency || config.quotaDisplayType === "TOKENS") {
    return `${new Intl.NumberFormat(locale, {
      maximumFractionDigits: 0,
    }).format(Math.round(safeQuota))} tokens`;
  }

  let symbol = "￥";
  let exchangeRate = config.usdExchangeRate;
  if (config.quotaDisplayType === "USD") {
    symbol = "$";
    exchangeRate = 1;
  } else if (config.quotaDisplayType === "CUSTOM") {
    symbol = config.customCurrencySymbol;
    exchangeRate = config.customCurrencyExchangeRate;
  }

  const amount = (safeQuota / config.quotaPerUnit) * exchangeRate;
  const sign = amount < 0 ? "-" : "";
  const formatted = formatDecimalAmount(amount, locale);
  const joiner = config.quotaDisplayType === "CUSTOM" ? " " : "";
  return `${sign}${symbol}${joiner}${formatted}`;
}

export function formatStarAiRequestCount(
  count: number,
  locale?: string,
): string {
  const safeCount = Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(safeCount);
}
