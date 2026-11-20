import { test } from "node:test";
import assert from "node:assert/strict";
import { appKey, selectAppDiverse } from "../src/library/diversity.js";

test("diverse sampling reaches apps beyond a dominant top-100 cluster, preserving score order", () => {
  const ranked = [
    ...Array.from({ length: 120 }, (_, i) => ({ id: `a${i}`, product: "App A" })),
    { id: "b", product: "App B" },
    { id: "c", product: "App C" },
  ];
  const pool = selectAppDiverse(ranked, (row) => row.product, 100, 100);
  assert.equal(pool.length, 100);
  assert.equal(pool[0].id, "a0");
  assert.deepEqual(
    pool.slice(-2).map((row) => row.id),
    ["b", "c"],
  );
  assert.deepEqual(
    selectAppDiverse(pool, (row) => row.product, 4, 2).map((row) => row.id),
    ["a0", "a1", "b", "c"],
  );
});

test("app caps are strict, labels normalize and an extra slot never displaces a different app", () => {
  const ranked = [" App A ", "APP A", "Ａpp   A", "App B", "App B", "App C"].map((product, id) => ({
    product,
    id,
  }));
  assert.equal(appKey(" Ａpp   A "), "app a");
  assert.deepEqual(
    selectAppDiverse(ranked, (row) => row.product, 20, 1).map((row) => row.id),
    [0, 3, 5],
  );
  assert.deepEqual(
    selectAppDiverse(ranked, (row) => row.product, 3, 2).map((row) => row.id),
    [0, 3, 5],
  );
  assert.equal(selectAppDiverse([], (row) => String(row), 4, 1).length, 0);
});
