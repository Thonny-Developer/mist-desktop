'use strict';

/**
 * Agent tool layer (main process).
 *
 * Each tool takes a parsed action object + a `ctx` ({ store, getWindow,
 * appendMemory }) and returns a uniform result:
 *   { ok, summary, output, error?, todosChanged?, workspaceChanged? }
 *     - summary : short human string for the chat UI
 *     - output  : text fed back to the model as the tool result
 *
 * All filesystem access is sandboxed to the user's chosen working folder;
 * paths that escape it are rejected.
 */

const { dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const MAX_READ_BYTES = 20_000; // keep file reads from blowing the context window
const IGNORE = new Set(['node_modules', '.git', '.DS_Store']);

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Resolve a relative path inside the working folder, or throw. */
function resolveInWork(ctx, rel) {
  const work = ctx.store.get('workingDir');
  if (!work) throw new Error('No working folder set — call set_working_folder first.');
  const root = path.resolve(work);
  const abs = path.resolve(root, rel || '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Path escapes the working folder.');
  }
  return abs;
}

/* ---------------- filesystem tools ---------------- */
async function pickFolder(ctx) {
  const win = ctx.getWindow();
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a working folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) {
    return { ok: false, summary: 'folder selection cancelled', output: 'User cancelled folder selection.' };
  }
  ctx.store.set('workingDir', res.filePaths[0]);
  return {
    ok: true,
    summary: `working folder set · ${res.filePaths[0]}`,
    output: `OK: working folder is now ${res.filePaths[0]}`,
    workspaceChanged: true
  };
}

function listFiles(a, ctx) {
  const abs = resolveInWork(ctx, a.path || '.');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !IGNORE.has(e.name))
    .sort((x, y) => (x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name) : x.isDirectory() ? -1 : 1));
  const lines = entries.map((e) => (e.isDirectory() ? `[dir]  ${e.name}/` : `       ${e.name}`));
  return {
    ok: true,
    summary: `listed ${entries.length} item(s) in ${a.path || '.'}`,
    output: lines.join('\n') || '(empty folder)'
  };
}

function readFile(a, ctx) {
  if (!a.path) throw new Error('read_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  const buf = fs.readFileSync(abs, 'utf-8');
  const out = buf.length > MAX_READ_BYTES ? buf.slice(0, MAX_READ_BYTES) + '\n…(truncated)' : buf;
  return { ok: true, summary: `read ${a.path} (${buf.length} B)`, output: out || '(empty file)' };
}

function writeFile(a, ctx) {
  if (!a.path) throw new Error('write_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  const existed = fs.existsSync(abs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, a.content ?? '', 'utf-8');
  const bytes = Buffer.byteLength(a.content || '', 'utf-8');
  return {
    ok: true,
    summary: `${existed ? 'edited' : 'created'} ${a.path} (${bytes} B)`,
    output: `OK: ${existed ? 'overwrote' : 'created'} ${a.path}`
  };
}

function deleteFile(a, ctx) {
  if (!a.path) throw new Error('delete_file requires "path".');
  const abs = resolveInWork(ctx, a.path);
  if (!fs.existsSync(abs)) return { ok: false, summary: `not found: ${a.path}`, output: `Error: ${a.path} does not exist.` };
  fs.rmSync(abs, { recursive: true, force: true });
  return { ok: true, summary: `deleted ${a.path}`, output: `OK: deleted ${a.path}` };
}

/* ---------------- todo tools ---------------- */
function addTodo(a, ctx) {
  if (!a.text) throw new Error('add_todo requires "text".');
  const todos = ctx.store.get('todos') || [];
  const item = { id: uid(), text: String(a.text), done: false, createdAt: Date.now() };
  todos.push(item);
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo added · ${item.text}`, output: `OK: added todo ${item.id} — "${item.text}"`, todosChanged: true };
}

function completeTodo(a, ctx) {
  const todos = ctx.store.get('todos') || [];
  const t = todos.find((x) => x.id === a.id || x.text === a.text);
  if (!t) return { ok: false, summary: 'todo not found', output: 'Error: no matching todo.' };
  t.done = true;
  ctx.store.set('todos', todos);
  return { ok: true, summary: `todo done · ${t.text}`, output: `OK: completed "${t.text}"`, todosChanged: true };
}

function listTodos(ctx) {
  const todos = ctx.store.get('todos') || [];
  const out = todos.length
    ? todos.map((t) => `[${t.done ? 'x' : ' '}] (${t.id}) ${t.text}`).join('\n')
    : '(no todos)';
  return { ok: true, summary: `${todos.length} todo(s)`, output: out };
}

/* ---------------- memory tool ---------------- */
function remember(a, ctx) {
  if (!a.text) throw new Error('remember requires "text".');
  ctx.appendMemory([String(a.text)]);
  return { ok: true, summary: `remembered · ${a.text}`, output: 'OK: saved to long-term memory.' };
}

/* ---------------- dispatcher ---------------- */
async function exec(action, ctx) {
  try {
    switch (action.tool) {
      case 'set_working_folder': return await pickFolder(ctx);
      case 'list_files': return listFiles(action, ctx);
      case 'read_file': return readFile(action, ctx);
      case 'write_file': return writeFile(action, ctx);
      case 'delete_file': return deleteFile(action, ctx);
      case 'add_todo': return addTodo(action, ctx);
      case 'complete_todo': return completeTodo(action, ctx);
      case 'list_todos': return listTodos(ctx);
      case 'remember': return remember(action, ctx);
      default:
        return { ok: false, summary: `unknown tool: ${action.tool}`, output: `Error: unknown tool "${action.tool}".` };
    }
  } catch (e) {
    return { ok: false, summary: `${action.tool || 'tool'} failed`, error: e.message, output: `Error: ${e.message}` };
  }
}

module.exports = { exec };
