// Rebuilds the browser recognition WebAssembly that both Authorities packages embed:
// ONNX Runtime Web reduced to the recognition model's operators (ort.mjs/ort.wasm) and the
// Tesseract layout core (layout-core.mjs/layout-core.wasm, from the pinned OCR source's
// layout-core.cpp). Every compile maps the build root to /build, so source-location strings
// carry no machine path.
//
//   node browser-ocr/wasm/build.mjs      (from AuthoritiesHelper/modern, after browser-ocr/package.mjs)
//
// Needs git, tar and Python 3.10+ on PATH and about 10 GB of scratch space under
// AUTHORITIES_OCR_WASM_ROOT (default: the system temp directory). Emscripten, CMake and Ninja
// are installed into that root at the versions pinned below. Commit the four outputs.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORT = { tag: 'v1.22.0', commit: '731cb2fe24574eede4e44f325b1e4c05fe440a28' };
// ORT pins this Eigen commit by a GitLab archive whose bytes GitLab has since regenerated; the commit is the pin.
const EIGEN = { repo: 'https://github.com/eigen-mirror/eigen.git', commit: '1d8b82b0740839c0de7f1242a3585e3390ff5f33' };
const EMSDK = '4.0.4'; // ONNX Runtime 1.22.0's pinned Emscripten
// tesseract.js-core v7.0.0: its Tesseract (2a9c1c49) and Leptonica (4af068b5) submodules.
const TESSERACT_JS = { repo: 'https://github.com/naptha/tesseract.js-core.git', commit: 'acffef2b66eb44a31df297e11d905f4b39001068' };
const PYTHON_TOOLS = ['cmake==3.31.6', 'ninja==1.11.1.4', 'onnx==1.17.0', 'flatbuffers==25.2.10'];

const here = import.meta.dirname, vendor = path.resolve(here, '../../vendor');
const root = path.resolve(process.env.AUTHORITIES_OCR_WASM_ROOT ?? path.join(os.tmpdir(), 'authorities-ocr-wasm'));
const windows = process.platform === 'win32';
const slash = (value) => value.replaceAll('\\', '/');

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options, shell: windows && /\.(bat|cmd)$/i.test(command) });
}

function checkout(repo, commit, directory) {
  if (!fs.existsSync(path.join(directory, '.git'))) {
    fs.mkdirSync(directory, { recursive: true });
    run('git', ['init', '-q', directory]);
    run('git', ['-C', directory, 'remote', 'add', 'origin', repo]);
  }
  run('git', ['-C', directory, 'fetch', '-q', '--depth=1', 'origin', commit]);
  run('git', ['-C', directory, '-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', commit]);
}

// Python tools in their own environment, then Emscripten through ONNX Runtime's emsdk submodule.
const venv = path.join(root, 'venv'), bin = path.join(venv, windows ? 'Scripts' : 'bin');
const python = path.join(bin, windows ? 'python.exe' : 'python');
if (!fs.existsSync(python)) run(windows ? 'python' : 'python3', ['-m', 'venv', venv]);
run(python, ['-m', 'pip', 'install', '-q', ...PYTHON_TOOLS]);

const ort = path.join(root, 'onnxruntime');
checkout('https://github.com/microsoft/onnxruntime.git', ORT.commit, ort);
run('git', ['-C', ort, 'submodule', 'update', '--init', '--depth=1', 'cmake/external/emsdk']);
const emsdk = path.join(ort, 'cmake/external/emsdk'), emsdkTool = path.join(emsdk, windows ? 'emsdk.bat' : 'emsdk');
const emscripten = path.join(emsdk, 'upstream/emscripten');
// emsdk.bat exits 0 even when a download breaks off, so its result is checked, with one retry.
for (let attempt = 0; !fs.existsSync(path.join(emscripten, 'emcc.py')); attempt++) {
  assert(attempt < 2, `Emscripten ${EMSDK} did not install.`);
  run(emsdkTool, ['install', EMSDK], { cwd: emsdk });
}
run(emsdkTool, ['activate', EMSDK], { cwd: emsdk });

// EMCC_CFLAGS reaches every emcc call, including those CMake and ORT's build script make.
const prefixMap = [...new Set([slash(root), root])].map((from) => `-ffile-prefix-map=${from}=/build`).join(' ');
const env = { ...process.env, EMSDK: emsdk, EMCC_CFLAGS: prefixMap, PATH: [bin, emscripten, process.env.PATH].join(path.delimiter) };

// ONNX Runtime: minimal build with only the operators recognition/model.ort uses.
const model = path.join(vendor, 'runtime/assets/model.ort');
assert(fs.existsSync(model), 'Run browser-ocr/package.mjs first; the operator set comes from its model.ort.');
const modelDir = path.join(root, 'model'), ops = path.join(root, 'required_operators.config');
fs.mkdirSync(modelDir, { recursive: true });
fs.copyFileSync(model, path.join(modelDir, 'model.ort'));
run(python, [path.join(ort, 'tools/python/create_reduced_build_config.py'), '--format', 'ORT', modelDir, ops], { env });
const eigen = path.join(root, 'eigen');
checkout(EIGEN.repo, EIGEN.commit, eigen);
const ortBuild = path.join(root, 'ort-build');
run(python, [path.join(ort, 'tools/ci_build/build.py'), '--build_dir', ortBuild, '--config', 'MinSizeRel',
  '--build_wasm', '--enable_wasm_simd', '--enable_wasm_threads', '--emsdk_version', EMSDK, '--skip_submodule_sync',
  '--minimal_build', '--include_ops_by_config', ops, '--disable_exceptions', '--disable_rtti',
  '--skip_tests', '--parallel', '--cmake_generator', 'Ninja', '--target', 'onnxruntime_webassembly',
  '--cmake_extra_defines', `FETCHCONTENT_SOURCE_DIR_EIGEN3=${slash(eigen)}`], { cwd: ort, env });
