let ready;

// Tesseract's line finder, from Legal Browser OCR's runtime (tesseract-layout-worker.js), changed
// twice: it takes grey pixels, and what Tesseract and Leptonica write ("Detected 105 diacritics", and
// as each worker starts, that Tesseract's debug-image font cannot be built) is not written to the
// console. The page kept about 12 MB for every such line after its worker ended. The last lines
// written go with an error instead.
let written = [];
const write = (text) => { written = [...written.slice(-4), text]; };
async function start(corePath, wasmPath) {
  const createCore = (await import(corePath)).default;
  const core = await createCore({ locateFile: () => wasmPath, print: write, printErr: write });
  return { core, api: core._kl_create() };
}

self.onmessage = async ({ data: { id, pixels, width, height, corePath, wasmPath, sourceResolution = 200, psm = 3, binaryThreshold = 0 } }) => {
  try {
    ready ||= start(corePath, wasmPath);
    const { api, core } = await ready;
    core._kl_set_psm?.(api,psm);
    // Grey pixels, a byte each, as the page's renderer draws them, or RGBA: Tesseract reads their luminance
    // either way and finds the same lines, from a quarter of the memory and a little sooner.
    const input=new Uint8Array(pixels),useGray=input.length===width*height;
    const image = core._malloc(input.byteLength);
    core.HEAPU8.set(input, image);
    let capacity = 128;
    let boxes = core._malloc(capacity * 16);
    const useBinary=Boolean(binaryThreshold&&core._kl_lines_binary),find=useGray?core._kl_lines_gray:useBinary?core._kl_lines_binary:(core._kl_lines_dpi||core._kl_lines);
    const call=()=>useGray?find(api,image,width,height,boxes,capacity):useBinary?find(api,image,width,height,boxes,capacity,sourceResolution,binaryThreshold):core._kl_lines_dpi?find(api,image,width,height,boxes,capacity,sourceResolution):find(api,image,width,height,boxes,capacity);
    let count = call();
    if (count < 0) {
      capacity = -count;
      core._free(boxes);
      boxes = core._malloc(capacity * 16);
      count = call();
    }
    const lines = Array.from({ length: count }, (_, index) => {
      const offset = boxes / 4 + index * 4;
      const [x0, y0, x1, y1] = core.HEAP32.subarray(offset, offset + 4);
      return { x0, y0, x1, y1 };
    });
    core._free(boxes);
    core._free(image);
    self.postMessage({ id, lines });
  } catch (error) {
    self.postMessage({ id, error: [error.message, ...written].join(' / ') });
  }
};
