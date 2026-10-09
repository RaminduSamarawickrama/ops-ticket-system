import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { del, get, put } from '@vercel/blob';

export interface StoredFile {
  body: ReadableStream<Uint8Array> | Uint8Array;
  contentType: string;
}

/** Private file storage for screenshots. Files are never reachable by a public URL. */
export interface FileStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(keys: string[]): Promise<void>;
}

/** Vercel Blob in a PRIVATE store. Reads require the store credentials, which only the server has. */
export function vercelBlobStorage(): FileStorage {
  return {
    async put(key, bytes, contentType) {
      await put(key, Buffer.from(bytes), {
        access: 'private',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
    },
    async get(key) {
      const result = await get(key, { access: 'private' });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      return { body: result.stream, contentType: result.blob.contentType };
    },
    async delete(keys) {
      if (keys.length > 0) await del(keys);
    },
  };
}

/** In-memory storage for automated tests. */
export function memoryStorage(): FileStorage & { files: Map<string, StoredFile & { body: Uint8Array }> } {
  const files = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    files,
    async put(key, bytes, contentType) {
      files.set(key, { body: bytes, contentType });
    },
    async get(key) {
      return files.get(key) ?? null;
    },
    async delete(keys) {
      for (const k of keys) files.delete(k);
    },
  };
}

/**
 * Local-disk storage for development on your own machine ONLY. It refuses to run in production,
 * because a serverless function's filesystem is temporary and files would be lost.
 */
export function localDiskStorage(root = path.resolve('.local-storage')): FileStorage {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    throw new Error('Local disk storage cannot be used in production. Configure a private Vercel Blob store.');
  }
  const resolve = (key: string) => {
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  };
  return {
    async put(key, bytes, contentType) {
      const file = resolve(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      await writeFile(`${file}.type`, contentType);
    },
    async get(key) {
      try {
        const file = resolve(key);
        const [body, contentType] = await Promise.all([readFile(file), readFile(`${file}.type`, 'utf8')]);
        return { body: new Uint8Array(body), contentType };
      } catch {
        return null;
      }
    },
    async delete(keys) {
      for (const k of keys) {
        const file = resolve(k);
        await rm(file, { force: true });
        await rm(`${file}.type`, { force: true });
      }
    },
  };
}

/** Pick storage from the environment. Production always uses the private Blob store. */
export function storageFromEnv(env: Record<string, string | undefined> = process.env): FileStorage {
  if (env.STORAGE_DRIVER === 'local') return localDiskStorage();
  return vercelBlobStorage();
}
