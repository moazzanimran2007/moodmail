const DEFAULT_MODEL = 'gemini-3.8-flash';

const form = document.getElementById('keyForm');
const keyInput = document.getElementById('apiKey');
const saveButton = document.getElementById('saveKey');
const keyStatus = document.getElementById('keyStatus');
const modelSelect = document.getElementById('model');

function showStatus(message, kind = '') {
  keyStatus.textContent = message;
  keyStatus.className = `status ${kind}`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiKey = keyInput.value.trim();

  if (!apiKey) {
    await chrome.storage.local.remove('geminiApiKey');
    showStatus('Key removed.');
    return;
  }

  saveButton.disabled = true;
  showStatus('Checking your key…');
  const result = await chrome.runtime.sendMessage({ type: 'test-key', apiKey });
  saveButton.disabled = false;

  // A network or busy error says nothing about the key, so only a rejection blocks saving.
  if (!result.ok && result.code === 'key') {
    showStatus(result.message, 'bad');
    return;
  }
  await chrome.storage.local.set({ geminiApiKey: apiKey });
  keyInput.value = '';
  keyInput.placeholder = 'Key saved. Paste a new one to replace it.';
  if (result.ok) showStatus('Connected. Open a draft in your email and start typing.', 'good');
  else showStatus(`Key saved, but it could not be checked: ${result.message}`, 'bad');
});

modelSelect.addEventListener('change', () => {
  chrome.storage.local.set({ geminiModel: modelSelect.value });
});

chrome.storage.local.get(['geminiApiKey', 'geminiModel']).then(({ geminiApiKey, geminiModel = DEFAULT_MODEL }) => {
  modelSelect.value = geminiModel;
  if (geminiApiKey) keyInput.placeholder = 'Key saved. Paste a new one to replace it.';
});
