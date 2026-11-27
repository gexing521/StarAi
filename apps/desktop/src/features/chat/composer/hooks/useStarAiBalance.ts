import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { isStarAiProviderId, type StarAiBalanceSnapshot } from "@pi-desktop/shared";
import { api } from "../../../../lib/api";
import { useAppStore } from "../../../../stores/app-store";

type BalanceStoreState = {
  snapshot: StarAiBalanceSnapshot | null;
  loading: boolean;
  openingTopUp: boolean;
  error: boolean;
  lastFetchedAt: number;
};

const REFRESH_STALE_MS = 30_000;
const FOCUS_REFRESH_STALE_MS = 10_000;
const OPEN_REFRESH_STALE_MS = 5_000;

let state: BalanceStoreState = {
  snapshot: null,
  loading: false,
  openingTopUp: false,
  error: false,
  lastFetchedAt: 0,
};

let inflight: Promise<StarAiBalanceSnapshot | null> | null = null;
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

async function fetchStarAiBalance(options?: { force?: boolean; staleMs?: number }): Promise<StarAiBalanceSnapshot | null> {
  if (!hasBridge()) return state.snapshot;
  const staleMs = options?.staleMs ?? REFRESH_STALE_MS;
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
  state = {
    snapshot: null,
    loading: false,
    openingTopUp: false,
    error: false,
    lastFetchedAt: 0,
  };
  emit();
}

export function useStarAiBalance({ open, runActive }: { open: boolean; runActive: boolean }) {
  const providers = useAppStore((s) => s.providers);
  const hasStarAiProvider = providers.some((provider) => isStarAiProviderId(provider.id));
  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const prevRunActiveRef = useRef(runActive);
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
  }, [hasStarAiProvider]);

  useEffect(() => {
    const wasRunning = prevRunActiveRef.current;
    prevRunActiveRef.current = runActive;
    if (wasRunning && !runActive && hasStarAiProvider) {
      void fetchStarAiBalance({ force: true });
    }
  }, [hasStarAiProvider, runActive]);

  useEffect(() => {
    if (!open || !hasStarAiProvider) return;
    void fetchStarAiBalance({ staleMs: OPEN_REFRESH_STALE_MS });
  }, [open, hasStarAiProvider]);

  useEffect(() => {
    if (!hasStarAiProvider || typeof window === "undefined") return;
    const onFocus = () => {
      void fetchStarAiBalance({ staleMs: FOCUS_REFRESH_STALE_MS });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
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
