import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSymmetricKey } from '@/lib/crypto';
import { decryptBoardFile } from '@/lib/crypto-format';
import { BoardFileState, type BoardFilePlaintext, type BoardFileStateIO } from './file-state';

const png = (byte: number): BoardFilePlaintext => ({
  mimeType: 'image/png',
  data: new Uint8Array([byte, byte, byte]),
});

/** Records every request so a test can tell what was sealed and sent, and under which version. */
function spyIO(initial: Record<string, BoardFilePlaintext> = {}) {
  const files = new Map(Object.entries(initial));
  const sealed: Array<{ fileId: string; keyVersion: number }> = [];
  const uploaded = new Map<string, Uint8Array>();

  const io: BoardFileStateIO = {
    read: vi.fn(async (fileId: string) => files.get(fileId) ?? null),
    seal: vi.fn(async (fileId, plaintext, key, keyVersion) => {
      sealed.push({ fileId, keyVersion });
      // A real envelope, so a test can open it again with the same key and version.
      const { encryptBoardFile } = await import('@/lib/crypto-format');
      return encryptBoardFile(
        key,
        { boardId: 'b1', boardKeyVersion: keyVersion, fileId },
        plaintext,
      );
    }),
    upload: vi.fn(async (fileId, ciphertext) => {
      uploaded.set(fileId, ciphertext);
    }),
  };
  return { io, sealed, uploaded, files };
}

describe('BoardFileState', () => {
  let key: CryptoKey;
  let newKey: CryptoKey;

  beforeEach(async () => {
    key = await generateSymmetricKey();
    newKey = await generateSymmetricKey();
  });

  it('uploads a new file once and remembers the version it was stored at', async () => {
    const { io, uploaded, sealed } = spyIO({ a: png(1) });
    const state = new BoardFileState(io);

    await state.upload(['a'], key, 1);
    await state.upload(['a'], key, 1);

    expect(sealed).toEqual([{ fileId: 'a', keyVersion: 1 }]);
    expect(uploaded.has('a')).toBe(true);
    expect(state.keyVersionOf('a')).toBe(1);
  });

  it('does not upload a file the load already found on the server', async () => {
    const { io, sealed } = spyIO({ a: png(1) });
    const state = new BoardFileState(io);
    state.markStored(['a'], 1);

    await state.upload(['a'], key, 1);

    expect(sealed).toEqual([]);
    expect(io.upload).not.toHaveBeenCalled();
  });

  it('re-encrypts a loaded file from the bytes the editor holds, at the new version', async () => {
    const { io, uploaded, sealed } = spyIO({ a: png(7) });
    const state = new BoardFileState(io);
    state.markStored(['a'], 1);

    const complete = await state.reencrypt(['a'], newKey, 2);

    expect(complete).toBe(true);
    expect(sealed).toEqual([{ fileId: 'a', keyVersion: 2 }]);
    expect(state.keyVersionOf('a')).toBe(2);

    const opened = await decryptBoardFile(newKey, uploaded.get('a')!, {
      boardId: 'b1',
      boardKeyVersion: 2,
      fileId: 'a',
    });
    expect([...opened.data]).toEqual([7, 7, 7]);
  });

  it('reports failure for a file it cannot produce and still moves the others', async () => {
    const { io, sealed } = spyIO({ good: png(2) });
    const state = new BoardFileState(io);
    state.markStored(['good', 'gone'], 1);

    const complete = await state.reencrypt(['good', 'gone'], newKey, 2);

    // `gone` has no bytes anywhere: the re-key cannot complete, but `good` moved.
    expect(complete).toBe(false);
    expect(sealed).toEqual([{ fileId: 'good', keyVersion: 2 }]);
    expect(state.keyVersionOf('good')).toBe(2);
    expect(state.keyVersionOf('gone')).toBe(1);
  });

  it('keeps a file that moved at the new version when a retry only has the failures left', async () => {
    const { io, files, sealed } = spyIO({ good: png(2), gone: png(3) });
    const state = new BoardFileState(io);
    state.markStored(['good', 'gone'], 1);

    // First attempt: `gone` cannot be read (its bytes are not available this time).
    const readOnce = vi
      .mocked(io.read)
      .mockImplementation(async (fileId) => (fileId === 'gone' ? null : png(3)));
    expect(await state.reencrypt(['good', 'gone'], newKey, 2)).toBe(false);
    expect(sealed).toEqual([{ fileId: 'good', keyVersion: 2 }]);

    readOnce.mockImplementation(async (fileId) => files.get(fileId) ?? null);
    expect(await state.reencrypt(['good', 'gone'], newKey, 2)).toBe(true);

    // The second pass only sealed the file that had not moved.
    expect(sealed).toEqual([
      { fileId: 'good', keyVersion: 2 },
      { fileId: 'gone', keyVersion: 2 },
    ]);
  });

  it('forgets a removed image, so adding it back uploads it again', async () => {
    const { io, sealed } = spyIO({ a: png(1) });
    const state = new BoardFileState(io);

    await state.upload(['a'], key, 1);
    state.retain([]);
    expect(state.keyVersionOf('a')).toBeUndefined();

    await state.upload(['a'], key, 1);
    expect(sealed).toEqual([
      { fileId: 'a', keyVersion: 1 },
      { fileId: 'a', keyVersion: 1 },
    ]);
  });

  it('keeps only the files the scene still names', async () => {
    const { io } = spyIO({ a: png(1), b: png(2), c: png(3) });
    const state = new BoardFileState(io);
    state.markStored(['a', 'b', 'c'], 1);

    state.retain(['a', 'c']);

    expect(state.keyVersionOf('a')).toBe(1);
    expect(state.keyVersionOf('b')).toBeUndefined();
    expect(state.keyVersionOf('c')).toBe(1);
  });

  it('keeps two boards apart: each has its own record', async () => {
    const one = spyIO({ a: png(1) });
    const two = spyIO({ a: png(9) });
    const first = new BoardFileState(one.io);
    const second = new BoardFileState(two.io);

    await first.upload(['a'], key, 1);
    // The second board has never uploaded `a`; the first board's version must not leak into it.
    expect(second.keyVersionOf('a')).toBeUndefined();
    await second.upload(['a'], newKey, 1);

    expect(one.sealed).toEqual([{ fileId: 'a', keyVersion: 1 }]);
    expect(two.sealed).toEqual([{ fileId: 'a', keyVersion: 1 }]);
  });

  it('drops the earlier session on reset so a reloaded board does the work again', async () => {
    const { io, sealed } = spyIO({ a: png(1) });
    const state = new BoardFileState(io);
    await state.upload(['a'], key, 1);

    state.reset();

    expect(state.keyVersionOf('a')).toBeUndefined();
    await state.upload(['a'], key, 1);
    expect(sealed).toHaveLength(2);
  });
});
