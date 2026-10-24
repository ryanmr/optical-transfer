/// <reference lib="webworker" />
import { OpfsDir } from '../core/opfs';
import { Receiver } from '../core/receiver';
import type { RecvIn, RecvOut } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let rx: Receiver | null = null;
let queue: Promise<void> = Promise.resolve();
let dirty = false;

const post = (m: RecvOut) => self.postMessage(m);
const sendStats = () => {
  if (rx) post({ type: 'stats', stats: rx.stats() });
  dirty = false;
};

// Frames arrive faster than OPFS/finalisation may complete; process strictly in order.
function enqueue(fn: () => Promise<void>) {
  queue = queue.then(fn).catch((e) => post({ type: 'error', message: (e as Error).message ?? String(e) }));
}

setInterval(() => {
  rx?.flush();
}, 500);
setInterval(() => {
  if (dirty) sendStats();
}, 150);

self.onmessage = (ev: MessageEvent<RecvIn>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      enqueue(async () => {
        const opfs = await OpfsDir.root();
        rx = new Receiver(await opfs.dir(msg.root));
        rx.onChange = sendStats;
        await rx.init();
        sendStats();
      });
      break;
    case 'frame':
      enqueue(async () => {
        await rx!.ingest(msg.bytes);
        dirty = true;
      });
      break;
    case 'reset':
      enqueue(async () => {
        await rx!.reset();
        sendStats();
      });
      break;
    case 'switch':
      enqueue(async () => {
        await rx!.switchTo(msg.session);
        sendStats();
      });
      break;
  }
};
