import { BrowserWindow, session, type Session } from "electron";
import { readStarAiLoginTheme } from "./star-ai-login-theme";
import { STARAI_ORIGIN, starAiError } from "./star-ai-session";

export const STARAI_WALLET_PATH = "/wallet";
export const STARAI_TOPUP_EXTERNAL_PARTITION = "starai-topup-external";

export function isSafeTopUpUrl(address: string): boolean {
  if (address === "about:blank") return true;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isStarAiOriginUrl(address: string): boolean {
  if (address === "about:blank") return true;
  if (!isSafeTopUpUrl(address)) return false;
  try {
    return new URL(address).origin === STARAI_ORIGIN;
  } catch {
    return false;
  }
}

function externalTopUpPartition(): Session {
  // Non-persistent in-memory session so third-party payment gateways never share
  // the signed-in `persist:starai-account` cookies.
  const isolated = session.fromPartition(STARAI_TOPUP_EXTERNAL_PARTITION);
  isolated.setPermissionCheckHandler(() => false);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  return isolated;
}

let activeTopUpWindow: BrowserWindow | null = null;
let activeTopUpPromise: Promise<void> | null = null;
let topUpGeneration = 0;

function openIsolatedExternalWindow(
  parent: BrowserWindow,
  url: string,
  backgroundColor: string,
  children: Set<BrowserWindow>,
) {
  const isolated = externalTopUpPartition();
  const child = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 640,
    minHeight: 520,
    parent: parent.isDestroyed() ? undefined : parent,
    autoHideMenuBar: true,
    title: "StarAI",
    backgroundColor,
    webPreferences: {
      session: isolated,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  });
  children.add(child);
  child.once("closed", () => children.delete(child));
  guardTopUpWindow(child, isolated, backgroundColor, children, false);
  void child.loadURL(url).catch(() => {
    if (!child.isDestroyed()) child.close();
  });
}

function guardTopUpWindow(
  win: BrowserWindow,
  accountPartition: Session,
  backgroundColor: string,
  children: Set<BrowserWindow>,
  restrictToStarAiOrigin: boolean,
) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!isSafeTopUpUrl(url)) return { action: "deny" };
    const sameOrigin = restrictToStarAiOrigin && isStarAiOriginUrl(url);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 980,
        height: 740,
        minWidth: 640,
        minHeight: 520,
        parent: win.isDestroyed() ? undefined : win,
        autoHideMenuBar: true,
        title: "StarAI",
        backgroundColor,
        webPreferences: {
          session: sameOrigin ? accountPartition : externalTopUpPartition(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      },
    };
  });
  contents.on("did-create-window", (child, details) => {
    children.add(child);
    child.once("closed", () => children.delete(child));
    const sameOrigin = restrictToStarAiOrigin && isStarAiOriginUrl(details.url);
    guardTopUpWindow(child, accountPartition, backgroundColor, children, sameOrigin);
  });
  contents.on("will-navigate", (event) => {
    if (!isSafeTopUpUrl(event.url)) {
      event.preventDefault();
      return;
    }
    if (restrictToStarAiOrigin && !isStarAiOriginUrl(event.url)) {
      event.preventDefault();
      openIsolatedExternalWindow(win, event.url, backgroundColor, children);
    }
  });
  contents.on("will-redirect", (event) => {
    if (!event.isMainFrame) return;
    if (!isSafeTopUpUrl(event.url)) {
      event.preventDefault();
      return;
    }
    if (restrictToStarAiOrigin && !isStarAiOriginUrl(event.url)) {
      event.preventDefault();
      openIsolatedExternalWindow(win, event.url, backgroundColor, children);
    }
  });
}

export function closeStarAiTopUp() {
  topUpGeneration += 1;
  if (activeTopUpWindow && !activeTopUpWindow.isDestroyed()) {
    activeTopUpWindow.close();
  }
}

/** Open the signed-in StarAI wallet/recharge page in an isolated Electron window. */
export function openStarAiTopUp(
  parent: BrowserWindow | null,
  partition: Session,
): Promise<void> {
  if (activeTopUpWindow && !activeTopUpWindow.isDestroyed()) {
    if (activeTopUpWindow.isMinimized()) activeTopUpWindow.restore();
    activeTopUpWindow.focus();
  }
  if (activeTopUpPromise) {
    return activeTopUpPromise;
  }
  const generation = ++topUpGeneration;
  const promise = (async () => {
    const theme = await readStarAiLoginTheme(parent);
    if (generation !== topUpGeneration) return;
    const win = new BrowserWindow({
      width: 1060,
      height: 760,
      minWidth: 780,
      minHeight: 560,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: false,
      autoHideMenuBar: true,
      title: "StarAI",
      show: false,
      backgroundColor: theme.background,
      webPreferences: {
        session: partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
      },
    });
    const children = new Set<BrowserWindow>();
    guardTopUpWindow(win, partition, theme.background, children, true);
    win.once("ready-to-show", () => {
      if (!win.isDestroyed()) win.show();
    });
    activeTopUpWindow = win;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        for (const child of children) {
          if (!child.isDestroyed()) child.close();
        }
        children.clear();
        if (activeTopUpWindow === win) {
          activeTopUpWindow = null;
        }
        if (error) reject(error);
        else resolve();
      };
      win.once("closed", () => finish());
      void win.loadURL(STARAI_ORIGIN + STARAI_WALLET_PATH).catch(() => {
        if (!win.isDestroyed()) win.destroy();
        finish(starAiError("STARAI_UNAVAILABLE", "Unable to open the StarAI top-up page."));
      });
    });
  })().finally(() => {
    if (activeTopUpPromise === promise) {
      activeTopUpPromise = null;
    }
  });
  activeTopUpPromise = promise;
  return promise;
}
