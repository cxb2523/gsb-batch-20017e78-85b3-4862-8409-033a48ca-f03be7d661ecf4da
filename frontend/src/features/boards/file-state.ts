/**
 * The one record of the image files a canvas holds, shared by the upload, the re-encryption and
 * the save.
 *
 * Uploading a new image and re-encrypting the scene's images after a key rotation used to keep
 * separate notions of "which files this canvas has": the uploader remembered what it had sent in
 * one place, and the save re-encrypted whatever the live editor happened to hold in another. When
 * those drifted apart, a board could be moved to a new key with some images still sealed under the
 * old one (nobody could open them) or keep objects nothing referenced any more (orphans).
 *
 * This class is that single record: per file id, the plaintext it was made from, the key version
 * its server copy belongs to, and the ciphertext this editor sealed for it. The upload flow writes
 * it and the save flow reads it to decide what still has to be sent.
 *
 * React-free and Excalidraw-free: the bytes, the sealing and the upload arrive as dependencies, so
 * the rules can be tested without a canvas or a server.
 */

/** The bytes an image was made from: what gets encrypted, and what a rotation re-encrypts. */
export interface BoardFilePlaintext {
  mimeType: string;
  data: Uint8Array;
}

/** How this editor came to know a file. A loaded file is already stored and is never re-encoded. */
type BoardFileSource = 'loaded' | 'added';

interface FileRecord {
  /** The bytes the ciphertext was made from; absent until they are read. */
  plaintext?: BoardFilePlaintext;
  /** The key version the server copy belongs to; absent until a copy is known or sent. */
  keyVersion?: number;
  /** The ciphertext this editor sealed for the file, when it sealed one. */
  ciphertext?: Uint8Array;
  source: BoardFileSource;
}

export interface BoardFileStateIO {
  /**
   * The file's current bytes, or null when this editor holds no copy of it. `compress` is true for
   * a file added in this session, which goes through the browser's re-encoding, and false for a
   * file loaded from the server, whose stored bytes are already the ones to keep.
   */
  read: (fileId: string, options: { compress: boolean }) => Promise<BoardFilePlaintext | null>;
  /** Seals the bytes for the board at the given key version. */
  seal: (
    fileId: string,
    plaintext: BoardFilePlaintext,
    key: CryptoKey,
    keyVersion: number,
  ) => Promise<Uint8Array>;
  /** Sends the sealed bytes to the server; throws when the upload failed. */
  upload: (fileId: string, ciphertext: Uint8Array) => Promise<void>;
}

/** The part of a file state that a save reads. */
export interface BoardFileSync {
  /** Uploads every named file that is not stored at `keyVersion`. */
  upload(fileIds: readonly string[], key: CryptoKey, keyVersion: number): Promise<void>;
  /** Re-encrypts every named file at `keyVersion`; false when one of them could not be produced. */
  reencrypt(fileIds: readonly string[], key: CryptoKey, keyVersion: number): Promise<boolean>;
}

/** One board, one editor session. Two open boards never share a record. */
export class BoardFileState implements BoardFileSync {
  private readonly records = new Map<string, FileRecord>();
  private readonly io: BoardFileStateIO;

  constructor(io: BoardFileStateIO) {
    this.io = io;
  }

  /**
   * Forgets everything, for a board opened afresh. A reload may land on a newer key version, and
   * keeping the earlier session's versions would make the save skip work that is now due.
   */
  reset(): void {
    this.records.clear();
  }

  /**
   * Records files the server already holds at `keyVersion` (the ones a load decrypted). They are
   * not uploaded again, but a rotation still re-encrypts them from the bytes the editor holds.
   */
  markStored(fileIds: readonly string[], keyVersion: number): void {
    for (const fileId of fileIds) {
      if (!this.records.has(fileId)) {
        this.records.set(fileId, { keyVersion, source: 'loaded' });
      }
    }
  }

  /**
   * Forgets every file the scene no longer names. A removed image leaves nothing behind, and an
   * image added back afterwards is sealed and uploaded again, as the server dropped its copy.
   */
  retain(fileIds: readonly string[]): void {
    const keep = new Set(fileIds);
    for (const fileId of [...this.records.keys()]) {
      if (!keep.has(fileId)) this.records.delete(fileId);
    }
  }

  /** The key version this session knows the file is stored under, if it knows. */
  keyVersionOf(fileId: string): number | undefined {
    return this.records.get(fileId)?.keyVersion;
  }

  /**
   * Uploads every named file that is not already stored at `keyVersion`. A file with no local
   * bytes is left where the server keeps it: it came from the server, and re-sending it would mean
   * inventing bytes this editor does not have. An upload that throws stops the save before its
   * payload is sent, so a stored scene never names an image the server did not accept.
   */
  async upload(fileIds: readonly string[], key: CryptoKey, keyVersion: number): Promise<void> {
    await Promise.all(
      fileIds.map(async (fileId) => {
        const record = this.records.get(fileId);
        if ((record?.keyVersion ?? 0) >= keyVersion) return;

        const plaintext = await this.plaintextOf(fileId);
        if (!plaintext) return;

        await this.sealAndStore(fileId, plaintext, key, keyVersion);
      }),
    );
  }

  /**
   * Seals and uploads every named file at `keyVersion`, whatever version it sits at now. Returns
   * false when a file cannot be produced (no bytes, a failed seal or a failed upload), which tells
   * the save not to switch the board's key and not to send its payload. Files that succeeded keep
   * their new version, so a retry only has the failed ones left.
   */
  async reencrypt(
    fileIds: readonly string[],
    key: CryptoKey,
    keyVersion: number,
  ): Promise<boolean> {
    const moved = await Promise.all(
      fileIds.map((fileId) => this.reencryptOne(fileId, key, keyVersion)),
    );
    return moved.every(Boolean);
  }

  private async reencryptOne(fileId: string, key: CryptoKey, keyVersion: number): Promise<boolean> {
    const record = this.records.get(fileId);
    if ((record?.keyVersion ?? 0) >= keyVersion) return true;

    try {
      const plaintext = await this.plaintextOf(fileId);
      if (!plaintext) return false;
      await this.sealAndStore(fileId, plaintext, key, keyVersion);
      return true;
    } catch (error) {
      // One file that cannot move must not stop the others; the save as a whole still fails.
      console.error(`Could not re-encrypt board file ${fileId}:`, error);
      return false;
    }
  }

  private async sealAndStore(
    fileId: string,
    plaintext: BoardFilePlaintext,
    key: CryptoKey,
    keyVersion: number,
  ): Promise<void> {
    const ciphertext = await this.io.seal(fileId, plaintext, key, keyVersion);
    await this.io.upload(fileId, ciphertext);
    const source = this.records.get(fileId)?.source ?? 'added';
    this.records.set(fileId, { plaintext, keyVersion, ciphertext, source });
  }

  /** The file's bytes, cached after the first read so a later rotation reuses them unchanged. */
  private async plaintextOf(fileId: string): Promise<BoardFilePlaintext | null> {
    const record = this.records.get(fileId);
    if (record?.plaintext) return record.plaintext;

    // A file that came from the server keeps its stored bytes; only one added here is re-encoded.
    const compress = record?.source !== 'loaded';
    const plaintext = await this.io.read(fileId, { compress });
    if (!plaintext) return null;

    this.records.set(fileId, {
      plaintext,
      source: record?.source ?? 'added',
      ...(record?.keyVersion !== undefined ? { keyVersion: record.keyVersion } : {}),
    });
    return plaintext;
  }
}
