/**
 * The file state for one open canvas, wired to the live editor and the board's image route.
 *
 * An image added in this session is re-encoded by `processImageFile` — the existing 2048px cap,
 * 8MB cap and WebP/PNG/JPEG choice — before it is encrypted. One loaded from the server keeps the
 * bytes that were stored, so a re-key re-encrypts exactly what is already there rather than
 * re-compressing it a second time.
 */

import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { encryptBoardFile } from '@/lib/crypto-format';
import { dataUrlToBytes, processImageFile } from '@/lib/image-resize';
import { uploadBoardFile } from './api';
import { BoardFileState, type BoardFilePlaintext } from './file-state';

export interface CanvasFileStateParams {
  workspaceRef: string;
  boardId: string;
  /** The editor's files, read lazily so an image added after this was built is still seen. */
  getFiles: () => BinaryFiles;
}

export function createCanvasFileState(params: CanvasFileStateParams): BoardFileState {
  const { workspaceRef, boardId, getFiles } = params;

  return new BoardFileState({
    read: async (fileId, { compress }): Promise<BoardFilePlaintext | null> => {
      const file = getFiles()[fileId];
      if (!file?.dataURL) return null;

      const { data, mimeType } = dataUrlToBytes(file.dataURL);
      if (!compress) return { data, mimeType };
      return await processImageFile(new Blob([data], { type: mimeType }));
    },
    seal: (fileId, plaintext, key, keyVersion) =>
      encryptBoardFile(key, { boardId, boardKeyVersion: keyVersion, fileId }, plaintext),
    upload: (fileId, ciphertext) => uploadBoardFile(workspaceRef, boardId, fileId, ciphertext),
  });
}
