const GITHUB = /^https:\/\/github\.com\//;

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-focus') toggle(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'fullscreen' || !sender.tab) return;
  setFullscreen(sender.tab.windowId, message.on)
    .catch(() => {})
    .finally(() => sendResponse({}));
  return true;
});

async function toggle(tab) {
  if (!tab?.id || !GITHUB.test(tab.url ?? '')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  } catch {
    // Tabs opened before the extension was installed (or reloaded) have no
    // live content script yet.
    const target = { tabId: tab.id };
    await chrome.scripting.insertCSS({ target, files: ['src/overlay.css'] });
    await chrome.scripting.executeScript({ target, files: ['src/chunker.js', 'src/content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'toggle' });
  }
}

// Remember the window's state before going full screen so leaving focus mode
// puts it back exactly, and never touch a window that was already full screen.
async function setFullscreen(windowId, on) {
  const key = `window:${windowId}`;
  if (on) {
    const win = await chrome.windows.get(windowId);
    if (win.state === 'fullscreen') return;
    await chrome.storage.session.set({ [key]: win.state });
    await chrome.windows.update(windowId, { state: 'fullscreen' });
  } else {
    const { [key]: previous } = await chrome.storage.session.get(key);
    if (!previous) return;
    await chrome.storage.session.remove(key);
    await chrome.windows.update(windowId, { state: previous });
  }
}
