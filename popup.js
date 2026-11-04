const enabled = document.getElementById('enabled');
const autoAsk = document.getElementById('autoAsk');
const improve = document.getElementById('improve');
const status = document.getElementById('status');

function refresh() {
  autoAsk.disabled = !enabled.checked;
  improve.disabled = !enabled.checked;
}

function openSettings() {
  chrome.runtime.openOptionsPage();
  window.close();
}

enabled.addEventListener('change', () => {
  chrome.storage.sync.set({ enabled: enabled.checked });
  status.textContent = '';
  refresh();
});

autoAsk.addEventListener('change', () => {
  chrome.storage.sync.set({ autoAsk: autoAsk.checked });
});

improve.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tab.id, { type: 'open-moods' });
  } catch {
    reply = null;
  }
  if (reply?.ok) {
    window.close();
  } else if (reply?.reason === 'no-editor') {
    status.textContent = 'Open a new email or a reply first.';
  } else {
    status.textContent = 'Open Gmail, Outlook or Yahoo Mail in this tab. If it is already open, reload the page.';
  }
});

document.getElementById('settings').addEventListener('click', openSettings);
document.getElementById('addKey').addEventListener('click', openSettings);

chrome.storage.sync.get({ enabled: true, autoAsk: true }).then((saved) => {
  enabled.checked = saved.enabled;
  autoAsk.checked = saved.autoAsk;
  refresh();
});

chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => {
  document.getElementById('keyNotice').hidden = Boolean(geminiApiKey);
});

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((command) => command.name === 'open-moods')?.shortcut;
  document.getElementById('shortcut').textContent = shortcut ? `Shortcut: ${shortcut}` : '';
});
