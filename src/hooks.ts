import { initLocale, getString } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { openPapersWindow } from "./modules/papersWindow";
import { autoSyncOnStartup, syncRecentDays } from "./modules/sync";
import { getPref } from "./utils/prefs";
import { isWindowAlive } from "./utils/window";

const MENU_ID = "hfdailypapers-menu";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPrefs();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

function registerPrefs() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    // Stable pane id so the menu can open this pane directly via
    // Zotero.Utilities.Internal.openPreferences (PreferencePanes has no
    // public open() method).
    id: addon.data.config.addonRef,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  registerMainMenu(win);

  // Auto sync runs quietly after a delay, only once per session.
  if (!addon.data.autoSyncStarted) {
    addon.data.autoSyncStarted = true;
    autoSyncOnStartup();
  }
}

function registerMainMenu(win: _ZoteroTypes.MainWindow) {
  // The startup hook and the bootstrap observer may both fire for the same
  // window; skip if our menu is already there.
  if (win.document.getElementById(MENU_ID)) {
    return;
  }
  const popup = win.document.getElementById("menu_ToolsPopup");
  if (!popup) {
    return;
  }
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`;
  ztoolkit.Menu.register(popup as XUL.MenuPopup, {
    tag: "menu",
    id: MENU_ID,
    label: getString("menu-root-label"),
    icon: menuIcon,
    children: [
      {
        tag: "menuitem",
        label: getString("menu-browse-label"),
        commandListener: () => openPapersWindow(),
      },
      {
        tag: "menuitem",
        label: getString("menu-sync-label", {
          args: { days: getPref("lookbackDays") },
        }),
        commandListener: () => {
          syncRecentDays()
            .then((summary) => {
              if (summary.skipped) {
                return; // a concurrent sync already showed a notification
              }
              new ztoolkit.ProgressWindow(addon.data.config.addonName)
                .createLine({
                  text: getString("sync-done", {
                    args: {
                      created: summary.created,
                      exists: summary.exists,
                    },
                  }),
                  type: "success",
                  progress: 100,
                })
                .show();
            })
            .catch((e) => {
              // The sync itself already showed a failure notification.
              ztoolkit.log("Manual sync failed", e);
            });
        },
      },
      { tag: "menuseparator" },
      {
        tag: "menuitem",
        label: getString("menu-prefs-label"),
        commandListener: () => {
          try {
            Zotero.Utilities.Internal.openPreferences(
              addon.data.config.addonRef,
            );
          } catch (e) {
            ztoolkit.log("Failed to open preference pane", e);
          }
        },
      },
    ],
  });
}

async function onMainWindowUnload(win: Window): Promise<void> {
  // Only remove this window's menu; ztoolkit registrations of other windows
  // must survive. unregisterAll() happens once, in onShutdown.
  win.document.getElementById(MENU_ID)?.remove();
  if (isWindowAlive(addon.data.papersWindow)) {
    addon.data.papersWindow!.close();
  }
}

function onShutdown(): void {
  ztoolkit.unregisterAll();
  if (isWindowAlive(addon.data.papersWindow)) {
    addon.data.papersWindow!.close();
  }
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
};
