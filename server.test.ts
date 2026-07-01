import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsLs, fsCat, fsRaw, validName, fsCreate, fsRename, fsDelete } from "./server.ts";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "files-mod-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "b.txt"), "hello");
  writeFileSync(join(dir, "a.txt"), "world");
  writeFileSync(join(dir, ".hidden"), "x");
  writeFileSync(join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02]));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function postReq(body: unknown) {
  return new Request("http://x/m", { method: "POST", body: JSON.stringify(body) });
}

function url(endpoint: "ls" | "cat" | "raw", path: string, qs = "") {
  return new URL(`http://x/${endpoint}?path=${encodeURIComponent(path)}${qs ? "&" + qs : ""}`);
}

test("ls lists dirs before files, alphabetical, hides dotfiles, files needs ?files=1", async () => {
  const res = fsLs(url("ls", dir, "files=1"));
  const body = (await res.json()) as any;
  expect(body.entries.map((e: any) => e.name)).toEqual(["sub", "a.txt", "b.txt", "bin"]);
});

test("ls excludes files without ?files=1", async () => {
  const res = fsLs(url("ls", dir));
  const body = (await res.json()) as any;
  expect(body.entries.map((e: any) => e.name)).toEqual(["sub"]);
});

test("ls includes dotfiles with ?hidden=1", async () => {
  const res = fsLs(url("ls", dir, "files=1&hidden=1"));
  const body = (await res.json()) as any;
  expect(body.entries.some((e: any) => e.name === ".hidden")).toBe(true);
});

test("cat returns content + size", async () => {
  const res = fsCat(url("cat", join(dir, "b.txt")));
  const body = (await res.json()) as any;
  expect(body.content).toBe("hello");
  expect(body.size).toBe(5);
});

test("cat rejects binary files (415)", async () => {
  const res = fsCat(url("cat", join(dir, "bin")));
  expect(res.status).toBe(415);
});

test("cat rejects non-absolute path (400)", async () => {
  const res = fsCat(new URL("http://x/cat?path=relative"));
  expect(res.status).toBe(400);
});

test("raw streams bytes with a content-type header", async () => {
  const res = fsRaw(url("raw", join(dir, "a.txt")));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBeTruthy();
  expect(await res.text()).toBe("world");
});

test("ls returns 404 for a missing path", () => {
  const res = fsLs(url("ls", join(dir, "does-not-exist")));
  expect(res.status).toBe(404);
});

test("ls returns 400 when path is a file, not a directory", () => {
  const res = fsLs(url("ls", join(dir, "a.txt")));
  expect(res.status).toBe(400);
});

test("raw returns 404 for a missing path", () => {
  const res = fsRaw(url("raw", join(dir, "does-not-exist")));
  expect(res.status).toBe(404);
});

test("raw returns 400 when path is a directory", () => {
  const res = fsRaw(url("raw", join(dir, "sub")));
  expect(res.status).toBe(400);
});

test("validName accepts a normal filename", () => {
  expect(validName("hello.txt")).toBe(true);
  expect(validName("my-folder")).toBe(true);
});

test("validName rejects traversal + separators + empty", () => {
  expect(validName("")).toBe(false);
  expect(validName(".")).toBe(false);
  expect(validName("..")).toBe(false);
  expect(validName("a/b")).toBe(false);
  expect(validName("a\\b")).toBe(false);
  expect(validName("../evil")).toBe(false);
});

test("fsCreate makes an empty file", async () => {
  const res = await fsCreate(postReq({ path: dir, name: "new.txt", kind: "file" }));
  expect(res.status).toBe(200);
  expect(existsSync(join(dir, "new.txt"))).toBe(true);
});

test("fsCreate makes a directory", async () => {
  const res = await fsCreate(postReq({ path: dir, name: "newdir", kind: "dir" }));
  expect(res.status).toBe(200);
  expect(existsSync(join(dir, "newdir"))).toBe(true);
});

test("fsCreate rejects a traversal name (400)", async () => {
  const res = await fsCreate(postReq({ path: dir, name: "../evil", kind: "file" }));
  expect(res.status).toBe(400);
  expect(existsSync(join(dir, "..", "evil"))).toBe(false);
});

test("fsCreate returns 409 when target exists", async () => {
  const res = await fsCreate(postReq({ path: dir, name: "a.txt", kind: "file" }));
  expect(res.status).toBe(409);
});

test("fsCreate returns 404 when parent dir is missing", async () => {
  const res = await fsCreate(postReq({ path: join(dir, "nope"), name: "x", kind: "file" }));
  expect(res.status).toBe(404);
});

test("fsCreate returns 400 when parent is a file", async () => {
  const res = await fsCreate(postReq({ path: join(dir, "a.txt"), name: "x", kind: "file" }));
  expect(res.status).toBe(400);
});

test("fsRename renames an entry in place", async () => {
  writeFileSync(join(dir, "old.txt"), "x");
  const res = await fsRename(postReq({ path: join(dir, "old.txt"), name: "renamed.txt" }));
  expect(res.status).toBe(200);
  expect(existsSync(join(dir, "old.txt"))).toBe(false);
  expect(existsSync(join(dir, "renamed.txt"))).toBe(true);
});

test("fsRename rejects an invalid name (400)", async () => {
  const res = await fsRename(postReq({ path: join(dir, "a.txt"), name: "../evil" }));
  expect(res.status).toBe(400);
});

test("fsRename returns 404 when source is missing", async () => {
  const res = await fsRename(postReq({ path: join(dir, "ghost"), name: "x.txt" }));
  expect(res.status).toBe(404);
});

test("fsRename returns 409 when target exists", async () => {
  const res = await fsRename(postReq({ path: join(dir, "a.txt"), name: "b.txt" }));
  expect(res.status).toBe(409);
});

test("fsDelete removes a file (trash or fallback)", async () => {
  writeFileSync(join(dir, "doomed.txt"), "x");
  const res = await fsDelete(postReq({ path: join(dir, "doomed.txt") }));
  expect(res.status).toBe(200);
  expect(existsSync(join(dir, "doomed.txt"))).toBe(false);
});

test("fsDelete removes a directory recursively", async () => {
  mkdirSync(join(dir, "doomeddir"));
  writeFileSync(join(dir, "doomeddir", "inner.txt"), "x");
  const res = await fsDelete(postReq({ path: join(dir, "doomeddir") }));
  expect(res.status).toBe(200);
  expect(existsSync(join(dir, "doomeddir"))).toBe(false);
});

test("fsDelete returns 404 for a missing path", async () => {
  const res = await fsDelete(postReq({ path: join(dir, "never") }));
  expect(res.status).toBe(404);
});

test("fsDelete refuses to delete a filesystem root (400)", async () => {
  const res = await fsDelete(postReq({ path: "/" }));
  expect(res.status).toBe(400);
});
