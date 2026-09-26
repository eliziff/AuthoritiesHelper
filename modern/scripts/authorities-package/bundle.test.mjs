import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertAuthoritiesBundle, assertStandaloneFrontendModules } from "./bundle.mjs";

test("packaging consumes the built native engine without compiling Rust", () => {
  const script = readFileSync(new URL("../../package-authorities.ps1", import.meta.url), "utf8");
  assert.doesNotMatch(script, /\bcargo(?:\.exe)?\b/iu);
  assert.match(script, /native\\legal-structure-node\\target\\release\\legal_structure_node\.dll/u);
});

const core = Object.fromEntries([
  "src/authoritiesStandalone.ts",
  "src/authoritiesStandaloneServer.ts",
  "src/routes/authoritiesRuntime.ts",
  "src/lib/authoritiesBuild.ts",
].map((path) => [path, {}]));

test("accepts the shared standalone Authorities core", () => {
  assert.doesNotThrow(() => assertAuthoritiesBundle({ inputs: core }));
});

for (const input of ["src/lib/jobQueue.ts", "src/middleware/auth.ts",
  "src/lib/spreadsheet.ts", "node_modules/xlsx/xlsx.mjs",
  "src/lib/chat/chatApplication.ts", "node_modules/@supabase/supabase-js/dist/index.js",
  "node_modules/openai/index.js", "node_modules/postal-mime/src/postal-mime.js"]) {
  test(`rejects ${input}`, () => assert.throws(() =>
    assertAuthoritiesBundle({ inputs: { ...core, [input]: {} } }), /bundle contains/u));
}

const frontend = ["/repo/frontend/src/authoritiesMain.tsx",
  "/repo/frontend/src/app/authorities/AuthoritiesWorkspace.tsx",
  "/repo/frontend/src/app/authorities/standaloneHost.ts",
  "/repo/frontend/src/app/lib/standaloneWorkProducts.ts"];
test("retains real shared source validation", () => assert.doesNotThrow(() =>
  assertAuthoritiesBundle({ inputs: { ...core, "node_modules/zod/index.js": {} } })));

test("accepts the shared local Authorities workspace", () => assert.doesNotThrow(() =>
  assertStandaloneFrontendModules([...frontend,
    "/repo/frontend/src/app/lib/api/client.ts",
    "/repo/frontend/src/app/lib/api/mutationEvents.ts"])));
for (const input of ["/repo/frontend/src/app/authorities/beaverHost.ts",
  "/repo/frontend/src/app/components/assistant/WorkProductAssistant.tsx",
  "/repo/frontend/src/app/lib/api/documents.ts",
  "/repo/frontend/src/app/lib/api/auth.ts",
  "/repo/frontend/node_modules/@supabase/supabase-js/dist/index.js"]) {
  test(`rejects frontend ${input}`, () => assert.throws(() =>
    assertStandaloneFrontendModules([...frontend, input]), /frontend contains/u));
}

test("launcher reuses only its build and opens a persistent app profile",
  { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "authorities-launcher-"));
    const buildId = "a".repeat(64);
    try {
      copyFileSync(new URL("./Authorities.ps1", import.meta.url), path.join(root, "Authorities.ps1"));
      writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ buildId }));
      const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass",
        "-Command", String.raw`
          . (Join-Path $env:AUTHORITIES_TEST_ROOT 'Authorities.ps1')
          function Invoke-RestMethod { [pscustomobject]@{ status='ok'; app='authorities'; buildId=('a' * 64) } }
          if (-not (Test-Healthy)) { throw 'Matching runtime was rejected' }
          function Invoke-RestMethod { [pscustomobject]@{ status='ok'; app='authorities'; buildId=('b' * 64) } }
          if (Test-Healthy) { throw 'Mismatched runtime was reused' }
          function Resolve-Chromium { 'browser.exe' }
          function Start-Process { param($FilePath, $ArgumentList); $script:opened = @($ArgumentList) }
          Open-Authorities
          if (-not (Test-Path -LiteralPath $BrowserProfile -PathType Container) -or
              -not ($script:opened -contains "--app=$Url") -or
              -not ($script:opened | Where-Object { $_ -like '--user-data-dir=*' })) {
            throw 'Persistent app profile was not opened'
          }
        `], { encoding: "utf8", env: { ...process.env, AUTHORITIES_TEST_ROOT: root,
          LOCALAPPDATA: path.join(root, "state") } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
