import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  normaliseFactContent,
  type RawFact,
  verifyFacts,
} from "../../src/modules/engineering-brain/evidence";
import { initRepo, tempDir } from "../fixtures/git-repo";

type Fact = RawFact;

let parent: string;
let repo: string;
let outside: string;

beforeAll(() => {
  parent = tempDir();
  repo = initRepo(join(parent, "app"));
  outside = join(parent, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside the repo\n");
  mkdirSync(join(repo, "src", "modules", "engineering-brain"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# Demo\n");
  writeFileSync(join(repo, "package.json"), '{"name":"demo"}\n');
  writeFileSync(join(repo, "src", "index.ts"), "export {};\n");
  writeFileSync(join(repo, "src", "modules", "engineering-brain", "registry.ts"), "export {};\n");
  // A symlink inside the repo pointing outside it, and one pointing at a file inside it.
  symlinkSync(join(outside, "secret.txt"), join(repo, "src", "leak.ts"));
  symlinkSync(join(repo, "src", "index.ts"), join(repo, "src", "alias.ts"));
  // Sensitive files: present and regular, but never acceptable evidence.
  mkdirSync(join(repo, "config"));
  for (const f of [
    ".env",
    ".env.production",
    "config/server.pem",
    "config/tls.KEY",
    "config/store.p12",
    "config/cert.pfx",
    "id_rsa",
    "id_ed25519.pub",
    "id_ecdsa",
    "config/credentials.json",
    ".npmrc",
  ]) {
    writeFileSync(join(repo, f), "x\n");
  }
  // A harmless-looking name that points at a sensitive file inside the repo.
  symlinkSync(join(repo, ".env"), join(repo, "src", "settings.ts"));
});
afterAll(() => rmSync(parent, { recursive: true, force: true }));

const fact = (content: string, ...paths: string[]): Fact => ({
  kind: "stack",
  content,
  evidence: paths.map((path) => ({ path })),
});

describe("verifyFacts", () => {
  test("keeps facts whose every evidence path is a regular file inside the repo", () => {
    const r = verifyFacts(repo, [
      { kind: "purpose", content: "A demo project.", evidence: [{ path: "README.md", line: 1 }] },
      fact("Uses TypeScript.", "src/index.ts", "package.json"),
      fact("An alias module re-exports the entrypoint.", "src/alias.ts"),
    ]);
    expect(r.kept.map((f) => f.content)).toEqual([
      "A demo project.",
      "Uses TypeScript.",
      "An alias module re-exports the entrypoint.",
    ]);
    expect(r.kept[0]?.evidence).toEqual([{ path: "README.md", line: 1 }]);
    expect(r.dropped).toEqual({});
  });

  test("normalises ./ and duplicate slashes in a kept evidence path", () => {
    const r = verifyFacts(repo, [fact("Entrypoint.", "./src//index.ts")]);
    expect(r.kept[0]?.evidence).toEqual([{ path: "src/index.ts" }]);
  });

  test("drops a parent-relative path", () => {
    const r = verifyFacts(repo, [fact("Reads passwd.", "../../etc/passwd")]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ unsafe_path: 1 });
  });

  test("drops an absolute path, even one inside the repo", () => {
    const r = verifyFacts(repo, [
      fact("Hosts file.", "/etc/hosts"),
      fact("Readme.", join(repo, "README.md")),
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ unsafe_path: 2 });
  });

  test("drops a symlink whose target is outside the repo", () => {
    const r = verifyFacts(repo, [fact("Leaky module.", "src/leak.ts")]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ outside_repo: 1 });
  });

  test("drops a missing file and a directory", () => {
    const r = verifyFacts(repo, [fact("Gone.", "src/missing.ts"), fact("A folder.", "src")]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ missing: 1, not_file: 1 });
  });

  test("drops a fact when any one of its evidence paths is invalid", () => {
    const r = verifyFacts(repo, [fact("Mixed.", "README.md", "src/leak.ts")]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ outside_repo: 1 });
  });

  test("drops sensitive evidence: .git, env files, keys and credentials", () => {
    const paths = [
      ".git/config",
      ".git/HEAD",
      ".env",
      ".env.production",
      "config/server.pem",
      "config/tls.KEY",
      "config/store.p12",
      "config/cert.pfx",
      "id_rsa",
      "id_ed25519.pub",
      "id_ecdsa",
      "config/credentials.json",
      ".npmrc",
      "src/settings.ts",
    ];
    const r = verifyFacts(
      repo,
      paths.map((p) => fact("Looks at a file.", "README.md", p)),
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ sensitive_path: paths.length });
  });

  test("names that only resemble sensitive ones are kept", () => {
    writeFileSync(join(repo, "env.example.md"), "x\n");
    writeFileSync(join(repo, "src", "keys.ts"), "x\n");
    const r = verifyFacts(repo, [fact("Docs.", "env.example.md", "src/keys.ts")]);
    expect(r.kept.length).toBe(1);
  });

  test("drops a fact with more than 5 evidence entries instead of clamping", () => {
    const r = verifyFacts(repo, [
      fact("Many.", "README.md", "README.md", "README.md", "README.md", "README.md", "README.md"),
      // The sixth entry is the bad one: clamping first would have hidden it.
      fact(
        "Hidden.",
        "README.md",
        "README.md",
        "README.md",
        "README.md",
        "README.md",
        "/etc/hosts",
      ),
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ too_much_evidence: 2 });
  });

  test("drops a fact with an over-long evidence path", () => {
    const r = verifyFacts(repo, [fact("Long path.", `${"a/".repeat(260)}x.ts`)]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ unsafe_path: 1 });
  });

  test("over-long content is dropped as too_long, not cut", () => {
    const r = verifyFacts(repo, [fact(`Long ${"word ".repeat(100)}`, "README.md")]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ too_long: 1 });
  });

  test("a secret past the 400th character is still caught", () => {
    const r = verifyFacts(repo, [
      fact(`${"word ".repeat(85)} key AKIAABCDEFGHIJKLMNOP`, "README.md"),
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ content_secret: 1 });
  });

  test("drops content holding an AWS key or an internal URL", () => {
    const r = verifyFacts(repo, [
      fact("The deploy key is AKIAABCDEFGHIJKLMNOP.", "README.md"),
      fact("The dev server runs at http://localhost:3000 by default.", "package.json"),
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ content_secret: 1, content_internal_url: 1 });
  });

  test("a long repository path in the content is not mistaken for a secret", () => {
    const r = verifyFacts(repo, [
      fact(
        "The registry lives in src/modules/engineering-brain/registry.ts (see `src/modules/engineering-brain/`).",
        "src/modules/engineering-brain/registry.ts",
      ),
      fact("Entry at src/index.ts:12 is tiny.", "src/index.ts"),
    ]);
    expect(r.kept.length).toBe(2);
    expect(r.dropped).toEqual({});
  });

  test("an unknown long token is still treated as a secret", () => {
    const r = verifyFacts(repo, [
      fact("Token src/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH in config.", "README.md"),
    ]);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual({ content_secret: 1 });
  });
});

describe("normaliseFactContent", () => {
  test("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normaliseFactContent("  Uses   Next.js, React!\n")).toBe("uses nextjs react");
    expect(normaliseFactContent("uses nextjs react")).toBe("uses nextjs react");
  });
});
