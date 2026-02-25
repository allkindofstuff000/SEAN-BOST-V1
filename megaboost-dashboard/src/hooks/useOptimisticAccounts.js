import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../lib/api";
import { createMutationQueue, MutationCancelledError } from "../utils/mutationQueue";
import { isRunningLikeStatus, isStartAllEligibleStatus } from "../utils/accountStatus";

const RETRY_OPTIONS = {
  enabled: true,
  attempts: 3,
  delays: [500, 1500, 4000],
  jitterMs: 250
};

const INITIAL_QUEUE_STATE = {
  running: 0,
  queued: 0,
  totalPending: 0,
  pendingByKey: {}
};

function createMutationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeAccount(payload) {
  if (!payload) return null;
  if (payload.accountId && payload.patch && typeof payload.patch === "object") {
    return {
      _id: String(payload.accountId),
      ...payload.patch
    };
  }

  const candidate = payload.data && !Array.isArray(payload.data)
    ? payload.data
    : payload.account || payload;

  if (candidate?.accountId && candidate?.patch && typeof candidate.patch === "object") {
    return {
      _id: String(candidate.accountId),
      ...candidate.patch
    };
  }

  return candidate;
}

function withAccountUpdate(accounts, accountId, updater) {
  const index = accounts.findIndex((account) => account._id === accountId);
  if (index < 0) {
    return { changed: false, next: accounts, previous: null };
  }

  const previous = accounts[index];
  const updated = updater(previous);

  if (updated === previous) {
    return { changed: false, next: accounts, previous };
  }

  const next = accounts.slice();
  next[index] = updated;
  return { changed: true, next, previous };
}

function isCancelled(error) {
  return error instanceof MutationCancelledError || error?.code === "MUTATION_CANCELLED";
}

