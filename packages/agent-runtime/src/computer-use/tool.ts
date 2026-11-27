import { COMPUTER_MAX_STEPS_LIMIT } from "@pi-desktop/shared";
import { Type } from "typebox";

/**
 * The agent-facing `Computer` schema (ADR 0342 §2).
 *
 * It takes an instruction and nothing else: no window, no element, no
 * coordinate. The target comes from the grant the user minted, and addressing
 * is the inner loop's job, so there is no argument here through which the
 * conversation model could choose what gets operated.
 */
export const computerUseParameters = {
  instruction: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "One concrete task to carry out in the granted application window, in plain language.",
  }),
  maxSteps: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: COMPUTER_MAX_STEPS_LIMIT,
      description: "Upper bound on actions for this call. The grant's own budget still applies.",
    }),
  ),
  observeOnly: Type.Optional(
    Type.Boolean({
      description: "Describe the window without acting on it.",
    }),
  ),
};

export const computerUseDescription = [
  "Operate native desktop applications on the user's computer through the OS accessibility layer.",
  "Give a single concrete task in `instruction`; StarAI will prompt the user directly for approval or OS accessibility permission if needed before running the steps.",
  "You do not choose the window, and you cannot click coordinates yourself: the runtime binds the target window, and every step is re-validated against it.",
  "Use `observeOnly` to read the window without changing it.",
  "If the user declines permission or the call returns a COMPUTER_* error (such as COMPUTER_DISABLED, COMPUTER_OS_PERMISSION_MISSING, or COMPUTER_STOPPED_BY_USER), report the reason clearly instead of retrying.",
  "This is not a substitute for Bash, file tools, or the browser tool when those are better suited. Use it when the user asks for native GUI desktop control.",
].join(" ");
