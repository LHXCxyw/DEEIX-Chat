import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines } from "./line-diff.ts";

for (const [name, before, after, added, removed] of [
  ["新建非空文件", "", "hello\nworld\n", 2, 0],
  ["覆盖只统计修改行", "a\nb\n", "a\nc\n", 1, 1],
  ["空文件不产生虚假行", "", "", 0, 0],
  ["删除全部内容", "a\n", "", 0, 1],
  ["末尾换行变化", "a", "a\n", 1, 1],
  ["相同内容", "a\n", "a\n", 0, 0],
] as const) {
  test(name, () => {
    const lines = diffLines(before, after);
    assert.equal(lines.filter((line) => line.kind === "added").length, added);
    assert.equal(lines.filter((line) => line.kind === "removed").length, removed);
  });
}