const ortOut = path.join(ortBuild, 'MinSizeRel');

// Tesseract layout core: Leptonica without image codecs (pixels arrive decoded), Tesseract
// without the legacy engine as tesseract.js-core configures it for WebAssembly, linked with
// the pinned OCR source's layout-core.cpp.
const emcmake = path.join(emscripten, windows ? 'emcmake.bat' : 'emcmake');
const cmake = (source, build, args, target) => {
  run(emcmake, ['cmake', '-S', source, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_C_FLAGS=-O3', '-DCMAKE_CXX_FLAGS=-O3', '-DBUILD_SHARED_LIBS=OFF', ...args], { env });
  run(path.join(bin, 'cmake'), ['--build', build, '--parallel', ...(target ? ['--target', target] : [])], { env });
};
const tesseractJs = path.join(root, 'tesseract.js-core');
checkout(TESSERACT_JS.repo, TESSERACT_JS.commit, tesseractJs);
run('git', ['-C', tesseractJs, 'submodule', 'update', '--init', '--depth=1', 'third_party/leptonica', 'third_party/tesseract']);
const leptonica = path.join(tesseractJs, 'third_party/leptonica'), tesseract = path.join(tesseractJs, 'third_party/tesseract');
// Tesseract probes emcc's version through the Unix launcher, which Windows cannot run; a failed
// probe adds a flag current Emscripten rejects. Probe the configured compiler instead.
const tesseractCmake = path.join(tesseract, 'CMakeLists.txt');
fs.writeFileSync(tesseractCmake, fs.readFileSync(tesseractCmake, 'utf8')
  .replace('COMMAND ${EMSCRIPTEN_ROOT_PATH}/emcc --version', 'COMMAND ${CMAKE_C_COMPILER} --version'));
// Leptonica's package config records its install prefix, so it is configured with it.
const dependencies = path.join(root, 'dep');
cmake(leptonica, path.join(leptonica, 'build'), [`-DCMAKE_INSTALL_PREFIX=${slash(dependencies)}`, '-DSW_BUILD=OFF', '-DBUILD_PROG=OFF', '-DLIBWEBP_SUPPORT=OFF',
  '-DOPENJPEG_SUPPORT=OFF', ...['GIF', 'JPEG', 'PNG', 'TIFF', 'ZLIB', 'PkgConfig'].map((name) => `-DCMAKE_DISABLE_FIND_PACKAGE_${name}=ON`)]);
run(path.join(bin, 'cmake'), ['--install', path.join(leptonica, 'build')], { env });
cmake(tesseract, path.join(tesseract, 'build'), ['-DWASM_BUILD=ON', '-DHAVE_SSE4_1=ON', '-DSW_BUILD=OFF',
  `-DLeptonica_DIR=${slash(path.join(dependencies, 'lib/cmake/leptonica'))}`, '-DOPENMP_BUILD=OFF', '-DBUILD_TRAINING_TOOLS=OFF',
  '-DGRAPHICS_DISABLED=ON', '-DDISABLED_LEGACY_ENGINE=ON', '-DDISABLE_TIFF=ON', '-DDISABLE_ARCHIVE=ON', '-DDISABLE_CURL=ON',
  '-DINSTALL_CONFIGS=OFF'], 'libtesseract');
const layoutSource = path.join(root, 'layout-core.cpp'), layoutOut = path.join(root, 'layout');
fs.copyFileSync(path.join(vendor, 'ocr-source/layout-core.cpp'), layoutSource);
fs.mkdirSync(layoutOut, { recursive: true });
const library = (directory, name) => fs.readdirSync(directory, { recursive: true }).map(String)
  .find((file) => path.basename(file).startsWith(name) && file.endsWith('.a'));
const exported = [...fs.readFileSync(layoutSource, 'utf8').matchAll(/^\S.*\b(kl_\w+)\(/gmu)].map((match) => `_${match[1]}`);
run(path.join(emscripten, windows ? 'em++.bat' : 'em++'), [layoutSource, '-O3', '-std=c++17',
  `-I${path.join(tesseract, 'include')}`, `-I${path.join(tesseract, 'build/include')}`,
  path.join(tesseract, 'build', library(path.join(tesseract, 'build'), 'libtesseract')),
  path.join(leptonica, 'build', library(path.join(leptonica, 'build'), 'libleptonica')),
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=worker', '-sALLOW_MEMORY_GROWTH=1', '-sFILESYSTEM=0',
  `-sEXPORTED_FUNCTIONS=${[...exported, '_malloc', '_free'].join(',')}`, '-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32',
  '-o', path.join(layoutOut, 'layout-core.mjs')], { env });

// The page names the WASM itself (locateFile), so the glue keeps only a neutral default name.
for (const [from, to] of [[path.join(ortOut, 'ort-wasm-simd-threaded.mjs'), 'ort.mjs'], [path.join(ortOut, 'ort-wasm-simd-threaded.wasm'), 'ort.wasm'],
  [path.join(layoutOut, 'layout-core.mjs'), 'layout-core.mjs'], [path.join(layoutOut, 'layout-core.wasm'), 'layout-core.wasm']])
  fs.copyFileSync(from, path.join(here, to));
for (const name of ['ort.mjs', 'ort.wasm', 'layout-core.mjs', 'layout-core.wasm'])
  console.log(`${crypto.createHash('sha256').update(fs.readFileSync(path.join(here, name))).digest('hex')}  ${name}`);

function assert(condition, message) { if (!condition) throw new Error(message); }
