// The one command that starts the local runner from a clean clone (Node and pnpm installed).
// The README, the hosted page's org-CORS message and `pnpm donewhen` all use this string.
export const LOCAL_START_COMMAND =
  'git clone https://github.com/wth-lg/clinical-agent-env && cd clinical-agent-env && pnpm start';
