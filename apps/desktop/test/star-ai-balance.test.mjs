import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_STARAI_CURRENCY_CONFIG,
  IPC,
  IPC_WHITELIST,
  formatStarAiQuota,
  formatStarAiRequestCount,
  normalizeStarAiCurrencyConfig,
} from "@pi-desktop/shared";
import {
  STARAI_ORIGIN,
  STARAI_REFRESH,
  StarAiSession,
} from "../electron/main/star-ai-session.ts";
import { starAiEn, starAiZh } from "../src/locales/star-ai.ts";

const sessionReply = (id = 42) =>
  Response.json({
    success: true,
    data: {
      access_token: "session-token",
      access_expires_at: Math.floor(Date.now() / 1000) + 900,
      user: { id, username: "alice", display_name: "Alice" },
      session: { sid: "test-session" },
    },
  });

test("StarAI balance IPC channels are registered and whitelisted", () => {
  assert.equal(IPC.invoke.starAiBalance, "pi-desktop/starai/balance");
  assert.equal(IPC.invoke.starAiTopUp, "pi-desktop/starai/topUp");
  assert.equal(IPC_WHITELIST.has(IPC.invoke.starAiBalance), true);
  assert.equal(IPC_WHITELIST.has(IPC.invoke.starAiTopUp), true);
});

test("formatStarAiQuota formats CNY, USD, custom currency, tiny spend, and token modes", () => {
  assert.equal(formatStarAiQuota(0, DEFAULT_STARAI_CURRENCY_CONFIG, "zh-CN"), "￥0.00");
  assert.equal(formatStarAiQuota(64_250_000, DEFAULT_STARAI_CURRENCY_CONFIG, "zh-CN"), "￥128.50");
  assert.equal(formatStarAiQuota(2_100, DEFAULT_STARAI_CURRENCY_CONFIG, "zh-CN"), "￥0.0042");
  assert.equal(formatStarAiQuota(5, DEFAULT_STARAI_CURRENCY_CONFIG, "zh-CN"), "￥0.0001");
  assert.equal(formatStarAiQuota(-500_000, DEFAULT_STARAI_CURRENCY_CONFIG, "zh-CN"), "-￥1.00");

  const usd = normalizeStarAiCurrencyConfig({
    quota_per_unit: 500_000,
    display_in_currency: true,
    quota_display_type: "USD",
    usd_exchange_rate: 7.2,
  });
  assert.equal(formatStarAiQuota(1_250_000, usd, "en-US"), "$2.50");

  const custom = normalizeStarAiCurrencyConfig({
    quota_per_unit: 500_000,
    display_in_currency: true,
    quota_display_type: "CUSTOM",
    custom_currency_symbol: "€",
    custom_currency_exchange_rate: 0.9,
  });
  assert.equal(formatStarAiQuota(2_500_000, custom, "en-US"), "€ 4.50");

  const tokens = normalizeStarAiCurrencyConfig({
    quota_per_unit: 500_000,
    display_in_currency: false,
    quota_display_type: "CNY",
  });
  assert.equal(formatStarAiQuota(500_000, tokens, "en-US"), "500,000 tokens");
  assert.equal(formatStarAiRequestCount(1284, "zh-CN"), "1,284");
});

