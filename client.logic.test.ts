import { test, expect } from "bun:test";
import { validName, affectedParent } from "./src/index.tsx";

test("validName mirrors the server rule", () => {
  expect(validName("ok.ts")).toBe(true);
  expect(validName("")).toBe(false);
  expect(validName("..")).toBe(false);
  expect(validName("a/b")).toBe(false);
  expect(validName("a\\b")).toBe(false);
});

test("affectedParent picks the dir whose listing changed", () => {
  expect(affectedParent("create", "/home/u/proj", "")).toBe("/home/u/proj");
  expect(affectedParent("rename", "", "/home/u/proj/old.txt")).toBe("/home/u/proj");
  expect(affectedParent("delete", "", "/home/u/proj/gone.txt")).toBe("/home/u/proj");
});
