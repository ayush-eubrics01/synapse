import { describe, expect, test } from "bun:test";
import { INCLUDE_DEPTH_MAX, includeTargets } from "../../src/integrations/repository/git-includes";

const FILE = "/home/u/r/.git/config";
const HOME = "/home/u";
const t = (text: string) => includeTargets(text, FILE, HOME);

describe("includeTargets", () => {
  test("depth cap constant", () => expect(INCLUDE_DEPTH_MAX).toBe(10));
  test("relative to the including file's directory", () => {
    expect(t("[include]\n\tpath = extra.cfg")).toEqual(["/home/u/r/.git/extra.cfg"]);
  });
  test("includeIf with ~/ expands to home", () => {
    expect(t('[includeIf "gitdir:/home/u/"]\n\tpath = ~/inc.cfg')).toEqual(["/home/u/inc.cfg"]);
  });
  test("case-insensitive names, quoted absolute value, trailing comment", () => {
    expect(t('[Include]\n\tPath = "/abs/x.cfg" ; note')).toEqual(["/abs/x.cfg"]);
  });
  test("hash comment after an unquoted value", () => {
    expect(t("[include]\npath = y # c")).toEqual(["/home/u/r/.git/y"]);
  });
  test("path in another section is ignored", () => {
    expect(t("[core]\n\tpath = no")).toEqual([]);
  });
  test("same-line section and key", () => {
    expect(t("[include] path = same-line.cfg")).toEqual(["/home/u/r/.git/same-line.cfg"]);
  });
  test("empty value gives nothing", () => {
    expect(t("[include]\n\tpath =\n\tpath")).toEqual([]);
  });
  test("escaped quote unescapes", () => {
    expect(t('[include]\n\tpath = "a\\"b"')).toEqual(['/home/u/r/.git/a"b']);
  });
  test("duplicates are kept, in file order", () => {
    expect(t('[include]\npath = a\npath = b\n[includeIf "x"]\npath = a')).toEqual([
      "/home/u/r/.git/a",
      "/home/u/r/.git/b",
      "/home/u/r/.git/a",
    ]);
  });
  test("backslash-newline continues a value", () => {
    expect(t("[include]\n\tpath = foo\\\nbar.cfg")).toEqual(["/home/u/r/.git/foobar.cfg"]);
  });
  test("] inside a quoted subsection, path on the same line", () => {
    expect(t('[includeIf "gitdir:**/[r]/"] path = x.cfg')).toEqual(["/home/u/r/.git/x.cfg"]);
  });
  test("~name is unresolved unless it is the current user", () => {
    expect(t("[include]\n\tpath = ~nobody-such/x")).toEqual(["unresolved:~nobody-such/x"]);
    const me = require("node:os").userInfo().username;
    expect(t(`[include]\n\tpath = ~${me}/x.cfg`)).toEqual(["/home/u/x.cfg"]);
  });
  test("backslash-newline does not continue a comment", () => {
    expect(
      t("[include]\n# note \\\npath = hidden.cfg\npath = a.cfg ; x \\\npath = hidden2.cfg\n"),
    ).toEqual(["/home/u/r/.git/hidden.cfg", "/home/u/r/.git/a.cfg", "/home/u/r/.git/hidden2.cfg"]);
  });
  test("relative paths are not normalised lexically", () => {
    expect(t("[include]\npath = l1/../x.cfg")).toEqual(["/home/u/r/.git/l1/../x.cfg"]);
  });
  describe("whitespace before a continuation is kept (git oracle values)", () => {
    test("space, then a comment on the next line", () => {
      expect(t("[include]\npath = a.cfg \\\n; comment\n")).toEqual(["/home/u/r/.git/a.cfg "]);
    });
    test("space, backslash at end of file", () => {
      expect(t("[include]\npath = a.cfg \\")).toEqual(["/home/u/r/.git/a.cfg "]);
    });
    test("tab, then a hash comment on the next line", () => {
      expect(t("[include]\npath = a.cfg\t\\\n# c\n")).toEqual(["/home/u/r/.git/a.cfg\t"]);
    });
    test("quoted value with a semicolon, space, comment on the next line", () => {
      expect(t('[include]\npath = "x;" \\\n; c\n')).toEqual(["/home/u/r/.git/x; "]);
    });
    test("without a continuation trailing whitespace is still trimmed", () => {
      expect(t("[include]\npath = a.cfg \t\n")).toEqual(["/home/u/r/.git/a.cfg"]);
    });
  });
});
