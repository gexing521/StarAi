import assert from "node:assert/strict";
import test from "node:test";
import {
  STARAI_CLIENT_ID,
  STARAI_CLIENT_NAME,
  STARAI_ORIGIN,
  STARAI_REFRESH,
  StarAiSession,
  starAiError,
} from "../electron/main/star-ai-session.ts";
import { createStarAiTransport } from "../electron/main/star-ai-transport.ts";
import { starAiModelFamily } from "../../../packages/shared/src/star-ai-model-family.ts";

import { STARAI_SERVICES, starAiGroupService, sortStarAiGroupsByRatio } from "../../../packages/shared/src/star-ai-services.ts";

const sessionReply = (id = 42) => Response.json({ success: true, data: {
  access_token: "session-token", access_expires_at: Math.floor(Date.now() / 1000) + 900,
  user: { id, username: "user" }, session: { sid: "test-session" },
} });

test("a new profile does not contact the relay, and simultaneous requests rotate only once", async () => {
  let cookie = false;
  let requests = 0;
  const account = new StarAiSession(async (url, init) => {
    assert.equal(url, STARAI_ORIGIN + STARAI_REFRESH);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.get("Origin"), STARAI_ORIGIN);
    assert.equal(init.credentials, "include");
    requests++;
    return sessionReply();
  }, async () => cookie);
  assert.equal(await account.session(), null);
  assert.equal(requests, 0);
  cookie = true;
  const [first, second] = await Promise.all([account.session(), account.session()]);
  assert.equal(first.account.id, 42);
  assert.equal(first, second);
  assert.equal(requests, 1);
});

test("directory binds each group to its own models, including Unicode and reserved URL characters", async () => {
  const group = "group / 中文&+";
  const account = new StarAiSession(async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, STARAI_ORIGIN);
    if (target.pathname === STARAI_REFRESH) return sessionReply();
    assert.equal(init.headers.get("Authorization"), "Bearer session-token");
    if (target.pathname === "/api/user/self/groups") {
      return Response.json({ success: true, data: {
        [group]: { desc: "  Group\n \tA\u0000 ", ratio: 0.125 },
        free: { desc: "Group A", ratio: 0 }, auto: { ratio: "自动" }, missing: { ratio: null },
      } });
    }
    if (target.pathname === "/api/pricing") return Response.json({ success: true,
      group_ratio: { [group]: 99, auto: 1 },
      data: [
        { model_name: "a", vendor_id: 2, enable_groups: [group] },
        { model_name: "forbidden", vendor_id: 2, enable_groups: [group] },
        { model_name: "b", enable_groups: ["free"] },
        { model_name: "movie", tags: "视频", enable_groups: [group] },
        { model_name: "rank", supported_endpoint_types: ["rerank"], enable_groups: [group] },
        { model_name: "all-only", enable_groups: ["all"] },
        { model_name: "zero", enable_groups: ["free"] },
        { model_name: "auto-listed", enable_groups: ["auto"] },
      ],
      vendors: [{ id: 2, name: "Anthropic" }],
    });
    assert.equal(target.pathname, "/api/user/models");
    return Response.json({ success: true, data: target.searchParams.get("group") === group ? ["b", "a", "a", "hidden", "movie", "rank", "all-only"] : ["zero", "auto-listed"] });
  }, async () => true);
  assert.deepEqual(await account.groups(await account.session()), [
    { id: group, label: group, description: "Group A", ratio: 0.125, models: ["a", "movie", "rank"], chatModels: ["a"], modelVendors: { a: "Anthropic" } },
    { id: "free", label: "free", description: "Group A", ratio: 0, models: ["zero"], chatModels: ["zero"] },
    { id: "auto", label: "auto", ratio: "auto", models: ["auto-listed"], chatModels: ["auto-listed"] },
  ]);
});

