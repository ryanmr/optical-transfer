// Minimal synchronous-file storage abstraction. In the browser it is backed by OPFS sync access
// handles (see opfs.ts); tests use the in-memory implementation below.

export interface SyncFile {
  read(buf: Uint8Array, at: number): number;
  write(buf: Uint8Array, at: number): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

export interface StorageDir {
  /** Open (creating if needed) a file for synchronous random access. */
  open(name: string): Promise<SyncFile>;
  exists(name: string): Promise<boolean>;
  /** Whole-file read of a file that is not currently open. */
  readAll(name: string): Promise<Uint8Array | null>;
  writeAll(name: string, data: Uint8Array): Promise<void>;
  /** Stream a file that is not currently open. */
  stream(name: string): Promise<ReadableStream<Uint8Array>>;
  remove(name: string): Promise<void>;
  dir(name: string): Promise<StorageDir>;
  removeDir(name: string): Promise<void>;
  /** Path segments from the storage root, e.g. ['sessions', 'abcd']. */
  readonly path: string[];
}

class MemFile implements SyncFile {
  constructor(private readonly store: Map<string, Uint8Array>, private readonly name: string) {
    if (!store.has(name)) store.set(name, new Uint8Array(0));
  }
  private get data(): Uint8Array {
    return this.store.get(this.name)!;
  }
  read(buf: Uint8Array, at: number): number {
    const src = this.data.subarray(at, at + buf.length);
    buf.set(src);
    return src.length;
  }
  write(buf: Uint8Array, at: number): number {
    const end = at + buf.length;
    if (end > this.data.length) {
      const grown = new Uint8Array(Math.max(end, this.data.length * 2));
      grown.set(this.data);
      this.store.set(this.name, grown.subarray(0, end));
    }
    this.data.set(buf, at);
    return buf.length;
  }
  getSize(): number {
    return this.data.length;
  }
  truncate(size: number): void {
    const d = new Uint8Array(size);
    d.set(this.data.subarray(0, size));
    this.store.set(this.name, d);
  }
  flush(): void {}
  close(): void {}
}

export class MemoryDir implements StorageDir {
  private readonly files = new Map<string, Uint8Array>();
  private readonly dirs = new Map<string, MemoryDir>();
  constructor(readonly path: string[] = []) {}
  async open(name: string): Promise<SyncFile> {
    return new MemFile(this.files, name);
  }
  async exists(name: string): Promise<boolean> {
    return this.files.has(name);
  }
  async readAll(name: string): Promise<Uint8Array | null> {
    const f = this.files.get(name);
    return f ? f.slice() : null;
  }
  async writeAll(name: string, data: Uint8Array): Promise<void> {
    this.files.set(name, data.slice());
  }
  async stream(name: string): Promise<ReadableStream<Uint8Array>> {
    const data = this.files.get(name);
    if (!data) throw new Error(`no such file: ${name}`);
    let off = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (off >= data.length) return ctrl.close();
        ctrl.enqueue(data.slice(off, off + 65536));
        off += 65536;
      },
    });
  }
  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
  async dir(name: string): Promise<StorageDir> {
    let d = this.dirs.get(name);
    if (!d) this.dirs.set(name, (d = new MemoryDir([...this.path, name])));
    return d;
  }
  async removeDir(name: string): Promise<void> {
    this.dirs.delete(name);
  }
}
