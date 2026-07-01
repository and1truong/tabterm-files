import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("files server bundle exists + exports activate", async () => {
  expect(existsSync("dist/modules/files/server.js")).toBe(true);
  const m = await import("./dist/modules/files/server.js");
  expect(typeof (m.default ?? m.activate)).toBe("function");
});

test("files client bundle exists + exports activate", async () => {
  expect(existsSync("dist/modules/files/client.js")).toBe(true);
  const m = await import("./dist/modules/files/client.js");
  expect(typeof (m.default ?? m.activate)).toBe("function");
});
