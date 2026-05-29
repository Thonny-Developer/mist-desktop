'use strict';

const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const mistral = require('./mistral');
const agent = require('./agent');

const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ *
 *  Persistent store
 *  - `settings`  : user preferences (model, sliders, theme, ...)
 *  - `sessions`  : chat history [{id,title,model,createdAt,...,messages}]
 *  - `presets`   : system-prompt presets
 *  - `windowState`: last size/position
 *  The API key is stored separately, encrypted with safeStorage when available.
 * ------------------------------------------------------------------ */
const store = new Store({
  name: 'mistral-cli',
  defaults: {
    settings: {
      endpoint: mistral.DEFAULT_ENDPOINT,
      model: 'mistral-large-latest',
      temperature: 0.7,
      topP: 1,
      maxTokens: 0, // 0 = unset
      stream: true,
      renderMarkdown: true,
      outputFormat: 'markdown',
      theme: 'dark',
      fontSize: 14,
      collapseSidebar: false,
      activePresetId: 'general'
    },
    sessions: [],
    presets: defaultPresets(),
    workingDir: '',   // agent file-tool sandbox root
    todos: [],        // agent todo list
    windowState: { width: 1180, height: 760, x: undefined, y: undefined, maximized: false }
  }
});

/** Built-in system-prompt presets shipped on first run. */
function defaultPresets() {
  return [
    {
      id: 'general',
      name: 'General',
      content: 'You are a helpful, concise assistant. Answer clearly and accurately.'
    },
    {
      id: 'code',
      name: 'Code Assistant',
      content:
        'You are a senior software engineer.\nAnswer concisely. Prefer code over prose.\n\n- Always use modern syntax (ES2022+, async/await).\n- When refactoring, preserve public APIs.\n- Explain trade-offs only when asked.'
    },
    {
      id: 'translator',
      name: 'Translator',
      content:
        'You are a professional translator. Translate the user\'s text faithfully, preserving tone and formatting. Do not add commentary unless asked.'
    },
    {
      id: 'analyst',
      name: 'Analyst',
      content:
        'You are a rigorous data and business analyst. Break problems down, state assumptions explicitly, and support conclusions with reasoning.'
    }
  ];
}

let mainWindow = null;
// Tracks the in-flight streaming request so it can be aborted.
let activeController = null;

/* ------------------------------------------------------------------ *
 *  Long-term memory
 *  A plain Markdown file in the app's userData dir that the assistant can
 *  append to (via <remember>…</remember> blocks) and the user can edit in
 *  Settings. Injected into every request as a leading system message.
 * ------------------------------------------------------------------ */
const memoryPath = path.join(app.getPath('userData'), 'memory.md');
const MEMORY_HEADER =
  '# Mist Desktop — Memory\n\nDurable facts about the user and ongoing work. Edit freely.\n';

function ensureMemory() {
  if (!fs.existsSync(memoryPath)) fs.writeFileSync(memoryPath, MEMORY_HEADER, 'utf-8');
}
function readMemory() {
  try { ensureMemory(); return fs.readFileSync(memoryPath, 'utf-8'); }
  catch { return ''; }
}
function writeMemory(content) {
  try { fs.writeFileSync(memoryPath, content ?? '', 'utf-8'); return true; }
  catch { return false; }
}
function appendMemory(items) {
  if (!items || !items.length) return;
  const current = readMemory().replace(/\s*$/, '');
  const lines = items.map((i) => `- ${i.replace(/\s+/g, ' ').trim()}`).join('\n');
  writeMemory(`${current}\n${lines}\n`);
}

/* ------------------------------------------------------------------ *
 *  Agent system prompt
 *  Describes the available tools (Claude-Code style) plus live state:
 *  working folder, open todos, and long-term memory.
 * ------------------------------------------------------------------ */
