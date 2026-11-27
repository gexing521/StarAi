import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const { build } = createRequire(new URL("../../../packages/agent-runtime/package.json", import.meta.url))(
  "esbuild",
);

async function loadConsentAndService(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-computer-consent-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stub = join(root, "electron-stub.mjs");
  await writeFile(
    stub,
    "export const desktopCapturer = { getSources: async () => [] };\nexport const systemPreferences = { getMediaAccessStatus: () => \"not-determined\" };\n",
  );
  const runtimeStub = join(root, "runtime-stub.mjs");
  await writeFile(
    runtimeStub,
    "export async function completeOneShot() { throw new Error('not injected'); }\n",
  );

  const brokerOut = join(root, "consent-broker.mjs");
  const serviceOut = join(root, "service.mjs");
  await Promise.all([
    build({
      entryPoints: [fileURLToPath(new URL("../electron/main/computer-use/consent-broker.ts", import.meta.url))],
      outfile: brokerOut,
      bundle: true,
      platform: "node",
      format: "esm",
      alias: { electron: stub },
    }),
    build({
      entryPoints: [fileURLToPath(new URL("../electron/main/computer-use/service.ts", import.meta.url))],
      outfile: serviceOut,
      bundle: true,
      platform: "node",
      format: "esm",
      alias: { electron: stub, "@pi-desktop/agent-runtime": runtimeStub },
    }),
  ]);

  const [brokerMod, serviceMod] = await Promise.all([
    import(pathToFileURL(brokerOut).href),
    import(pathToFileURL(serviceOut).href),
  ]);
  return { ...brokerMod, ...serviceMod };
}

test("createComputerConsentBroker sends request, settles response, aborts cleanly, and fails closed without window", async (t) => {
  const { createComputerConsentBroker } = await loadConsentAndService(t);
  const sent = [];
  let win = null;
  const broker = createComputerConsentBroker({
    getMainWindow: () => win,
    send: (channel, payload) => sent.push({ channel, payload }),
  });

  const caps = {
    platform: "darwin",
    backend: "macos-ax",
    fidelity: "full",
    accessibility: "not-requested",
    capture: "not-requested",
  };

  assert.equal(
    await broker.request({ reason: "enable-and-os-permission", instruction: "open TextEdit", capabilities: caps }),
    "denied",
    "fails closed when main window does not exist",
  );
  assert.equal(sent.length, 0);

  let focused = 0;
  win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => { focused += 1; },
  };

  const ac1 = new AbortController();
  const p1 = broker.request({
    reason: "enable-and-os-permission",
    instruction: "open TextEdit",
    capabilities: caps,
    signal: ac1.signal,
  });
  assert.equal(focused, 1);
  assert.equal(sent.length, 1);
  const req1 = sent[0].payload;
  assert.equal(req1.reason, "enable-and-os-permission");
  assert.equal(broker.respond(req1.requestId, "approved"), true);
  assert.equal(broker.respond(req1.requestId, "denied"), false, "second respond returns false");
  assert.equal(await p1, "approved");

  const ac2 = new AbortController();
  const p2 = broker.request({
    reason: "os-permission",
    instruction: "click save",
    capabilities: caps,
    signal: ac2.signal,
  });
  const req2 = sent[1].payload;
  ac2.abort();
  assert.equal(await p2, "denied");
  assert.equal(sent[2].payload.requestId, req2.requestId);
});

test("createComputerUseTool prompts to enable, approves in-flight, and falls back to conversation model", async (t) => {
  const { createComputerUseTool } = await loadConsentAndService(t);
  const settings = { computerUse: { enabled: false } };
  let currentGrant = null;
  const promptCalls = [];

  const host = {
    call: async (method) => {
      if (method === "settings.get") return structuredClone(settings);
      if (method === "computer.grantDescribe") return { grant: currentGrant };
      if (method === "computer.grantCreate") {
        currentGrant = {
          grantId: "cug_auto",
          revision: 1,
          scope: "desktop",
          targetId: "77:12",
          targetLabel: "TextEdit",
          appKey: "textedit",
          bounds: { x: 0, y: 0, width: 400, height: 300 },
          inputPolicy: "autonomous-in-scope",
          capture: "a11y-only",
          remainingBudget: 5,
          sessionId: "session-1",
          createdAt: "2026-11-27T00:00:00.000Z",
          expiresAt: "2026-11-27T00:15:00.000Z",
          state: "active",
        };
        return currentGrant;
      }
      if (method === "computer.inspect") {
        return {
          grantId: "cug_auto",
          revision: 1,
          bounds: { x: 0, y: 0, width: 400, height: 300 },
          fidelity: "full",
          nodes: [],
          truncated: false,
          secureInput: false,
        };
      }
      if (method === "computer.listTargets") return { targets: [] };
      throw new Error(`unexpected host call: ${method}`);
    },
  };

  let fallbackCalls = 0;
  const tool = createComputerUseTool({
    getHost: () => host,
    overlay: { apply: () => {} },
    readCapabilities: async () => ({
      platform: "darwin",
      backend: "macos-ax",
      fidelity: "full",
      accessibility: "not-requested",
      applicationAccessibility: "not-requested",
      capture: "not-requested",
    }),
    requestConsent: async (req) => {
      promptCalls.push(req);
      settings.computerUse.enabled = true;
      return "approved";
    },
    resolveProvider: async () => null,
    resolveFallbackProvider: async (sessionId) => {
      fallbackCalls += 1;
      assert.equal(sessionId, "session-1");
      return {
        id: "conv-provider",
        name: "Conversation",
        modelId: "gpt-6.2-sol",
        apiKey: "secret",
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
      };
    },
    capture: async () => undefined,
    complete: async () => ({ text: '{"kind":"done","summary":"created file"}' }),
  });

  const result = await tool({
    sessionId: "session-1",
    toolCallId: "call-1",
    args: { instruction: "open TextEdit" },
    signal: new AbortController().signal,
  });

  assert.equal(result.ok, true);
  assert.equal(promptCalls.length, 1);
  assert.equal(promptCalls[0].reason, "enable-and-os-permission");
  assert.equal(fallbackCalls, 1);
});