test("StarAiSession.balance fetches self stats, rolling 24h usage, and caches currency status", async () => {
  const seen = [];
  let statusCalls = 0;
  let usagePayload = [
    { quota: 125_000 },
    { quota: 375_000 },
  ];
  const account = new StarAiSession(
    async (url, init) => {
      const parsed = new URL(url);
      seen.push({ path: parsed.pathname, query: parsed.search, auth: init.headers.get("Authorization") });
      if (parsed.pathname === STARAI_REFRESH) return sessionReply();
      if (parsed.pathname === "/api/status") {
        statusCalls++;
        return Response.json({
          success: true,
          data: {
            quota_per_unit: 500_000,
            display_in_currency: true,
            quota_display_type: "CNY",
            usd_exchange_rate: 1,
          },
        });
      }
      if (parsed.pathname === "/api/user/self") {
        return Response.json({
          success: true,
          data: {
            id: 42,
            username: "alice",
            display_name: "Alice Pro",
            quota: 50_000_000,
            used_quota: 12_500_000,
            request_count: 321,
          },
        });
      }
      if (parsed.pathname === "/api/data/self") {
        assert.equal(parsed.searchParams.get("default_time"), "hour");
        const start = Number(parsed.searchParams.get("start_timestamp"));
        const end = Number(parsed.searchParams.get("end_timestamp"));
        assert.equal(end - start, 24 * 3600);
        return Response.json({ success: true, data: usagePayload });
      }
      throw new Error(`Unexpected path ${parsed.pathname}`);
    },
    async () => true,
  );

  const first = await account.balance(1_700_000_000);
  assert.ok(first);
  assert.deepEqual(first.account, { id: 42, name: "Alice Pro" });
  assert.equal(first.remainQuota, 50_000_000);
  assert.equal(first.usedQuota, 12_500_000);
  assert.equal(first.recent24hQuota, 500_000);
  assert.equal(first.requestCount, 321);
  assert.equal(first.currency.quotaDisplayType, "CNY");
  assert.equal(statusCalls, 1);

  // Null slice from Go backend means zero usage in the last 24h; status stays cached.
  usagePayload = null;
  const second = await account.balance(1_700_000_100);
  assert.ok(second);
  assert.equal(second.recent24hQuota, 0);
  assert.equal(statusCalls, 1);

  // Signed-out accounts return null without calling /api/user/self.
  const signedOut = new StarAiSession(async () => {
    throw new Error("should not fetch");
  }, async () => false);
  assert.equal(await signedOut.balance(), null);
});

test("StarAiSession.balance falls back to default CNY currency when /api/status is unavailable", async () => {
  const account = new StarAiSession(
    async (url) => {
      const path = new URL(url).pathname;
      if (path === STARAI_REFRESH) return sessionReply();
      if (path === "/api/status") return new Response(null, { status: 503 });
      if (path === "/api/user/self") {
        return Response.json({
          success: true,
          data: { quota: 1_000_000, used_quota: 500_000, request_count: 10 },
        });
      }
      if (path === "/api/data/self") {
        return Response.json({ success: true, data: [] });
      }
      throw new Error(`Unexpected path ${path}`);
    },
    async () => true,
  );
  const snapshot = await account.balance(1_700_000_000);
  assert.ok(snapshot);
  assert.deepEqual(snapshot.currency, DEFAULT_STARAI_CURRENCY_CONFIG);
  assert.equal(formatStarAiQuota(snapshot.remainQuota, snapshot.currency, "zh-CN"), "￥2.00");
});

test("top-up URL guard, 1-minute polling cadence, and composer balance wiring satisfy contracts", async () => {
  const [topUpSource, toolbarSource, balanceHookSource] = await Promise.all([
    readFile(new URL("../electron/main/star-ai-topup.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chat/composer/ComposerToolbar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/features/chat/composer/hooks/useStarAiBalance.ts", import.meta.url), "utf8"),
  ]);
  assert.match(topUpSource, /STARAI_WALLET_PATH = "\/wallet"/);
  assert.match(topUpSource, /url\.protocol === "https:" && !url\.username && !url\.password/);
  assert.match(balanceHookSource, /STARAI_BALANCE_POLL_INTERVAL_MS = 60_000/);
  assert.doesNotMatch(balanceHookSource, /runActive/);

  const permissionIdx = toolbarSource.indexOf("<ComposerPermissionPicker");
  const balanceIdx = toolbarSource.indexOf("<ComposerStarAiBalance");
  const leftSlotsIdx = toolbarSource.indexOf('<ComposerControlSlots side="left"');
  assert.ok(permissionIdx > 0 && balanceIdx > permissionIdx && leftSlotsIdx > balanceIdx);

  for (const key of [
    "balancePrefix",
    "balanceRemaining",
    "balanceRecent24h",
    "balanceHistoryUsage",
    "balanceRequestCount",
    "balanceTopUp",
  ]) {
    assert.equal(typeof starAiZh[key], "string");
    assert.equal(typeof starAiEn[key], "string");
    assert.ok(starAiZh[key].length > 0);
    assert.ok(starAiEn[key].length > 0);
  }
  assert.equal(starAiZh.balancePrefix, "Star");
  assert.equal(starAiZh.balanceRecent24h, "近 24 小时消耗");
  assert.equal(starAiZh.balanceHistoryUsage, "历史使用情况");
  assert.equal(starAiZh.balanceRequestCount, "请求计数");
  assert.equal(starAiZh.balanceRemaining, "剩余额度");
  assert.equal(starAiZh.balanceTopUp, "充值");
});
