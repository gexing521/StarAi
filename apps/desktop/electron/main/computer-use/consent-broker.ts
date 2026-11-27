import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import {
  IPC,
  type ComputerCapabilities,
  type ComputerConsentDecision,
  type ComputerConsentReason,
  type ComputerConsentRequest,
} from "@pi-desktop/shared";

const MAX_INSTRUCTION_CHARS = 400;

export type ComputerConsentPromptInput = {
  reason: ComputerConsentReason;
  instruction: string;
  capabilities: ComputerCapabilities;
  signal?: AbortSignal;
};

export type ComputerConsentBroker = {
  request: (input: ComputerConsentPromptInput) => Promise<ComputerConsentDecision>;
  respond: (requestId: string, decision: ComputerConsentDecision) => boolean;
  dispose: () => void;
};

type PendingConsent = {
  resolve: (decision: ComputerConsentDecision) => void;
  cleanupAbort?: () => void;
};

/**
 * Coordinates in-app Computer Use activation / macOS Accessibility prompts
 * between the main-process tool handler and the renderer modal dialog.
 */
export function createComputerConsentBroker(deps: {
  getMainWindow: () => BrowserWindow | null;
  send: (channel: string, payload: unknown) => void;
}): ComputerConsentBroker {
  const pending = new Map<string, PendingConsent>();

  const settle = (requestId: string, decision: ComputerConsentDecision): boolean => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    entry.cleanupAbort?.();
    entry.resolve(decision);
    return true;
  };

  return {
    request(input) {
      if (input.signal?.aborted) {
        return Promise.resolve("denied");
      }
      const win = deps.getMainWindow();
      if (!win || win.isDestroyed()) {
        return Promise.resolve("denied");
      }
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } catch {
        // Non-fatal: still push the IPC prompt to the window.
      }

      const requestId = randomUUID();
      const payload: ComputerConsentRequest = {
        requestId,
        reason: input.reason,
        instruction: input.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS),
        capabilities: input.capabilities,
      };

      return new Promise<ComputerConsentDecision>((resolve) => {
        let cleanupAbort: (() => void) | undefined;
        if (input.signal) {
          const onAbort = () => {
            if (settle(requestId, "denied")) {
              deps.send(IPC.event.computerConsentDismiss, { requestId });
            }
          };
          input.signal.addEventListener("abort", onAbort, { once: true });
          cleanupAbort = () => input.signal?.removeEventListener("abort", onAbort);
        }
        pending.set(requestId, { resolve, cleanupAbort });
        deps.send(IPC.event.computerConsentRequest, payload);
      });
    },

    respond(requestId, decision) {
      return settle(requestId, decision);
    },

    dispose() {
      for (const requestId of [...pending.keys()]) {
        if (settle(requestId, "denied")) {
          deps.send(IPC.event.computerConsentDismiss, { requestId });
        }
      }
    },
  };
}
