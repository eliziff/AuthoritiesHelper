// The ABI is shared with Legal Pinpointer. Copy the output before the next WASM call.
export async function createEngine(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {}), e = instance.exports;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  return input => {
    const data = encoder.encode(JSON.stringify(input));
    if (data.length > 24_000_000) throw new Error('This document exceeds the browser structure limit.');
    const pointer = e.legal_structure_alloc(data.length);
    try {
      new Uint8Array(e.memory.buffer, pointer, data.length).set(data);
      e.legal_structure_analyze(pointer, data.length);
      const value = JSON.parse(decoder.decode(new Uint8Array(e.memory.buffer, e.legal_structure_output_pointer(), e.legal_structure_output_length())));
      if (!value.ok) throw new Error(value.error || 'Structure analysis failed.');
      if (value.offset_unit !== 'utf16') throw new Error('Unsupported structure offset convention.');
      return value;
    } finally { e.legal_structure_dealloc(pointer, data.length); }
  };
}