const AGENT_INSTRUCTIONS = [
  'You are Mist Desktop, an agentic assistant that runs on the user\'s computer and can take real actions on their machine, similar to Claude Code.',
  '',
  'To act, emit one or more action blocks anywhere in your reply, each on its own:',
  '<action>{"tool":"<name>", ...args}</action>',
  'The JSON must be valid and on a single logical block. After you emit actions, the system executes them and replies with "Tool results:"; then you continue. When the task is fully done and you have no more actions, reply normally WITHOUT any action block.',
  '',
  'Available tools:',
  '- {"tool":"set_working_folder"} — open a dialog asking the user to pick the folder to work in. Do this first if no working folder is set and you need files.',
  '- {"tool":"list_files","path":"."} — list files and directories (path is relative to the working folder).',
  '- {"tool":"read_file","path":"src/x.js"} — read a file.',
  '- {"tool":"write_file","path":"src/x.js","content":"…"} — create or overwrite a file (provide the FULL file content).',
  '- {"tool":"delete_file","path":"src/x.js"} — delete a file or folder.',
  '- {"tool":"add_todo","text":"…"} — add a todo item.',
  '- {"tool":"complete_todo","id":"<id>"} — mark a todo done (id is shown in the todo list).',
  '- {"tool":"list_todos"} — list current todos.',
  '- {"tool":"remember","text":"…"} — save a durable fact to long-term memory.',
  '',
  'Guidelines:',
  '- All file paths are relative to the working folder; you cannot read or write outside it.',
  '- For multi-step work, plan with add_todo first and complete_todo each item as you finish it.',
  '- Save lasting, reusable facts about the user or project with remember. Never mention these mechanisms to the user.',
  '- Keep narration brief; let the actions do the work.'
].join('\n');

