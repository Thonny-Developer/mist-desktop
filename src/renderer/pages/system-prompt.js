/* System Prompt editor — preset sidebar + monospace editor with a
 * synced line-number gutter, live char/token counters, active-preset marker. */
import {
  store, getSettings, saveSettings, escapeHtml, estimateTokens, uid, toast, confirmDialog
} from '../shared.js';

let presets = [];
let editingId = null;   // preset currently in the editor
let dirty = false;

async function render(container, ctx) {
  const settings = await getSettings();
  presets = (await store.get('presets')) || [];
  if (!presets.length) presets = [{ id: 'general', name: 'General', content: '' }];

  // Start on the active preset (or the first).
  if (!editingId || !presets.find((p) => p.id === editingId)) {
    editingId = settings.activePresetId && presets.find((p) => p.id === settings.activePresetId)
      ? settings.activePresetId : presets[0].id;
  }

  container.innerHTML = `
    <div class="prompt">
      <aside class="presets">
        <div class="presets-head">
          <span class="lbl">Presets</span>
          <button class="icon-btn" id="addPreset" title="New preset"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
        </div>
        <div class="presets-list scroll" id="presetList"></div>
      </aside>

      <section class="editor-pane">
        <div class="editor-head">
          <input class="field mono" id="presetName" style="max-width:240px" />
          <span class="note" id="activeFlag">active</span>
          <span class="spacer"></span>
          <button class="btn ghost sm" id="makeActive">Set active</button>
          <button class="btn primary sm" id="saveBtn">Save</button>
        </div>

        <div class="editor-body">
          <div class="gutter" id="gutter">1</div>
          <textarea class="editor-area" id="editor" spellcheck="false"
            placeholder="You are a helpful assistant…"></textarea>
        </div>

        <div class="editor-foot">
          <span class="meta mono" id="charCount">0 chars</span>
          <span class="meta mono" id="tokCount">~0 tokens</span>
          <span class="spacer"></span>
          <span class="note hidden" id="unsaved">unsaved changes</span>
          <span class="meta mono">markdown · monospace</span>
        </div>
      </section>
    </div>`;

  const editor = container.querySelector('#editor');
  const gutter = container.querySelector('#gutter');
  const nameInput = container.querySelector('#presetName');

  const loadIntoEditor = (id) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    editingId = id;
    nameInput.value = p.name;
    editor.value = p.content;
    dirty = false;
    syncGutter();
    updateCounts();
    drawList(settings);
    reflectActive(settings);
    container.querySelector('#unsaved').classList.add('hidden');
  };

  const syncGutter = () => {
    const lines = editor.value.split('\n').length || 1;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    gutter.textContent = s;
    gutter.scrollTop = editor.scrollTop;
  };
  const updateCounts = () => {
    const len = editor.value.length;
    container.querySelector('#charCount').textContent = `${len.toLocaleString()} chars`;
    container.querySelector('#tokCount').textContent = `~${estimateTokens(editor.value).toLocaleString()} tokens`;
  };
  const markDirty = () => {
    dirty = true;
    container.querySelector('#unsaved').classList.remove('hidden');
  };

  editor.addEventListener('input', () => { syncGutter(); updateCounts(); markDirty(); });
  editor.addEventListener('scroll', () => { gutter.scrollTop = editor.scrollTop; });
  nameInput.addEventListener('input', markDirty);

  container.querySelector('#saveBtn').addEventListener('click', save);
  container.querySelector('#addPreset').addEventListener('click', addPreset);
  container.querySelector('#makeActive').addEventListener('click', () => setActive(settings));

  function drawListInner() { drawList(settings); }

  async function save() {
    const p = presets.find((x) => x.id === editingId);
    if (!p) return;
    const name = nameInput.value.trim();
    if (!name) { nameInput.classList.add('invalid'); toast('Name the preset first', 'error'); return; }
    nameInput.classList.remove('invalid');
    p.name = name;
    p.content = editor.value;
    await store.set('presets', presets);
    dirty = false;
    container.querySelector('#unsaved').classList.add('hidden');
    drawListInner();
    toast('Preset saved', 'success', 1600);
  }

  async function addPreset() {
    const p = { id: uid(), name: 'New preset', content: '' };
    presets.push(p);
    await store.set('presets', presets);
    loadIntoEditor(p.id);
    nameInput.focus();
    nameInput.select();
  }

  async function setActive(s) {
    await saveSettings({ activePresetId: editingId });
    s.activePresetId = editingId;
    reflectActive(s);
    drawList(s);
    toast('Active system prompt updated', 'success', 1800);
  }

  function reflectActive(s) {
    const isActive = s.activePresetId === editingId;
    container.querySelector('#activeFlag').classList.toggle('hidden', !isActive);
    container.querySelector('#makeActive').classList.toggle('hidden', isActive);
  }

  async function deletePreset(id) {
    if (presets.length <= 1) { toast('Keep at least one preset', 'error'); return; }
    const p = presets.find((x) => x.id === id);
    const ok = await confirmDialog({ title: 'Delete preset?', body: `“${p?.name}” will be removed.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    presets = presets.filter((x) => x.id !== id);
    await store.set('presets', presets);
    if (settings.activePresetId === id) { await saveSettings({ activePresetId: presets[0].id }); settings.activePresetId = presets[0].id; }
    if (editingId === id) loadIntoEditor(presets[0].id);
    else drawList(settings);
  }

  function drawList(s) {
    const list = container.querySelector('#presetList');
    list.innerHTML = presets.map((p) => `
      <div class="preset ${p.id === editingId ? 'active' : ''}" data-id="${p.id}">
        <span class="dotac" style="visibility:${p.id === s.activePresetId ? 'visible' : 'hidden'}"></span>
        <span class="pname">${escapeHtml(p.name)}</span>
        <span class="icon-btn del" data-act="del" title="Delete" style="width:20px;height:20px;border:0"><svg viewBox="0 0 16 16"><path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9"/></svg></span>
      </div>`).join('');
    list.querySelectorAll('.preset').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-act="del"]')) { deletePreset(el.dataset.id); return; }
        if (dirty && el.dataset.id !== editingId) {
          confirmDialog({ title: 'Discard changes?', body: 'You have unsaved edits to this preset.', confirmText: 'Discard' })
            .then((ok) => { if (ok) loadIntoEditor(el.dataset.id); });
        } else {
          loadIntoEditor(el.dataset.id);
        }
      });
    });
  }

  loadIntoEditor(editingId);
  setTimeout(() => editor.focus(), 60);
}

export default { render };