test("site vendor names resolve aliases and group descriptions never assign model families", () => {
  assert.equal(starAiModelFamily("deployment-42", "Anthropic"), "Claude");
  assert.equal(starAiModelFamily("eu.anthropic.claude-opus-4-6-v1"), "Claude");
  assert.equal(starAiModelFamily("gateway/o3-mini"), "GPT");
  assert.equal(starAiModelFamily("deepseek/deepseek-v4-flash"), "DeepSeek");
  assert.equal(starAiModelFamily("custom", "Site publisher"), "Site publisher");
  assert.equal(starAiModelFamily("custom"), "other");
});

test("unavailable marketplace never falls back to raw authorized model names", async () => {
  const account = new StarAiSession(async (url) => {
    const path = new URL(url).pathname;
    if (path === STARAI_REFRESH) return sessionReply();
    if (path === "/api/pricing") return new Response(null, { status: 503 });
    assert.equal(path, "/api/user/self/groups");
    return Response.json({ success: true, data: { live: { ratio: 0 } } });
  }, async () => true);
  await assert.rejects(account.groups(await account.session()), { errorCode: "STARAI_UNAVAILABLE" });
});

test("marketplace services follow the site's group names, precedence and stable ratio ordering", () => {
  assert.deepEqual(STARAI_SERVICES, ["gpt", "claude", "gemini", "domestic", "grok", "media", "other"]);
  const names = ["vip用户gpt", "claude满血cc渠道", "Gemini分组", "DeepSeek【高级渠道】", "Kimi分组", "GLM分组", "grok满血", "gpt-image专用", "绘图组", "XC"];
  assert.deepEqual(names.map(starAiGroupService), ["gpt", "claude", "gemini", "domestic", "domestic", "domestic", "grok", "media", "media", "other"]);
  const groups = ["auto", 0, 0.2, 3, 0.2].map((ratio, id) => ({id, ratio}));
  assert.deepEqual(sortStarAiGroupsByRatio(groups).map(g => g.id), [3, 2, 4, 1, 0]);
});

test("chat pins the origin, route, account and selected group", async () => {
  const requests = [];
  const account = new StarAiSession(async (url, init) => {
    if (url.endsWith(STARAI_REFRESH)) return sessionReply();
    requests.push([url, init]);
    return new Response("data: [DONE]\n\n");
  }, async () => true);
  const route = { accountId: 42, group: "group-a", model: "model-a" };
  const body = { group: "other", model: "other", messages: [], stream: true };
  const signal = new AbortController().signal;
  await assert.rejects(account.submitChat({ ...route, accountId: 99 }, body, signal), {errorCode: "STARAI_LOGIN_REQUIRED"});
  assert.equal(requests.length, 0);
  assert.match(await (await account.submitChat(route, body, signal)).text(), /DONE/);
  const [[url, init]] = requests;
  assert.equal(url, STARAI_ORIGIN + "/pg/chat/completions");
  assert.deepEqual(JSON.parse(init.body), { ...body, group: route.group, model: route.model });
  assert.equal(init.signal, signal);
  assert.equal(init.redirect, "error");
  assert.equal(init.headers.get("Accept"), "text/event-stream");
  assert.equal(init.headers.get("User-Agent"), `${STARAI_CLIENT_NAME}/0.0.1`);
  assert.equal(init.headers.get("X-StarAI-Client"), STARAI_CLIENT_ID);
  assert.equal(init.headers.get("X-StarAI-Version"), "0.0.1");
});