/** Build the full agent system message including live state. */
function buildAgentSystem() {
  const mem = readMemory().trim();
  const work = store.get('workingDir') || '';
  const todos = store.get('todos') || [];
  const todoStr = todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] (${t.id}) ${t.text}`).join('\n')
    : '(none)';
  return [
    AGENT_INSTRUCTIONS,
    '',
    `Working folder: ${work || '(none — ask to set one with set_working_folder)'}`,
    '',
    'Open todos:',
    todoStr,
    '',
    'Current long-term memory:',
    mem || '(empty)'
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 *  Window lifecycle
 * ------------------------------------------------------------------ */
function createWindow() {
  const state = store.get('windowState');

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0e10',
    frame: false, // custom titlebar drawn in the renderer
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false // preload uses Node (electron-store via IPC stays in main)
    }
  });

  if (state.maximized) mainWindow.maximize();

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
    // Forward renderer console + load failures to the terminal during dev.
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      console.log(`[renderer:${level}] ${message} (${source}:${line})`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.log(`[did-fail-load] ${code} ${desc} ${url}`);
    });
  }

  // Persist window geometry on resize/move (debounced) and on close.
  const persist = debounce(saveWindowState, 400);
  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('close', saveWindowState);

  // Keep maximize state in sync for the renderer's titlebar button.
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximized', false));

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function saveWindowState() {
  if (!mainWindow) return;
  const maximized = mainWindow.isMaximized();
  // When maximized, keep the previous restored bounds so unmaximize is sane.
  if (!maximized) {
    const b = mainWindow.getBounds();
    store.set('windowState', { ...b, maximized: false });
  } else {
    store.set('windowState', { ...store.get('windowState'), maximized: true });
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ *
 *  Secure API key storage (safeStorage with plaintext fallback)
 * ------------------------------------------------------------------ */
function setApiKey(key) {
  if (!key) {
    store.delete('apiKey');
    store.delete('apiKeyEnc');
    return;
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(key);
    store.set('apiKeyEnc', enc.toString('base64'));
    store.delete('apiKey'); // never keep a plaintext copy
  } else {
    store.set('apiKey', key);
    store.delete('apiKeyEnc');
  }
}

function getApiKey() {
  const enc = store.get('apiKeyEnc');
  if (enc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return '';
    }
  }
  return store.get('apiKey', '');
}

/* ------------------------------------------------------------------ *
 *  IPC: persistent store
 * ------------------------------------------------------------------ */
ipcMain.handle('store:get', (_e, key) => store.get(key));
ipcMain.handle('store:set', (_e, key, value) => {
  store.set(key, value);
  return true;
});
ipcMain.handle('store:delete', (_e, key) => {
  store.delete(key);
  return true;
});

// Long-term memory channels.
ipcMain.handle('memory:get', () => readMemory());
ipcMain.handle('memory:set', (_e, content) => writeMemory(content));
ipcMain.handle('memory:path', () => memoryPath);

// Working folder (agent file sandbox).
ipcMain.handle('workspace:get', () => store.get('workingDir') || '');
ipcMain.handle('workspace:pick', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return store.get('workingDir') || '';
  store.set('workingDir', res.filePaths[0]);
  return res.filePaths[0];
});
ipcMain.handle('workspace:clear', () => { store.set('workingDir', ''); return ''; });

// Todos (shared between the agent and the UI).
ipcMain.handle('todos:get', () => store.get('todos') || []);
ipcMain.handle('todos:toggle', (_e, id) => {
  const todos = store.get('todos') || [];
  const t = todos.find((x) => x.id === id);
  if (t) t.done = !t.done;
  store.set('todos', todos);
  return todos;
});
ipcMain.handle('todos:clear', () => { store.set('todos', []); return []; });

// API key gets its own channels so the encrypted value never leaves main verbatim.
ipcMain.handle('apikey:get', () => getApiKey());
ipcMain.handle('apikey:has', () => Boolean(getApiKey()));
ipcMain.handle('apikey:set', (_e, key) => {
  setApiKey(key);
  return true;
});
ipcMain.handle('apikey:encrypted', () => safeStorage.isEncryptionAvailable());

/* ------------------------------------------------------------------ *
 *  IPC: window controls
 * ------------------------------------------------------------------ */
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false);

/* ------------------------------------------------------------------ *
 *  IPC: Mistral API
 *  Streaming uses fire-and-forget `send` + push events on 'mistral:stream'.
 * ------------------------------------------------------------------ */
ipcMain.on('mistral:send', async (event, { messages }) => {
  const settings = store.get('settings');
  const apiKey = getApiKey();

  // Abort any prior in-flight request before starting a new one.
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const controller = activeController;

  const reply = (msg) => {
    if (!event.sender.isDestroyed()) event.sender.send('mistral:stream', msg);
  };

  // Prepend the agent system message (tools + live state) so the model always
  // knows what it can do and what the current context is.
  const baseMessages = [{ role: 'system', content: buildAgentSystem() }, ...messages];
  const ctx = { store, getWindow: () => mainWindow, appendMemory };

  try {
    await agent.run({
      baseMessages,
      settings,
      apiKey,
      signal: controller.signal,
      emit: reply,
      ctx
    });
  } catch (err) {
    reply({ type: 'error', message: err.message, code: err.code || 'unknown' });
  } finally {
    if (activeController === controller) activeController = null;
  }
});

ipcMain.on('mistral:abort', () => {
  if (activeController) activeController.abort();
});

ipcMain.handle('mistral:test', async () => {
  const settings = store.get('settings');
  return mistral.testConnection({ settings, apiKey: getApiKey() });
});

ipcMain.handle('mistral:models', async () => {
  const settings = store.get('settings');
  try {
    return await mistral.listModels({ settings, apiKey: getApiKey() });
  } catch {
    return mistral.SUPPORTED_MODELS;
  }
});

/* ------------------------------------------------------------------ *
 *  IPC: export a session to disk (.md / .json)
 * ------------------------------------------------------------------ */
ipcMain.handle('session:export', async (_e, { session, format }) => {
  const ext = format === 'json' ? 'json' : 'md';
  const safeTitle = (session.title || 'session').replace(/[^\w\- ]+/g, '').slice(0, 60).trim() || 'session';

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Export session',
    defaultPath: `${safeTitle}.${ext}`,
    filters:
      ext === 'json'
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'Markdown', extensions: ['md'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const content = ext === 'json' ? JSON.stringify(session, null, 2) : sessionToMarkdown(session);
  await fs.promises.writeFile(filePath, content, 'utf-8');
  return { ok: true, filePath };
});

function sessionToMarkdown(session) {
  const lines = [];
  lines.push(`# ${session.title || 'Untitled session'}`, '');
  lines.push(`- **Model:** ${session.model || 'unknown'}`);
  lines.push(`- **Created:** ${new Date(session.createdAt).toLocaleString()}`);
  lines.push(`- **Messages:** ${session.messageCount ?? session.messages?.length ?? 0}`, '', '---', '');
  for (const m of session.messages || []) {
    const who = m.role === 'user' ? '## You' : m.role === 'assistant' ? '## Mistral' : `## ${m.role}`;
    lines.push(who, '', m.content || '', '');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 *  App lifecycle
 * ------------------------------------------------------------------ */
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
