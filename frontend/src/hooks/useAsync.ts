import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export interface UseAsyncOptions {
  /** Run the fetcher automatically on mount or dependency change. */
  autoRun?: boolean;
}

/**
 * Generic async data hook. Handles loading, error, and data states.
 *
 * Example:
 *   const { data, loading, error, refresh } = useAsync(api.getUsers, []);
 */
export function useAsync<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList = [],
  options: UseAsyncOptions = { autoRun: true }
) {
  const [state, setState] = useState<AsyncState<T>>({
    data: null,
    loading: options.autoRun !== false,
    error: null,
  });

  // Keep the latest fetcher reference without making refresh unstable.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fetcherRef.current();
      setState({ data, loading: false, error: null });
      return data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ data: null, loading: false, error: message });
      throw err;
    }
  }, []);

  const reset = useCallback(() => {
    setState({ data: null, loading: false, error: null });
  }, []);

  useEffect(() => {
    if (options.autoRun !== false) {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, options.autoRun, ...deps]);

  return { ...state, refresh, reset, setData: (data: T | null) => setState((s) => ({ ...s, data })) };
}
