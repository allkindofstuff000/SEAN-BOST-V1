export class MutationCancelledError extends Error {
  constructor(message = "Queued mutation was cancelled") {
    super(message);
    this.name = "MutationCancelledError";
    this.code = "MUTATION_CANCELLED";
  }
}

function defaultMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createMutationQueue({ maxConcurrency = 5 } = {}) {
  const queue = [];
  const listeners = new Set();
  const runningByMutationId = new Map();
  const runningByKey = new Map();
  const queuedByKey = new Map();

  const stats = {
    running: 0,
    queued: 0,
    totalPending: 0,
    pendingByKey: {}
  };

  const recomputeStats = () => {
    const pendingByKey = {};

    runningByKey.forEach((job, key) => {
      if (job) pendingByKey[key] = true;
    });
    queuedByKey.forEach((job, key) => {
      if (job) pendingByKey[key] = true;
    });

    stats.running = runningByMutationId.size;
    stats.queued = queue.length;
    stats.totalPending = stats.running + stats.queued;
    stats.pendingByKey = pendingByKey;
  };

  const notify = () => {
    recomputeStats();
    listeners.forEach((listener) => listener({ ...stats, pendingByKey: { ...stats.pendingByKey } }));
  };

  const removeQueuedJob = (job) => {
    const index = queue.findIndex((item) => item.mutationId === job.mutationId);
    if (index >= 0) {
      queue.splice(index, 1);
    }

    if (queuedByKey.get(job.key)?.mutationId === job.mutationId) {
      queuedByKey.delete(job.key);
    }
  };

  const runJob = async (job) => {
    runningByMutationId.set(job.mutationId, job);
    runningByKey.set(job.key, job);
    notify();

    try {
      const result = await job.run();
      if (job.onSuccess) {
        await job.onSuccess(result, job);
      }
      job.resolve(result);
    } catch (error) {
      if (job.rollback) {
        try {
          await job.rollback(error, job);
        } catch (rollbackError) {
          console.error("Mutation rollback failed", rollbackError);
        }
      }
      if (job.onError) {
        await job.onError(error, job);
      }
      job.reject(error);
    } finally {
      runningByMutationId.delete(job.mutationId);
      if (runningByKey.get(job.key)?.mutationId === job.mutationId) {
        runningByKey.delete(job.key);
      }
      dispatch();
      notify();
    }
  };

  const dispatch = () => {
    if (queue.length === 0) return;

    while (runningByMutationId.size < maxConcurrency) {
      const nextIndex = queue.findIndex((candidate) => !runningByKey.has(candidate.key));

      if (nextIndex < 0) {
        return;
      }

      const [nextJob] = queue.splice(nextIndex, 1);
      if (queuedByKey.get(nextJob.key)?.mutationId === nextJob.mutationId) {
        queuedByKey.delete(nextJob.key);
      }

      runJob(nextJob);

      if (queue.length === 0) {
        return;
      }
    }
  };

  const enqueueMutation = ({
    key,
    type,
    mutationId = defaultMutationId(),
    run,
    optimisticApply,
    rollback,
    onSuccess,
    onError
  }) => {
    if (!key) {
      throw new Error("enqueueMutation requires a key");
    }

    if (typeof run !== "function") {
      throw new Error("enqueueMutation requires a run function");
    }

    const runningJob = runningByKey.get(key);
    if (runningJob && runningJob.type === type) {
      return runningJob.promise;
    }

    const existingQueued = queuedByKey.get(key);
    if (existingQueued && existingQueued.type === type) {
      return existingQueued.promise;
    }

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const job = {
      key,
      type,
      mutationId,
      run,
      rollback,
      onSuccess,
      onError,
      resolve,
      reject,
      promise,
      optimisticContext: null
    };

    if (optimisticApply) {
      job.optimisticContext = optimisticApply(job);
    }

    if (existingQueued) {
      removeQueuedJob(existingQueued);

      if (existingQueued.rollback) {
        try {
          existingQueued.rollback(new MutationCancelledError("Replaced by newer queued mutation"), existingQueued);
        } catch (rollbackError) {
          console.error("Failed to rollback replaced mutation", rollbackError);
        }
      }

      existingQueued.reject(new MutationCancelledError("Queued mutation replaced"));
    }

    queuedByKey.set(key, job);
    queue.push(job);

    dispatch();
    notify();

    return promise;
  };

  const cancelQueuedMutation = (key) => {
    const queued = queuedByKey.get(key);
    if (!queued) return false;

    removeQueuedJob(queued);

    if (queued.rollback) {
      try {
        queued.rollback(new MutationCancelledError("Queued mutation cancelled"), queued);
      } catch (rollbackError) {
        console.error("Failed to rollback cancelled queued mutation", rollbackError);
      }
    }

    queued.reject(new MutationCancelledError("Queued mutation cancelled"));
    notify();
    return true;
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    listener({ ...stats, pendingByKey: { ...stats.pendingByKey } });

    return () => {
      listeners.delete(listener);
    };
  };

  const getState = () => ({
    running: stats.running,
    queued: stats.queued,
    totalPending: stats.totalPending,
    pendingByKey: { ...stats.pendingByKey }
  });

  notify();

  return {
    enqueueMutation,
    cancelQueuedMutation,
    subscribe,
    getState
  };
}
