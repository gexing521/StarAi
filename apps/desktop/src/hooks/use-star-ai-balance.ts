import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { isStarAiProviderId, type StarAiBalanceSnapshot } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";

type BalanceStoreState = {
  snapshot: StarAiBalanceSnapshot | null;
  loading: boolean;
  openingTopUp: boolean;
  error: boolean;
  lastFetchedAt: number;
};

export const STARAI_BALANCE_POLL_INTERVAL_MS = 60_000;

let state: BalanceStoreState = {
  snapshot: null,
  loading: false,
  openingTopUp: false,
  error: false,
  lastFetchedAt: 0,
};

let inflight: Promise<StarAiBalanceSnapshot | null> | null = null;
let activePollSubscribers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<BalanceStoreState>) {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

function hasBridge(): boolean {
  return typeof window !== "undefined" && typeof window.piDesktop?.invoke === "function";
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

async function fetchStarAiBalance(options?: {
  force?: boolean;
  staleMs?: number;
}): Promise<StarAiBalanceSnapshot | null> {
  if (!hasBridge()) return state.snapshot;
  const staleMs = options?.staleMs ?? STARAI_BALANCE_POLL_INTERVAL_MS;
  if (!options?.force && state.lastFetchedAt > 0 && Date.now() - state.lastFetchedAt < staleMs) {
    return state.snapshot;
  }
  if (inflight) return inflight;
  setState({ loading: true });
  inflight = api.starAiBalance().then(
    (snapshot) => {
      setState({
        snapshot,
        loading: false,
        error: false,
        lastFetchedAt: Date.now(),
      });
      return snapshot;
    },
    (error: unknown) => {
      const code = (error as { code?: string } | null)?.code;
      if (code === "STARAI_LOGIN_REQUIRED") {
        setState({
          snapshot: null,
          loading: false,
          error: false,
          lastFetchedAt: Date.now(),
        });
        return null;
      }
      setState({
        loading: false,
        error: true,
      });
      return state.snapshot;
    },
  ).finally(() => {
    inflight = null;
  });
  return inflight;
}

function startPolling() {
  activePollSubscribers += 1;
  if (pollTimer !== null || typeof window === "undefined") return;
  pollTimer = setInterval(() => {
    if (!isDocumentVisible()) return;
    void fetchStarAiBalance({ staleMs: STARAI_BALANCE_POLL_INTERVAL_MS });
  }, STARAI_BALANCE_POLL_INTERVAL_MS);
}

function stopPolling() {
  activePollSubscribers = Math.max(0, activePollSubscribers - 1);
  if (activePollSubscribers === 0 && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function triggerStarAiTopUp(): Promise<void> {
  if (!hasBridge() || state.openingTopUp) return;
  setState({ openingTopUp: true });
  try {
    const result = await api.starAiTopUp();
    if (result?.balance) {
      setState({
        snapshot: result.balance,
        error: false,
        lastFetchedAt: Date.now(),
      });
    } else {
      void fetchStarAiBalance({ force: true });
    }
  } finally {
    setState({ openingTopUp: false });
  }
}

export function resetStarAiBalanceStoreForTests() {
  inflight = null;
  activePollSubscribers = 0;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  state = {
    snapshot: null,
    loading: false,
    openingTopUp: false,
    error: false,
    lastFetchedAt: 0,
  };
  emit();
}

export function useStarAiBalance() {
  const providers = useAppStore((s) => s.providers);
  const hasStarAiProvider = providers.some((provider) => isStarAiProviderId(provider.id));
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const prevHasStarAiRef = useRef(hasStarAiProvider);

  useEffect(() => {
    if (!hasStarAiProvider) {
      if (prevHasStarAiRef.current && state.snapshot !== null) {
        setState({ snapshot: null, error: false, lastFetchedAt: 0 });
      }
      prevHasStarAiRef.current = false;
      return;
    }
    const becameSignedIn = !prevHasStarAiRef.current;
    prevHasStarAiRef.current = true;
    void fetchStarAiBalance({ force: becameSignedIn });
    startPolling();
    const onVisibleOrFocus = () => {
      if (!isDocumentVisible()) return;
      void fetchStarAiBalance({ staleMs: STARAI_BALANCE_POLL_INTERVAL_MS });
    };
    window.addEventListener("focus", onVisibleOrFocus);
    document.addEventListener("visibilitychange", onVisibleOrFocus);
    return () => {
      stopPolling();
      window.removeEventListener("focus", onVisibleOrFocus);
      document.removeEventListener("visibilitychange", onVisibleOrFocus);
    };
  }, [hasStarAiProvider]);

  const refresh = useCallback(() => {
    return fetchStarAiBalance({ force: true });
  }, []);

  const openTopUp = useCallback(() => {
    return triggerStarAiTopUp();
  }, []);

  return {
    hasStarAiProvider,
    snapshot: store.snapshot,
    loading: store.loading,
    openingTopUp: store.openingTopUp,
    error: store.error,
    refresh,
    openTopUp,
  };
}
