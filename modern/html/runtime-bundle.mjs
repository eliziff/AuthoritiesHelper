// Bundles the Authorities runtime (Beaver's shared application code) for a browser Worker.
// Node built-ins and undici resolve to this directory's browser adapters;
// everything else is the same source the loopback package bundles.
import { createRequire } from "node:module";
import path from "node:path";
import { localOnly, sharedContractSource } from "../scripts/authorities-package/bundle.mjs";

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
  undici: own("undici.mjs"),
};

const browserRuntime = (substitutes) => ({
  name: "authorities-browser-runtime",
  setup(build) {
    build.onResolve({ filter: /[\\/]pdfProfile$/ }, () => ({ path: own("pdf-profile.mjs") }));
    build.onResolve({ filter: /^(?:node:)?[a-z_]+(?:\/[a-z_]+)?$/ }, ({ path: name, importer }) => {
      // readable-stream probes for a native stream; it is the stream implementation here.
      if (name === "stream" && /node_modules[\\/]readable-stream[\\/]/.test(importer)) return { path: own("node/absent.mjs") };
      const substitute = substitutes[name.replace(/^node:/, "")];
      return substitute ? { path: substitute } : null;
    });
  },
});

// `plugins` run first: a product built on this runtime (ALR) supplies its own operations through them.
// `localStores`: the runtime reads local legal data files the page gives it (node/sqlite.mjs, with SQLite's
// WebAssembly build, and the "mount-store" operation in runtime-worker.mjs); without it, neither is part of it.
export async function bundleRuntime({ plugins = [], localStores = false } = {}) {
  const { build } = createRequire(path.join(backend, "package.json"))("esbuild");
  const options = {
    absWorkingDir: backend, bundle: true, write: false,
    platform: "browser", format: "iife", target: "es2022", minify: true, legalComments: "none",
    mainFields: ["browser", "module", "main"], conditions: ["worker", "browser"],
    inject: [own("node/globals.mjs")], logLevel: "warning",
    plugins: [...plugins, sharedContractSource, localOnly,
      browserRuntime(localStores ? { ...SUBSTITUTES, sqlite: own("node/sqlite.mjs") } : SUBSTITUTES)],
    ...localStores ? { loader: { ".wasm": "binary" } } : {},
  };
  // The Worker that parses PDFs beside the runtime, which starts it from this source.
  const parser = await build({ ...options, entryPoints: [own("parse-worker.mjs")], metafile: true,
    define: { "process.env.NODE_ENV": '"production"' } });
  const result = await build({ ...options, entryPoints: [own("runtime-worker.mjs")], metafile: true,
    // Server code locates siblings from its own directory; the runtime has one virtual root.
    define: { "process.env.NODE_ENV": '"production"', __dirname: '"/app"', __filename: '"/app/runtime.js"',
      __PARSE_WORKER__: JSON.stringify(parser.outputFiles[0].text), __LOCAL_STORES__: String(localStores) },
  });
  // Every file either bundle read, relative to the backend.
  const inputs = [...new Set([parser, result].flatMap(({ metafile }) => Object.keys(metafile.inputs)))]
    .map((file) => file.replaceAll("\\", "/"));
  return { code: result.outputFiles[0].text, inputs };
}
