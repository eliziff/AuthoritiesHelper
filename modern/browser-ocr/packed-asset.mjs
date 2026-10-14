// Standalone pages carry base64; packaged hosts serve the same compressed bytes on demand.
export async function inflateAsset(value) {
  let stream;
  if (typeof value === "string") {
    const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(value) : Uint8Array.from(atob(value), c => c.charCodeAt(0));
    stream = new Blob([bytes]).stream();
  } else {
    const response = await fetch(value.url);
    if (!response.ok) throw new Error(`Application asset failed (${response.status}).`);
    stream = response.body;
  }
  return new Response(stream.pipeThrough(new DecompressionStream("gzip")));
}
