import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const electronStub = "data:text/javascript," + encodeURIComponent(`
  export const app = { getLocale: () => "zh-CN" };
  export class BrowserWindow {}
  export const screen = {
    getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }),
    screenToDipRect: (_win, rect) => ({
      x: Math.round(rect.x / 1.5),
      y: Math.round(rect.y / 1.5),
      width: Math.round(rect.width / 1.5),
      height: Math.round(rect.height / 1.5),
    }),
    screenToDipPoint: (point) => ({
      x: Math.round(point.x / 1.5),
      y: Math.round(point.y / 1.5),
    }),
  };
  export const desktopCapturer = { getSources: async () => [] };
  export const systemPreferences = { getMediaAccessStatus: () => "not-determined" };
`);

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: electronStub, shortCircuit: true };
    if (context.parentURL?.includes("/electron/main/") && /^\.\.?\/[\w/-]+$/.test(specifier)) {
      return next(specifier + ".ts", context);
    }
    return next(specifier, context);
  },
});

const { capturePermissionState, captureSourceIdFor } = await import(
  "../electron/main/computer-use/capture.ts"
);
const { mapCursorEventToDisplay } = await import(
  "../electron/main/computer-use/cursor-overlay.ts"
);
hooks.deregister();

test("capturePermissionState reports granted on Windows without OS prompt", () => {
  assert.equal(capturePermissionState("win32"), "granted");
  assert.equal(capturePermissionState("linux"), "not-requested");
});

test("captureSourceIdFor joins Windows HWND targetId with desktopCapturer source id", () => {
  const sources = [
    { id: "window:131456:0" },
    { id: "window:987654:0" },
  ];
  assert.equal(captureSourceIdFor(sources, "4321:987654"), "window:987654:0");
  assert.equal(captureSourceIdFor(sources, "4321:111111"), undefined);
});

test("mapCursorEventToDisplay converts physical pixels to DIP on Windows only", () => {
  const showEvent = {
    kind: "show",
    grantId: "cug_1",
    bounds: { x: 150, y: 300, width: 1200, height: 900 },
  };
  const winShow = mapCursorEventToDisplay(showEvent, "win32");
  assert.deepEqual(winShow.bounds, { x: 100, y: 200, width: 800, height: 600 });

  const macShow = mapCursorEventToDisplay(showEvent, "darwin");
  assert.deepEqual(macShow.bounds, showEvent.bounds);

  const moveEvent = {
    kind: "move",
    grantId: "cug_1",
    x: 450,
    y: 600,
    label: "Save",
  };
  const winMove = mapCursorEventToDisplay(moveEvent, "win32");
  assert.equal(winMove.x, 300);
  assert.equal(winMove.y, 400);

  const macMove = mapCursorEventToDisplay(moveEvent, "darwin");
  assert.equal(macMove.x, 450);
  assert.equal(macMove.y, 600);
});