test("Claude groups send the Claude Code client identity and other groups keep the StarAI one", async () => {
  const requests = [];
  const account = new StarAiSession(async (url, init) => {
    if (url.endsWith(STARAI_REFRESH)) return sessionReply();
    requests.push({ path: new URL(url).pathname, headers: init.headers });
    return Response.json({});
  }, async () => true, "0.2.3");
  const signal = new AbortController().signal;
  const route = { accountId: 42, model: "claude-haiku-5-5", group: "claude企业组" };
  await account.submitChat(route, { messages: [], stream: true }, signal);
  await account.submitChat({ ...route, group: "claude特价渠道" }, { messages: [] }, signal);
  await account.submitChat({ ...route, group: "claude kiro企业正价号池" }, { messages: [] }, signal);
  await account.submitChat({ ...route, group: "claude企业组不限客户端" }, { group: route.group, messages: [] }, signal);
  await account.submitChat({ ...route, group: "auto" }, { messages: [] }, signal);
  await account.submitChat({ ...route, group: "default" }, { messages: [] }, signal);

  const [enterprise, special, kiro, unrestricted, auto, plain] = requests;
  for (const bound of [enterprise, special, kiro, unrestricted]) {
    assert.equal(bound.path, "/pg/chat/completions");
    assert.equal(bound.headers.get("User-Agent"), "claude-cli/2.1.332 (external, sdk-cli)");
    assert.equal(bound.headers.get("x-app"), "cli");
    assert.equal(bound.headers.get("anthropic-version"), "2023-06-01");
    assert.equal(bound.headers.get("anthropic-dangerous-direct-browser-access"), "true");
    assert.equal(bound.headers.get("x-stainless-lang"), "js");
    assert.equal(bound.headers.get("x-stainless-package-version"), "0.128.0");
    assert.equal(bound.headers.get("x-stainless-runtime"), "node");
    assert.equal(bound.headers.get("x-stainless-timeout"), "600");
    assert.equal(bound.headers.get("X-StarAI-Client"), "starai-desktop");
    assert.equal(bound.headers.get("X-StarAI-Version"), "0.2.3");
    assert.equal(bound.headers.get("Authorization"), "Bearer session-token");
  }
  assert.equal(enterprise.headers.get("Accept"), "text/event-stream");
  for (const generic of [auto, plain]) {
    assert.equal(generic.headers.get("User-Agent"), "StarAI/0.2.3");
    assert.equal(generic.headers.has("x-app"), false);
    assert.equal(generic.headers.has("anthropic-version"), false);
  }
});

test("Claude enterprise chat negotiates SSE on consecutive turns and JSON on a non-streaming turn", async () => {
  const received = [];
  const account = new StarAiSession(async (url, init) => {
    if (url.endsWith(STARAI_REFRESH)) {
      assert.equal(init.headers.get("Accept"), "application/json");
      return sessionReply();
    }
    const { messages, stream } = JSON.parse(init.body);
    const expected = stream === true ? "text/event-stream" : "application/json";
    if (init.headers.get("Accept") !== expected) return new Response(null, { status: 406 });
    received.push(messages);
    return new Response(null, { headers: { "Content-Type": expected } });
  }, async () => true);
  const route = { accountId: 42, group: "claude企业组", model: "claude-haiku-5-5" };
  const signal = new AbortController().signal;
  const messages = [];
  for (const [question, answer] of [["Start at seven.", "7"], ["Double it.", "14"], ["Add three.", "17"]]) {
    messages.push({ role: "user", content: question });
    const reply = await account.submitChat(route, { messages, stream: true }, signal);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("Content-Type"), "text/event-stream");
    assert.deepEqual(received.at(-1), messages);
    messages.push({ role: "assistant", content: answer });
  }
  for (const body of [{ messages, stream: false }, { messages }]) {
    const reply = await account.submitChat(route, body, signal);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("Content-Type"), "application/json");
  }
});

test("session requests carry StarAI client identification headers with the app version", async () => {
  const seen = [];
  const account = new StarAiSession(async (url, init) => {
    seen.push({
      url,
      userAgent: init.headers.get("User-Agent"),
      client: init.headers.get("X-StarAI-Client"),
      version: init.headers.get("X-StarAI-Version"),
    });
    if (url.endsWith(STARAI_REFRESH)) return sessionReply();
    return new Response("data: [DONE]\n\n");
  }, async () => true, "0.2.3");
  await account.submitChat(
    { accountId: 42, group: "default", model: "model-a" },
    { messages: [], stream: true },
    new AbortController().signal,
  );
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(request.userAgent, `${STARAI_CLIENT_NAME}/0.2.3`);
    assert.equal(request.client, STARAI_CLIENT_ID);
    assert.equal(request.version, "0.2.3");
  }
});

