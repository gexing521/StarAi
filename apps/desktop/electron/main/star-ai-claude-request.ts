import { createHash } from "node:crypto";
import { STARAI_CLAUDE_CODE_VERSION } from "./star-ai-claude-headers.ts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};

const billingText = `x-anthropic-billing-header: cc_version=${STARAI_CLAUDE_CODE_VERSION}.e7e; cc_entrypoint=sdk-cli;`;
const identityText = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/** Adapt the OpenAI request before the relay converts it to Claude Messages. */
export function prepareStarAiClaudeRequest(
  body: RecordValue,
  installationId: string,
  sessionId: string,
): RecordValue {
  const messages = Array.isArray(body.messages) ? [...body.messages] : body.messages;
  if (Array.isArray(messages)) {
    const first = record(messages[0]);
    const content = first.content;
    const hasIdentity = first.role === "system" && Array.isArray(content) && content.length === 2
      && record(content[0]).text === billingText && record(content[1]).text === identityText;
    if (!hasIdentity) {
      messages.unshift({ role: "system", content: [
        { type: "text", text: billingText },
        { type: "text", text: identityText, cache_control: { type: "ephemeral" } },
      ] });
    }
  }
  return {
    ...body,
    messages,
    metadata: {
      ...record(body.metadata),
      user_id: JSON.stringify({
        device_id: createHash("sha256").update(installationId).digest("hex"),
        account_uuid: "",
        session_id: sessionId,
      }),
    },
  };
}
