/**
 * Where the API lives.
 *
 * - `VITE_KEYSTONE_API_URL` when set (deployments that serve the dashboard from
 *   a different origin than the API).
 * - Dev server default: the Vite dev process runs on :5173 and the API on :4001.
 * - Production builds fall back to "" — same origin. The server image serves
 *   `frontend/dist` itself, so a release build must NOT bake in localhost: an
 *   empty base makes every fetch relative to wherever the page was served from.
 */
const fromEnv: string | undefined = import.meta.env.VITE_KEYSTONE_API_URL;

export const API_BASE: string = fromEnv
  ? fromEnv
  : import.meta.env.DEV
    ? "http://localhost:4001"
    : "";