test("createComputerUseTool returns COMPUTER_DISABLED or COMPUTER_OS_PERMISSION_MISSING when consent denied", async (t) => {
  const { createComputerUseTool } = await loadConsentAndService(t);
  let grantCreateCalled = false;

  const makeTool = (enabled, accessibility) =>
    createComputerUseTool({
      getHost: () => ({
        call: async (method) => {
          if (method === "settings.get") return { computerUse: { enabled } };
          if (method === "computer.grantCreate") grantCreateCalled = true;
          throw new Error(`unexpected host call: ${method}`);
        },
      }),
      overlay: { apply: () => {} },
      readCapabilities: async () => ({
        platform: "darwin",
        backend: "macos-ax",
        fidelity: "full",
        accessibility,
        applicationAccessibility: accessibility,
        capture: "not-requested",
      }),
      requestConsent: async () => "denied",
      resolveProvider: async () => null,
      resolveFallbackProvider: async () => null,
    });

  const r1 = await makeTool(false, "granted")({
    sessionId: "s1",
    toolCallId: "c1",
    args: { instruction: "click button" },
    signal: new AbortController().signal,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.errorCode, "COMPUTER_DISABLED");

  const r2 = await makeTool(true, "not-requested")({
    sessionId: "s1",
    toolCallId: "c2",
    args: { instruction: "click button" },
    signal: new AbortController().signal,
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.errorCode, "COMPUTER_OS_PERMISSION_MISSING");
  assert.equal(grantCreateCalled, false);
});

test("createComputerUseTool gates on authoritative backend accessibility rather than applicationAccessibility alone", async (t) => {
  const { createComputerUseTool } = await loadConsentAndService(t);
  const reasons = [];

  // App is granted, backend host-core is NOT granted -> must still prompt for os-permission.
  const needsBackend = createComputerUseTool({
    getHost: () => ({
      call: async (method) => {
        if (method === "settings.get") return { computerUse: { enabled: true } };
        throw new Error(`unexpected host call: ${method}`);
      },
    }),
    overlay: { apply: () => {} },
    readCapabilities: async () => ({
      platform: "darwin",
      backend: "macos-ax",
      fidelity: "full",
      accessibility: "not-requested",
      applicationAccessibility: "granted",
      capture: "not-requested",
    }),
    requestConsent: async (req) => {
      reasons.push(req.reason);
      return "denied";
    },
    resolveProvider: async () => null,
    resolveFallbackProvider: async () => null,
  });

  const deniedResult = await needsBackend({
    sessionId: "s1",
    toolCallId: "c3",
    args: { instruction: "click button" },
    signal: new AbortController().signal,
  });
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.errorCode, "COMPUTER_OS_PERMISSION_MISSING");
  assert.deepEqual(reasons, ["os-permission"]);

  // Backend host-core IS granted even if applicationAccessibility is not -> proceeds without prompting.
  let promptCalled = false;
  let currentGrant = null;
  const backendReady = createComputerUseTool({
    getHost: () => ({
      call: async (method) => {
        if (method === "settings.get") return { computerUse: { enabled: true } };
        if (method === "computer.grantDescribe") return { grant: currentGrant };
        if (method === "computer.grantCreate") {
          currentGrant = {
            grantId: "cug_auto",
            revision: 1,
            scope: "desktop",
            targetId: "77:12",
            targetLabel: "TextEdit",
            appKey: "textedit",
            bounds: { x: 0, y: 0, width: 400, height: 300 },
            inputPolicy: "autonomous-in-scope",
            capture: "a11y-only",
            remainingBudget: 5,
            sessionId: "s2",
            createdAt: "2026-11-27T00:00:00.000Z",
            expiresAt: "2026-11-27T00:15:00.000Z",
            state: "active",
          };
          return currentGrant;
        }
        if (method === "computer.inspect") {
          return {
            grantId: "cug_auto",
            revision: 1,
            bounds: { x: 0, y: 0, width: 400, height: 300 },
            fidelity: "full",
            nodes: [],
            truncated: false,
            secureInput: false,
          };
        }
        if (method === "computer.listTargets") return { targets: [] };
        throw new Error(`unexpected host call: ${method}`);
      },
    }),
    overlay: { apply: () => {} },
    readCapabilities: async () => ({
      platform: "darwin",
      backend: "macos-ax",
      fidelity: "full",
      accessibility: "granted",
      applicationAccessibility: "not-requested",
      capture: "not-requested",
    }),
    requestConsent: async () => {
      promptCalled = true;
      return "denied";
    },
    resolveProvider: async () => null,
    resolveFallbackProvider: async () => ({
      id: "conv-provider",
      name: "Conversation",
      modelId: "gpt-6.2-sol",
      apiKey: "secret",
      supportsReasoning: false,
      supportedThinkingLevels: ["off"],
    }),
    capture: async () => undefined,
    complete: async () => ({ text: '{"kind":"done","summary":"ok"}' }),
  });

  const okResult = await backendReady({
    sessionId: "s2",
    toolCallId: "c4",
    args: { instruction: "click button" },
    signal: new AbortController().signal,
  });
  assert.equal(okResult.ok, true);
  assert.equal(promptCalled, false);
});
