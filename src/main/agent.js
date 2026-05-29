'use strict';

/**
 * Agentic loop (main process) — a Claude-Code-style tool runner.
 *
 * Each turn we stream a completion from the model. The model can emit one or
 * more action blocks:
 *
 *   <action>{"tool":"write_file","path":"x.js","content":"…"}</action>
 *
 * We parse them, execute via the tool layer, feed the results back as a new
 * message, and loop — until the model replies without any action block (the
 * final answer). All progress is reported through the `emit` callback as
 * structured stream events the renderer assembles into one assistant message.
 */

const mistral = require('./mistral');
const tools = require('./tools');

const MAX_TURNS = 10; // hard cap so a misbehaving model can't loop forever

/** Pull every <action>…</action> block and parse the JSON inside. */
function parseActions(text) {
  const re = /<action>\s*([\s\S]*?)\s*<\/action>/gi;
  const actions = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const json = JSON.parse(raw);
      if (json && json.tool) actions.push(json);
      else actions.push({ __error: 'missing "tool" field' });
    } catch (e) {
      actions.push({ __error: e.message });
    }
  }
  return actions;
}

function stripTags(text) {
  return (text || '')
    .replace(/<action>[\s\S]*?<\/action>/gi, '')
    .replace(/<action>[\s\S]*$/i, '')
    .replace(/<remember>[\s\S]*?<\/remember>/gi, '')
    .replace(/<remember>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Run the loop.
 * @param {Object}   o
 * @param {Array}    o.baseMessages  Full message array (incl. system prompts).
 * @param {Object}   o.settings
 * @param {string}   o.apiKey
 * @param {AbortSignal} o.signal
 * @param {Function} o.emit          Stream-event sink.
 * @param {Object}   o.ctx           Tool context ({ store, getWindow, appendMemory }).
 */
async function run({ baseMessages, settings, apiKey, signal, emit, ctx }) {
  const work = [...baseMessages];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let text = '';
    let result;
    try {
      result = await mistral.sendMessage({
        messages: work,
        settings,
        apiKey,
        signal,
        onToken: (delta) => { text += delta; emit({ type: 'token', delta }); }
      });
    } catch (e) {
      if (e.code === 'aborted') { emit({ type: 'done', content: '', aborted: true }); return; }
      emit({ type: 'error', message: e.message, code: e.code || 'unknown' });
      return;
    }

    text = result.content || text;

    // Aborted mid-stream: keep whatever we have, stop the loop.
    if (result.aborted) {
      emit({ type: 'done', content: stripTags(text), aborted: true, usage: result.usage });
      return;
    }

    const actions = parseActions(text);
    if (!actions.length) {
      emit({ type: 'done', content: stripTags(text), usage: result.usage });
      return;
    }

    // The model wants to act. Record its raw turn and mark the boundary so the
    // renderer commits the visible text before tool lines appear.
    work.push({ role: 'assistant', content: text });
    emit({ type: 'turn' });

    const results = [];
    for (const act of actions) {
      if (act.__error) {
        emit({ type: 'tool', name: '(invalid)', ok: false, summary: `invalid action JSON: ${act.__error}` });
        results.push({ tool: '(invalid)', output: `Error: could not parse action — ${act.__error}` });
        continue;
      }
      emit({ type: 'tool-start', name: act.tool });
      const r = await tools.exec(act, ctx);
      emit({
        type: 'tool',
        name: act.tool,
        ok: r.ok,
        summary: r.summary,
        error: r.error,
        todosChanged: !!r.todosChanged,
        workspaceChanged: !!r.workspaceChanged
      });
      results.push({ tool: act.tool, output: r.output });

      if (signal?.aborted) { emit({ type: 'done', content: stripTags(text), aborted: true }); return; }
    }

    // Feed tool results back to the model for the next turn.
    work.push({
      role: 'user',
      content: 'Tool results:\n' + results.map((r) => `• ${r.tool}: ${r.output}`).join('\n')
    });
  }

  emit({ type: 'done', content: '_Reached the maximum number of tool steps for one request._' });
}

module.exports = { run, stripTags };