function shallowEqualObjects(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;

  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  for (let i = 0; i < leftKeys.length; i += 1) {
    const key = leftKeys[i];
    if (left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

export default function useOptimisticAccounts({
  accounts,
  setAccounts,
  setUsedAccounts,
  setAccountLimit,
  notifyError,
  notifySuccess,
  ensureLicenseAllows,
  maxConcurrency = 5
}) {
  const queueRef = useRef(createMutationQueue({ maxConcurrency }));
  const accountsRef = useRef(accounts || []);
  const pendingMutationByAccountRef = useRef(new Map());
  const queueStateRef = useRef(INITIAL_QUEUE_STATE);

  const [queueState, setQueueState] = useState(INITIAL_QUEUE_STATE);

  useEffect(() => {
    accountsRef.current = accounts || [];
  }, [accounts]);

  useEffect(() => {
    const unsubscribe = queueRef.current.subscribe((snapshot) => {
      queueStateRef.current = snapshot;
      setQueueState(snapshot);
    });

    return unsubscribe;
  }, []);

  const setPendingMeta = useCallback((accountId, pending) => {
    if (!accountId) return;

    if (!pending) {
      pendingMutationByAccountRef.current.delete(accountId);
      return;
    }

    pendingMutationByAccountRef.current.set(accountId, pending);
  }, []);

  const clearPendingMetaIfCurrent = useCallback((accountId, mutationId) => {
    const current = pendingMutationByAccountRef.current.get(accountId);
    if (current?.mutationId === mutationId) {
      pendingMutationByAccountRef.current.delete(accountId);
    }
  }, []);

  const isLatestMutation = useCallback((accountId, mutationId) => {
    return pendingMutationByAccountRef.current.get(accountId)?.mutationId === mutationId;
  }, []);

  const isAccountPending = useCallback((accountId) => {
    if (!accountId) return false;

    const fromQueue = Boolean(queueStateRef.current.pendingByKey[accountId]);
    const fromMeta = pendingMutationByAccountRef.current.has(accountId);
    return fromQueue || fromMeta;
  }, []);

  const isGlobalPending = queueState.running > 0 || queueState.queued > 0;

  const handleError = useCallback(
    (prefix, error) => {
      if (isCancelled(error)) return;

      const message = error?.response?.data?.message || error?.message || "Unknown error";
      notifyError(`${prefix}: ${message}`);
      console.error(prefix, error);
    },
    [notifyError]
  );

  const enqueueAccountMutation = useCallback(
    async ({
      accountId,
      type,
      expectedStatus,
      optimisticApply,
      rollback,
      run,
      onSuccess,
      errorPrefix
    }) => {
      const mutationId = createMutationId();

      return queueRef.current.enqueueMutation({
        key: accountId,
        type,
        mutationId,
        optimisticApply: () => {
          setPendingMeta(accountId, { mutationId, type, expectedStatus });
          return optimisticApply(mutationId);
        },
        rollback: (error, job) => {
          if (!isLatestMutation(accountId, mutationId)) {
            return;
          }

          rollback(error, job.optimisticContext, mutationId);
          clearPendingMetaIfCurrent(accountId, mutationId);
          handleError(errorPrefix, error);
        },
        run,
        onSuccess: (result) => {
          if (!isLatestMutation(accountId, mutationId)) {
            return;
          }

          onSuccess(result, mutationId);
          clearPendingMetaIfCurrent(accountId, mutationId);
        },
        onError: () => {
          // rollback already handles user-facing behavior.
        }
      });
    },
    [clearPendingMetaIfCurrent, handleError, isLatestMutation, setPendingMeta]
  );

  const startAccount = useCallback(
    async (accountId) => {
      if (!accountId) return null;

      try {
        return await enqueueAccountMutation({
          accountId,
          type: "start",
          expectedStatus: "running",
          optimisticApply: (mutationId) => {
            let previousAccount = null;

            setAccounts((prev) => {
              const { changed, next, previous } = withAccountUpdate(prev, accountId, (current) => ({
                ...current,
                status: "running",
                __syncing: true,
                __pendingMutationId: mutationId
              }));

              previousAccount = previous;
              return changed ? next : prev;
            });

            return { previousAccount };
          },
          rollback: (_error, context, mutationId) => {
            setAccounts((prev) => {
              if (!context?.previousAccount) return prev;

              const { changed, next } = withAccountUpdate(prev, accountId, () => ({
                ...context.previousAccount,
                __syncing: false,
                __pendingMutationId: null
              }));

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          run: () => api.post(`/api/accounts/${accountId}/start`, {}, { retry: RETRY_OPTIONS }),
          onSuccess: (response, mutationId) => {
            const serverAccount = normalizeAccount(response?.data);

            setAccounts((prev) => {
              const { changed, next } = withAccountUpdate(prev, accountId, (current) => {
                const merged = serverAccount?._id
                  ? { ...current, ...serverAccount }
                  : { ...current, status: "running" };

                return {
                  ...merged,
                  __syncing: false,
                  __pendingMutationId: null
                };
              });

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          errorPrefix: "Failed to start account"
        });
      } catch (error) {
        if (!isCancelled(error)) {
          console.error("startAccount failed", error);
        }
        return null;
      }
    },
    [clearPendingMetaIfCurrent, enqueueAccountMutation, setAccounts]
  );

  const stopAccount = useCallback(
    async (accountId) => {
      if (!accountId) return null;

      try {
        return await enqueueAccountMutation({
          accountId,
          type: "stop",
          expectedStatus: "stopped",
          optimisticApply: (mutationId) => {
            let previousAccount = null;

            setAccounts((prev) => {
              const { changed, next, previous } = withAccountUpdate(prev, accountId, (current) => ({
                ...current,
                status: "stopped",
                __syncing: true,
                __pendingMutationId: mutationId
              }));

              previousAccount = previous;
              return changed ? next : prev;
            });

            return { previousAccount };
          },
          rollback: (_error, context, mutationId) => {
            setAccounts((prev) => {
              if (!context?.previousAccount) return prev;

              const { changed, next } = withAccountUpdate(prev, accountId, () => ({
                ...context.previousAccount,
                __syncing: false,
                __pendingMutationId: null
              }));

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          run: () => api.post(`/api/accounts/${accountId}/stop`, {}, { retry: RETRY_OPTIONS }),
          onSuccess: (response, mutationId) => {
            const serverAccount = normalizeAccount(response?.data);

            setAccounts((prev) => {
              const { changed, next } = withAccountUpdate(prev, accountId, (current) => {
                const merged = serverAccount?._id
                  ? { ...current, ...serverAccount }
                  : { ...current, status: "stopped" };

                return {
                  ...merged,
                  __syncing: false,
                  __pendingMutationId: null
                };
              });

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          errorPrefix: "Failed to stop account"
        });
      } catch (error) {
        if (!isCancelled(error)) {
          console.error("stopAccount failed", error);
        }
        return null;
      }
    },
    [clearPendingMetaIfCurrent, enqueueAccountMutation, setAccounts]
  );

  const restartAccount = useCallback(
    async (accountId) => {
      if (!accountId) return null;

      try {
        return await enqueueAccountMutation({
          accountId,
          type: "restart",
          expectedStatus: "starting",
          optimisticApply: (mutationId) => {
            let previousAccount = null;

            setAccounts((prev) => {
              const { changed, next, previous } = withAccountUpdate(prev, accountId, (current) => ({
                ...current,
                status: "restarting",
                nextBumpAt: null,
                nextBumpDelayMs: null,
                waitingUntil: null,
                cooldownMinutes: null,
                __syncing: true,
                __pendingMutationId: mutationId
              }));

              previousAccount = previous;
              return changed ? next : prev;
            });

            return { previousAccount };
          },
          rollback: (_error, context, mutationId) => {
            setAccounts((prev) => {
              if (!context?.previousAccount) return prev;

              const { changed, next } = withAccountUpdate(prev, accountId, () => ({
                ...context.previousAccount,
                __syncing: false,
                __pendingMutationId: null
              }));

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          run: () => api.post(`/api/accounts/${accountId}/restart`, {}, { retry: RETRY_OPTIONS }),
          onSuccess: (response, mutationId) => {
            const serverAccount = normalizeAccount(response?.data);

            setAccounts((prev) => {
              const { changed, next } = withAccountUpdate(prev, accountId, (current) => {
                const merged = serverAccount?._id
                  ? { ...current, ...serverAccount }
                  : {
                      ...current,
                      status: "starting",
                      nextBumpAt: null,
                      nextBumpDelayMs: null,
                      waitingUntil: null,
                      cooldownMinutes: null
                    };

                return {
                  ...merged,
                  __syncing: false,
                  __pendingMutationId: null
                };
              });

              return changed ? next : prev;
            });

            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          errorPrefix: "Failed to restart account"
        });
      } catch (error) {
        if (!isCancelled(error)) {
          console.error("restartAccount failed", error);
        }
        return null;
      }
    },
    [clearPendingMetaIfCurrent, enqueueAccountMutation, setAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId) => {
      if (!accountId) return null;

      try {
        return await enqueueAccountMutation({
          accountId,
          type: "delete",
          expectedStatus: null,
          optimisticApply: () => {
            let previousAccount = null;
            let previousIndex = -1;

            setAccounts((prev) => {
              previousIndex = prev.findIndex((account) => account._id === accountId);
              if (previousIndex < 0) return prev;

              previousAccount = prev[previousIndex];
              const next = prev.slice();
              next.splice(previousIndex, 1);
              return next;
            });

            if (previousAccount) {
              setUsedAccounts((value) => Math.max(0, value - 1));
            }

            return { previousAccount, previousIndex };
          },
          rollback: (_error, context, mutationId) => {
            if (!context?.previousAccount) return;

            setAccounts((prev) => {
              if (prev.some((account) => account._id === context.previousAccount._id)) {
                return prev;
              }

              const next = prev.slice();
              const insertAt = Math.max(0, Math.min(context.previousIndex, next.length));
              next.splice(insertAt, 0, {
                ...context.previousAccount,
                __syncing: false,
                __pendingMutationId: null
              });

              return next;
            });

            setUsedAccounts((value) => value + 1);
            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          run: () => api.delete(`/api/accounts/${accountId}`, { retry: RETRY_OPTIONS }),
          onSuccess: (_response, mutationId) => {
            clearPendingMetaIfCurrent(accountId, mutationId);
          },
          errorPrefix: "Failed to delete account"
        });
      } catch (error) {
        if (!isCancelled(error)) {
          console.error("deleteAccount failed", error);
        }
        return null;
      }
    },
    [clearPendingMetaIfCurrent, enqueueAccountMutation, setAccounts, setUsedAccounts]
  );

  const addAccount = useCallback(
    async (payload) => {
      await ensureLicenseAllows({ action: "add", additionalAccounts: 1 });

      const tempId = `temp-${createMutationId()}`;
      const mutationId = createMutationId();

      return queueRef.current.enqueueMutation({
        key: "account:add",
        type: "add",
        mutationId,
        optimisticApply: () => {
          const optimisticAccount = {
            _id: tempId,
            email: payload.email,
            status: "stopped",
            createdAt: new Date().toISOString(),
            proxyHost: payload.proxyHost,
            proxyPort: payload.proxyPort,
            proxyUsername: payload.proxyUsername,
            proxyPassword: payload.proxyPassword,
            __syncing: true,
            __pendingMutationId: mutationId,
            __optimistic: true
          };

          setAccounts((prev) => [optimisticAccount, ...prev]);
          setUsedAccounts((value) => value + 1);

          return { tempId };
        },
        rollback: (error, context) => {
          setAccounts((prev) => prev.filter((account) => account._id !== context?.tempId));
          setUsedAccounts((value) => Math.max(0, value - 1));
          handleError("Failed to add account", error);
        },
        run: () => api.post("/api/accounts", payload, { retry: RETRY_OPTIONS }),
        onSuccess: (response) => {
          const body = response?.data || {};
          const created = normalizeAccount(body);

          setAccounts((prev) =>
            prev.map((account) => {
              if (account._id !== tempId) return account;

              return {
                ...(created || account),
                __syncing: false,
                __pendingMutationId: null,
                __optimistic: false
              };
            })
          );

          if (typeof body?.meta?.usedAccounts === "number") {
            setUsedAccounts(body.meta.usedAccounts);
          }

          if (typeof body?.meta?.accountLimit === "number") {
            setAccountLimit(body.meta.accountLimit);
          }

          notifySuccess("Account added");
          return created;
        },
        onError: () => {
          // rollback handles user-facing error behavior.
        }
      });
    },
    [ensureLicenseAllows, handleError, notifySuccess, setAccountLimit, setAccounts, setUsedAccounts]
  );

  const updateAccountSettings = useCallback(
    async (accountId, patch) => {
      if (!accountId) return null;

      return enqueueAccountMutation({
        accountId,
        type: "update-settings",
        expectedStatus: null,
        optimisticApply: (mutationId) => {
          let previousAccount = null;

          setAccounts((prev) => {
            const { changed, next, previous } = withAccountUpdate(prev, accountId, (current) => ({
              ...current,
              ...patch,
              __syncing: true,
              __pendingMutationId: mutationId
            }));

            previousAccount = previous;
            return changed ? next : prev;
          });

          return { previousAccount };
        },
        rollback: (_error, context, mutationId) => {
          if (!context?.previousAccount) return;

          setAccounts((prev) => {
            const { changed, next } = withAccountUpdate(prev, accountId, () => ({
              ...context.previousAccount,
              __syncing: false,
              __pendingMutationId: null
            }));

            return changed ? next : prev;
          });

          clearPendingMetaIfCurrent(accountId, mutationId);
        },
        run: () => api.put(`/api/accounts/${accountId}`, patch, { retry: RETRY_OPTIONS }),
        onSuccess: (response, mutationId) => {
          const serverAccount = normalizeAccount(response?.data);

          setAccounts((prev) => {
            const { changed, next } = withAccountUpdate(prev, accountId, (current) => ({
              ...current,
              ...(serverAccount || patch),
              __syncing: false,
              __pendingMutationId: null
            }));

            return changed ? next : prev;
          });

          clearPendingMetaIfCurrent(accountId, mutationId);
          notifySuccess("Settings updated");
        },
        errorPrefix: "Failed to update account settings"
      });
    },
    [clearPendingMetaIfCurrent, enqueueAccountMutation, notifySuccess, setAccounts]
  );

  const toggleStatus = useCallback(
    (accountId, currentStatus) => {
      if (isRunningLikeStatus(currentStatus)) {
        return stopAccount(accountId);
      }
      return startAccount(accountId);
    },
    [startAccount, stopAccount]
  );

  const startAllAccounts = useCallback(
    async (accountsList) => {
      await ensureLicenseAllows({ action: "start_all" });

      const source = accountsList || accountsRef.current || [];
      const targets = source.filter((account) => isStartAllEligibleStatus(account.status));
      const targetIds = targets.map((account) => account._id).filter(Boolean);

      if (targetIds.length === 0) {
        return {
          success: true,
          data: {
            requested: source.length,
            eligible: 0,
            started: 0,
            startedAccountIds: []
          }
        };
      }

      const targetIdSet = new Set(targetIds);
      const previousStatusById = new Map(
        targets.map((account) => [account._id, account.status])
      );

      setAccounts((prev) =>
        prev.map((account) => {
          if (!targetIdSet.has(account._id)) return account;
          return {
            ...account,
            status: "starting",
            __syncing: true,
            __pendingMutationId: null
          };
        })
      );

      try {
        const response = await api.post(
          "/api/accounts/start-all",
          { accountIds: targetIds },
          { retry: RETRY_OPTIONS }
        );

        const body = response?.data || {};
        const startedIds = Array.isArray(body?.data?.startedAccountIds)
          ? body.data.startedAccountIds.map((id) => String(id))
          : targetIds;
        const startedIdSet = new Set(startedIds);

        setAccounts((prev) =>
          prev.map((account) => {
            if (!targetIdSet.has(account._id)) return account;

            if (startedIdSet.has(account._id)) {
              return {
                ...account,
                status: "starting",
                __syncing: false,
                __pendingMutationId: null
              };
            }

            return {
              ...account,
              status: previousStatusById.get(account._id) || account.status,
              __syncing: false,
              __pendingMutationId: null
            };
          })
        );

        return body;
      } catch (error) {
        setAccounts((prev) =>
          prev.map((account) => {
            if (!targetIdSet.has(account._id)) return account;
            return {
              ...account,
              status: previousStatusById.get(account._id) || account.status,
              __syncing: false,
              __pendingMutationId: null
            };
          })
        );

        handleError("Failed to start all accounts", error);
        throw error;
      }
    },
    [ensureLicenseAllows, handleError, setAccounts]
  );

  const stopAllAccounts = useCallback(
    async (accountsList) => {
      const source = accountsList || accountsRef.current || [];
      const targets = source.filter((account) => isRunningLikeStatus(account.status));
      const targetIds = targets.map((account) => account._id).filter(Boolean);

      if (targetIds.length === 0) {
        return {
          success: true,
          data: {
            requested: source.length,
            targeted: 0,
            stopped: 0,
            stoppedAccountIds: []
          }
        };
      }

      const targetIdSet = new Set(targetIds);
      const previousStatusById = new Map(
        targets.map((account) => [account._id, account.status])
      );

      setAccounts((prev) =>
        prev.map((account) => {
          if (!targetIdSet.has(account._id)) return account;
          return {
            ...account,
            status: "stopped",
            __syncing: true,
            __pendingMutationId: null
          };
        })
      );

      try {
        const response = await api.post(
          "/api/accounts/stop-all",
          { accountIds: targetIds },
          { retry: RETRY_OPTIONS }
        );

        const body = response?.data || {};
        const stoppedIds = Array.isArray(body?.data?.stoppedAccountIds)
          ? body.data.stoppedAccountIds.map((id) => String(id))
          : targetIds;
        const stoppedIdSet = new Set(stoppedIds);

        setAccounts((prev) =>
          prev.map((account) => {
            if (!targetIdSet.has(account._id)) return account;

            if (stoppedIdSet.has(account._id)) {
              return {
                ...account,
                status: "stopped",
                __syncing: false,
                __pendingMutationId: null
              };
            }

            return {
              ...account,
              status: previousStatusById.get(account._id) || account.status,
              __syncing: false,
              __pendingMutationId: null
            };
          })
        );

        return body;
      } catch (error) {
        setAccounts((prev) =>
          prev.map((account) => {
            if (!targetIdSet.has(account._id)) return account;
            return {
              ...account,
              status: previousStatusById.get(account._id) || account.status,
              __syncing: false,
              __pendingMutationId: null
            };
          })
        );

        handleError("Failed to stop all accounts", error);
        throw error;
      }
    },
    [handleError, setAccounts]
  );

  const mergeServerAccounts = useCallback(
    (serverAccounts) => {
      setAccounts((prev) => {
        const localById = new Map(prev.map((account) => [account._id, account]));

        const merged = serverAccounts.map((incoming) => {
          const local = localById.get(incoming._id);
          if (!local) {
            return {
              ...incoming,
              __syncing: false,
              __pendingMutationId: null,
              __optimistic: false
            };
          }

          const pending = pendingMutationByAccountRef.current.get(incoming._id);

          if (!pending) {
            const candidate = {
              ...local,
              ...incoming,
              __syncing: false,
              __pendingMutationId: null,
              __optimistic: false
            };
            return shallowEqualObjects(candidate, local) ? local : candidate;
          }

          const isConfirmation =
            (incoming.pendingMutationId && incoming.pendingMutationId === pending.mutationId) ||
            (pending.expectedStatus && incoming.status === pending.expectedStatus);

          if (isConfirmation) {
            pendingMutationByAccountRef.current.delete(incoming._id);
            const candidate = {
              ...local,
              ...incoming,
              __syncing: false,
              __pendingMutationId: null,
              __optimistic: false
            };
            return shallowEqualObjects(candidate, local) ? local : candidate;
          }

          return {
            ...local,
            ...incoming,
            status: local.status,
            __syncing: true,
            __pendingMutationId: pending.mutationId
          };
        });

        prev.forEach((account) => {
          if (account.__optimistic && !merged.some((item) => item._id === account._id)) {
            merged.unshift(account);
          }
        });

        return merged;
      });
    },
    [setAccounts]
  );

  const applySocketAccountUpdate = useCallback(
    (incomingUpdate) => {
      const update = normalizeAccount(incomingUpdate);
      if (!update?._id) return;

      if (update.deleted) {
        setAccounts((prev) => prev.filter((account) => account._id !== update._id));
        pendingMutationByAccountRef.current.delete(update._id);
        return;
      }

      const pending = pendingMutationByAccountRef.current.get(update._id);

      setAccounts((prev) => {
        const index = prev.findIndex((account) => account._id === update._id);
        if (index < 0) {
          return [{ ...update, __syncing: false, __pendingMutationId: null }, ...prev];
        }

        const current = prev[index];
        const next = prev.slice();

        if (!pending) {
          const candidate = {
            ...current,
            ...update,
            __syncing: false,
            __pendingMutationId: null,
            __optimistic: false
          };
          next[index] = shallowEqualObjects(candidate, current) ? current : candidate;
          return next;
        }

        const isConfirmation =
          (update.pendingMutationId && update.pendingMutationId === pending.mutationId) ||
          (pending.expectedStatus && update.status === pending.expectedStatus);

        if (isConfirmation) {
          pendingMutationByAccountRef.current.delete(update._id);
          const candidate = {
            ...current,
            ...update,
            __syncing: false,
            __pendingMutationId: null,
            __optimistic: false
          };
          next[index] = shallowEqualObjects(candidate, current) ? current : candidate;
          return next;
        }

        next[index] = {
          ...current,
          ...update,
          status: current.status,
          __syncing: true,
          __pendingMutationId: pending.mutationId
        };

        return next;
      });
    },
    [setAccounts]
  );

  const cancelQueuedMutation = useCallback((accountId) => {
    return queueRef.current.cancelQueuedMutation(accountId);
  }, []);

  const pendingMutations = useMemo(() => ({ ...queueState.pendingByKey }), [queueState.pendingByKey]);

  return {
    pendingMutations,
    queueState,
    isGlobalPending,
    isAccountPending,
    cancelQueuedMutation,
    startAccount,
    stopAccount,
    restartAccount,
    deleteAccount,
    startAllAccounts,
    stopAllAccounts,
    addAccount,
    updateAccountSettings,
    toggleStatus,
    mergeServerAccounts,
    applySocketAccountUpdate
  };
}
