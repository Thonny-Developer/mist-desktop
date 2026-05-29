/* Chat page — the core feature.
 * Conversation state, SSE streaming with a live cursor, markdown rendering,
 * abortable generation, token counter, smart auto-scroll, and history
 * persistence. */
import {
  store, getSettings, renderMarkdown, bindCopyButtons, escapeHtml,
  estimateTokens, formatRelative, uid, toast, stripAgentTags
} from '../shared.js';

const api = window.api;

/* Module-level live conversation so it survives page navigation. */
let convo = freshConvo('mistral-large-latest');
let streaming = false;
let unsubStream = null;
let autoScroll = true;

function freshConvo(model) {
  return { id: uid(), title: '', model, createdAt: Date.now(), messages: [], savedId: null };
}

/* ---------------- session persistence ---------------- */
async function loadSessions() {
  return (await store.get('sessions')) || [];
}

/** Persist the current conversation into the sessions array (insert or update). */
async function persistConvo() {
  if (!convo.messages.length) return;
  const firstUser = convo.messages.find((m) => m.role === 'user');
  const title = (firstUser?.content || 'New chat').replace(/\s+/g, ' ').trim().slice(0, 60);
  const record = {
    id: convo.savedId || convo.id,
    title,
    model: convo.model,
    createdAt: convo.createdAt,
    updatedAt: Date.now(),
    messageCount: convo.messages.length,
    messages: convo.messages
  };
  const sessions = await loadSessions();
  const idx = sessions.findIndex((s) => s.id === record.id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.unshift(record);
  convo.savedId = record.id;
  convo.title = title;
  await store.set('sessions', sessions);
}

/* ---------------- render ---------------- */
async function render(container, ctx) {
  const settings = await getSettings();
  convo.model = settings.model || convo.model;

  // Handle navigation intents.
  if (ctx.params?.newChat) await newChat(false);
  if (ctx.params?.openSession) await openSession(ctx.params.openSession, false);

  const preset = await activePreset(settings);

  container.innerHTML = `
    <div class="chat">
      <!-- sessions column -->
      <aside class="sessions">
        <div class="sessions-head">
          <span class="lbl">Sessions</span>
          <div class="field-box searchbox">
            <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5"/><path d="M11 11l3 3"/></svg>
            <input type="text" id="sesSearch" placeholder="Search…" />
          </div>
        </div>
        <div class="sessions-list" id="sesList"></div>
      </aside>

      <!-- thread + composer -->
      <section class="thread-pane">
        <header class="thread-head">
          <span class="model mono" id="thModel">${escapeHtml(convo.model)}</span>
          <span class="streaming hidden" id="thStreaming"><span class="pulse"></span>working</span>
          <span class="spacer"></span>
          <button class="head-chip" id="folderBtn" title="Working folder">
            <svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6H2z"/></svg>
            <span id="folderLabel">Set folder</span>
          </button>
          <button class="head-chip" id="todosBtn" title="Todos">
            <svg viewBox="0 0 16 16"><path d="M3 5l2 2 3-3M3 11l2 2 3-3M10 5h4M10 11h4"/></svg>
            <span id="todosLabel">Todos</span>
          </button>
          <span class="preset-name mono" id="thPreset">${escapeHtml(preset?.name || 'General')}</span>
          <button class="icon-btn" id="thNew" title="New chat (Ctrl+N)">
            <svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10"/></svg>
          </button>
        </header>

        <div class="thread" id="thread"></div>

        <div class="composer">
          <textarea id="composer" placeholder="Message Mistral…  (Enter to send · Shift+Enter for newline)"></textarea>
          <div class="composer-bar">
            <span class="meta mono">↵ send</span>
            <span class="meta mono">·  ${escapeHtml((convo.model || '').replace('-latest', ''))}</span>
            <span class="meta mono" id="tokMeta">·  0 tok</span>
            <span class="spacer"></span>
            <button class="btn ghost sm hidden" id="stopBtn">Stop ⎋</button>
            <button class="btn primary sm" id="sendBtn">Send ↵</button>
          </div>
        </div>
      </section>
    </div>`;

  // refs
  const thread = container.querySelector('#thread');
  const composer = container.querySelector('#composer');
  const sendBtn = container.querySelector('#sendBtn');
  const stopBtn = container.querySelector('#stopBtn');
  const tokMeta = container.querySelector('#tokMeta');

  // Track manual scrolling so streaming doesn't yank the view down.
  thread.addEventListener('scroll', () => {
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60;
    autoScroll = nearBottom;
  });

  // Composer behaviour: Enter sends, Shift+Enter newlines; autosize; token count.
  const updateTokens = () => {
    const ctxTokens = estimateTokens(convo.messages.map((m) => m.content).join(' '));
    const inputTokens = estimateTokens(composer.value);
    tokMeta.textContent = `·  ${(ctxTokens + inputTokens).toLocaleString()} tok`;
  };
  composer.addEventListener('input', () => {
    composer.style.height = 'auto';
    composer.style.height = Math.min(220, composer.scrollHeight) + 'px';
    updateTokens();
  });
  composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  sendBtn.addEventListener('click', () => send());
  stopBtn.addEventListener('click', () => stop());
  container.querySelector('#thNew').addEventListener('click', () => ctx.navigate('chat', { newChat: true }));

  // Escape stops generation while this page is mounted.
  const onKey = (e) => { if (e.key === 'Escape' && streaming) { e.preventDefault(); stop(); } };
  document.addEventListener('keydown', onKey);
  chatPage._onKey = onKey;

  // Session search.
  container.querySelector('#sesSearch').addEventListener('input', (e) => drawSessions(e.target.value));

  // ---- working folder + todos chips ----
  const folderLabel = container.querySelector('#folderLabel');
  const todosLabel = container.querySelector('#todosLabel');

  async function refreshFolder() {
    const dir = await api.workspace.get();
    folderLabel.textContent = dir ? dir.split(/[\\/]/).pop() : 'Set folder';
    container.querySelector('#folderBtn').classList.toggle('set', !!dir);
    container.querySelector('#folderBtn').title = dir || 'Choose a working folder';
  }
  async function refreshTodos() {
    const todos = await api.todos.get();
    const done = todos.filter((t) => t.done).length;
    todosLabel.textContent = todos.length ? `Todos ${done}/${todos.length}` : 'Todos';
    container.querySelector('#todosBtn').classList.toggle('set', todos.length > 0);
  }

  container.querySelector('#folderBtn').addEventListener('click', async () => {
    await api.workspace.pick();
    await refreshFolder();
  });
  container.querySelector('#todosBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTodosPopover(container, refreshTodos);
  });

  // Initial paint.
  paintThread(thread);
  await drawSessions('');
  await refreshFolder();
  await refreshTodos();
  updateTokens();
  reflectStreamingUI();
  setTimeout(() => composer.focus(), 60);

  /* ---- send / stream ---- */
  async function send() {
    const text = composer.value.trim();
    if (!text || streaming) return;
    const settings = await getSettings();
    convo.model = settings.model || convo.model;

    convo.messages.push({ role: 'user', content: text });
    composer.value = '';
    composer.style.height = 'auto';
    updateTokens();
    paintThread(thread);
    forceScroll(thread);
    await persistConvo();
    await drawSessions(container.querySelector('#sesSearch').value);

    // Build the message array (prepend system prompt if set).
    const preset = await activePreset(settings);
    const outgoing = [];
    if (preset?.content?.trim()) outgoing.push({ role: 'system', content: preset.content });
    outgoing.push(...convo.messages);

    // Assistant placeholder. The agent loop streams multiple turns into this
    // one message: `committed` holds finalised visible text + tool lines from
    // previous turns; `rawTurn` is the current turn's raw tokens.
    const asstMsg = { role: 'assistant', content: '' };
    convo.messages.push(asstMsg);
    streaming = true;
    autoScroll = true;
    reflectStreamingUI();
    paintThread(thread, /*streamingLast*/ true);
    forceScroll(thread);

    let committed = '';
    let rawTurn = '';
    let rafPending = false;

    const display = () => committed + rawTurn; // renderMarkdown strips action tags
    const flush = () => {
      rafPending = false;
      asstMsg.content = display();
      updateLastAssistant(thread, asstMsg.content, true);
      if (autoScroll) forceScroll(thread);
    };
    const scheduleFlush = () => { if (!rafPending) { rafPending = true; requestAnimationFrame(flush); } };

    // Commit the current turn's visible text before tool lines are appended.
    const commitTurn = () => {
      const visible = stripAgentTags(rawTurn).replace(/\s+$/, '');
      if (visible) committed += (committed ? '\n\n' : '') + visible;
      rawTurn = '';
    };

    unsubStream = api.mistral.onStream((msg) => {
      if (msg.type === 'token') {
        rawTurn += msg.delta;
        scheduleFlush();
      } else if (msg.type === 'turn') {
        commitTurn();
        scheduleFlush();
      } else if (msg.type === 'tool-start') {
        // Optimistic "running" line could go here; we render the result line below.
      } else if (msg.type === 'tool') {
        // Append a Claude-Code-style tool line as a markdown blockquote.
        const mark = msg.ok === false ? '⚠' : '✓';
        committed += `\n\n> \`${escapeHtml(msg.name)}\` — ${escapeHtml(msg.summary || (msg.ok ? 'done' : 'failed'))} ${mark}`;
        if (msg.todosChanged) refreshTodos();
        if (msg.workspaceChanged) refreshFolder();
        scheduleFlush();
      } else if (msg.type === 'done') {
        finish(msg.aborted, msg.content);
      } else if (msg.type === 'error') {
        finishError(msg.message);
      }
    });

    api.mistral.send({ messages: outgoing });

    function finish(aborted) {
      cleanupStream();
      commitTurn(); // fold in any trailing final-turn text
      asstMsg.content = committed.trim();
      if (!asstMsg.content && aborted) convo.messages.pop(); // nothing produced
      updateTokens();
      paintThread(thread);
      persistConvo();
      drawSessions(container.querySelector('#sesSearch').value);
      refreshTodos();
      if (aborted) toast('Generation stopped', 'info', 2000);
    }
    function finishError(message) {
      cleanupStream();
      commitTurn();
      asstMsg.content = committed.trim();
      if (!asstMsg.content) convo.messages.pop();
      paintThread(thread);
      toast(message || 'Request failed', 'error');
      persistConvo();
    }
  }

  function stop() {
    if (!streaming) return;
    api.mistral.abort();
  }

  function cleanupStream() {
    streaming = false;
    if (unsubStream) { unsubStream(); unsubStream = null; }
    reflectStreamingUI();
    composer.focus();
  }

  function reflectStreamingUI() {
    const head = container.querySelector('#thStreaming');
    head?.classList.toggle('hidden', !streaming);
    sendBtn.classList.toggle('hidden', streaming);
    stopBtn.classList.toggle('hidden', !streaming);
  }

  /* ---- sessions list ---- */
  async function drawSessions(query) {
    const list = container.querySelector('#sesList');
    if (!list) return;
    const sessions = await loadSessions();
    const q = (query || '').toLowerCase();
    const filtered = sessions.filter((s) => s.title.toLowerCase().includes(q));

    if (!filtered.length) {
      list.innerHTML = `<div class="empty" style="padding:30px 10px"><div class="sub">${q ? 'No matches.' : 'No sessions yet.\nStart chatting to build history.'}</div></div>`;
      return;
    }
    const activeId = convo.savedId || convo.id;
    list.innerHTML = filtered.map((s) => `
      <div class="ses ${s.id === activeId ? 'active' : ''}" data-id="${s.id}">
        <div class="ses-title">${escapeHtml(s.title || 'Untitled')}</div>
        <div class="ses-meta">
          <span class="when">${formatRelative(s.updatedAt)} · ${s.messageCount} msg</span>
          <span class="chip">${escapeHtml((s.model || '').replace('-latest', '').replace('mistral-', '') || 'chat')}</span>
        </div>
      </div>`).join('');
    list.querySelectorAll('.ses').forEach((el) =>
      el.addEventListener('click', () => openSessionById(el.dataset.id)));
  }

  async function openSessionById(id) {
    const sessions = await loadSessions();
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    await openSession(s, true);
    paintThread(thread);
    await drawSessions(container.querySelector('#sesSearch').value);
    updateTokens();
    forceScroll(thread);
  }
}

