/**
 * Paste-detection helpers for the dashboard's command parser.
 *
 * These exist to recover gracefully when users carry CLI syntax into the
 * dashboard chat — the most common mistakes are:
 *
 *   1. Leaving `--` between the slash command and the URL (npm convention).
 *      Example: `/explore -- https://shop.com/ --features login`
 *      → that's how npm passes flags through to scripts; in the dashboard
 *      there's no npm in the loop, so `--` ends up parsed as the URL and
 *      the URL validator rejects it.
 *
 *   2. Pasting the entire `npm run …` line.
 *      Example: `npm run explore -- https://shop.com/ --features login`
 *      → the gateway treats it as an unknown command. Without a hint,
 *      users don't know whether it's a typo or a missing feature.
 *
 * The fixes here are deliberately narrow: only intervene when we're highly
 * confident about the user's intent. Otherwise let the normal validators
 * run and produce their own error.
 */

export interface LeadingDashFix {
  /** The command body with leading `-- ` stripped. */
  cleaned: string;
  /** True when we actually stripped something. Caller emits a hint when set. */
  stripped: boolean;
}

/**
 * Detects the pattern: leading `--` followed by whitespace and a probable URL.
 * Strips it so downstream parsing sees the URL directly. Falls through (no
 * change) when what follows the `--` doesn't look like a URL — the validator
 * will then produce its normal "doesn't look like a URL" error.
 *
 *   "-- https://shop.com/ --features login"   → cleaned: "https://shop.com/ --features login", stripped: true
 *   "-- shop.com"                              → cleaned: "shop.com", stripped: true (URL normaliser will accept it)
 *   "-- garbage"                               → cleaned: "-- garbage", stripped: false (let validator complain)
 *   "https://shop.com/ --features login"      → cleaned: <unchanged>, stripped: false (no leading --)
 *   "--features login"                         → cleaned: <unchanged>, stripped: false (no whitespace after --)
 */
export function stripNpmStyleLeadingDashes(rest: string): LeadingDashFix {
  const m = rest.match(/^--\s+(\S.*)$/);
  if (!m) return { cleaned: rest, stripped: false };
  const remainder = m[1]!;
  const firstToken = remainder.split(/\s+/)[0] ?? '';
  if (looksLikeUrl(firstToken)) {
    return { cleaned: remainder, stripped: true };
  }
  return { cleaned: rest, stripped: false };
}

function looksLikeUrl(token: string): boolean {
  if (!token) return false;
  if (/^https?:\/\/\S/i.test(token)) return true;
  // Bare host like "shop.com" or "www.shop.com" — URL validator auto-prepends https://
  if (/^[a-z0-9][\w.-]*\.[a-z]{2,}(?:[/:?#].*)?$/i.test(token)) return true;
  return false;
}

export interface CliPasteHint {
  /** The slash command we infer the user wanted (e.g. "/explore"). */
  slash: '/explore' | '/generate' | '/heal';
  /** The arguments after the npm prefix, trimmed. Always at least "<args>". */
  args: string;
  /** A fully formed, copy-pasteable suggestion. */
  suggestion: string;
}

/**
 * Detects when the whole input is `npm run (explore|generate|heal) [--] <args>`
 * — i.e. the user pasted a terminal command into the chat. Returns a tailored
 * hint, or null if the input isn't an npm-paste.
 */
export function detectPastedCliCommand(content: string): CliPasteHint | null {
  const m = content.match(/^\s*npm\s+run\s+(explore|generate|heal)\b\s*(?:--\s+)?(.*)$/i);
  if (!m) return null;
  const cmd = (m[1] ?? '').toLowerCase();
  if (cmd !== 'explore' && cmd !== 'generate' && cmd !== 'heal') return null;
  const slash = `/${cmd}` as CliPasteHint['slash'];
  const rawArgs = (m[2] ?? '').trim();
  const args = rawArgs.length > 0 ? rawArgs : '<args>';
  return {
    slash,
    args,
    suggestion: `${slash} ${args}`.trim(),
  };
}
