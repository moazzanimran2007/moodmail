// MoodMail content script. It finds the compose box, asks for a mood, and swaps in the rewrite.
(() => {
  'use strict';

  const MOODS = [
    { label: 'Professional', direction: 'polished, respectful and businesslike, clear without sounding stiff' },
    { label: 'Friendly', direction: 'warm and approachable, like a helpful colleague' },
    { label: 'Confident', direction: 'assured and decisive, with hedges like "I think" and "just" removed' },
    { label: 'Persuasive', direction: 'makes a compelling case, leading with what the reader gains and ending on a clear ask' },
    { label: 'Apologetic', direction: 'sincere and owning the problem, without excuses or grovelling' },
    { label: 'Grateful', direction: 'genuinely thankful and specific about what is appreciated' },
    { label: 'Urgent', direction: 'time-sensitive and action-oriented, polite but pressing, without inventing a deadline' },
    { label: 'Casual', direction: 'relaxed and conversational, with contractions and short sentences' },
    { label: 'Firm', direction: 'direct and unambiguous about expectations or boundaries, while staying civil' },
  ];
  const GRAMMAR_ONLY = { label: 'Grammar only', grammarOnly: true };

  const PAUSE_MS = 3000;
  const MIN_WORDS = 5;
  const TALL_ENOUGH_PX = 60;

  // Signatures and quoted threads stay as they are and are never sent to Gemini.
  const PROTECTED = [
    '.gmail_signature',
    '.gmail_signature_prefix',
    '[data-smartmail="gmail_signature"]',
    '.gmail_quote',
    '.gmail_quote_container',
    '.gmail_extra',
    '#Signature',
    '[id^="Signature"]',
    '#ms-outlook-mobile-signature',
    '#appendonsend',
    '#divRplyFwdMsg',
    '#x_divRplyFwdMsg',
    '#mail-editor-reference-message-container',
    '.signature',
    '[class*="yahoo_quoted"]',
    '[id*="yahoo_quoted"]',
    'blockquote[type="cite"]',
    'hr',
  ].join(',');

  // Things Gemini cannot rewrite travel as ⟦n⟧ tokens and come back untouched.
  const ATOMIC = 'img,table,svg,video,.gmail_chip,[contenteditable="false"]';
  // Webmail classes that carry the writer's default text style.
  const KEPT_CLASSES = /\b(?:gmail_default|elementToProof)\b/;
  const BLOCK = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DIV', 'FOOTER', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HEADER', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION',
  ]);

  let settings = { enabled: true, autoAsk: true };
  let activeEditor = null; // the compose box the launcher sits on
  let target = null; // the compose box the card is talking about
  let view = null; // what the card is showing, or null when it is closed
  let currentJob = 0;
  let applying = false; // true while MoodMail itself is changing the draft
  let placer = null;
  let ui = null;
  const drafts = new WeakMap();

  const stateOf = (editor) => {
    if (!drafts.has(editor)) drafts.set(editor, { asked: false, timer: null });
    return drafts.get(editor);
  };

  // ---- Finding the compose box ----

  function isTall(el) {
    return el.getBoundingClientRect().height >= TALL_ENOUGH_PX;
  }

  function findEditor(node) {
    if (!(node instanceof Element)) return null;
    if (node.tagName === 'TEXTAREA') return isTall(node) ? node : null;
    const editor = node.closest('[contenteditable="true"],[contenteditable=""],[contenteditable="plaintext-only"]');
    if (!editor) return null;
    return editor.matches('[g_editable="true"],[aria-label*="body" i]') || isTall(editor) ? editor : null;
  }

  function findAnyEditor() {
    const focused = findEditor(document.activeElement);
    if (focused) return focused;
    if (activeEditor?.isConnected) return activeEditor;
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('[contenteditable="true"],[contenteditable=""],textarea')) {
      const editor = findEditor(el);
      if (!editor) continue;
      const { width, height } = editor.getBoundingClientRect();
      if (width * height > bestArea) {
        best = editor;
        bestArea = width * height;
      }
    }
    return best;
  }

  // ---- Reading the draft ----

  // The writer's text is the first stretch of the editor, outside any signature or quote, that
  // has words in it. That covers replying above or below the quoted thread.
  function draftRange(editor) {
    const guards = [...editor.querySelectorAll(PROTECTED)].filter((el) => !el.parentElement.closest(PROTECTED));
    let first = null;
    for (let i = 0; i <= guards.length; i++) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (i > 0) range.setStartAfter(guards[i - 1]);
      if (i < guards.length) range.setEndBefore(guards[i]);
      const stretch = { range, beforeGuard: i < guards.length, guarded: guards.length > 0 };
      first ??= stretch;
      if (range.toString().trim()) return stretch;
    }
    return first;
  }

  function toMarkup(fragment) {
    const draft = { images: [], hasBold: false, hasItalic: false, hasLists: false };
    let out = '';
    const newline = () => {
      if (out && !out.endsWith('\n')) out += '\n';
    };
    const walkChildren = (node) => node.childNodes.forEach(walk);

    const wrap = (node, mark) => {
      const start = out.length;
      out += mark;
      walkChildren(node);
      const inner = out.slice(start + mark.length);
      if (inner.trim()) {
        out += mark;
        return true;
      }
      out = out.slice(0, start) + inner;
      return false;
    };

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        out += node.nodeValue.replace(/[​﻿]/g, '').replace(/ /g, ' ').replace(/\s*[\r\n\t]+\s*/g, ' ');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName;
      if (node.matches(ATOMIC)) {
        draft.images.push(node.outerHTML);
        out += `⟦${draft.images.length}⟧`;
      } else if (tag === 'BR') {
        out += '\n';
      } else if (tag === 'A') {
        const label = node.textContent.trim();
        const href = node.getAttribute('href') || '';
        if (!label) walkChildren(node);
        else if (!/^(https?:|mailto:)/i.test(href) || href === label || href === `mailto:${label}`) out += label;
        else out += `[${label}](${href})`;
      } else if (tag === 'UL' || tag === 'OL') {
        draft.hasLists = true;
        newline();
        let number = 0;
        for (const item of node.children) {
          number += 1;
          out += tag === 'UL' ? '- ' : `${number}. `;
          walkChildren(item);
          newline();
        }
      } else if (BLOCK.has(tag)) {
        newline();
        walkChildren(node);
        newline();
        if (tag === 'P') out += '\n';
      } else if (tag === 'B' || tag === 'STRONG' || ['bold', '600', '700', '800', '900'].includes(node.style?.fontWeight)) {
        if (wrap(node, '**')) draft.hasBold = true;
      } else if (tag === 'I' || tag === 'EM' || node.style?.fontStyle === 'italic') {
        if (wrap(node, '*')) draft.hasItalic = true;
      } else {
        walkChildren(node);
      }
    }

    walkChildren(fragment);
    draft.text = out
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return draft;
  }

  // The look of the writer's text, so the rewrite keeps their font, color and text direction.
  function blockAttributes(fragment) {
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !text.nodeValue.trim()) text = walker.nextNode();

    const style = {};
    let dir = '';
    let kept = '';
    for (let el = text?.parentElement; el; el = el.parentElement) {
      if (el.tagName === 'A') continue;
      const isFont = el.tagName === 'FONT';
      dir ||= el.getAttribute('dir') || '';
      kept ||= el.getAttribute('class')?.match(KEPT_CLASSES)?.[0] || '';
      style['font-family'] ||= el.style.fontFamily || (isFont && el.getAttribute('face')) || '';
      style['font-size'] ||= el.style.fontSize;
      style.color ||= el.style.color || (isFont && el.getAttribute('color')) || '';
    }
    const css = Object.entries(style)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}:${value}`)
      .join(';');
    return [kept && ['class', kept], dir && ['dir', dir], css && ['style', css]]
      .filter(Boolean)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
  }

  function readDraft(editor) {
    if (editor.tagName === 'TEXTAREA') {
      return { text: editor.value.trim(), original: editor.value, images: [] };
    }
    const { range, beforeGuard } = draftRange(editor);
    const fragment = range.cloneContents();
    const draft = toMarkup(fragment);
    draft.blockAttrs = blockAttributes(fragment);
    const box = document.createElement('div');
    box.append(fragment);
    draft.html = box.innerHTML;
    draft.beforeGuard = beforeGuard;
    return draft;
  }

  // ---- Writing the draft back ----

  const escapeHtml = (text) =>
    text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function inlineHtml(line, draft) {
    const held = [];
    const hold = (html) => {
      held.push(html);
      return `${held.length - 1}`;
    };
    const anchor = (url, label) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
    let text = line
      .replace(/⟦(\d+)⟧/g, (_, n) => hold(draft.images[n - 1] ?? ''))
      .replace(/\[([^\]]+)\]\(((?:https?:|mailto:)[^)\s]+)\)/g, (_, label, url) => hold(anchor(url, label)))
      .replace(/https?:\/\/[^\s]+/g, (url) => {
        const bare = url.replace(/[.,;:!?)]+$/, '');
        return hold(anchor(bare, bare)) + url.slice(bare.length);
      });
    text = escapeHtml(text);
    if (draft.hasBold) text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    if (draft.hasItalic) text = text.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>');
    return text.replace(/(\d+)/g, (_, i) => held[i]);
  }

  function markupToHtml(text, draft) {
    const LIST_ITEM = /^\s*(?:([-*•])|\d+[.)])\s+(.*)$/;
    const isItem = (line) => draft.hasLists && LIST_ITEM.test(line ?? '');
    const lines = text.split('\n');
    let html = '';
    let list = null;
    for (const [index, line] of lines.entries()) {
      // Lists carry their own margins, so a blank line beside one would double the gap.
      if (!line.trim() && (isItem(lines[index - 1]) || isItem(lines[index + 1]))) continue;
      const item = isItem(line) ? line.match(LIST_ITEM) : null;
      const wanted = item ? (item[1] ? 'ul' : 'ol') : null;
      if (list && list !== wanted) {
        html += `</${list}>`;
        list = null;
      }
      if (wanted && !list) {
        html += `<${wanted}>`;
        list = wanted;
      }
      const attrs = draft.blockAttrs || '';
      if (item) html += `<li${attrs}>${inlineHtml(item[2], draft)}</li>`;
      else html += `<div${attrs}>${line.trim() ? inlineHtml(line, draft) : '<br>'}</div>`;
    }
    if (list) html += `</${list}>`;
    return html;
  }

  // Chrome's insert command merges inline content beside the selection into the new text, which
  // would turn Gmail's signature marker into ordinary draft text. A block of its own gives the
  // draft nothing to merge with.
  function isolateDraft(editor, range) {
    const atEnd = (node, offset) => offset === (node.nodeType === Node.TEXT_NODE ? node.length : node.childNodes.length);
    // Step out of containers the range only touches at an edge, so none are left behind empty.
    while (range.endOffset === 0 && range.endContainer !== editor) range.setEndBefore(range.endContainer);
    while (atEnd(range.startContainer, range.startOffset) && range.startContainer !== editor) {
      range.setStartAfter(range.startContainer);
    }

    let box = null;
    if (range.startContainer === range.endContainer && range.endOffset - range.startOffset === 1) {
      const only = range.startContainer.childNodes[range.startOffset];
      if (only?.nodeType === Node.ELEMENT_NODE && BLOCK.has(only.tagName)) box = only;
    }
    if (!box) {
      box = document.createElement('div');
      box.append(range.extractContents());
      range.insertNode(box);
    }
    const inner = document.createRange();
    inner.selectNodeContents(box);
    return inner;
  }

  // execCommand keeps the browser's own undo stack and fires the input events webmail apps
  // listen to, so Ctrl+Z keeps working and the app saves the new draft.
  function putHtml(editor, html) {
    editor.focus();
    const stretch = draftRange(editor);
    const range = stretch.guarded ? isolateDraft(editor, stretch.range) : stretch.range;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    if (document.execCommand('insertHTML', false, html)) return;
    range.deleteContents();
    range.insertNode(range.createContextualFragment(html));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText' }));
  }

  function putText(editor, text) {
    editor.focus();
    editor.select();
    if (document.execCommand('insertText', false, text)) return;
    editor.value = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Swapping the text moves the selection into the editor. Anyone typing somewhere else by then,
  // such as in the subject line, keeps their place.
  function changeDraft(editor, work) {
    const focused = document.activeElement;
    const selection = window.getSelection();
    const caret = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    applying = true;
    try {
      work();
    } finally {
      applying = false;
    }
    if (!focused || focused === editor) return;
    focused.focus();
    if (caret && focused.contains(caret.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(caret);
    }
  }

  function writeDraft(editor, draft, rewritten) {
    changeDraft(editor, () => {
      if (editor.tagName === 'TEXTAREA') putText(editor, rewritten);
      else putHtml(editor, markupToHtml(rewritten, draft) + (draft.beforeGuard ? '<div><br></div>' : ''));
    });
  }

  function restoreDraft(editor, draft) {
    changeDraft(editor, () => {
      if (editor.tagName === 'TEXTAREA') putText(editor, draft.original);
      else putHtml(editor, draft.html);
    });
  }

  // A token Gemini dropped still belongs in the email, so it goes back at the end.
  function keepTokens(text, draft) {
    let result = text;
    draft.images.forEach((_, i) => {
      if (!result.includes(`⟦${i + 1}⟧`)) result += `\n\n⟦${i + 1}⟧`;
    });
    return result;
  }

  const DETAIL = /https?:\/\/[^\s)\]]+|[\w.+-]+@[\w-]+\.\w[\w.-]*|[$€£]?\d[\d,.:/-]*(?:\s?(?:am|pm|%))?/gi;

  function detailsIn(text) {
    const found = text.replace(/⟦\d+⟧/g, '').match(DETAIL) || [];
    return new Set(found.map((d) => d.replace(/[\s.,:;/-]+$/, '').replace(/\s+/g, '').toLowerCase()));
  }

  // Numbers, links and addresses that differ between the draft and the rewrite are worth a look.
  function changedDetails(before, after) {
    const squash = (text) => text.toLowerCase().replace(/\s+/g, '');
    const a = squash(before);
    const b = squash(after);
    return [
      ...[...detailsIn(before)].filter((d) => !b.includes(d)),
      ...[...detailsIn(after)].filter((d) => !a.includes(d)),
    ];
  }

  // ---- Rewriting ----

  async function requestRewrite(text, mood) {
    try {
      return await chrome.runtime.sendMessage({ type: 'improve', text, mood });
    } catch {
      return { ok: false, code: 'stale', message: 'MoodMail was updated. Reload this page and try again.' };
    }
  }

  async function run(editor, mood, source = readDraft(editor)) {
    stateOf(editor).asked = true;
    clearTimeout(stateOf(editor).timer);
    if (!source.text) {
      showNote(editor, 'Nothing to improve yet. Type your email first.');
      return;
    }

    const before = readDraft(editor).text;
    const job = ++currentJob;
    showWorking(editor, mood);
    const result = await requestRewrite(source.text, mood);

    if (job !== currentJob) return;
    if (!editor.isConnected) {
      closeCard();
    } else if (!result.ok) {
      showError(editor, result, () => run(editor, mood, source));
    } else if (readDraft(editor).text !== before) {
      showChanged(editor, mood);
    } else if (result.text === source.text && before === source.text) {
      showNote(editor, 'This already reads well, so nothing changed.');
    } else {
      const rewritten = keepTokens(result.text, source);
      writeDraft(editor, source, rewritten);
      showDone(editor, mood, source, changedDetails(source.text, rewritten));
    }
  }

  // ---- The floating UI ----

  const CSS = `
    :host {
      --surface: #ffffff; --text: #1c2321; --muted: #5b6663; --line: #dbe2e0; --hover: #eff4f3;
      --accent: #0f766e; --accent-hover: #0c5f58; --on-accent: #ffffff; --warn-text: #7a4f00; --warn-bg: #fff4d6;
      --danger: #b3261e; --shadow: 0 8px 28px rgba(15, 30, 28, .18), 0 1px 3px rgba(15, 30, 28, .12);
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --surface: #22282a; --text: #eef2f1; --muted: #a6b1ae; --line: #3b4446; --hover: #2d3537;
        --accent: #2dd4bf; --accent-hover: #5eead4; --on-accent: #06211e; --warn-text: #f2c661; --warn-bg: #3a2f12;
        --danger: #f2a39d; --shadow: 0 8px 28px rgba(0, 0, 0, .5), 0 1px 3px rgba(0, 0, 0, .4);
      }
    }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .launcher, .card {
      color-scheme: light dark;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }
    button, input { font: inherit; color: inherit; }
    button { cursor: pointer; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    .launcher {
      position: fixed; width: 30px; height: 30px; padding: 0; border: 0; border-radius: 50%;
      display: grid; place-items: center; background: var(--accent); color: var(--on-accent);
      box-shadow: 0 2px 8px rgba(15, 30, 28, .3); pointer-events: auto; transition: transform .12s ease, background .12s ease;
    }
    .launcher:hover { background: var(--accent-hover); transform: scale(1.08); }
    .launcher svg { width: 16px; height: 16px; }

    .card {
      position: fixed; width: 312px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow: auto;
      padding: 14px; border: 1px solid var(--line); border-radius: 14px;
      background: var(--surface); color: var(--text); box-shadow: var(--shadow); pointer-events: auto;
      animation: rise .14s ease-out;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } }
    @media (prefers-reduced-motion: reduce) { .card { animation: none; } .launcher { transition: none; } }

    .head { display: flex; align-items: center; gap: 8px; }
    .title { flex: 1; min-width: 0; margin: 0; font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .close {
      flex: none; width: 24px; height: 24px; margin: -3px -4px -3px 0; padding: 0; border: 0; border-radius: 6px;
      display: grid; place-items: center; background: none; color: var(--muted);
    }
    .close:hover { background: var(--hover); color: var(--text); }
    .close svg { width: 14px; height: 14px; }

    .moods { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 12px; }
    .chip {
      min-height: 34px; padding: 0 2px; border: 1px solid var(--line); border-radius: 9px; background: none;
      font-size: 12.5px; transition: background .1s ease, border-color .1s ease, color .1s ease;
    }
    .chip:hover { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }

    .custom { display: flex; gap: 6px; margin-top: 8px; }
    .custom input {
      flex: 1; min-width: 0; height: 34px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px;
      background: none; font-size: 12.5px;
    }
    .custom input::placeholder { color: var(--muted); }
    .custom input:focus { outline: none; border-color: var(--accent); }
    .go {
      flex: none; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px;
      display: grid; place-items: center; background: var(--accent); color: var(--on-accent);
    }
    .go:hover { background: var(--accent-hover); }
    .go:disabled { opacity: .4; cursor: default; }
    .go svg { width: 15px; height: 15px; }

    .text-button { padding: 2px 0; border: 0; background: none; color: var(--accent); font-size: 12.5px; font-weight: 500; }
    .text-button:hover { text-decoration: underline; }
    .plain { display: block; margin: 8px auto 0; }

    .body { margin: 6px 0 0; color: var(--muted); }
    .check { flex: none; width: 16px; height: 16px; color: var(--accent); }
    .warning { margin: 10px 0 0; padding: 7px 9px; border-radius: 8px; background: var(--warn-bg); color: var(--warn-text); font-size: 12px; }
    .actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
    .action {
      height: 30px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: none; font-size: 12.5px; font-weight: 500;
    }
    .action:hover { background: var(--hover); }
    .action.primary { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
    .action.primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }

    .spinner {
      flex: none; width: 16px; height: 16px; border: 2px solid var(--line); border-top-color: var(--accent);
      border-radius: 50%; animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
    .error .title, .note .title { white-space: normal; font-weight: 500; font-size: 13px; }
    .error .title { color: var(--danger); }
  `;

  const ICONS = {
    spark: { fill: 'M12 2.5l2.2 6.3 6.3 2.2-6.3 2.2L12 19.5l-2.2-6.3L3.5 11l6.3-2.2z' },
    close: { stroke: 'M6 6l12 12M18 6L6 18' },
    arrow: { stroke: 'M5 12h14M13 6l6 6-6 6' },
    check: { stroke: 'M5 12.5l4.5 4.5L19 7.5' },
  };

  function icon(name, className) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    const path = document.createElementNS(NS, 'path');
    const { fill, stroke } = ICONS[name];
    path.setAttribute('d', fill || stroke);
    path.setAttribute('fill', fill ? 'currentColor' : 'none');
    if (stroke) {
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', '2.2');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
    return svg;
  }

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  function ensureUi() {
    if (ui) return ui;
    const host = el('div', { id: 'moodmail-root' });
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646; pointer-events: none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const launcher = el(
      'button',
      {
        className: 'launcher',
        type: 'button',
        title: 'Improve this email',
        'aria-label': 'MoodMail: improve this email',
        hidden: true,
        onclick: () => {
          if (view) dismiss();
          else if (activeEditor) showMoods(activeEditor);
        },
      },
      icon('spark'),
    );
    const card = el('section', { className: 'card', role: 'dialog', 'aria-label': 'MoodMail', hidden: true });

    // Clicks on the card should not pull the caret out of the email.
    const keepFocus = (e) => {
      if (e.target.tagName !== 'INPUT') e.preventDefault();
    };
    launcher.addEventListener('mousedown', keepFocus);
    card.addEventListener('mousedown', keepFocus);
    // Keys typed in the card must not reach webmail's global keyboard shortcuts.
    for (const type of ['keydown', 'keypress', 'keyup']) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }

    shadow.append(el('style', { textContent: CSS }), launcher, card);
    document.documentElement.append(host);
    ui = { shadow, launcher, card };
    return ui;
  }

  function header(title, onClose = dismiss) {
    return el(
      'div',
      { className: 'head' },
      el('p', { className: 'title', textContent: title }),
      el('button', { className: 'close', type: 'button', 'aria-label': 'Close', onclick: onClose }, icon('close')),
    );
  }

  function showCard(editor, nextView, ...children) {
    ensureUi();
    target = editor;
    view = nextView;
    ui.card.className = nextView === 'error' || nextView === 'note' ? `card ${nextView}` : 'card';
    ui.card.replaceChildren(...children);
    ui.card.hidden = false;
    place();
  }

  function closeCard() {
    target = null;
    view = null;
    if (!ui) return;
    if (ui.shadow.activeElement && activeEditor?.isConnected) activeEditor.focus();
    ui.card.hidden = true;
    ui.card.replaceChildren();
  }

  // Closing the card by hand means "stop asking about this draft".
  function dismiss() {
    if (target) stateOf(target).asked = true;
    currentJob += 1;
    closeCard();
  }

  function showMoods(editor, { auto = false, focus = false, source } = {}) {
    const go = (mood) => run(editor, mood, source);
    const input = el('input', {
      type: 'text',
      placeholder: 'Or describe it: firm but kind',
      maxLength: 120,
      'aria-label': 'Describe the mood you want',
      oninput: () => {
        goButton.disabled = !input.value.trim();
      },
    });
    const goButton = el(
      'button',
      { className: 'go', type: 'submit', disabled: true, 'aria-label': 'Rewrite in this mood' },
      icon('arrow'),
    );
    const form = el(
      'form',
      {
        className: 'custom',
        onsubmit: (e) => {
          e.preventDefault();
          const label = input.value.trim();
          if (label) go({ label });
        },
      },
      input,
      goButton,
    );
    const chips = MOODS.map((mood) =>
      el('button', { className: 'chip', type: 'button', textContent: mood.label, onclick: () => go(mood) }),
    );
    showCard(
      editor,
      auto ? 'asking' : 'moods',
      header('What mood are you going for?'),
      el('div', { className: 'moods' }, ...chips),
      form,
      el('button', {
        className: 'text-button plain',
        type: 'button',
        textContent: 'Just fix the grammar',
        onclick: () => go(GRAMMAR_ONLY),
      }),
    );
    if (focus) chips[0].focus();
  }

  function showWorking(editor, mood) {
    const title = mood.grammarOnly ? 'Fixing the grammar…' : `Rewriting: ${mood.label}…`;
    const head = header(title);
    head.prepend(el('span', { className: 'spinner', role: 'status', 'aria-label': 'Working' }));
    showCard(editor, 'working', head);
  }

  function showDone(editor, mood, source, details) {
    const head = header(mood.grammarOnly ? 'Grammar fixed' : `Improved: ${mood.label}`);
    head.prepend(icon('check', 'check'));
    const children = [head];
    if (details.length) {
      children.push(el('p', { className: 'warning', textContent: `Double-check: ${details.slice(0, 4).join(', ')}` }));
    }
    children.push(
      el(
        'div',
        { className: 'actions' },
        el('button', {
          className: 'action',
          type: 'button',
          textContent: 'Undo',
          onclick: () => {
            restoreDraft(editor, source);
            closeCard();
          },
        }),
        el('button', {
          className: 'action',
          type: 'button',
          textContent: 'Try another mood',
          onclick: () => showMoods(editor, { source }),
        }),
      ),
    );
    showCard(editor, 'done', ...children);
  }

  function showChanged(editor, mood) {
    showCard(
      editor,
      'changed',
      header('You kept typing'),
      el('p', { className: 'body', textContent: 'Your draft is untouched, so nothing you just typed was lost.' }),
      el(
        'div',
        { className: 'actions' },
        el('button', {
          className: 'action primary',
          type: 'button',
          textContent: 'Rewrite again',
          onclick: () => run(editor, mood),
        }),
      ),
    );
  }

  function showNote(editor, message) {
    showCard(editor, 'note', header(message));
  }

  function showError(editor, result, retry) {
    const action = result.settings
      ? el('button', {
          className: 'action primary',
          type: 'button',
          textContent: 'Open settings',
          onclick: () => chrome.runtime.sendMessage({ type: 'open-settings' }),
        })
      : el('button', { className: 'action primary', type: 'button', textContent: 'Try again', onclick: retry });
    showCard(editor, 'error', header(result.message), el('div', { className: 'actions' }, action));
  }

  // The visible part of an element, after any scrolling containers have clipped it.
  function visibleRect(element) {
    let { top, left, right, bottom } = element.getBoundingClientRect();
    for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'hidden') {
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top);
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    return { top, left, right, bottom, width: right - left, height: bottom - top };
  }

  function place() {
    if (!ui) return;
    const editor = target || activeEditor;
    if (!editor?.isConnected) {
      currentJob += 1;
      closeCard();
      activeEditor = null;
      ui.launcher.hidden = true;
      clearInterval(placer);
      placer = null;
      return;
    }
    const rect = visibleRect(editor);
    const visible = settings.enabled && rect.width > 0 && rect.height > 0;
    ui.launcher.hidden = !visible;
    ui.card.style.visibility = visible ? '' : 'hidden';
    if (!visible) return;

    const right = Math.min(rect.right, window.innerWidth - 8);
    const bottom = Math.min(rect.bottom, window.innerHeight - 8);
    ui.launcher.style.left = `${right - 38}px`;
    ui.launcher.style.top = `${bottom - 38}px`;

    if (ui.card.hidden) return;
    const { offsetWidth: width, offsetHeight: height } = ui.card;
    // Beside the compose box when there is room, then below or above it, so the card does not
    // cover the text. Only a compose box that fills the screen leaves no choice but to overlap.
    let x = rect.left - width - 12;
    let y = Math.max(8, Math.min(bottom - height, window.innerHeight - height - 8));
    if (x < 8) {
      x = Math.max(8, right - width - 8);
      if (rect.bottom + 8 + height <= window.innerHeight - 8) y = rect.bottom + 8;
      else if (rect.top - height - 8 >= 8) y = rect.top - height - 8;
    }
    ui.card.style.left = `${x}px`;
    ui.card.style.top = `${y}px`;
  }

  function setActive(editor) {
    if (!settings.enabled) return;
    ensureUi();
    activeEditor = editor;
    // A card about another compose window no longer applies, unless its rewrite is still running.
    if (target && target !== editor && view !== 'working') closeCard();
    if (!placer) placer = setInterval(place, 300);
    place();
  }

  // ---- Page events ----

  function scheduleAsk(editor) {
    const state = stateOf(editor);
    clearTimeout(state.timer);
    if (!settings.enabled || !settings.autoAsk || state.asked) return;
    state.timer = setTimeout(() => {
      if (!editor.isConnected || view || state.asked) return;
      const words = readDraft(editor).text.split(/\s+/).filter(Boolean).length;
      if (words >= MIN_WORDS) showMoods(editor, { auto: true });
    }, PAUSE_MS);
  }

  document.addEventListener(
    'focusin',
    (e) => {
      const editor = findEditor(e.target);
      if (editor) setActive(editor);
    },
    true,
  );

  document.addEventListener(
    'input',
    (e) => {
      if (applying) return;
      const editor = findEditor(e.target);
      if (!editor) return;
      setActive(editor);
      // Resuming typing puts away the prompt and the result bar. The prompt returns at the next pause.
      if (target === editor && ['asking', 'done', 'note'].includes(view)) closeCard();
      scheduleAsk(editor);
    },
    true,
  );

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && view) {
        e.stopPropagation();
        dismiss();
      }
    },
    true,
  );

  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'open-moods') return false;
    if (!settings.enabled) {
      sendResponse({ ok: false, reason: 'off' });
      return false;
    }
    const editor = findAnyEditor();
    if (!editor) {
      sendResponse({ ok: false, reason: 'no-editor' });
      return false;
    }
    setActive(editor);
    showMoods(editor, { focus: message.focus });
    sendResponse({ ok: true });
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) settings.enabled = changes.enabled.newValue;
    if (changes.autoAsk) settings.autoAsk = changes.autoAsk.newValue;
    if (!settings.enabled) {
      currentJob += 1;
      closeCard();
    }
    place();
  });

  chrome.storage.sync.get(settings).then((saved) => {
    settings = saved;
    const editor = findEditor(document.activeElement);
    if (editor) setActive(editor);
  });
})();
