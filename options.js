const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

const form = document.getElementById('keyForm');
const keyInput = document.getElementById('apiKey');
const saveButton = document.getElementById('saveKey');
const keyStatus = document.getElementById('keyStatus');
const modelSelect = document.getElementById('model');
const formsSwitch = document.getElementById('forms');
const instructionsBox = document.getElementById('instructions');
const notesBox = document.getElementById('notes');
const pageContextSwitch = document.getElementById('pageContext');
const notesStatus = document.getElementById('notesStatus');
let saveTimer = null;

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

formsSwitch.addEventListener('change', () => {
  chrome.storage.sync.set({ forms: formsSwitch.checked });
});

chrome.storage.sync.get({ forms: true, pageContext: true }).then(({ forms, pageContext }) => {
  formsSwitch.checked = forms;
  pageContextSwitch.checked = pageContext;
});

// Notes are personal, so they stay in this device's storage rather than syncing.
function saveNotes() {
  clearTimeout(saveTimer);
  notesStatus.textContent = '';
  saveTimer = setTimeout(async () => {
    await chrome.storage.local.set({ instructions: instructionsBox.value, notes: notesBox.value });
    notesStatus.textContent = 'Saved.';
    notesStatus.className = 'status good';
  }, 400);
}
instructionsBox.addEventListener('input', saveNotes);
notesBox.addEventListener('input', saveNotes);

pageContextSwitch.addEventListener('change', () => {
  chrome.storage.sync.set({ pageContext: pageContextSwitch.checked });
});

chrome.storage.local.get({ instructions: '', notes: '' }).then(({ instructions, notes }) => {
  instructionsBox.value = instructions;
  notesBox.value = notes;
});

chrome.storage.local.get(['geminiApiKey', 'geminiModel']).then(({ geminiApiKey, geminiModel = DEFAULT_MODEL }) => {
  modelSelect.value = geminiModel;
  if (geminiApiKey) keyInput.placeholder = 'Key saved. Paste a new one to replace it.';
});

// ---- Documents ----

const OFFICE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'xml', 'html', 'htm']);
const MAX_DOCUMENTS = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const DOCUMENT_TEXT_MAX = 20_000;

const docInput = document.getElementById('docInput');
const docAdd = document.getElementById('docAdd');
const docList = document.getElementById('docList');
const docStatus = document.getElementById('docStatus');

function showDocStatus(message, kind = '') {
  docStatus.textContent = message;
  docStatus.className = `status ${kind}`;
}

function make(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const tidy = (text) =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function readFile(file) {
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is over 10 MB.`);
  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = await file.text();
    if (extension !== 'html' && extension !== 'htm') return raw;
    // Parsing into a detached document runs no scripts and loads nothing. Their code isn't text, so it goes.
    const page = new DOMParser().parseFromString(raw, 'text/html');
    page.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove());
    return page.body?.textContent || '';
  }
  const mimeType = OFFICE_TYPES[extension];
  if (!mimeType) throw new Error(`MoodMail can't read ${file.name}. Add a PDF, Word, PowerPoint, Excel or text file.`);
  showDocStatus(`Gemini is reading ${file.name}…`);
  const result = await chrome.runtime.sendMessage({ type: 'read-document', mimeType, data: toBase64(await file.arrayBuffer()) });
  if (!result.ok) throw new Error(result.message);
  return result.text;
}

const loadDocuments = async () => (await chrome.storage.local.get({ documents: [] })).documents;

async function saveDocuments(documents) {
  await chrome.storage.local.set({ documents });
  // Pages only need the count to offer the switch on the card. The text stays in this device's storage.
  await chrome.storage.sync.set({ documentCount: documents.filter((doc) => doc.on).length });
  renderDocuments(documents);
}

async function changeDocument(id, change) {
  const documents = await loadDocuments();
  await saveDocuments(change(documents, documents.find((doc) => doc.id === id)));
}

function renderDocuments(documents) {
  docList.replaceChildren(
    ...documents.map((doc) => {
      const use = make('input', { type: 'checkbox', checked: doc.on });
      use.setAttribute('aria-label', `Use ${doc.name}`);
      use.addEventListener('change', () =>
        changeDocument(doc.id, (all, found) => {
          found.on = use.checked;
          return all;
        }),
      );
      const remove = make('button', { type: 'button', className: 'link', textContent: 'Remove' });
      remove.addEventListener('click', async () => {
        await changeDocument(doc.id, (all) => all.filter((other) => other.id !== doc.id));
        showDocStatus(`Removed ${doc.name}.`);
      });
      const size = `${doc.text.length.toLocaleString()} characters${doc.shortened ? ', shortened to fit' : ''}`;
      return make(
        'li',
        {},
        make('div', { className: 'doc-head' }, make('span', { className: 'doc-name', textContent: doc.name }), make('label', { className: 'switch' }, use, make('span'))),
        make('p', { className: 'hint' }, `${size} · `, remove),
        make('details', {}, make('summary', { textContent: 'See the text MoodMail will use' }), make('pre', { textContent: doc.text })),
      );
    }),
  );
  docAdd.disabled = documents.length >= MAX_DOCUMENTS;
}

docAdd.addEventListener('click', () => docInput.click());

docInput.addEventListener('change', async () => {
  const files = [...docInput.files];
  docInput.value = '';
  docAdd.disabled = true;
  let documents = await loadDocuments();
  for (const file of files) {
    if (documents.length >= MAX_DOCUMENTS) {
      showDocStatus(`You can add up to ${MAX_DOCUMENTS} documents. Remove one to add another.`, 'bad');
      break;
    }
    try {
      showDocStatus(`Reading ${file.name}…`);
      const text = tidy(await readFile(file));
      if (!text) throw new Error(`No readable text found in ${file.name}.`);
      const doc = { id: crypto.randomUUID(), name: file.name, text: text.slice(0, DOCUMENT_TEXT_MAX), shortened: text.length > DOCUMENT_TEXT_MAX, on: true };
      documents = [...documents, doc];
      await saveDocuments(documents);
      showDocStatus(`Added ${file.name}.`, 'good');
    } catch (err) {
      showDocStatus(err.message, 'bad');
    }
  }
  renderDocuments(documents);
});

loadDocuments().then(renderDocuments);
