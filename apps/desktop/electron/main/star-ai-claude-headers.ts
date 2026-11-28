/**
 * Claude Code client headers for StarAI Claude groups.
 *
 * A StarAI Claude group only accepts official Claude Code clients upstream, so
 * chat bound to one is sent with a captured Claude Code identity instead of the
 * StarAI desktop one. The values mirror a real Claude Code request and stay
 * aligned with pi-model-manager's `claude-code` header profile.
 *
 * `anthropic-beta` is deliberately absent: the relay derives the protocol betas
 * for the converted request, and a fixed list would either disable capabilities
 * or contradict the negotiated model. `Authorization` and `Host` are owned by
 * the request layer and must not be templated here.
 */

import { starAiGroupService } from "@pi-desktop/shared";

export const STARAI_CLAUDE_CODE_HEADERS: Readonly<Record<string, string>> = {
  "anthropic-dangerous-direct-browser-access": "true",
  "anthropic-version": "2023-06-01",
  "user-agent": "claude-cli/2.1.332 (external, sdk-cli)",
  "x-app": "cli",
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "0.128.0",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.12.1",
  "x-stainless-timeout": "600",
};

/** Claude groups follow the site's own group classification; `auto` stays generic. */
export function isStarAiClaudeGroup(group: string): boolean {
  return starAiGroupService(group) === "claude";
}
