// esbuild settings for a desktop program that runs the Authorities runtime itself (native-runtime.mjs), on Node:
// Beaver's code as its server runs it, except that it reaches the hosts the page's runtime reaches, as it does
// (../html/undici.mjs: its sources, the legal source service and the publisher PDF service, nothing while only
// local data is used, and no name lookups of its own), and reads the local stores where they lie (node-sqlite.mjs,
// node-fs.mjs, native-stores.mjs). `ukCaseLaw` and `network` are the page's runtime's options (../html/runtime-bundle.mjs).
import path from "node:path";
import { sharedContractSource } from "../scripts/authorities-package/bundle.mjs";

const inside = (directory, file) => !path.relative(directory, file).startsWith("..");

/** `modern`: this AuthoritiesHelper/modern folder as the build reaches it (a checkout's link to it, with esbuild's
 *  preserveSymlinks), so its modules are each bundled once. */
export function nativeRuntimePlugin({ ukCaseLaw = false, network = true, modern = path.dirname(import.meta.dirname) } = {}) {
  const here = path.join(modern, "webview"), html = path.join(modern, "html"), own = (file) => path.join(here, file);
  return {
    name: "authorities-native-runtime",
    setup(build) {
      const options = build.initialOptions;
      options.define = { ...options.define, __UK_CASE_LAW__: String(ukCaseLaw), __NETWORK__: String(network) };
      options.loader = { ...options.loader, ".wasm": "binary" };
      sharedContractSource.setup(build);
      const node = ({ importer }) =>!/[\\/]node_modules[\\/]/u.test(importer);
      build.onResolve({ filter: /^undici$/ }, (args) => node(args) ? { path: path.join(html, "undici.mjs") } : null);
      build.onResolve({ filter: /^(?:node:)?dns(?:\/promises)?$/ }, (args) =>
        node(args) ? { path: path.join(html, "node/dns.mjs") } : null);
      build.onResolve({ filter: /[\\/]node[\\/]globals\.mjs$/ }, ({ importer }) =>
        inside(html, importer) ? { path: own("node-globals.mjs") } : null);
      build.onResolve({ filter: /^(?:node:)?sqlite$/ }, ({ importer }) =>
        importer === own("node-sqlite.mjs") ? null : { path: own("node-sqlite.mjs") });
      build.onResolve({ filter: /[\\/]html[\\/]node[\\/]sqlite\.mjs$/ }, () => ({ path: own("node-sqlite.mjs") }));
      build.onResolve({ filter: /[\\/]html[\\/]local-stores\.mjs$/ }, () => ({ path: own("native-stores.mjs") }));
      // The store lookups see the databases read in place as files.
      build.onResolve({ filter: /^(?:node:)?fs$/ }, ({ importer }) =>
        /[\\/]backend[\\/]src[\\/]lib[\\/]legalSources[\\/]/u.test(importer) ? { path: own("node-fs.mjs") } : null);
      // SQLite's WebAssembly build finds Node's modules from its own address, which a CommonJS bundle has as its own file.
      if (options.format === "cjs") build.onLoad({ filter: /[\\/]@sqlite\.org[\\/]sqlite-wasm[\\/]dist[\\/]node\.mjs$/ }, async ({ path: file }) => ({
        contents: (await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8")))
          .replaceAll("import.meta.url", '("file:///" + __filename.replaceAll("\\\\", "/"))'), loader: "js" }));
    },
  };
}