/* ---------------- thread painting ---------------- */
function paintThread(thread, streamingLast = false) {
  if (!convo.messages.length) {
    thread.innerHTML = `
      <div class="empty">
        <div class="glyph"><svg viewBox="0 0 16 16"><path d="M3 5.5h10v6H7l-2 2v-2H3z" stroke-width="1.4"/></svg></div>
        <div class="title">Start a conversation</div>
        <div class="sub">Ask Mistral anything. Your messages stream back token-by-token, with markdown and syntax highlighting.</div>
      </div>`;
    return;
  }
  thread.innerHTML = convo.messages.map((m, i) => {
    if (m.role === 'user') {
      return `<div class="msg-row user"><div class="bubble user">${escapeHtml(m.content)}</div></div>`;
    }
    const isLast = i === convo.messages.length - 1;
    const cursor = streamingLast && isLast ? '<span class="stream-cursor">▏</span>' : '';
    return `<div class="msg-row asst-row"><div class="asst">
        <div class="who">Assistant</div>
        <div class="msg-content">${renderMarkdown(m.content)}${cursor}</div>
      </div></div>`;
  }).join('');
  thread.querySelectorAll('.msg-content').forEach(bindCopyButtons);
}

/** Update just the streaming assistant message without rebuilding the thread. */
function updateLastAssistant(thread, text, withCursor) {
  const last = thread.querySelector('.asst-row:last-child .msg-content');
  if (!last) { paintThread(thread, true); return; }
  last.innerHTML = renderMarkdown(text) + (withCursor ? '<span class="stream-cursor">▏</span>' : '');
  bindCopyButtons(last);
}

