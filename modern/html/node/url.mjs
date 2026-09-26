export const pathToFileURL = (path) => new URL(`file://${encodeURI(path)}`);
export const fileURLToPath = (url) => decodeURI(new URL(url).pathname);
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export default { pathToFileURL, fileURLToPath, URL, URLSearchParams };
