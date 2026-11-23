// Token text. A token's bytes may be an incomplete UTF-8 sequence, because a
// character can be split between two tokens.

// A run of consecutive path tokens drawn as one unit in the Stream. Almost
// always a single token; several when their bytes only form valid text together.
export interface TokenGroup {
  start: number; // index of the first token of the group
  end: number; // one past the last
  text: string; // decoded text of the whole group
}

// Lenient decoder: invalid or incomplete bytes become U+FFFD. ignoreBOM keeps
// a token that is exactly U+FEFF instead of swallowing it.
const lenient = new TextDecoder('utf-8', { ignoreBOM: true });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Incremental UTF-8 validator (the well-formed byte table of the Unicode
// standard). `need` is the number of continuation bytes still missing for
// the sequence in progress, and [lo, hi] the range the next one must be in.
class Utf8State {
  need = 0;
  private lo = 0x80;
  private hi = 0xbf;

  // Feeds one byte. Returns false if the byte is invalid where it stands.
  push(b: number): boolean {
    if (this.need > 0) {
      if (b >= this.lo && b <= this.hi) {
        this.need--;
        this.lo = 0x80;
        this.hi = 0xbf;
        return true;
      }
      this.need = 0; // the sequence is broken: `b` starts afresh
    }
    if (b < 0x80) return true;
    if (b >= 0xc2 && b <= 0xdf) this.open(1, 0x80, 0xbf);
    else if (b === 0xe0) this.open(2, 0xa0, 0xbf);
    else if ((b >= 0xe1 && b <= 0xec) || b === 0xee || b === 0xef) this.open(2, 0x80, 0xbf);
    else if (b === 0xed) this.open(2, 0x80, 0x9f);
    else if (b === 0xf0) this.open(3, 0x90, 0xbf);
    else if (b >= 0xf1 && b <= 0xf3) this.open(3, 0x80, 0xbf);
    else if (b === 0xf4) this.open(3, 0x80, 0x8f);
    else return false; // stray continuation byte, C0, C1 or F5..FF
    return true;
  }

  // True if `b` is the continuation byte the open sequence expects.
  continues(b: number): boolean {
    return this.need > 0 && b >= this.lo && b <= this.hi;
  }

  reset(): void {
    this.need = 0;
    this.lo = 0x80;
    this.hi = 0xbf;
  }

  private open(need: number, lo: number, hi: number): void {
    this.need = need;
    this.lo = lo;
    this.hi = hi;
  }
}

function concat(parts: readonly Uint8Array[], start: number, end: number): Uint8Array {
  if (end - start === 1) return parts[start];
  let n = 0;
  for (let i = start; i < end; i++) n += parts[i].length;
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = start; i < end; i++) {
    out.set(parts[i], p);
    p += parts[i].length;
  }
  return out;
}

// Groups tokens so that every group decodes to valid UTF-8. A token whose
// bytes are not valid on their own is joined with the following ones until
// the sequence completes. Control tokens (`isControl[i]`) always stand alone.
// Bytes that never complete (at the end of the list, or before a control
// token) form a group whose text holds U+FFFD.
//
// A group closes at the first token boundary where no multi-byte sequence is
// left open. Bytes that are invalid in themselves (a stray continuation byte,
// 0xFF) cannot be completed by later tokens, so they do not hold the group
// open: they decode to U+FFFD within it. Linear in the number of bytes.
export function groupTokens(bytes: readonly Uint8Array[], isControl: readonly boolean[]): TokenGroup[] {
  const groups: TokenGroup[] = [];
  const state = new Utf8State();
  let start = 0; // first token of the group being built
  const close = (end: number): void => {
    if (end > start) groups.push({ start, end, text: lenient.decode(concat(bytes, start, end)) });
    start = end;
  };
  for (let i = 0; i < bytes.length; i++) {
    if (isControl[i]) {
      close(i); // pending bytes that never completed
      state.reset();
      close(i + 1);
      continue;
    }
    for (const b of bytes[i]) state.push(b);
    if (state.need === 0) close(i + 1);
  }
  close(bytes.length);
  return groups;
}

// True if `bytes` is a complete, valid UTF-8 sequence on its own.
export function isCompleteUtf8(bytes: Uint8Array): boolean {
  try {
    strict.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function hex(b: number): string {
  return '\\x' + b.toString(16).toUpperCase().padStart(2, '0');
}

// Control characters have no glyph: shown as escaped bytes too. Newline and
// tab stay, for showWhitespace.
function escapeControls(text: string): string {
  return text.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, (c) => hex(c.charCodeAt(0)));
}

// Text of one token for a label (a Candidates row, a pill): valid UTF-8 is
// decoded; anything else is shown as escaped bytes, e.g. "\xC3".
// A token with valid text and a partial character, like " caf\xC3", keeps its
// valid part as text.
export function tokenLabel(bytes: Uint8Array): string {
  if (isCompleteUtf8(bytes)) return escapeControls(lenient.decode(bytes));
  const state = new Utf8State();
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    // Length of the valid sequence starting at i, or 0.
    state.reset();
    let n = 0;
    if (state.push(bytes[i])) {
      n = 1;
      while (state.need > 0 && i + n < bytes.length && state.continues(bytes[i + n])) {
        state.push(bytes[i + n]);
        n++;
      }
      if (state.need > 0) n = 0;
    }
    if (n > 0) {
      out += escapeControls(lenient.decode(bytes.subarray(i, i + n)));
      i += n;
    } else {
      out += hex(bytes[i]);
      i++;
    }
  }
  return out;
}

// Makes whitespace visible in a label: space as "·", newline as "↵", tab as "⇥".
export function showWhitespace(text: string): string {
  return text.replace(/[ \n\t]/g, (c) => (c === ' ' ? '·' : c === '\n' ? '↵' : '⇥'));
}
