import { describe, expect, it } from "vitest";
import {
  isGithubLoginAllowed,
  resolveGithubAllowlist,
} from "./github-allowlist.js";

describe("resolveGithubAllowlist", () => {
  it("treats an unset value as open signup", () => {
    expect(resolveGithubAllowlist({})).toBeNull();
  });

  it("parses, trims, and case-folds the list", () => {
    const allowlist = resolveGithubAllowlist({
      ALLOWED_GITHUB_LOGINS: " MikeAStock , octocat,, ",
    });
    expect([...(allowlist ?? [])]).toEqual(["mikeastock", "octocat"]);
  });

  it("rejects a set-but-empty value rather than falling open", () => {
    expect(() =>
      resolveGithubAllowlist({ ALLOWED_GITHUB_LOGINS: "  , ," }),
    ).toThrow("lists no logins");
  });
});

describe("isGithubLoginAllowed", () => {
  it("allows anyone when no allowlist is configured", () => {
    expect(isGithubLoginAllowed(null, "anyone")).toBe(true);
    expect(isGithubLoginAllowed(null, null)).toBe(true);
  });

  it("matches regardless of the casing GitHub reports", () => {
    const allowlist = resolveGithubAllowlist({
      ALLOWED_GITHUB_LOGINS: "mikeastock",
    });
    expect(isGithubLoginAllowed(allowlist, "MikeAStock")).toBe(true);
    expect(isGithubLoginAllowed(allowlist, "mikeastock")).toBe(true);
  });

  it("refuses logins outside the list", () => {
    const allowlist = resolveGithubAllowlist({
      ALLOWED_GITHUB_LOGINS: "mikeastock",
    });
    expect(isGithubLoginAllowed(allowlist, "someone-else")).toBe(false);
  });

  it("refuses accounts with no GitHub login once an allowlist exists", () => {
    const allowlist = resolveGithubAllowlist({
      ALLOWED_GITHUB_LOGINS: "mikeastock",
    });
    expect(isGithubLoginAllowed(allowlist, null)).toBe(false);
    expect(isGithubLoginAllowed(allowlist, undefined)).toBe(false);
    expect(isGithubLoginAllowed(allowlist, "   ")).toBe(false);
  });
});
