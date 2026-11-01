export type DeferredDeliveryJob<T, R> = {
  payload: T;
  onResult?: (result: R) => void | Promise<void>;
};

export function createDeferredDeliveryQueue<T, R>(deliver: (payload: T) => Promise<R>) {
  let activeExecutions = 0;
  let draining = false;
  const queue: Array<DeferredDeliveryJob<T, R>> = [];

  const drain = async () => {
    if (draining || activeExecutions > 0) return;
    draining = true;
    try {
      while (activeExecutions === 0 && queue.length > 0) {
        const job = queue.shift()!;
        let result: R;
        try {
          result = await deliver(job.payload);
        } catch (error) {
          result = ({ ok: false, error: String((error as any)?.message || error) } as unknown) as R;
        }
        if (job.onResult) {
          try { await job.onResult(result); } catch { /* audit callbacks must not stop the queue */ }
        }
      }
    } finally {
      draining = false;
      if (activeExecutions === 0 && queue.length > 0) setImmediate(() => { void drain(); });
    }
  };

  return {
    beginExecution() { activeExecutions += 1; },
    endExecution() {
      activeExecutions = Math.max(0, activeExecutions - 1);
      if (activeExecutions === 0 && queue.length > 0) setImmediate(() => { void drain(); });
    },
    enqueue(job: DeferredDeliveryJob<T, R>) {
      queue.push(job);
      if (activeExecutions === 0) setImmediate(() => { void drain(); });
      return { queued: true, pending: queue.length };
    },
    snapshot() { return { activeExecutions, pending: queue.length, draining }; },
  };
}
