import { useCallback, useEffect, useState } from "react";

export interface HashRoute {
  path: string;
  params: Record<string, string>;
}

function parseHash(): HashRoute {
  const raw = window.location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = raw.split("?");
  const path = pathPart.startsWith("/") ? pathPart : `/${pathPart}`;
  const params: Record<string, string> = {};
  if (queryPart) {
    for (const segment of queryPart.split("&")) {
      const [key, value] = segment.split("=");
      if (key) {
        params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : "";
      }
    }
  }
  return { path, params };
}

export function useHashRoute(): HashRoute & { navigate: (hash: string) => void } {
  const [route, setRoute] = useState<HashRoute>(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((hash: string) => {
    window.location.hash = hash.startsWith("#") ? hash : `#${hash}`;
  }, []);

  return { ...route, navigate };
}