function forceScroll(thread) { thread.scrollTop = thread.scrollHeight; }

/* ---------------- conversation transitions ---------------- */
async function newChat(repaint = true) {
  await persistConvo();
  const settings = await getSettings();
  convo = freshConvo(settings.model || 'mistral-large-latest');
  if (repaint) {
    const thread = document.querySelector('#thread');
    if (thread) paintThread(thread);
  }
}

async function openSession(session, repaint = true) {
  await persistConvo();
  convo = {
    id: session.id,
    savedId: session.id,
    title: session.title,
    model: session.model,
    createdAt: session.createdAt,
    messages: session.messages.map((m) => ({ role: m.role, content: m.content }))
  };
  if (repaint) {
    const thread = document.querySelector('#thread');
    if (thread) paintThread(thread);
  }
}

async function activePreset(settings) {
  const presets = (await store.get('presets')) || [];
  return presets.find((p) => p.id === settings.activePresetId) || presets[0] || null;
}

/* ---------------- todos popover ---------------- */
let todosPop = null;
function closeTodosPopover() {
  todosPop?.remove();
  todosPop = null;
  document.removeEventListener('click', onDocClickTodos);
}
function onDocClickTodos(e) {
  if (!e.target.closest('#todosPop') && !e.target.closest('#todosBtn')) closeTodosPopover();
}
async function toggleTodosPopover(container, onChange) {
  if (todosPop) { closeTodosPopover(); return; }
  const anchor = container.querySelector('#todosBtn');
  const todos = await api.todos.get();

  todosPop = document.createElement('div');
  todosPop.id = 'todosPop';
  todosPop.className = 'todos-pop';
  const list = todos.length
    ? todos.map((t) => `
        <div class="todo-item ${t.done ? 'done' : ''}" data-id="${t.id}">
          <span class="cbox ${t.done ? 'on' : ''}"></span>
          <span class="todo-text">${escapeHtml(t.text)}</span>
        </div>`).join('')
    : '<div class="todo-empty">No todos yet. The assistant will add them as it works.</div>';
  todosPop.innerHTML = `
    <div class="todos-head"><span class="lbl">Todos</span>${todos.length ? '<button class="btn ghost sm" id="todosClear">Clear all</button>' : ''}</div>
    <div class="todos-list">${list}</div>`;

  // Position under the anchor.
  const r = anchor.getBoundingClientRect();
  document.getElementById('overlayHost').appendChild(todosPop);
  todosPop.style.top = `${r.bottom + 6}px`;
  todosPop.style.right = `${window.innerWidth - r.right}px`;

  todosPop.querySelectorAll('.todo-item').forEach((el) =>
    el.addEventListener('click', async () => {
      await api.todos.toggle(el.dataset.id);
      closeTodosPopover();
      await onChange();
      toggleTodosPopover(container, onChange); // reopen with fresh state
    }));
  todosPop.querySelector('#todosClear')?.addEventListener('click', async () => {
    await api.todos.clear();
    closeTodosPopover();
    await onChange();
  });

  setTimeout(() => document.addEventListener('click', onDocClickTodos), 0);
}

/* ---------------- lifecycle ---------------- */
function destroy() {
  if (chatPage._onKey) { document.removeEventListener('keydown', chatPage._onKey); chatPage._onKey = null; }
  closeTodosPopover();
  // Note: we intentionally keep an active stream alive so it survives a quick
  // page switch; the subscription closes itself on done/error.
}

const chatPage = { render, destroy, _onKey: null };
export default chatPage;
