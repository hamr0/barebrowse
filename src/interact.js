/**
 * interact.js — Click, type, scroll, and press keys via CDP Input/DOM domains.
 *
 * All functions take a session-scoped CDP handle (from cdp.session()).
 * Coordinates come from DOM.getBoxModel which returns viewport-relative quads.
 */

/** Key definitions for special keys: key, code, keyCode (windowsVirtualKeyCode). */
const KEY_MAP = {
  Enter:      { key: 'Enter',     code: 'Enter',      keyCode: 13, text: '\r' },
  Tab:        { key: 'Tab',       code: 'Tab',         keyCode: 9,  text: '\t' },
  Escape:     { key: 'Escape',    code: 'Escape',      keyCode: 27 },
  Backspace:  { key: 'Backspace', code: 'Backspace',   keyCode: 8 },
  Delete:     { key: 'Delete',    code: 'Delete',      keyCode: 46 },
  ArrowUp:    { key: 'ArrowUp',   code: 'ArrowUp',     keyCode: 38 },
  ArrowDown:  { key: 'ArrowDown', code: 'ArrowDown',   keyCode: 40 },
  ArrowLeft:  { key: 'ArrowLeft', code: 'ArrowLeft',   keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home:       { key: 'Home',      code: 'Home',        keyCode: 36 },
  End:        { key: 'End',       code: 'End',         keyCode: 35 },
  PageUp:     { key: 'PageUp',    code: 'PageUp',      keyCode: 33 },
  PageDown:   { key: 'PageDown',  code: 'PageDown',    keyCode: 34 },
  Space:      { key: ' ',         code: 'Space',       keyCode: 32 },
};

/**
 * Get the viewport-relative center point of a DOM node.
 * Scrolls the element into view first to ensure valid coordinates.
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID from ARIA tree
 * @returns {Promise<{x: number, y: number}>}
 */
async function getCenter(session, backendNodeId) {
  await session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { model } = await session.send('DOM.getBoxModel', { backendNodeId });
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const [x1, y1, , , x3, y3] = model.content;
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
}

/**
 * Click an element by its backendDOMNodeId.
 * Scrolls into view, resolves coordinates, then dispatches mousePressed + mouseReleased.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID
 */
export async function click(session, backendNodeId) {
  const { x, y } = await getCenter(session, backendNodeId);
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });
}

/**
 * Type text into an element by its backendDOMNodeId.
 * Default: DOM.focus + Input.insertText (fast, no key events).
 * With { keyEvents: true }: dispatches keyDown/keyUp per character (triggers handlers).
 * With { clear: true }: selects all existing text and deletes it before typing.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID
 * @param {string} text - Text to type
 * @param {object} [opts]
 * @param {boolean} [opts.keyEvents=false] - Use char-by-char key events
 * @param {boolean} [opts.clear=false] - Clear existing content before typing
 */
export async function type(session, backendNodeId, text, opts = {}) {
  await session.send('DOM.focus', { backendNodeId });

  if (opts.clear) {
    // Select all (Ctrl+A) then delete
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, modifiers: 2, // 2 = Ctrl
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, modifiers: 2,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace',
      windowsVirtualKeyCode: 8,
    });
  }

  if (opts.keyEvents) {
    for (const char of text) {
      await session.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char });
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char });
    }
  } else {
    await session.send('Input.insertText', { text });
  }
}

/**
 * Press a special key (Enter, Tab, Escape, etc.).
 * Dispatches keyDown + keyUp for the named key.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {string} key - Key name (e.g. 'Enter', 'Tab', 'Escape', 'ArrowDown')
 */
export async function press(session, key) {
  const def = KEY_MAP[key];
  if (!def) throw new Error(`Unknown key: "${key}". Valid keys: ${Object.keys(KEY_MAP).join(', ')}`);
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode };
  if (def.text) base.text = def.text;
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Scroll the page via mouseWheel event.
 * Dispatches at viewport center by default, or at given coordinates.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} deltaY - Pixels to scroll (positive = down, negative = up)
 * @param {number} [x=400] - X coordinate for scroll event
 * @param {number} [y=300] - Y coordinate for scroll event
 */
export async function scroll(session, deltaY, x = 400, y = 300) {
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x, y, deltaX: 0, deltaY,
  });
}

/**
 * Hover over an element by its backendDOMNodeId.
 * Scrolls into view, then dispatches mouseMoved at center.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID
 */
export async function hover(session, backendNodeId) {
  const { x, y } = await getCenter(session, backendNodeId);
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y,
  });
}

/**
 * Select a value in a <select> element or custom dropdown.
 *
 * Strategy 1: Native <select> — set .value + dispatch 'change' event.
 * Strategy 2: Custom dropdown — click to open, find matching option, click it.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID of the select/combobox
 * @param {string} value - Value or visible text to select
 */
export async function select(session, backendNodeId, value) {
  // Resolve to a JS object so we can check tagName and set value
  const { object } = await session.send('DOM.resolveNode', { backendNodeId });

  // Try native <select> first
  const { result: tagResult } = await session.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { return this.tagName; }',
    returnByValue: true,
  });

  if (tagResult.value === 'SELECT') {
    // Native select: set value + dispatch change
    await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(v) {
        // Try by value first, then by visible text
        const opt = Array.from(this.options).find(o => o.value === v || o.textContent.trim() === v);
        if (opt) {
          this.value = opt.value;
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }`,
      arguments: [{ value }],
      returnByValue: true,
    });
    return;
  }

  // Custom dropdown: click to open, then find and click the matching option
  await click(session, backendNodeId);
  await new Promise((r) => setTimeout(r, 300)); // wait for dropdown to open

  // Search for a matching option in the ARIA tree
  const { result: found } = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const options = document.querySelectorAll('[role="option"], [role="menuitem"], li[role="option"]');
      for (const opt of options) {
        if (opt.textContent.trim() === ${JSON.stringify(value)}) {
          opt.click();
          return true;
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
}

/**
 * Drag one element to another.
 * Scrolls source into view, mouse down, move to target center, mouse up.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} fromNodeId - Source element backendDOMNodeId
 * @param {number} toNodeId - Target element backendDOMNodeId
 */
export async function drag(session, fromNodeId, toNodeId) {
  const from = await getCenter(session, fromNodeId);
  const to = await getCenter(session, toNodeId);

  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1,
  });
  // Intermediate move for drag recognition
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: midX, y: midY });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1,
  });
}

/**
 * Upload files to a file input element.
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID of the file input
 * @param {string[]} files - Absolute paths to files to upload
 */
export async function upload(session, backendNodeId, files) {
  await session.send('DOM.setFileInputFiles', { files, backendNodeId });
}
