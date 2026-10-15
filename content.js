(() => {
  'use strict';

  // All operations are local to this ChatGPT tab; no API tokens, network calls or broad permissions.
  if (window.__cgptQueueInstalled) return;
  window.__cgptQueueInstalled = true;

  const STORAGE_KEY = '__cgpt_next_question_queue_v1';
  const IDLE_MS = 1300;
  const SEND_BUTTON_TIMEOUT_MS = 4500;
  const ACK_TIMEOUT_MS = 5500;
  const START_TIMEOUT_MS = 11000;
  const TICK_MS = 350;

  const selectors = {
    composer: [
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="prompt-textarea"][contenteditable="true"]',
      '[data-testid="composer-input"][contenteditable="true"]',
      'form [contenteditable="true"][data-lexical-editor="true"]',
      'form .ProseMirror[contenteditable="true"]',
      '#prompt-textarea',
      '[data-testid="prompt-textarea"]',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"][data-placeholder]',
      'form textarea[name="prompt-textarea"]',
      'form textarea[placeholder*="Message"]',
      'form textarea[placeholder*="消息"]'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label="发送消息"]',
      'button.composer-submit-btn',
      'button[type="submit"]'
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[data-testid="stop-generating-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止生成"]',
      'button[aria-label="停止回答"]',
      'button[aria-label="停止"]'
    ]
  };

  // ChatGPT has several composer implementations (ProseMirror, Lexical and
  // textarea). Some also keep hidden buttons in the DOM after a response.
  function visible(element) {
    if (!element || !element.isConnected || !element.getClientRects().length) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function normalizeEditor(candidate) {
    if (!candidate) return null;
    if (candidate.matches('textarea, [contenteditable="true"]')) return candidate;
    return candidate.querySelector('[contenteditable="true"],textarea');
  }

  function getComposer() {
    for (const selector of selectors.composer) {
      for (const candidate of document.querySelectorAll(selector)) {
        const editor = normalizeEditor(candidate);
        if (visible(editor)) return editor;
      }
    }
    return null;
  }

  function findComposerForm() {
    const editor = getComposer();
    return editor?.closest('form') || null;
  }

  // The Send button often DOES NOT EXIST while the editor is empty. Never
  // require it before inserting text; resolve it after the editor reacts.
  function getSendButton() {
    const form = findComposerForm();
    if (!form) return null;
    for (const selector of selectors.send) {
      const candidate = [...form.querySelectorAll(selector)].find(visible);
      if (candidate && !candidate.matches(selectors.stop.join(','))) return candidate;
    }
    return [...form.querySelectorAll('button[aria-label], button[title]')].find(btn => {
      if (!visible(btn)) return false;
      const label = (btn.getAttribute('aria-label') || btn.title || '').trim();
      return /^(send|send prompt|send message|发送|发送消息|发送提示词)$/i.test(label);
    }) || null;
  }

  function isBusy() {
    if (selectors.stop.some(selector => [...document.querySelectorAll(selector)].some(visible))) return true;
    const form = findComposerForm();
    if (!form) return false;
    return [...form.querySelectorAll('button[aria-label], button[title]')].some(btn => {
      if (!visible(btn)) return false;
      const label = (btn.getAttribute('aria-label') || btn.title || '').trim();
      return /^(stop|stop generating|stop response|stop streaming|停止|停止生成|停止回答)$/i.test(label);
    });
  }
  function isDisabled(button) {
    return !visible(button) || button.disabled || button.getAttribute('aria-disabled') === 'true';
  }
  function editorText(editor) {
    return (editor instanceof HTMLTextAreaElement ? editor.value : editor.innerText || editor.textContent || '').trim();
  }
  function getChatKey() { return location.origin + location.pathname; }
  function isRootChat(key) {
    try { return new URL(key).pathname === '/'; } catch { return false; }
  }
  function hasAttachments() {
    const editor = getComposer();
    const form = editor?.closest('form') || editor?.parentElement?.closest('form');
    if (!form) return false;
    return !!form.querySelector('[data-testid*="attachment-preview"], [data-testid*="attachment-chip"], [aria-label*="Remove attachment"], [aria-label*="移除附件"]');
  }

  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { saved = {}; }
  const queues = saved.queues && typeof saved.queues === 'object' ? saved.queues : {};
  let chatKey = getChatKey();
  // Never resume automatic actions unexpectedly after reload.
  let paused = Object.keys(saved).length > 0; // first install runs automatically; page refresh pauses
  let expanded = false; // The panel always starts collapsed on page load.
  let nativeEnter = saved.nativeEnter !== false;
  let statusMessage = paused ? '已暂停' : '';
  let sending = false;
  let sawBusyDuringSend = false;
  let waitingForStart = false;
  let waitingSince = 0;
  let busyBefore = isBusy();
  let idleSince = busyBefore ? 0 : Date.now();
  let lastRenderSignature = '';

  function queue() {
    if (!Array.isArray(queues[chatKey])) queues[chatKey] = [];
    return queues[chatKey];
  }
  function persist() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ queues, nativeEnter })); }
    catch { statusMessage = '存储空间不足；刷新可能丢失队列'; }
  }
  function setStatus(msg) { statusMessage = msg; render(); }
  function add(text) {
    const content = String(text || '').trim();
    if (!content) return false;
    queue().push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: content });
    persist();
    setStatus(paused ? '已加入 · 已暂停' : '已加入队列');
    return true;
  }
  function remove(id) {
    if (sending && queue()[0]?.id === id) return;
    queues[chatKey] = queue().filter(q => q.id !== id);
    persist(); render();
  }
  function reorder(id, delta) {
    const items = queue();
    const idx = items.findIndex(q => q.id === id);
    const dest = idx + delta;
    if (idx < 0 || dest < 0 || dest >= items.length || (sending && (idx === 0 || dest === 0))) return;
    [items[idx], items[dest]] = [items[dest], items[idx]];
    persist(); render();
  }
  function checkRoute() {
    const newKey = getChatKey();
    if (newKey === chatKey) return;
    const oldKey = chatKey;
    const pending = queue();
    // A new chat obtains /c/<id> right after the first message is submitted.
    const creatingChat = isRootChat(oldKey) && /\/c\/[^/]+/.test(new URL(newKey).pathname);
    if (creatingChat && !Array.isArray(queues[newKey]) && pending.length) {
      queues[newKey] = pending;
      delete queues[oldKey];
    } else if (!creatingChat) {
      paused = true;
      waitingForStart = false;
      sending = false;
      setStatus('已切换对话 · 暂停');
    }
    chatKey = newKey;
    busyBefore = isBusy();
    idleSince = busyBefore ? 0 : Date.now();
    persist(); render();
  }

  function clearComposer(editor) {
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(editor, '');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return editorText(editor) === '';
    }
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand('delete');
    selection.removeAllRanges();
    return !!ok && editorText(editor) === '';
  }

  function insertComposerText(editor, text) {
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!setter) return false;
      setter.call(editor, text);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return editorText(editor).length > 0;
    }
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    // insertText generates ProseMirror's expected beforeinput/input events.
    const okay = document.execCommand('insertText', false, text);
    sel.removeAllRanges();
    return (okay || editorText(editor) === text.trim()) && editorText(editor) === text.trim();
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function sendNext() {
    if (sending || paused || waitingForStart || !queue().length || isBusy()) return;
    const startKey = chatKey;
    // ChatGPT changes '/' into '/c/<new-id>' when the first message is sent.
    const sameChat = () => chatKey === startKey || (isRootChat(startKey) && /^\/c\/[^/]+/.test(new URL(chatKey).pathname));
    const item = queue()[0];
    const editor = getComposer();
    if (!editor) { setStatus('找不到输入框'); return; }
    if (editorText(editor)) { setStatus('请先清空输入框'); return; }
    if (hasAttachments()) { setStatus('请先移除附件'); return; }
    sending = true;
    sawBusyDuringSend = false;
    try {
      if (!insertComposerText(editor, item.text)) throw new Error('写入失败');
      // Let the site's editor state update before looking up the send button.
      let sendButton = null;
      for (let attempt = 0; attempt < Math.ceil(SEND_BUTTON_TIMEOUT_MS / 150); attempt++) {
        await sleep(150);
        if (!sameChat() || paused) throw new Error('对话已切换');
        sendButton = getSendButton();
        if (!isDisabled(sendButton)) break;
      }
      if (isDisabled(sendButton)) throw new Error('发送按钮不可用');
      if (isBusy()) throw new Error('仍在回复中');
      // Some builds replace the voice icon with Send only after input events.
      // Resolve a fresh reference to avoid clicking a stale, detached element.
      sendButton = getSendButton();
      if (isDisabled(sendButton)) throw new Error('发送按钮失效');
      sendButton.click();
      const clickedAt = Date.now();
      let acknowledged = false;
      while (Date.now() - clickedAt < ACK_TIMEOUT_MS) {
        await sleep(150);
        if (!sameChat()) throw new Error('对话已切换，请检查消息');
        if (isBusy() || sawBusyDuringSend || !editorText(editor)) { acknowledged = true; break; }
      }
      if (!acknowledged) throw new Error('发送状态不明，请检查');
      // Remove only AFTER the site acknowledges submission (busy or editor clear).
      if (queue()[0]?.id === item.id) queue().shift();
      waitingForStart = !(isBusy() || sawBusyDuringSend);
      waitingSince = Date.now();
      idleSince = 0;
      persist();
      setStatus(waitingForStart ? '等待回复' : '回复中');
    } catch (err) {
      paused = true;
      setStatus(`已暂停：${err.message}`);
    } finally {
      sending = false;
      render();
    }
  }

  function onNativeEnter(event) {
    if (!nativeEnter || event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    if (!isBusy()) return;
    const editor = getComposer();
    if (!editor || !(editor === event.target || editor.contains(event.target))) return;
    if (hasAttachments()) { setStatus('请先移除附件'); return; }
    const text = editorText(editor);
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!clearComposer(editor)) { setStatus('无法清空，请使用面板'); return; }
    add(text);
  }

  // Match ChatGPT's selected site theme, which may differ from the OS theme.
  // Always start collapsed, including when an older extension saved expanded=true.
  function pageTheme() {
    const root = document.documentElement;
    const body = document.body;
    const preference = [root.getAttribute('data-theme'), root.getAttribute('data-color-mode'),
      body?.getAttribute('data-theme'), body?.getAttribute('data-color-mode')]
      .find(value => /^(dark|light)$/i.test(value || ''));
    if (preference) return preference.toLowerCase();
    if (root.classList.contains('dark') || body?.classList.contains('dark')) return 'dark';
    if (root.classList.contains('light') || body?.classList.contains('light')) return 'light';
    const scheme = window.getComputedStyle(root).colorScheme;
    if (scheme === 'dark' || scheme === 'light') return scheme;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  const host = document.createElement('div');
  host.id = 'cgpt-queue-extension-host';
  host.style.cssText = 'position:fixed;bottom:90px;right:18px;z-index:2147483647;max-width:calc(100vw - 36px);';
  const shadow = host.attachShadow({ mode: 'open' });
  function syncTheme() {
    const theme = pageTheme();
    if (host.dataset.theme !== theme) host.dataset.theme = theme;
  }

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial; display:block; font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      font-size:13px; line-height:1.4; color-scheme:light;
      --cq-panel:#fff; --cq-surface:#f4f4f4; --cq-text:#171717;
      --cq-muted:#6b6b6b; --cq-border:#e5e5e5; --cq-hover:#ededed;
      --cq-action:#171717; --cq-action-text:#fff;
    }
    :host([data-theme="dark"]) {
      color-scheme:dark; --cq-panel:#212121; --cq-surface:#303030;
      --cq-text:#f5f5f5; --cq-muted:#b0b0b0; --cq-border:#424242;
      --cq-hover:#393939; --cq-action:#f5f5f5; --cq-action-text:#171717;
    }
    * { box-sizing:border-box; }
    button, textarea, input { font:inherit; }
    button { cursor:pointer; }
    button:focus-visible,textarea:focus-visible,input:focus-visible { outline:2px solid var(--cq-muted); outline-offset:2px; }
    #pill {
      display:flex; align-items:center; gap:8px; float:right; border:1px solid var(--cq-border);
      padding:8px 13px; border-radius:999px; background:var(--cq-panel); color:var(--cq-text);
      font-weight:600; box-shadow:0 3px 14px #00000018; white-space:nowrap;
    }
    #pill:hover { background:var(--cq-surface); }
    #panel {
      width:320px; max-width:calc(100vw - 36px); max-height:min(470px,70vh);
      display:flex; flex-direction:column; background:var(--cq-panel); color:var(--cq-text);
      border:1px solid var(--cq-border); border-radius:16px;
      box-shadow:0 8px 30px #00000024; overflow:hidden;
    }
    .top { display:flex; justify-content:space-between; align-items:center; padding:13px 14px 8px; gap:10px; }
    .title { font-size:14px; font-weight:650; }
    .header-right { display:flex; align-items:center; gap:8px; }
    #count { font-size:12px; color:var(--cq-muted); white-space:nowrap; }
    .body { padding:4px 12px 12px; display:flex; flex-direction:column; gap:9px; overflow-y:auto; }
    .muted { color:var(--cq-muted); font-size:12px; }
    #draft { width:100%; min-height:64px; max-height:180px; resize:vertical; padding:10px 11px;
      border:1px solid var(--cq-border); border-radius:12px; background:var(--cq-surface);
      color:var(--cq-text); outline-offset:1px; }
    #draft::placeholder { color:var(--cq-muted); }
    .btn { border:0; border-radius:9px; background:transparent; color:var(--cq-text); padding:6px 9px; }
    .btn:hover { background:var(--cq-hover); }
    .btn.primary { background:var(--cq-action); color:var(--cq-action-text); font-weight:600; padding:7px 12px; }
    .btn.primary:hover { opacity:.88; }
    .btn:disabled { cursor:not-allowed; opacity:.4; }
    .iconbtn { width:28px; height:28px; display:grid; place-items:center; font-size:20px; }
    .composer-actions, .queuehead, .actions { display:flex; align-items:center; gap:4px; }
    .composer-actions, .queuehead { justify-content:space-between; }
    .queuehead { border-top:1px solid var(--cq-border); padding-top:8px; }
    #status { font-size:12px; color:var(--cq-muted); line-height:1.45; overflow-wrap:anywhere; min-width:0; }
    #items { display:flex; flex-direction:column; gap:5px; }
    .item { display:flex; align-items:flex-start; gap:4px; background:var(--cq-surface);
      border-radius:10px; padding:8px 8px 8px 10px; }
    .itemtext { min-width:0; flex:1; white-space:pre-wrap; overflow-wrap:anywhere;
      max-height:70px; overflow:auto; line-height:1.45; }
    .itembuttons { display:flex; align-items:center; gap:0; }
    .itembuttons button { width:22px; height:24px; padding:0; border:0; background:transparent;
      color:var(--cq-muted); border-radius:5px; }
    .itembuttons button:hover:not(:disabled) { background:var(--cq-hover); color:var(--cq-text); }
    .itembuttons button:disabled { opacity:.25; cursor:default; }
    .setting { display:flex; align-items:center; gap:8px; cursor:pointer; font-size:12px; color:var(--cq-muted); }
    .setting input { accent-color:var(--cq-text); margin:0; }
    .empty { padding:8px 1px; }
  `;
  shadow.append(style);
  const pill = document.createElement('button');
  pill.id = 'pill';
  pill.type = 'button';
  pill.setAttribute('aria-label', '展开待发送队列');
  const panel = document.createElement('section');
  panel.id = 'panel';
  panel.setAttribute('aria-label', '待发送队列');
  panel.innerHTML = `
    <div class="top">
      <span class="title">下一问</span>
      <div class="header-right"><span id="count">待发送 (0)</span><button class="btn iconbtn" id="collapse" aria-label="收起" title="收起">×</button></div>
    </div>
    <div class="body">
      <textarea id="draft" placeholder="输入下一条问题…" aria-label="下一条问题"></textarea>
      <div class="composer-actions"><span class="muted">⌘ / Ctrl + Enter</span><button class="btn primary" id="add">加入队列</button></div>
      <div class="queuehead"><span id="status" role="status" aria-live="polite"></span><div class="actions"><button class="btn" id="toggle">暂停</button><button class="btn" id="clear">清空</button></div></div>
      <div id="items"></div>
      <label class="setting"><input type="checkbox" id="native-enter" checked><span>原输入框 Enter 入队</span></label>
    </div>`;
  shadow.append(pill, panel);
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);

  pill.addEventListener('click', () => { expanded = true; render(); });
  $('collapse').addEventListener('click', () => { expanded = false; render(); });
  $('add').addEventListener('click', () => {
    if (add($('draft').value)) $('draft').value = '';
    $('draft').focus();
  });
  $('draft').addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (add($('draft').value)) $('draft').value = '';
    }
  });
  $('toggle').addEventListener('click', () => {
    paused = !paused;
    if (paused) waitingForStart = false;
    setStatus(paused ? '已暂停' : '已继续');
  });
  $('clear').addEventListener('click', () => {
    if (!queue().length) return;
    if (!window.confirm(`清空当前对话的 ${queue().length} 条待发问题？`)) return;
    queues[chatKey] = [];
    persist(); render();
  });
  $('native-enter').addEventListener('change', evt => {
    nativeEnter = evt.target.checked;
    persist(); render();
  });
  $('items').addEventListener('click', event => {
    const btn = event.target.closest('button[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'remove') remove(btn.dataset.id);
    if (btn.dataset.action === 'up') reorder(btn.dataset.id, -1);
    if (btn.dataset.action === 'down') reorder(btn.dataset.id, 1);
  });

  function render() {
    syncTheme();
    const arr = queue();
    pill.hidden = expanded;
    panel.hidden = !expanded;
    // CSS display properties override hidden in some cases, so force explicit display.
    pill.style.display = expanded ? 'none' : 'block';
    panel.style.display = expanded ? 'flex' : 'none';
    pill.textContent = `☷ 队列 ${arr.length}${paused && arr.length ? ' · 暂停' : ''}`;
    $('count').textContent = `待发送 (${arr.length})`;
    $('toggle').textContent = paused ? '继续' : '暂停';
    $('native-enter').checked = nativeEnter;
    const busy = isBusy();
    const statusText = statusMessage || (paused ? '已暂停' : busy ? '回复中' : '自动发送已开启');
    if ($('status').textContent !== statusText) $('status').textContent = statusText;
    const signature = JSON.stringify({ arr, sending });
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;
    const list = $('items');
    list.replaceChildren();
    arr.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'item';
      const content = document.createElement('div');
      content.className = 'itemtext';
      content.textContent = `${idx + 1}. ${item.text}`;
      const actions = document.createElement('div');
      actions.className = 'itembuttons';
      for (const [action, label, title] of [['up','↑','上移'], ['down','↓','下移'], ['remove','×','删除']]) {
        const btn = document.createElement('button');
        btn.dataset.action = action;
        btn.dataset.id = item.id;
        btn.textContent = label;
        btn.title = title;
        if ((sending && idx === 0) || (action === 'up' && idx === 0) || (action === 'down' && idx === arr.length - 1)) btn.disabled = true;
        actions.append(btn);
      }
      row.append(content, actions);
      list.append(row);
    });
    if (!arr.length) {
      const empty = document.createElement('div');
      empty.className = 'muted empty';
      empty.textContent = '暂无问题';
      list.append(empty);
    }
  }

  function tick() {
    checkRoute();
    const busy = isBusy();
    if (busy) {
      if (sending) sawBusyDuringSend = true;
      busyBefore = true;
      waitingForStart = false;
      idleSince = 0;
    } else if (busyBefore) {
      busyBefore = false;
      idleSince = Date.now();
    } else if (!idleSince && !waitingForStart && !sending) {
      idleSince = Date.now();
    }
    if (waitingForStart && !busy && Date.now() - waitingSince > START_TIMEOUT_MS) {
      paused = true;
      waitingForStart = false;
      setStatus('等待回复超时 · 已暂停');
    }
    if (!paused && !sending && !waitingForStart && !busy && queue().length && idleSince && Date.now() - idleSince >= IDLE_MS) {
      void sendNext();
    }
    render();
  }

  document.addEventListener('keydown', onNativeEnter, true);
  let scanScheduled = false;
  const observer = new MutationObserver(() => {
    if (scanScheduled) return;
    scanScheduled = true;
    setTimeout(() => { scanScheduled = false; tick(); }, 100);
  });
  observer.observe(document.body, { subtree:true, childList:true, attributes:true, attributeFilter:['disabled','aria-label','data-testid','aria-disabled'] });
  window.setInterval(tick, TICK_MS);
  render();
})();
