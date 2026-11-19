import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSimilarity } from "../src/library/ranking.js";

test("image ranking distinguishes reversed layouts with the same tile contents", () => {
  const query = [
    { region: "full", vector: [1, 0] },
    { region: "top", vector: [1, 0] },
    { region: "bottom", vector: [0, 1] },
  ];
  const reversed = [
    query[0],
    { region: "top", vector: [0, 1] },
    { region: "bottom", vector: [1, 0] },
  ];
  assert.equal(imageSimilarity(query, query, "layout"), 1);
  assert.equal(imageSimilarity(query, reversed, "layout"), 0.6);
  assert.equal(imageSimilarity(query, reversed), 1);
});

test("image ranking falls back to whole view for missing orientation tiles", () => {
  assert.equal(
    imageSimilarity(
      [
        { region: "full", vector: [1, 0] },
        { region: "top", vector: [1, 0] },
      ],
      [
        { region: "full", vector: [1, 0] },
        { region: "left", vector: [0, 1] },
      ],
      "layout",
    ),
    1,
  );
  assert.equal(
    imageSimilarity(
      [{ region: "full", vector: [1, 0] }],
      [
        { region: "full", vector: [0, 1] },
        { region: "top", vector: [1, 0] },
      ],
      "layout",
    ),
    0,
  );
});
