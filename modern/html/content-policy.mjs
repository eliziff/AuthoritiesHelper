// The Content-Security-Policy a built page carries in its <head>, the only place a page served from a file or
// GitHub Pages can set one. Only the page's own inline scripts run (by their hashes), with WebAssembly, and the
// modules they load themselves ('strict-dynamic': the recognizer's Workers import theirs from data: addresses);
// no script written into the page as markup runs, nor any inline handler. Workers start from the page's blob:
// and data: addresses; nothing is framed, embedded or submitted; and the page and every Worker it starts connect
// to `connectSources` alone, beyond its own blob: and data: addresses.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function withContentSecurityPolicy(html, connectSources) {
  const hashes = [];
  for (let at = 0; ;) {
    const open = html.indexOf("<script", at);
    if (open < 0) break;
    const body = html.indexOf(">", open) + 1, close = html.indexOf("</script>", body);
    assert(!/\bsrc=/u.test(html.slice(open, body)), "A built page carries its scripts inline");
    // The browser hashes the script as parsed: its line endings made \n.
    const code = html.slice(body, close).replace(/\r\n?/gu, "\n");
    hashes.push(`'sha256-${createHash("sha256").update(code, "utf8").digest("base64")}'`);
    at = close + "</script>".length;
  }
  assert(hashes.length > 0, "A built page has a script");
  for (const source of connectSources) assert(/^https?:\/\/[\w.*-]+(?::(?:\d+|\*))?$/u.test(source), `Not a host: ${source}`);
  const policy = [
    "default-src 'none'",
    `script-src 'strict-dynamic' ${hashes.join(" ")} 'wasm-unsafe-eval'`,
    "worker-src blob: data:",
    "style-src 'unsafe-inline'",
    "img-src blob: data:",
    "font-src blob: data:",
    `connect-src ${[...connectSources, "blob:", "data:"].join(" ")}`,
    "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
  ].join("; ");
  const charset = /<meta charset="utf-8"\s*\/?>/iu;
  assert(charset.test(html), "A built page declares its charset first");
  return html.replace(charset, (tag) => `${tag}\n<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}
