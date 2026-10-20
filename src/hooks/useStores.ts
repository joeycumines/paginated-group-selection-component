import { useCallback, useSyncExternalStore } from 'react';
import type { SelectionEngine } from '../engine/SelectionEngine';
import type { MockServer } from '../server/mockServer';

const noop = () => () => {};

/** Re-render whenever the engine bumps its version. */
export function useEngineVersion(engine: SelectionEngine | null): number {
  const subscribe = useCallback((cb: () => void) => (engine ? engine.subscribe(cb) : noop()), [engine]);
  const getSnapshot = useCallback(() => (engine ? engine.version : -1), [engine]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Re-render whenever the mock server records a request. */
export function useServerLog(server: MockServer) {
  const getSnapshot = useCallback(() => server.log[server.log.length - 1]?.seq ?? 0, [server]);
  return useSyncExternalStore(server.subscribe, getSnapshot);
}
