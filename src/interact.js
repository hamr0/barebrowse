/**
 * interact.js — Click, type, and scroll via CDP Input/DOM domains.
 *
 * All functions take a session-scoped CDP handle (from cdp.session()).
 * Coordinates come from DOM.getBoxModel which returns viewport-relative quads.
 */

/**
 * Get the viewport-relative center point of a DOM node.
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID from ARIA tree
 * @returns {Promise<{x: number, y: number}>}
 */
async function getCenter(session, backendNodeId) {
  const { model } = await session.send('DOM.getBoxModel', { backendNodeId });
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const [x1, y1, , , x3, y3] = model.content;
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
}

/**
 * Click an element by its backendDOMNodeId.
 * Resolves coordinates via DOM.getBoxModel, then dispatches mousePressed + mouseReleased.
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
 *
 * @param {object} session - Session-scoped CDP handle
 * @param {number} backendNodeId - Backend DOM node ID
 * @param {string} text - Text to type
 * @param {object} [opts]
 * @param {boolean} [opts.keyEvents=false] - Use char-by-char key events
 */
export async function type(session, backendNodeId, text, opts = {}) {
  await session.send('DOM.focus', { backendNodeId });

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
