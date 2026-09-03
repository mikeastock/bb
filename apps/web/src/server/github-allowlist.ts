import type { Env } from "./env.js";

export type GithubAllowlist = ReadonlySet<string> | null;
export function resolveGithubAllowlist(
  env: Pick<Env, "ALLOWED_GITHUB_LOGINS">,
): GithubAllowlist {
  const raw = env.ALLOWED_GITHUB_LOGINS;
  if (raw === undefined) return null;

  const logins = raw
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter((login) => login.length > 0);
  if (logins.length === 0) {
    throw new Error(
      "ALLOWED_GITHUB_LOGINS is set but lists no logins; unset it to allow any GitHub account",
    );
  }
  return new Set(logins);
}

export function isGithubLoginAllowed(
  allowlist: GithubAllowlist,
  githubLogin: unknown,
): boolean {
  if (allowlist === null) return true;
  if (typeof githubLogin !== "string") return false;
  const normalized = githubLogin.trim().toLowerCase();
  return normalized.length > 0 && allowlist.has(normalized);
}
