/**
 * Minimal ANSI styling for the terminal. Colours are dropped when stdout is
 * not a TTY or `NO_COLOR` is set, so logs pipe cleanly.
 */

const enabled = process.stdout.isTTY === true && !process.env.NO_COLOR
const ESC = String.fromCharCode(27)

function wrap(code: string, text: string): string {
  return enabled ? `${ESC}[${code}m${text}${ESC}[0m` : text
}

/** Bold text. */
export const bold = (s: string): string => wrap('1', s)
/** Dim text. */
export const dim = (s: string): string => wrap('2', s)
/** Yellow text (warnings, fallbacks). */
export const yellow = (s: string): string => wrap('33', s)
/** Red text (errors). */
export const red = (s: string): string => wrap('31', s)
/** Green text (success). */
export const green = (s: string): string => wrap('32', s)
/** Cyan text (tool activity). */
export const cyan = (s: string): string => wrap('36', s)

/** A namespaced `[agent]` framework line. */
export const kitLine = (s: string): string => `${dim('[agent]')} ${s}`
/** A `[tool]` activity line. */
export const toolLine = (s: string): string => `${cyan('[tool]')} ${s}`
/** The assistant's reply framed for the scrollback. */
export function replyBlock(text: string): string {
  const body = text.trim() || dim('(no reply)')
  return `\n${bold('Bu')} ${body}\n`
}
