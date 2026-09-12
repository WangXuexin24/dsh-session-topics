/**
 * dsh-session-topics host half — deliberately empty.
 *
 * The profile row (`cordis.patch.yml` → id `session-topics`) must resolve to a
 * host module, so this file exists to be that module. It intentionally:
 *
 *   - declares NO `inject` — it depends on no host service, so it cannot sit
 *     pending at boot. (A plugin whose host half injects `workspace` /
 *     `storageDomain` / etc. is exactly what stalls `dsh web` startup.)
 *   - registers no tool, no prompt, no session event — zero token cost.
 *   - touches no file, no subprocess, no PowerShell.
 *
 * Everything the plugin does lives in `lib/client.js` (the browser half), and
 * all of its state is persisted client-side by `defineStore({ persist })`.
 *
 * @module dsh-session-topics
 */

/**
 * Host-side entry. Intentionally a no-op.
 * @returns nothing.
 */
export function apply() {
  // no-op on purpose — see the module doc comment.
}
