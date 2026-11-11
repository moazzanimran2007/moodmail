const enabled = document.getElementById('enabled');
const autoAsk = document.getElementById('autoAsk');
const improve = document.getElementById('improve');
const status = document.getElementById('status');
const siteRow = document.getElementById('siteRow');
const siteOn = document.getElementById('siteOn');
let site = null;

function refresh() {
  autoAsk.disabled = !enabled.checked;
  siteOn.disabled = !enabled.checked;
  improve.disabled = !enabled.checked || (site !== null && !siteOn.checked);
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

siteOn.addEventListener('change', async () => {
  const { offSites } = await chrome.storage.sync.get({ offSites: [] });
  const others = offSites.filter((off) => off !== site);
  chrome.storage.sync.set({ offSites: siteOn.checked ? others : [...others, site] });
  status.textContent = '';
  refresh();
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
    status.textContent = 'Click into an email or a text box first.';
  } else if (reply?.reason === 'off') {
    status.textContent = 'MoodMail is off for this site.';
  } else {
    status.textContent = "MoodMail can't run on this page. If it was already open, reload it.";
  }
});

document.getElementById('settings').addEventListener('click', openSettings);
document.getElementById('addKey').addEventListener('click', openSettings);

async function askPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? chrome.tabs.sendMessage(tab.id, { type: 'site' }).catch(() => null) : null;
}

Promise.all([chrome.storage.sync.get({ enabled: true, autoAsk: true, forms: true, offSites: [] }), askPage()]).then(([saved, page]) => {
  enabled.checked = saved.enabled;
  autoAsk.checked = saved.autoAsk;
  if (page?.site && (page.mail || saved.forms)) {
    site = page.site;
    siteOn.checked = !saved.offSites.includes(site);
    document.getElementById('siteLabel').textContent = `Use on ${site}`;
    siteRow.hidden = false;
  }
  refresh();
});

chrome.storage.local.get('geminiApiKey').then(({ geminiApiKey }) => {
  document.getElementById('keyNotice').hidden = Boolean(geminiApiKey);
});

chrome.commands.getAll().then((commands) => {
  const shortcut = commands.find((command) => command.name === 'open-moods')?.shortcut;
  document.getElementById('shortcut').textContent = shortcut ? `Shortcut: ${shortcut}` : '';
});
