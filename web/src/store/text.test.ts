import { describe, expect, it } from 'vitest';
import { groupTokens, isCompleteUtf8, showWhitespace, tokenLabel } from './text';

const enc = new TextEncoder();
const b = (...x: number[]): Uint8Array => new Uint8Array(x);
const s = (text: string): Uint8Array => enc.encode(text);

// Groups as [start, end, text].
function groups(bytes: Uint8Array[], control: boolean[] = []): [number, number, string][] {
  return groupTokens(bytes, control).map((g) => [g.start, g.end, g.text]);
}

describe('isCompleteUtf8', () => {
  it('accepts valid text', () => {
    expect(isCompleteUtf8(b())).toBe(true);
    expect(isCompleteUtf8(s(' cat'))).toBe(true);
    expect(isCompleteUtf8(s('é€😀'))).toBe(true);
    expect(isCompleteUtf8(b(0xef, 0xbb, 0xbf))).toBe(true); // U+FEFF
  });

  it('rejects incomplete and invalid bytes', () => {
    expect(isCompleteUtf8(b(0xc3))).toBe(false);
    expect(isCompleteUtf8(b(0xa9))).toBe(false);
    expect(isCompleteUtf8(b(0xe2, 0x82))).toBe(false);
    expect(isCompleteUtf8(b(0xf0, 0x9f, 0x98))).toBe(false);
    expect(isCompleteUtf8(b(0xff))).toBe(false);
    expect(isCompleteUtf8(b(0xc0, 0x80))).toBe(false); // overlong
    expect(isCompleteUtf8(b(0xed, 0xa0, 0x80))).toBe(false); // surrogate
  });
});

describe('groupTokens', () => {
  it('keeps whole tokens apart', () => {
    expect(groups([s('The'), s(' cat'), s('.')])).toEqual([
      [0, 1, 'The'],
      [1, 2, ' cat'],
      [2, 3, '.'],
    ]);
    expect(groups([])).toEqual([]);
  });

  it('joins a 2-byte character split in two tokens', () => {
    expect(groups([s(' caf'), b(0xc3), b(0xa9), s('!')])).toEqual([
      [0, 1, ' caf'],
      [1, 3, 'é'],
      [3, 4, '!'],
    ]);
  });

  it('joins a token that ends with half a character with the next', () => {
    expect(groups([b(0x20, 0x63, 0x61, 0x66, 0xc3), b(0xa9, 0x20)])).toEqual([[0, 2, ' café ']]);
  });

  it('joins a 3-byte character split in two or three tokens', () => {
    // € = E2 82 AC
    expect(groups([b(0xe2), b(0x82, 0xac)])).toEqual([[0, 2, '€']]);
    expect(groups([b(0xe2, 0x82), b(0xac)])).toEqual([[0, 2, '€']]);
    expect(groups([b(0xe2), b(0x82), b(0xac), s('x')])).toEqual([
      [0, 3, '€'],
      [3, 4, 'x'],
    ]);
  });

  it('joins a 4-byte character split in two or three tokens', () => {
    // 😀 = F0 9F 98 80
    expect(groups([b(0xf0, 0x9f), b(0x98, 0x80)])).toEqual([[0, 2, '😀']]);
    expect(groups([b(0xf0), b(0x9f, 0x98), b(0x80)])).toEqual([[0, 3, '😀']]);
  });

  it('closes a sequence that never completes at the end with U+FFFD', () => {
    expect(groups([s('a'), b(0xe2, 0x82)])).toEqual([
      [0, 1, 'a'],
      [1, 2, '�'],
    ]);
    expect(groups([s('a'), b(0xf0), b(0x9f)])).toEqual([
      [0, 1, 'a'],
      [1, 3, '�'],
    ]);
  });

  it('keeps control tokens alone, even in the middle of a character', () => {
    expect(groups([s('<s>'), s('Hi')], [true, false])).toEqual([
      [0, 1, '<s>'],
      [1, 2, 'Hi'],
    ]);
    expect(groups([b(0xc3), s('<eos>'), b(0xa9)], [false, true, false])).toEqual([
      [0, 1, '�'],
      [1, 2, '<eos>'],
      [2, 3, '�'],
    ]);
  });

  it('does not hold a group open for bytes that are invalid in themselves', () => {
    expect(groups([b(0xff), s('a')])).toEqual([
      [0, 1, '�'],
      [1, 2, 'a'],
    ]);
    expect(groups([b(0xa9), s('a')])).toEqual([
      [0, 1, '�'],
      [1, 2, 'a'],
    ]);
    // A lead byte followed by something that does not continue it.
    expect(groups([b(0xc3), s('x')])).toEqual([[0, 2, '�x']]);
  });

  it('is linear on a long path', () => {
    const n = 100_000;
    const bytes: Uint8Array[] = [];
    for (let i = 0; i < n; i++) bytes.push(i % 2 ? b(0xa9) : b(0xc3));
    bytes.push(b(0xe2)); // and a tail that never completes
    const t0 = performance.now();
    const g = groupTokens(bytes, []);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(g.length).toBe(n / 2 + 1);
    expect(g[0]).toEqual({ start: 0, end: 2, text: 'é' });
  });
});

describe('tokenLabel', () => {
  it('decodes valid text', () => {
    expect(tokenLabel(s(' cat'))).toBe(' cat');
    expect(tokenLabel(s('é'))).toBe('é');
    expect(tokenLabel(b())).toBe('');
    // Control characters have no glyph; newline and tab are left for showWhitespace.
    expect(tokenLabel(b(0x07))).toBe('\\x07');
    expect(tokenLabel(b(0x61, 0x0d, 0x0a))).toBe('a\\x0D\n');
    expect(tokenLabel(b(0x09, 0x7f))).toBe('\t\\x7F');
  });

  it('escapes bytes that are not valid text', () => {
    expect(tokenLabel(b(0xc3))).toBe('\\xC3');
    expect(tokenLabel(b(0xa9))).toBe('\\xA9');
    expect(tokenLabel(b(0xf0, 0x9f))).toBe('\\xF0\\x9F');
    expect(tokenLabel(b(0x20, 0x63, 0x61, 0x66, 0xc3))).toBe(' caf\\xC3');
    expect(tokenLabel(b(0xa9, 0x21))).toBe('\\xA9!');
    expect(tokenLabel(b(0xc3, 0xa9, 0xff))).toBe('é\\xFF');
  });
});

describe('showWhitespace', () => {
  it('makes space, newline and tab visible', () => {
    expect(showWhitespace(' a\tb\n')).toBe('·a⇥b↵');
    expect(showWhitespace('')).toBe('');
    expect(showWhitespace('abc')).toBe('abc');
  });
});
