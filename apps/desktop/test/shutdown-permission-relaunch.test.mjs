import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron") return { url: "test:electron-relaunch", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "test:electron-relaunch") {
      return {
        format: "module",
        shortCircuit: true,
        source: `import { EventEmitter } from "node:events";
          export const app = new EventEmitter();
          app.relaunchCalls = 0;
          app.releaseLockCalls = 0;
          app.quitCalls = 0;
          app.relaunch = () => { app.relaunchCalls += 1; };
          app.releaseSingleInstanceLock = () => { app.releaseLockCalls += 1; };
          app.quit = () => {
            app.quitCalls += 1;
            app.emit("before-quit", { preventDefault() {} });
          };
          export const globalShortcut = { unregister() {} };`,
      };
    }
    return next(url, context);
  },
});
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const { app } = await import("electron");
const { registerShutdownHandlers } = await import("../electron/main/bootstrap/shutdown.ts");
const { resetConfirmedQuitForTests } = await import("../electron/main/bootstrap/confirmed-quit.ts");
const { registerApplicationActivation } = await import("../electron/main/bootstrap/app-activation.ts");

const settle = () => new Promise((resolve) => setImmediate(resolve));

function setupShutdown({ confirmAnswers = [], isSystemPermissionRelaunch } = {}) {
  app.relaunchCalls = 0;
  app.releaseLockCalls = 0;
  app.quitCalls = 0;
  const state = {
    shutdownComplete: false,
    shutdownPromise: null,
    relaunchOnExit: false,
    quitting: false,
    quitConfirmed: false,
    closeBehavior: "tray",
    tray: null,
    pluginLauncherAccelerator: null,
    toggleWindowAccelerator: null,
  };
  let confirmCalls = 0;
  const dispose = () => undefined;
  registerShutdownHandlers({
    hasSingleInstanceLock: true,
    state,
    getHost: () => null,
    getSidecar: () => null,
    getMcpControl: () => null,
    activeTurns: new Map(),
    persistenceOutbox: { flush: async () => {} },
    inflightCheckpointer: { flushAll: async () => {}, dispose },
    flushEventPersistence: async () => {},
    pluginPanels: { closeAll: async () => {} },
    plugins: { disposeAll: async () => {} },
    userMcp: { disposeAll: dispose },
    browserHost: { dispose },
    pluginViews: { dispose: async () => {} },
    updater: { dispose, isInstallingUpdate: () => false },
    logger: { app: () => undefined },
    confirmQuitDialog: async () => {
      confirmCalls += 1;
      return confirmAnswers.shift() ?? true;
    },
    ...(isSystemPermissionRelaunch ? { isSystemPermissionRelaunch } : {}),
    disposePowerSaveBlockers: dispose,
  });
  return { state, getConfirmCalls: () => confirmCalls };
}

test("system-permission relaunch skips quit confirmation, schedules relaunch, and releases single-instance lock", async (t) => {
  resetConfirmedQuitForTests();
  t.after(() => {
    app.removeAllListeners();
    resetConfirmedQuitForTests();
  });
  const { state, getConfirmCalls } = setupShutdown({
    confirmAnswers: [false],
    isSystemPermissionRelaunch: () => true,
  });

  app.quit();
  await settle();
  assert.equal(getConfirmCalls(), 0, "must not block System Settings Quit & Reopen on quit dialog");
  assert.equal(state.quitting, true);
  await state.shutdownPromise;
  await settle();

  assert.equal(app.relaunchCalls, 1);
  assert.equal(app.releaseLockCalls, 1);
  assert.equal(state.shutdownComplete, true);
  assert.equal(app.quitCalls >= 2, true);
});

test("normal confirmed quit releases single-instance lock without scheduling relaunch", async (t) => {
  resetConfirmedQuitForTests();
  t.after(() => {
    app.removeAllListeners();
    resetConfirmedQuitForTests();
  });
  const { state, getConfirmCalls } = setupShutdown({
    confirmAnswers: [true],
    isSystemPermissionRelaunch: () => false,
  });

  app.quit();
  await settle();
  assert.equal(getConfirmCalls(), 1);
  await state.shutdownPromise;
  await settle();

  assert.equal(app.relaunchCalls, 0);
  assert.equal(app.releaseLockCalls, 1);
  assert.equal(state.shutdownComplete, true);
});

test("second-instance during shutdown requests relaunch instead of restoring closing window", async (t) => {
  t.after(() => {
    app.removeAllListeners();
  });
  let restored = 0;
  let relaunchRequested = 0;
  let quitting = false;

  registerApplicationActivation({
    restoreMainWindow: () => {
      restored += 1;
    },
    onSecondInstanceWhileQuitting: () => {
      relaunchRequested += 1;
    },
    isQuitting: () => quitting,
    isApplicationBooted: () => true,
    hasVisibleWindow: () => true,
  });

  app.emit("second-instance");
  assert.equal(restored, 1);
  assert.equal(relaunchRequested, 0);

  quitting = true;
  app.emit("second-instance");
  assert.equal(restored, 1);
  assert.equal(relaunchRequested, 1);
});
