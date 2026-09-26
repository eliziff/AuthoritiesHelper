// Bundles the Authorities runtime (Beaver's shared application code) for a browser Worker.
// Node built-ins, Express, multer and undici resolve to this directory's browser adapters;
// everything else is the same source the loopback package bundles.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { backendForbidden, localOnly } from "../scripts/authorities-package/bundle.mjs";

const here = import.meta.dirname, repo = path.resolve(here, "../../.."), backend = path.join(repo, "backend");
const require = createRequire(import.meta.url);
const own = (file) => path.join(here, file);
const SUBSTITUTES = {
  fs: own("node/fs.mjs"), "fs/promises": own("node/fs-promises.mjs"), crypto: own("node/crypto.mjs"),
  os: own("node/os.mjs"), url: own("node/url.mjs"), net: own("node/net.mjs"), dns: own("node/dns.mjs"),
  "dns/promises": own("node/dns.mjs"), "stream/promises": own("node/stream-promises.mjs"),
  child_process: own("node/unavailable.mjs"), sqlite: own("node/unavailable.mjs"),
  diagnostics_channel: own("node/diagnostics-channel.mjs"),
  path: require.resolve("path-browserify"), stream: require.resolve("readable-stream"),
  util: require.resolve("util/"), events: require.resolve("events/"), buffer: require.resolve("buffer/"),
  express: own("express.mjs"), multer: own("multer.mjs"), undici: own("undici.mjs"),
};
const backendRequired = ["src/routes/authoritiesRuntime.ts", "src/lib/authoritiesBuild.ts",
  "src/lib/structureNative.ts"];

export const browserRuntime = {
  name: "authorities-browser-runtime",
  setup(build) {
    build.onResolve({ filter: /^(?:node:)?[a-z_]+(?:\/[a-z_]+)?$/ }, ({ path: name, importer }) => {
      // readable-stream probes for a native stream; it is the stream implementation here.
      if (name === "stream" && /node_modules[\\/]readable-stream[\\/]/.test(importer)) return { path: own("node/absent.mjs") };
      const substitute = SUBSTITUTES[name.replace(/^node:/, "")];
      return substitute ? { path: substitute } : null;
    });
  },
};

export async function bundleRuntime() {
  const { build } = createRequire(path.join(backend, "package.json"))("esbuild");
  const result = await build({
    absWorkingDir: backend, entryPoints: [own("runtime-worker.mjs")], bundle: true, write: false,
    platform: "browser", format: "iife", target: "es2022", minify: true, legalComments: "none",
    metafile: true, mainFields: ["browser", "module", "main"], conditions: ["browser"],
    // Server code locates siblings from its own directory; the runtime has one virtual root.
    define: { "process.env.NODE_ENV": '"production"', __dirname: '"/app"', __filename: '"/app/runtime.js"' },
    inject: [own("node/globals.mjs")], plugins: [localOnly, browserRuntime], logLevel: "warning",
  });
  const inputs = Object.keys(result.metafile.inputs).map((file) => file.replaceAll("\\", "/"));
  for (const file of backendRequired)
    assert(inputs.includes(file), `Authorities runtime misses ${file}`);
  for (const file of inputs) for (const pattern of backendForbidden)
    assert(!pattern.test(file), `Authorities runtime contains ${file}`);
  return { code: result.outputFiles[0].text, inputs };
}
