import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { fingerprint, nearDuplicate } from "../src/library/deduplication.js";

test("pixel deduplication groups status-only changes and re-encodings but retains dialogs and color changes", async () => {
  const base = await sharp({
    create: { width: 200, height: 400, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer();
  const status = await sharp({
    create: { width: 200, height: 12, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const changedStatus = await sharp(base)
    .composite([{ input: status, top: 0, left: 0 }])
    .png()
    .toBuffer();
  const dialog = await sharp({
    create: { width: 120, height: 120, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const changedDialog = await sharp(base)
    .composite([{ input: dialog, top: 100, left: 40 }])
    .png()
    .toBuffer();
  const encoded = await sharp(base).webp({ lossless: true }).toBuffer();
  const color = await sharp({
    create: { width: 200, height: 400, channels: 3, background: "#785634" },
  })
    .png()
    .toBuffer();
  const icon = await sharp({ create: { width: 12, height: 12, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  const changedControl = await sharp(base)
    .composite([{ input: icon, top: 195, left: 95 }])
    .png()
    .toBuffer();
  const a = await fingerprint(base);
  assert.equal(nearDuplicate(a, await fingerprint(changedStatus)), true);
  assert.equal(nearDuplicate(a, await fingerprint(encoded)), true);
  assert.equal(nearDuplicate(a, await fingerprint(changedDialog)), false);
  assert.equal(nearDuplicate(a, await fingerprint(color)), false);
  assert.equal(nearDuplicate(a, await fingerprint(changedControl)), false);
  assert.equal(nearDuplicate(a, { ...a, aspect: 2 }), false);
});
