import type { StorageDir, SyncFile } from './storage';

// OPFS-backed storage. `open()` uses createSyncAccessHandle(), which only exists in dedicated
// workers; the other methods work anywhere.
export class OpfsDir implements StorageDir {
  constructor(private readonly handle: FileSystemDirectoryHandle, readonly path: string[] = []) {}

  static async root(): Promise<OpfsDir> {
    return new OpfsDir(await navigator.storage.getDirectory());
  }

  async open(name: string): Promise<SyncFile> {
    const fh = await this.handle.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    return {
      read: (buf, at) => h.read(buf, { at }),
      write: (buf, at) => h.write(buf, { at }),
      getSize: () => h.getSize(),
      truncate: (n) => h.truncate(n),
      flush: () => h.flush(),
      close: () => h.close(),
    };
  }

  async exists(name: string): Promise<boolean> {
    try {
      await this.handle.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  async readAll(name: string): Promise<Uint8Array | null> {
    try {
      const fh = await this.handle.getFileHandle(name);
      return new Uint8Array(await (await fh.getFile()).arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeAll(name: string, data: Uint8Array): Promise<void> {
    const f = await this.open(name);
    try {
      f.truncate(0);
      f.write(data, 0);
      f.flush();
    } finally {
      f.close();
    }
  }

  async stream(name: string): Promise<ReadableStream<Uint8Array>> {
    const fh = await this.handle.getFileHandle(name);
    return (await fh.getFile()).stream() as ReadableStream<Uint8Array>;
  }

  async remove(name: string): Promise<void> {
    try {
      await this.handle.removeEntry(name);
    } catch {
      /* already gone */
    }
  }

  async dir(name: string): Promise<StorageDir> {
    return new OpfsDir(await this.handle.getDirectoryHandle(name, { create: true }), [...this.path, name]);
  }

  async removeDir(name: string): Promise<void> {
    try {
      await this.handle.removeEntry(name, { recursive: true });
    } catch {
      /* already gone */
    }
  }
}

/** Main-thread helper: resolve a File from OPFS path segments. */
export async function opfsFile(path: string[]): Promise<File> {
  let dir = await navigator.storage.getDirectory();
  for (const seg of path.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
  return (await dir.getFileHandle(path[path.length - 1])).getFile();
}
