import { isStarAiProviderId, OAUTH_AUTH_KIND } from "@pi-desktop/shared";
import { sameComposerModelId } from "./composer-models";

/**
 * Managed StarAI HTTP 403 means group/model/client access was denied rather
 * than a user-configured API key being invalid. Older saved errors may only
 * carry the sanitized transport message.
 */
export function isStarAiChatForbidden(input: {
  code?: string | null;
  message?: string | null;
  providerId?: string | null;
  providerStatus?: unknown;
}): boolean {
  if (input.code !== "PROVIDER_UNAUTHORIZED") return false;
  if (isStarAiProviderId(input.providerId ?? undefined) && input.providerStatus === 403) return true;
  return (
    typeof input.message === "string" &&
    input.message.includes("StarAI chat request failed (HTTP 403).")
  );
}

type TranscriptMessage = {
  role: string;
  content?: string;
  thinking?: string;
  error?: unknown;
};

/** An assistant row that only carries a launch error is still the conversation. */
export function messageHasTranscriptContent(message: TranscriptMessage): boolean {
  const hasContent = Boolean((message.content || "").trim());
  const hasThinking =
    typeof message.thinking === "string" && Boolean(message.thinking.trim());
  if (message.role === "assistant") {
    return hasContent || hasThinking || Boolean(message.error);
  }
  return hasContent || message.role === "tool";
}

type VendorSessionModel = {
  providerId?: string | null;
  modelId?: string | null;
};

type VendorModelProvider = {
  id: string;
  authKind?: string;
  models?: ReadonlyArray<{ id: string }>;
};

/**
 * Vendor accounts refuse a session model the account list did not return.
 * An empty list means the catalog has not loaded, not that the account
 * offers nothing, so it must not turn a normal empty chat into an error.
 */
export function vendorAccountOmitsSessionModel(
  session: VendorSessionModel | null | undefined,
  providers: readonly VendorModelProvider[],
): boolean {
  const providerId = session?.providerId?.trim();
  const modelId = session?.modelId?.trim();
  if (!providerId || !modelId) return false;
  const provider = providers.find((item) => item.id === providerId);
  if (!provider || provider.authKind !== OAUTH_AUTH_KIND) return false;
  const models = provider.models ?? [];
  if (models.length === 0) return false;
  return !models.some((model) => sameComposerModelId(model.id, modelId));
}
