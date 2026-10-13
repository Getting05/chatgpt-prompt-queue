(() => {
  'use strict';

  // All operations are local to this ChatGPT tab; no API tokens, network calls or broad permissions.
  if (window.__cgptQueueInstalled) return;
  window.__cgptQueueInstalled = true;

  const STORAGE_KEY = '__cgpt_next_question_queue_v1';
  const IDLE_MS = 1300;
  const ACK_TIMEOUT_MS = 5500;
  const START_TIMEOUT_MS = 11000;
  const TICK_MS = 350;

  const selectors = {
    composer: [
      '#prompt-textarea[contenteditable="true"]',
      '#prompt-textarea',
      '[data-testid="composer-input"][contenteditable="true"]',
      '[contenteditable="true"][data-placeholder]',
      '[contenteditable="true"][role="textbox"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="消息"]'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label="发送消息"]'
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[data-testid="stop-generating-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止生成"]',
      'button[aria-label="停止回答"]',
      'button[aria-label="停止"]'
    ]
  };

  const first = (list) => {
    for (const selector of list) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  };

  function getComposer() { return first(selectors.composer); }
  function getSendButton() {
    const candidate = first(selectors.send);
    if (candidate) return candidate;
    // A semantic fallback rather than guessing the last button in a form.
    return [...document.querySelectorAll('button[aria-label],button[title]')].find(btn => {
      const label = (btn.getAttribute('aria-label') || btn.title || '').trim();
      return /^(send|send prompt|send message|发送|发送消息|发送提示词)$/i.test(label);
    }) || null;
  }
  function isBusy() {
    if (first(selectors.stop)) return true;
    return [...document.querySelectorAll('button[aria-label],button[title]')].some(btn => {
      const label = (btn.getAttribute('aria-label') || btn.title || '').trim();
      return /^(stop|stop generating|stop response|stop streaming|停止|停止生成|停止回答)$/i.test(label);
    });
  }
  function isDisabled(button) {
    return !button || button.disabled || button.getAttribute('aria-disabled') === 'true';
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
  let expanded = saved.expanded !== false;
  let nativeEnter = saved.nativeEnter !== false;
  let statusMessage = paused ? '刷新后已安全暂停；点击“继续自动发送”恢复' : '自动发送已启用，可直接排队';
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
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ queues, expanded, nativeEnter })); }
    catch { statusMessage = '存储空间不足；刷新可能丢失队列'; }
  }
  function setStatus(msg) { statusMessage = msg; render(); }
  function add(text) {
    const content = String(text || '').trim();
    if (!content) return false;
    queue().push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, text: content });
    persist();
    setStatus(`已排队 ${queue().length} 条；${paused ? '点“继续自动发送”启动' : '将自动发送'}`);
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
      setStatus('已切换对话，自动发送已暂停；旧队列按对话分别保留');
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
    return !!okay && editorText(editor).length > 0;
  }

  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  async function sendNext() {
    if (sending || paused || waitingForStart || !queue().length || isBusy()) return;
    const startKey = chatKey;
    // ChatGPT changes '/' into '/c/<new-id>' when the first message is sent.
    const sameChat = () => chatKey === startKey || (isRootChat(startKey) && /^\/c\/[^/]+/.test(new URL(chatKey).pathname));
    const item = queue()[0];
    const editor = getComposer();
    if (!editor || !getSendButton()) { setStatus('找不到 ChatGPT 输入框或发送按钮；已等待页面就绪'); return; }
    if (editorText(editor)) { setStatus('输入框有未发送的草稿；清空后会继续队列'); return; }
    if (hasAttachments()) { setStatus('检测到附件；请先处理附件，暂不自动发送纯文本队列'); return; }
    sending = true;
    sawBusyDuringSend = false;
    try {
      if (!insertComposerText(editor, item.text)) throw new Error('无法写入输入框，已暂停以免丢失问题');
      // Let the site's editor state update before looking up the send button.
      let sendButton = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        await sleep(120);
        if (!sameChat() || paused) throw new Error('对话已切换或队列已暂停');
        sendButton = getSendButton();
        if (!isDisabled(sendButton)) break;
      }
      if (isDisabled(sendButton)) throw new Error('发送按钮不可用；请检查输入框');
      if (isBusy()) throw new Error('上一条回复还在生成；没有发送');
      sendButton.click();
      const clickedAt = Date.now();
      let acknowledged = false;
      while (Date.now() - clickedAt < ACK_TIMEOUT_MS) {
        await sleep(150);
        if (!sameChat()) throw new Error('提交过程中对话已切换，请检查是否已发送');
        if (isBusy() || sawBusyDuringSend || !editorText(editor)) { acknowledged = true; break; }
      }
      if (!acknowledged) throw new Error('未确认是否提交成功；已暂停防止重复发送，请人工检查');
      // Remove only AFTER the site acknowledges submission (busy or editor clear).
      if (queue()[0]?.id === item.id) queue().shift();
      waitingForStart = !(isBusy() || sawBusyDuringSend);
      waitingSince = Date.now();
      idleSince = 0;
      persist();
      setStatus(waitingForStart ? '已提交，等待识别回答开始' : '已提交，等待 ChatGPT 回答结束');
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
    if (hasAttachments()) { setStatus('原生输入框含附件，暂不拦截 Enter'); return; }
    const text = editorText(editor);
    if (!text) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!clearComposer(editor)) { setStatus('未能安全清空输入框，请改用悬浮面板排队'); return; }
    add(text);
  }

  // The panel is a shadow root so ChatGPT's own styles don't break the extension.
  const host = document.createElement('div');
  host.id = 'cgpt-queue-extension-host';
  host.style.cssText = 'position:fixed;bottom:92px;right:16px;z-index:2147483647;max-width:calc(100vw - 32px);';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; font-family: system-ui,-apple-system,"Segoe UI",sans-serif; color-scheme: light dark; }
    * { box-sizing:border-box; }
    #pill { appearance:none; background:#197a65; color:white; border:0; border-radius:999px; padding:11px 17px; font-weight:700; cursor:pointer; box-shadow:0 5px 22px #0003; float:right; }
    #panel { width:340px; max-width:calc(100vw - 32px); max-height:min(560px,72vh); display:flex; flex-direction:column; background:#fff; color:#20242a; border:1px solid #d6dedc; border-radius:15px; box-shadow:0 10px 42px #0003; overflow:hidden; font-size:13px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:9px; padding:13px 14px; background:#f4f8f7; border-bottom:1px solid #e0e8e5; }
    .title { font-weight:750; font-size:15px; }
    .body { padding:12px; display:flex; flex-direction:column; gap:10px; overflow:auto; }
    .muted { color:#596b66; font-size:12px; }
    #status { background:#f2f6f5; border-radius:8px; padding:8px; overflow-wrap:anywhere; line-height:1.5; }
    textarea { display:block; width:100%; min-height:76px; padding:10px; resize:vertical; border:1px solid #c4d5cf; border-radius:8px; background:white; color:#20242a; font:inherit; outline-offset:2px; }
    button { font:inherit; cursor:pointer; }
    .btn { padding:7px 10px; border:1px solid #c5d0cc; border-radius:8px; background:#fff; color:#26332f; }
    .btn.primary { background:#197a65; color:#fff; border-color:#197a65; font-weight:650; }
    .btn.small { padding:4px 7px; }
    .btn:disabled { cursor:not-allowed; opacity:0.5; }
    .actions, .queuehead { display:flex; flex-wrap:wrap; gap:6px; align-items:center; justify-content:space-between; }
    .queuehead { padding-top:4px; border-top:1px solid #e7edeb; font-weight:650; }
    .item { display:flex; gap:6px; border:1px solid #e0e8e5; border-radius:9px; padding:8px; margin-top:6px; }
    .itemtext { min-width:0; flex:1; white-space:pre-wrap; overflow-wrap:anywhere; max-height:75px; overflow:auto; }
    .itembuttons { display:flex; flex-direction:column; gap:3px; }
    .itembuttons button { width:24px; height:22px; padding:0; background:#f6f9f8; border:1px solid #d9e5e1; border-radius:5px; }
    label { display:flex; gap:6px; align-items:center; cursor:pointer; }
    input[type=checkbox] { accent-color:#197a65; }
    .hint { line-height:1.55; }
    @media (prefers-color-scheme:dark) { #panel { background:#212521; color:#f1f5f3; border-color:#4b5650; } .top { background:#303730; border-color:#4b5650; } #status,.itembuttons button { background:#303730; color:#f1f5f3; } .muted { color:#b2c1b8; } .btn,textarea { background:#252b28; color:#f1f5f3; border-color:#4b5650; } .btn.primary { background:#197a65; } .queuehead { border-color:#4b5650; } .item { border-color:#4b5650; } .itembuttons button { border-color:#4b5650; } }
  `;
  shadow.append(style);
  const pill = document.createElement('button');
  pill.id = 'pill';
  const panel = document.createElement('section');
  panel.id = 'panel';
  panel.innerHTML = `
    <div class="top"><span class="title">ChatGPT 下一问队列</span><button class="btn small" id="collapse" title="收起">收起 −</button></div>
    <div class="body">
      <div id="status" role="status" aria-live="polite"></div>
      <textarea id="draft" placeholder="输入下一条问题（支持多行）"></textarea>
      <div class="actions"><button class="btn primary" id="add">加入待发队列</button><span class="muted">Ctrl / ⌘ + Enter 入队</span></div>
      <div class="queuehead"><span id="count">待发送 (0)</span><div class="actions"><button class="btn small" id="toggle">继续自动发送</button><button class="btn small" id="clear">清空</button></div></div>
      <div id="items"></div>
      <label><input type="checkbox" id="native-enter" checked><span>生成期间在原输入框按 Enter 排队</span></label>
      <div class="muted hint">Shift + Enter 仍可换行。只自动发送纯文本；切换对话或刷新后会暂停，防止误发。</div>
    </div>`;
  shadow.append(pill, panel);
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);

  pill.addEventListener('click', () => { expanded = true; persist(); render(); });
  $('collapse').addEventListener('click', () => { expanded = false; persist(); render(); });
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
    setStatus(paused ? '队列已手动暂停' : '已启动；当前回答结束后自动发送');
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
    const arr = queue();
    pill.hidden = expanded;
    panel.hidden = !expanded;
    // CSS display properties override hidden in some cases, so force explicit display.
    pill.style.display = expanded ? 'none' : 'block';
    panel.style.display = expanded ? 'flex' : 'none';
    pill.textContent = `待发送 ${arr.length} 条 ${paused ? '⏸' : '▶'}`;
    $('count').textContent = `待发送 (${arr.length})`;
    $('toggle').textContent = paused ? '▶ 继续自动发送' : '⏸ 暂停';
    $('native-enter').checked = nativeEnter;
    const busy = isBusy();
    const statusText = `${busy ? '● ChatGPT 正在生成' : '○ ChatGPT 暂未检测到生成'} · ${paused ? '已暂停' : '自动发送开启'}\n${statusMessage}`;
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
      empty.className = 'muted';
      empty.textContent = '暂无待发送问题';
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
      setStatus('未观察到新回复开始，已暂停后续发送，避免连续误发');
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
