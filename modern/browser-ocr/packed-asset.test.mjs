import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { inflateAsset } from "./packed-asset.mjs";

test("standalone and served compressed assets produce identical bytes", async () => {
  const source = "Clockwork leaves turn toward the sun.\n".repeat(100);
  const packed = gzipSync(source);
  assert.equal(await (await inflateAsset(packed.toString("base64"))).text(), source);
  assert.equal(await (await inflateAsset({ url: `data:application/octet-stream;base64,${packed.toString("base64")}` })).text(), source);
});

test("missing served assets reject before decompression", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("Missing", { status: 404 });
  try { await assert.rejects(inflateAsset({ url: "https://assets.invalid/missing.gz" }), /404/); }
  finally { globalThis.fetch = original; }
});
