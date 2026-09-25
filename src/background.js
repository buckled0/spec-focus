const GITHUB = /^https:\/\/github\.com\//;
const API = 'https://api.github.com';
const CONTENT_SCRIPTS = ['src/chunker.js', 'src/lines.js', 'src/github.js', 'src/content.js'];

chrome.action.onClicked.addListener(toggle);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-focus') toggle(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fullscreen' && sender.tab) {
    setFullscreen(sender.tab.windowId, message.on)
      .catch(() => {})
      .finally(() => sendResponse({}));
    return true;
  }
  if (message?.type === 'github') {
    github(message).then(sendResponse, (error) => sendResponse({ error: `Couldn't reach GitHub: ${error.message}` }));
    return true;
  }
  if (message?.type === 'options') chrome.runtime.openOptionsPage();
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
    await chrome.scripting.executeScript({ target, files: CONTENT_SCRIPTS });
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

// The token stays here and in storage; content scripts only see responses.
async function github({ path, method = 'GET', body }) {
  if (!path.startsWith('/')) throw new Error(`bad API path ${path}`);
  const { token } = await chrome.storage.local.get('token');
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
