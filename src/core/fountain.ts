// Fountain-code abstraction so LT can later be swapped for RaptorQ/Wirehair.

export interface FountainEncoder {
  readonly K: number;
  readonly S: number;
  /** Encoded symbol for `id` (length S). Deterministic in (K, id). */
  symbol(id: number): Uint8Array;
}

export interface FountainDecoder {
  readonly K: number;
  readonly S: number;
  /** Called once per source block as soon as it is recovered. */
  onBlock: ((index: number, data: Uint8Array) => void) | null;
  /** Feed one encoded symbol. Returns the number of source blocks newly recovered. */
  addSymbol(id: number, data: Uint8Array): number;
  /** Inject an already-known source block (e.g. restored from disk). */
  setBlock(index: number, data: Uint8Array): number;
  hasBlock(index: number): boolean;
  readonly recovered: number;
  isComplete(): boolean;
  /** View of a recovered source block. */
  block(index: number): Uint8Array;
}
