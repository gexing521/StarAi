import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  isStarAiChatForbidden,
  messageHasTranscriptContent,
  vendorAccountOmitsSessionModel,
} = await import("../src/lib/chat-launch-error.ts");

const oauth = (models) => [{ id: "chatgpt", authKind: "oauth", models }];

test("a launch error with no assistant text still counts as a transcript", () => {
  assert.equal(
    messageHasTranscriptContent({
      role: "assistant",
      content: "",
      error: { code: "MODEL_NOT_CONFIGURED", message: "missing" },
    }),
    true,
  );
  assert.equal(
    messageHasTranscriptContent({ role: "assistant", content: "   " }),
    false,
  );
  assert.equal(
    messageHasTranscriptContent({ role: "user", content: "hello" }),
    true,
  );
});

test("an empty vendor chat names a model the account did not return", () => {
  const session = { providerId: "chatgpt", modelId: "gpt-6-luna" };
  assert.equal(
    vendorAccountOmitsSessionModel(session, oauth([{ id: "gpt-5.6-luna" }])),
    true,
  );
  assert.equal(
    vendorAccountOmitsSessionModel(session, oauth([{ id: "openai/gpt-6-luna" }])),
    true,
  );
  assert.equal(vendorAccountOmitsSessionModel(session, oauth([])), false);
  assert.equal(vendorAccountOmitsSessionModel(
    { providerId: "chatgpt", modelId: "model" }, oauth([{ id: "generic/model" }]),
  ), true);
  assert.equal(vendorAccountOmitsSessionModel(
    { providerId: "chatgpt", modelId: "GENERIC/MODEL" }, oauth([{ id: "generic/model" }]),
  ), false);
  assert.equal(
    vendorAccountOmitsSessionModel(session, [
      { id: "chatgpt", authKind: "api_key", models: [{ id: "gpt-5.6-luna" }] },
    ]),
    false,
  );
});

test("the chat surface shows that omission instead of an empty page", async () => {
  const { readFile } = await import("node:fs/promises");
  const surface = await readFile(
    new URL("../src/components/ChatSurface.tsx", import.meta.url),
    "utf8",
  );
  assert.match(surface, /messageHasTranscriptContent\(message\)/);
  assert.match(surface, /vendorAccountOmitsSessionModel\(/);
  assert.match(surface, /activeSession\.modelId/);
  assert.match(surface, /noticeError \?/);
  assert.match(surface, /isStarAiChatForbidden\(/);
  assert.match(surface, /errors\.starAiChatForbidden/);
});

test("StarAI HTTP 403 errors are recognized as access denials without matching 401 or other providers", () => {
  assert.equal(
    isStarAiChatForbidden({
      code: "PROVIDER_UNAUTHORIZED",
      providerId: "starai-managed-group",
      providerStatus: 403,
      message: "403 Forbidden",
    }),
    true,
  );
  assert.equal(
    isStarAiChatForbidden({
      code: "PROVIDER_UNAUTHORIZED",
      message: "403 StarAI chat request failed (HTTP 403). Request ID: 123",
    }),
    true,
  );
  assert.equal(
    isStarAiChatForbidden({
      code: "PROVIDER_UNAUTHORIZED",
      providerId: "starai-managed-group",
      providerStatus: 401,
      message: "401 Unauthorized",
    }),
    false,
  );
  assert.equal(
    isStarAiChatForbidden({
      code: "PROVIDER_UNAUTHORIZED",
      providerId: "other-provider",
      providerStatus: 403,
      message: "403 Forbidden",
    }),
    false,
  );
  assert.equal(
    isStarAiChatForbidden({
      code: "PROVIDER_ERROR",
      providerId: "starai-managed-group",
      providerStatus: 403,
      message: "StarAI chat request failed (HTTP 403).",
    }),
    false,
  );
});
