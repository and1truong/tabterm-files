import { test, expect } from "bun:test";
import { validName, affectedParent, isCsv, parseCsv } from "./src/index.tsx";

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

test("recognizes CSV names and parses quoted RFC 4180-style fields", () => {
  expect(isCsv("report.csv")).toBe(true);
  expect(isCsv("REPORT.CSV")).toBe(true);
  expect(isCsv("report.tsv")).toBe(false);
  expect(parseCsv('\ufeffname,note\r\nAda,"hello, world"\r\nGrace,"said ""hi""\nand left"\r\n')).toEqual([
    ["name", "note"],
    ["Ada", "hello, world"],
    ["Grace", 'said "hi"\nand left'],
  ]);
});

test("keeps trailing empty CSV cells without adding a row after a final newline", () => {
  expect(parseCsv("first,second,\nvalue,,\n")).toEqual([
    ["first", "second", ""],
    ["value", "", ""],
  ]);
  expect(parseCsv("")).toEqual([]);
});
