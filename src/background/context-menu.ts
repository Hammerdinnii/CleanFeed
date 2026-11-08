import { api } from '../shared/api';
import { hostnameFromUrl } from '../shared/domain';
import { createLogger } from '../shared/log';
import { pauseFromMenu } from './pause';

/**
 * Context-menu entries. Menus persist across service-worker restarts, so they
 * are (re)created only on install/update; the click listener is registered on
 * every start.
 */
const log = createLogger('menu');
const MENU_PICK = 'cf-pick-element';
const MENU_PAUSE = 'cf-pause-site';
const MENU_OPTIONS = 'cf-options';

let listenerRegistered = false;

export function registerContextMenus(create: boolean): void {
  const menus = api.contextMenus;
  if (!menus) return;
  if (create) {
    menus.removeAll(() => {
      menus.create({ id: MENU_PICK, title: 'Hide an element on this page…', contexts: ['page', 'image', 'link', 'frame', 'video'] });
      menus.create({ id: MENU_PAUSE, title: 'Pause CleanFeed on this site for 30 minutes', contexts: ['page', 'action'] });
      menus.create({ id: MENU_OPTIONS, title: 'CleanFeed settings', contexts: ['action'] });
    });
  }
  if (listenerRegistered) return;
  listenerRegistered = true;
  menus.onClicked.addListener((info, tab) => {
    const tabId = tab?.id;
    if (info.menuItemId === MENU_OPTIONS) {
      void api.runtime.openOptionsPage();
      return;
    }
    if (tabId === undefined) return;
    if (info.menuItemId === MENU_PICK) {
      void api.scripting.executeScript({ target: { tabId }, files: ['picker.js'] }).catch((e) => log.warn(e));
    } else if (info.menuItemId === MENU_PAUSE) {
      const host = hostnameFromUrl(tab?.url);
      if (!host) return;
      void pauseFromMenu(host);
    }
  });
}
