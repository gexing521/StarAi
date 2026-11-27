import { BrowserWindow, type Session } from "electron";
import { readStarAiLoginTheme } from "./star-ai-login-theme";
import { STARAI_ORIGIN, starAiError } from "./star-ai-session";

export const STARAI_WALLET_PATH = "/wallet";

export function isSafeTopUpUrl(address: string): boolean {
  if (address === "about:blank") return true;
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

let activeTopUpWindow: BrowserWindow | null = null;
let activeTopUpPromise: Promise<void> | null = null;

function guardTopUpWindow(
  win: BrowserWindow,
  partition: Session,
  backgroundColor: string,
  children: Set<BrowserWindow>,
) {
  const contents = win.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    if (!isSafeTopUpUrl(url)) return { action: "deny" };
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
          session: partition,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          devTools: false,
        },
      },
    };
  });
  contents.on("did-create-window", (child) => {
    children.add(child);
    child.once("closed", () => children.delete(child));
    guardTopUpWindow(child, partition, backgroundColor, children);
  });
  contents.on("will-navigate", (event) => {
    if (!isSafeTopUpUrl(event.url)) event.preventDefault();
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame && !isSafeTopUpUrl(event.url)) event.preventDefault();
  });
}

export function closeStarAiTopUp() {
  if (activeTopUpWindow && !activeTopUpWindow.isDestroyed()) {
    activeTopUpWindow.close();
  }
}

/** Open the signed-in StarAI wallet/recharge page in an isolated Electron window. */
export async function openStarAiTopUp(
  parent: BrowserWindow | null,
  partition: Session,
): Promise<void> {
  if (activeTopUpWindow && !activeTopUpWindow.isDestroyed()) {
    if (activeTopUpWindow.isMinimized()) activeTopUpWindow.restore();
    activeTopUpWindow.focus();
    return activeTopUpPromise ?? Promise.resolve();
  }
  const theme = await readStarAiLoginTheme(parent);
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
  guardTopUpWindow(win, partition, theme.background, children);
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  activeTopUpWindow = win;
  const promise = new Promise<void>((resolve, reject) => {
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
        activeTopUpPromise = null;
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
  activeTopUpPromise = promise;
  return promise;
}
