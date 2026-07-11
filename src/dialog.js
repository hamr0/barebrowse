/**
 * dialog.js — Shared JS-dialog decision core for both engines.
 *
 * A JS dialog (alert/confirm/prompt/beforeunload) surfaces differently per
 * protocol — CDP's `Page.javascriptDialogOpening` vs BiDi's
 * `browsingContext.userPromptOpened` — but the *decision* (accept? what prompt
 * text?) and the log entry are identical. This module single-sources both so
 * the CDP path (index.js) and the BiDi path (firefox-page.js) can't drift
 * (code-review Phase-3 finding #5).
 */

/**
 * Build a dialogLog entry from a normalized dialog descriptor.
 * @param {string} type - 'alert' | 'confirm' | 'prompt' | 'beforeunload'
 * @param {string} [message]
 * @returns {{type: string, message: string, timestamp: string}}
 */
export function dialogLogEntry(type, message) {
  return { type, message: message || '', timestamp: new Date().toISOString() };
}

/**
 * Decide how to answer a JS dialog. Default policy (both engines): accept
 * everything except `beforeunload` (dismiss = stay on page); a `prompt`
 * returns its default text. A caller-installed handler may override via
 * `{ accept, promptText }`; if the handler throws we keep the defaults so the
 * page never hangs waiting for a reply that never arrives.
 *
 * @param {{type: string, message?: string, defaultPrompt?: string}} dialog
 * @param {?(function({type,message,defaultPrompt}): (object|Promise<object>))} handler
 * @returns {Promise<{accept: boolean, promptText: string}>}
 */
export async function decideDialog({ type, message, defaultPrompt }, handler) {
  let accept = type !== 'beforeunload';
  let promptText = defaultPrompt || '';
  if (handler) {
    try {
      const decision = await handler({
        type,
        message: message || '',
        defaultPrompt: defaultPrompt || '',
      });
      if (decision && typeof decision === 'object') {
        if (typeof decision.accept === 'boolean') accept = decision.accept;
        if (typeof decision.promptText === 'string') promptText = decision.promptText;
      }
    } catch {
      // Handler threw — keep defaults so the page doesn't hang.
    }
  }
  return { accept, promptText };
}
