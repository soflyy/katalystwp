/**
 * Minimal, brand-styled terminal prompts for KatalystWP.
 *
 * Built on @clack/core (solid cross-platform key handling, raw-mode, resize)
 * with our own rendering — no gutter rails, just:
 *
 *   ? Project directory
 *   > my-site
 *
 * and a horizontal, arrow-key + space multiselect for the agent picker.
 * Imported dynamically (only when a TTY prompt is actually shown), so
 * non-interactive callers never need node_modules.
 */

import { TextPrompt, MultiSelectPrompt, SelectPrompt, isCancel } from '@clack/core';
import { pink, dim } from './engine.js';

export { isCancel };

const INVERSE = (s) => `\u001b[7m${s}\u001b[27m`;
const Q = (msg) => `${pink('?')} ${msg}`;
const ARROW = pink('>');

// One-line text question:
//   ? <message>
//   > typed-input▌            (dim placeholder while empty)
export async function question(message, { placeholder = '', defaultValue = '', validate } = {}) {
  const p = new TextPrompt({
    placeholder,
    defaultValue,
    validate,
    render() {
      if (this.state === 'submit') return `${Q(dim(message))}\n${dim('>')} ${this.value || dim(placeholder)}`;
      if (this.state === 'cancel') return `${Q(dim(message))}\n${dim('> cancelled')}`;
      const input = this.userInputWithCursor;
      const line = this.userInput ? input : `${input}${dim(placeholder)}`;
      const err = this.state === 'error' ? `\n  ${pink('✖')} ${this.error}` : '';
      return `${Q(message)}\n${ARROW} ${line}${err}`;
    },
  });
  const v = await p.prompt();
  return typeof v === 'string' ? v.trim() : v;
}

// Horizontal multiselect (space toggles, arrows move, enter confirms):
//   ? <message>
//   > [x] Claude Code   [ ] Cursor CLI   [ ] Codex CLI
export async function pick(message, options, { initialValues = [], hint = 'space toggles · enter confirms' } = {}) {
  const p = new MultiSelectPrompt({
    options,
    initialValues,
    required: false,
    render() {
      const selected = this.value ?? [];
      if (this.state === 'submit' || this.state === 'cancel') {
        const labels = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
        return `${Q(dim(message))}\n${dim('>')} ${labels.length ? labels.join(', ') : dim('none')}`;
      }
      const line = options.map((o, i) => {
        const on = selected.includes(o.value);
        const cell = `[${on ? 'x' : ' '}] ${o.label}`;
        if (i === this.cursor) return on ? INVERSE(pink(cell)) : INVERSE(cell);
        return on ? pink(cell) : dim(cell);
      }).join('   ');
      return `${Q(message)}\n${ARROW} ${line}  ${dim(`· ${hint}`)}`;
    },
  });
  return p.prompt();
}

// Vertical single select (for the manager's env / action lists):
//   ? <message>
//   > name        detail
//     other-name  detail
export async function choose(message, options, { initialValue } = {}) {
  const p = new SelectPrompt({
    options,
    initialValue,
    render() {
      if (this.state === 'submit' || this.state === 'cancel') {
        const chosen = options.find((o) => o.value === this.value);
        return `${Q(dim(message))}\n${dim('>')} ${chosen ? chosen.label : dim('none')}`;
      }
      const rows = options.map((o, i) => {
        const line = o.hint ? `${o.label}  ${dim(o.hint)}` : o.label;
        return i === this.cursor ? `${ARROW} ${pink(o.label)}${o.hint ? `  ${dim(o.hint)}` : ''}` : `  ${line}`;
      });
      return `${Q(message)}\n${rows.join('\n')}`;
    },
  });
  return p.prompt();
}

// Single in-place progress line: tick('Installing WordPress') redraws
//   … Installing WordPress
// done() clears the line.
export function progressLine() {
  let active = false;
  return {
    tick(msg) {
      active = true;
      process.stdout.write(`\r\u001b[2K  ${pink('…')} ${dim(msg)}`);
    },
    done() {
      if (active) process.stdout.write('\r\u001b[2K');
      active = false;
    },
  };
}
