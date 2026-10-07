const MANAGER_PATH = 'src/manager.html';
const MENU_LINK = 'accelerator-download-link';
const MENU_PAGE = 'accelerator-download-page';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: 'Download this link with Download Accelerator',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'Download current page with Download Accelerator',
      contexts: ['page'],
    });
  });
});

/** 打开管理页，已打开则聚焦，避免每次右键都新开标签页 */
async function openManager() {
  const url = chrome.runtime.getURL(MANAGER_PATH);
  const { managerTabId } = await chrome.storage.session.get('managerTabId');

  if (typeof managerTabId === 'number') {
    try {
      const tab = await chrome.tabs.update(managerTabId, { active: true });
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return;
    } catch {
      // 标签页已被关闭，走下面的新建流程
    }
  }

  const tab = await chrome.tabs.create({ url });
  await chrome.storage.session.set({ managerTabId: tab.id });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { managerTabId } = await chrome.storage.session.get('managerTabId');
  if (tabId === managerTabId) await chrome.storage.session.remove('managerTabId');
});

chrome.action.onClicked.addListener(() => {
  openManager();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const target = info.menuItemId === MENU_LINK ? info.linkUrl : info.pageUrl;
  if (!target || !/^https?:\/\//i.test(target)) return;

  const { pendingUrls } = await chrome.storage.local.get('pendingUrls');
  await chrome.storage.local.set({ pendingUrls: [...(pendingUrls || []), target] });
  await openManager();
});