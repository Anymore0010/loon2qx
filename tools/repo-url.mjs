/**
 * Works out this repository's raw.githubusercontent.com base URL.
 *
 * The offline profile embeds absolute URLs pointing back at the snapshot files
 * committed in this repository. Hard-coding (or leaking a local test value)
 * silently produces a profile whose every resource 404s, so the base is
 * resolved from the git remote, with CI env vars taking precedence.
 *
 * Precedence:
 *   1. GITHUB_REPOSITORY + GITHUB_REF_NAME  (CI)
 *   2. SNAPSHOT_REPO + SNAPSHOT_REF         (explicit override)
 *   3. `git remote get-url origin`          (local)
 */
import { execFileSync } from "node:child_process";

/** Parses owner/repo out of any common GitHub remote URL form. */
export function parseRemote(url) {
  if (!url) return null;
  const patterns = [
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ];
  for (const re of patterns) {
    const m = url.trim().match(re);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}

function gitRemoteOrigin(cwd) {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Current branch name, falling back to "main". */
function gitBranch(cwd) {
  try {
    const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name && name !== "HEAD" ? name : "main";
  } catch {
    return "main";
  }
}

/**
 * @param {string} cwd directory used to inspect the git remote
 * @returns {{owner: string, repo: string, ref: string, slug: string, rawBase: string}}
 */
export function resolveRepoBase(cwd) {
  let owner;
  let repo;
  let ref;

  const envSlug = process.env.GITHUB_REPOSITORY;
  if (envSlug && envSlug.includes("/")) {
    [owner, repo] = envSlug.split("/");
    ref = process.env.GITHUB_REF_NAME || "main";
  } else if (process.env.SNAPSHOT_REPO && process.env.SNAPSHOT_REPO.includes("/")) {
    [owner, repo] = process.env.SNAPSHOT_REPO.split("/");
    ref = process.env.SNAPSHOT_REF || "main";
  } else {
    const parsed = parseRemote(gitRemoteOrigin(cwd));
    if (!parsed) {
      throw new Error(
        "Cannot determine repository owner/name. Set SNAPSHOT_REPO=owner/name (and optionally SNAPSHOT_REF), or add a git 'origin' remote."
      );
    }
    ({ owner, repo } = parsed);
    ref = process.env.SNAPSHOT_REF || gitBranch(cwd);
  }

  const slug = `${owner}/${repo}`;
  return {
    owner,
    repo,
    ref,
    slug,
    rawBase: `https://raw.githubusercontent.com/${slug}/${ref}`,
  };
}
