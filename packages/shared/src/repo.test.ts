import { describe, it, expect } from "vitest";
import { normalizeRepoUrl, resolveRepoKey, isRepoId, pickRootCommit } from "./repo.js";

describe("normalizeRepoUrl", () => {
  it("collapses every spelling of one remote to a single id", () => {
    // T3 — the field failure: one team split into isolated groups by URL spelling.
    const expected = "github.com/acme/app";
    for (const url of [
      "git@github.com:Acme/App.git",
      "https://github.com/Acme/App.git",
      "https://github.com/acme/app",
      "ssh://git@github.com/Acme/App",
      "http://github.com/ACME/APP.git",
      "github.com/Acme/App/",
    ]) {
      expect(normalizeRepoUrl(url), url).toBe(expected);
    }
  });

  it("works for non-GitHub hosts", () => {
    expect(normalizeRepoUrl("git@gitlab.com:Group/Sub.git")).toBe("gitlab.com/group/sub");
    expect(normalizeRepoUrl("https://bitbucket.org/Team/Repo.git")).toBe("bitbucket.org/team/repo");
  });

  it("leaves an already-normalized id untouched", () => {
    expect(normalizeRepoUrl("github.com/acme/app")).toBe("github.com/acme/app");
  });
});

describe("resolveRepoKey", () => {
  const ROOT = "caaa8780f2853aec824905cc3278402fc26caa0a";

  it("prefers repoId, so a fork and its upstream share one partition", () => {
    // T1's precondition — the two names have nothing in common, but the root
    // commit is identical because a fork inherits the whole history.
    const upstream = resolveRepoKey(ROOT, "github.com/Rohanxmalik/genos-ai");
    const fork = resolveRepoKey(ROOT, "github.com/mayank-9031/genos-ai");
    expect(upstream).toBe(fork);
    expect(upstream).toBe(ROOT);
  });

  it("falls back to the normalized URL when no repoId is supplied", () => {
    expect(resolveRepoKey(undefined, "git@github.com:Acme/App.git")).toBe("github.com/acme/app");
    expect(resolveRepoKey("", "https://github.com/Acme/App")).toBe("github.com/acme/app");
    expect(resolveRepoKey("   ", "github.com/Acme/App")).toBe("github.com/acme/app");
  });

  it("still converges two older clients that both omit repoId", () => {
    expect(resolveRepoKey(undefined, "git@github.com:Acme/App.git")).toBe(
      resolveRepoKey(undefined, "https://github.com/acme/app"),
    );
  });

  it("is case-insensitive on the repoId itself", () => {
    expect(resolveRepoKey(ROOT.toUpperCase(), "anything")).toBe(ROOT);
  });
});

describe("isRepoId", () => {
  it("accepts sha-1 and sha-256 object ids", () => {
    expect(isRepoId("caaa8780f2853aec824905cc3278402fc26caa0a")).toBe(true);
    expect(isRepoId("a".repeat(64))).toBe(true);
  });

  it("rejects anything that isn't an object id", () => {
    for (const bad of ["", "github.com/acme/app", "caaa878", "z".repeat(40), "  "]) {
      expect(isRepoId(bad), bad).toBe(false);
    }
  });
});

describe("pickRootCommit", () => {
  it("reads the single root commit", () => {
    expect(pickRootCommit("caaa8780f2853aec824905cc3278402fc26caa0a\n")).toBe(
      "caaa8780f2853aec824905cc3278402fc26caa0a",
    );
  });

  it("takes the earliest when a repo has several root commits", () => {
    // git lists newest-first, so the last line is the earliest — and it's the one
    // every fork of this repo also has.
    const newer = "b".repeat(40);
    const earliest = "a".repeat(40);
    expect(pickRootCommit(`${newer}\n${earliest}`)).toBe(earliest);
  });

  it("returns undefined rather than keying on garbage", () => {
    // A shallow clone or a non-repo gives no usable sha; callers fall back to the URL.
    expect(pickRootCommit("")).toBeUndefined();
    expect(pickRootCommit("fatal: not a git repository")).toBeUndefined();
  });
});
