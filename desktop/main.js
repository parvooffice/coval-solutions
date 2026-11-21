// COVAL for Windows: the COVAL web app in its own window, plus what a browser tab can't do:
// Windows notifications, a tray icon that keeps running in the background, scoring folders
// on this computer with the bundled engine, automatic updates, and the `coval` command.
"use strict";

const path = require("node:path");
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const agents = require("./lib/agents.js");

const APP_URL = (process.env.COVAL_URL || "https://coval-solutions-w92u.vercel.app").replace(/\/$/, "");
const APP_ORIGIN = new URL(APP_URL).origin;
// Sign-in goes through GitHub and Supabase inside the window, then returns to COVAL.
const SIGN_IN_HOSTS = [/^github\.com$/, /\.supabase\.co$/];
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ICON = path.join(__dirname, "build", "icon.png");
const TRAY_ICON = path.join(__dirname, "build", "tray.png");

let win = null;
let tray = null;
let quitting = false;
let unread = 0;
let trayHintShown = false;

// Packaged: resources\bin\coval-engine.exe. Developing: desktop\resources (after `npm run prepare-app`).
function engine() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "resources");
  return agents.findEngine(base);
}

function allowedInWindow(url) {
  try {
    const target = new URL(url);
    return target.origin === APP_ORIGIN || (target.protocol === "https:" && SIGN_IN_HOSTS.some((host) => host.test(target.hostname)));
  } catch {
    return false;
  }
}

// Only the COVAL web app (not GitHub or another site in the window) may use the bridge.
function fromCoval(event) {
  try {
    return new URL(event.senderFrame.url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function show(route) {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) win.webContents.send("coval:navigate", String(route));
}

function toast(title, body, route) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, icon: ICON });
  notification.on("click", () => show(route));
  notification.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 420,
    minHeight: 560,
    title: "COVAL",
    backgroundColor: "#09090b",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Keep checking for notifications while COVAL is hidden in the tray.
      backgroundThrottling: false,
    },
  });
  win.loadURL(`${APP_URL}/dashboard`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (allowedInWindow(url)) win.loadURL(url);
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (allowedInWindow(url)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !url.startsWith(APP_ORIGIN)) return; // -3: navigation replaced
    win.loadFile(path.join(__dirname, "offline.html"), { query: { retry: `${APP_URL}/dashboard` } });
  });
  // Closing the window keeps COVAL running in the tray so notifications still arrive.
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      toast("COVAL is still running", "It's in the system tray, so notifications keep coming. Right-click the tray icon to quit.");
    }
  });
  win.on("closed", () => { win = null; });
}

async function scanFolder(folder) {
  let target = folder;
  if (!target) {
    const options = { title: "Choose a project folder to score", properties: ["openDirectory"] };
    const picked = win && win.isVisible() ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (picked.canceled || !picked.filePaths[0]) return null;
    target = picked.filePaths[0];
  }
  const runner = engine();
  if (!runner) throw new Error("The COVAL engine is missing. Reinstall COVAL.");
  const result = await agents.scanWorkspace({ engine: runner, workspace: target, enabled: [] });
  const failures = result.results.filter((item) => item.error).length;
  const findings = result.results.reduce((sum, item) => sum + item.findings.length, 0);
  toast(
    `${path.basename(target)} scored ${result.overall ?? "—"}`,
    failures ? `${failures} agent(s) could not run.` : `${findings} things to fix. Open COVAL to see them.`,
    "code-evaluation",
  );
  return result;
}

function scanFromTray() {
  scanFolder()
    .then((result) => {
      if (!result) return;
      show("code-evaluation");
      win.webContents.send("coval:scan-result", result);
    })
    .catch((error) => dialog.showErrorBox("COVAL", error.message));
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(unread ? `COVAL: ${unread} new notification${unread === 1 ? "" : "s"}` : "COVAL");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: unread ? `Open COVAL (${unread} new)` : "Open COVAL", click: () => show() },
    { label: "Score a folder on this computer…", click: scanFromTray },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
        updateTray();
      },
    },
    { label: "Check for updates", enabled: app.isPackaged, click: () => autoUpdater.checkForUpdates().catch(() => {}) },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: "Quit COVAL", click: () => { quitting = true; app.quit(); } },
  ]));
}

function setupUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", (info) => {
    const notification = new Notification({ title: `COVAL ${info.version} is ready`, body: "Click to restart and update now, or it installs the next time you quit.", icon: ICON });
    notification.on("click", () => { quitting = true; autoUpdater.quitAndInstall(); });
    notification.show();
  });
  autoUpdater.on("error", () => {}); // offline, or no release published yet: try again later
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_INTERVAL_MS);
}

function registerIpc() {
  ipcMain.handle("coval:notify", (event, payload) => {
    if (!fromCoval(event) || !payload || typeof payload.title !== "string") return false;
    const route = typeof payload.route === "string" ? payload.route.slice(0, 120) : undefined;
    toast(payload.title.slice(0, 120), String(payload.body || "").slice(0, 300), route);
    return true;
  });
  ipcMain.on("coval:unread", (event, count) => {
    if (!fromCoval(event)) return;
    unread = Math.max(0, Math.min(999, Number(count) || 0));
    updateTray();
  });
  ipcMain.handle("coval:scan-folder", (event) => (fromCoval(event) ? scanFolder() : null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => show());
  app.setAppUserModelId("com.coval.desktop"); // Windows needs this to show notifications
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    if (process.argv.includes("--hidden")) win.hide();
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
    tray.on("click", () => show());
    updateTray();
    setupUpdates();
  });
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => {}); // keep running in the tray
}