test("an expired or malformed account and a refresh completing after logout cannot authorize", async () => {
  const expired = new StarAiSession(async () => new Response(null, { status: 401 }), async () => true);
  assert.equal(await expired.session(), null);
  const corrupted = new StarAiSession(async () => Response.json({success:true,data:{access_token:"value"}}), async () => true);
  await assert.rejects(corrupted.session(), { errorCode: "STARAI_INVALID_RESPONSE" });
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const account = new StarAiSession(async () => { started.resolve(); return response.promise; }, async () => true);
  const reading = account.session();
  await started.promise;
  account.forget();
  response.resolve(sessionReply());
  await assert.rejects(reading, { errorCode: "STARAI_LOGIN_REQUIRED" });
});

test("StarAI transport distinguishes unreachable network errors from explicit relay HTTP status codes", async () => {
  let mode = "network";
  const transport = createStarAiTransport(async () => {
    if (mode === "network") throw new TypeError("fetch failed");
    if (mode === "auth") throw starAiError("STARAI_LOGIN_REQUIRED", "Sign in to StarAI.");
    return new Response("Bad Gateway", { status: 502 });
  });
  try {
    const binding = await transport.bind({ accountId: 42, group: "default", models: ["gpt-test"] });
    binding.commit();
    const call = () =>
      fetch(`${binding.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${binding.secretValue}`,
        },
        body: JSON.stringify({ model: "gpt-test", messages: [] }),
      });

    // Unreachable network drops the loopback socket without a synthetic 502.
    await assert.rejects(call());

    mode = "auth";
    const authRes = await call();
    assert.equal(authRes.status, 401);

    mode = "relay502";
    const relayRes = await call();
    assert.equal(relayRes.status, 502);
  } finally {
    transport.close();
  }
});

test("StarAI chat errors expose the relay request ID without forwarding upstream diagnostics", async () => {
  const requestId = "20300102030405123456789abcd1234AbCd1234";
  let reportedId = requestId;
  const transport = createStarAiTransport(async () => Response.json({
    error: { code: "client_not_allowed", message: "private upstream diagnostic" },
  }, { status: 403, headers: { "X-Oneapi-Request-Id": reportedId } }));
  try {
    const route = await transport.bind({ accountId: 42, group: "claude企业组", models: ["claude-haiku-5-5"] });
    route.commit();
    for (const expectedId of [requestId, undefined]) {
      reportedId = expectedId ?? "unexpected diagnostic text";
      const response = await fetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${route.secretValue}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-5-5", messages: [] }),
      });
      assert.equal(response.status, 403);
      const summary = "StarAI chat request failed (HTTP 403).";
      assert.deepEqual(await response.json(), {
        error: { message: expectedId ? `${summary} Request ID: ${expectedId}` : summary },
      });
    }
  } finally {
    transport.close();
  }
});

test("StarAI transport returns 401 without upstream trace ID when aborted mid-flight", async () => {
  const started = Promise.withResolvers();
  const finishUpstream = Promise.withResolvers();
  const transport = createStarAiTransport(async () => {
    started.resolve();
    return finishUpstream.promise;
  });
  try {
    const first = await transport.bind({ accountId: 42, group: "default", models: ["model-a"] });
    first.commit();
    const pending = fetch(`${first.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${first.secretValue}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "model-a", messages: [] }),
    });
    await started.promise;
    const second = await transport.bind({ accountId: 42, group: "other", models: ["model-b"] });
    second.commit();
    finishUpstream.resolve(new Response("ok", {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-Oneapi-Request-Id": "20300102030405123456789abcd1234AbCd1234",
      },
    }));
    const response = await pending;
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: { message: "The local StarAI connection has changed." },
    });
  } finally {
    transport.close();
  }
});
