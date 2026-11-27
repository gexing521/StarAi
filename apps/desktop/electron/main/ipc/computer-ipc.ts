/**
 * The computer-use channels the renderer may call (ADR 0342, ADR 0344).
 *
 * Deliberately short: read what the platform can do, ask the OS for the
 * permission, read the live grant, and stop it. There is no channel here that
 * mints a grant, enumerates windows, or dispatches input — the renderer must
 * never hold that authority — and every call is pinned to the trusted main
 * window, so a plugin view or the cursor overlay cannot reach even these.
 */
import {
  IPC,
  type ComputerCapabilities,
  type ComputerConsentDecision,
  type ComputerGrantView,
} from "@pi-desktop/shared";
import { capturePermissionState } from "../computer-use/capture";
import { applicationAccessibility, openAccessibilitySettings } from "../computer-use/permission";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type ComputerIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => Pick<HostProcess, "call"> | null;
  /** Push the grant to the indicator and close the overlay when it ends. */
  publishGrant: (grant: ComputerGrantView | null) => void;
  /** Resolve an in-flight Computer Use consent prompt from the main window. */
  respondConsent?: (requestId: string, decision: ComputerConsentDecision) => boolean;
  /** Record that the user initiated OS accessibility authorization. */
  onPermissionRequested?: () => void;
  /** Restart the application cleanly after an OS permission grant. */
  relaunchApp?: () => void;
};

function hostUnavailable(): never {
  throw Object.assign(new Error("Host unavailable."), { errorCode: "HOST_UNAVAILABLE" });
}

export function registerComputerIpc({
  registrar,
  getHost,
  publishGrant,
  respondConsent,
  onPermissionRequested,
  relaunchApp,
}: ComputerIpcDependencies): void {
  registrar.handleWithEvent(IPC.invoke.computerCapabilities, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const capabilities = await host.call<ComputerCapabilities>("computer.capabilities", {});
    // host-core cannot answer for the capture path: that one is Chromium's.
    return { ...applicationAccessibility(capabilities), capture: capturePermissionState() };
  });

  // Request trust for the app visible in System Settings. The Rust child's
  // trust remains a separate, authoritative check before native input.
  registrar.handleWithEvent(IPC.invoke.computerRequestPermission, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const capabilities = await host.call<ComputerCapabilities>(
      "computer.capabilities",
      {},
    );
    const requested = capabilities.platform === "darwin" && capabilities.backend === "macos-ax"
      ? applicationAccessibility(capabilities, true)
      : await host.call<ComputerCapabilities>("computer.requestPermission", {});
    const view = { ...requested, capture: capturePermissionState() };
    onPermissionRequested?.();
    await openAccessibilitySettings(view);
    return view;
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantRevoke, async (event, request: unknown) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    const input = (request ?? {}) as Record<string, unknown>;
    const result = await host.call<{ revoked: boolean }>("computer.grantRevoke", {
      ...(typeof input.reason === "string" ? { reason: input.reason } : {}),
    });
    publishGrant(null);
    return result;
  });

  registrar.handleWithEvent(IPC.invoke.computerGrantDescribe, async (event) => {
    registrar.assertMainWindowSender(event);
    const host = getHost();
    if (!host) hostUnavailable();
    return host.call<{ grant: ComputerGrantView | null }>("computer.grantDescribe", {});
  });

  registrar.handleWithEvent(IPC.invoke.computerConsentRespond, async (event, request: unknown) => {
    registrar.assertMainWindowSender(event);
    const input = (request ?? {}) as Record<string, unknown>;
    const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
    const decision = input.decision;
    if (!requestId || (decision !== "approved" && decision !== "denied")) {
      throw Object.assign(new Error("Invalid computer consent response."), {
        errorCode: "INVALID_PARAMS",
      });
    }
    const ok = respondConsent ? respondConsent(requestId, decision) : false;
    return { ok };
  });

  registrar.handleWithEvent(IPC.invoke.computerRelaunch, async (event) => {
    registrar.assertMainWindowSender(event);
    relaunchApp?.();
    return { ok: true };
  });
}
