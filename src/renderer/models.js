/* Static model catalogue for the renderer (mirrors src/main/mistral.js).
 * Capabilities are display-only metadata for the About / model picker. */
export const SUPPORTED_MODELS = [
  'mistral-small-latest',
  'mistral-medium-latest',
  'mistral-large-latest',
  'codestral-latest'
];

export const MODEL_INFO = {
  'mistral-small-latest': { context: '32k context', caps: ['fast', 'function calling', 'json mode'] },
  'mistral-medium-latest': { context: '32k context', caps: ['function calling', 'json mode'] },
  'mistral-large-latest': { context: '128k context', caps: ['function calling', 'json mode', 'vision'] },
  'codestral-latest': { context: '256k context', caps: ['code', 'fill-in-the-middle'] }
};
