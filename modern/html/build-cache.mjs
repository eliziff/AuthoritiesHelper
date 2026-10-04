import { globSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const inputStamp = file => {
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats ? `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}` : 'missing';
};
const isGlob = input => /[*?{[]/u.test(input);
const members = (pattern, cwd) => globSync(pattern.replaceAll('\\', '/'), { cwd }).map(file => path.resolve(cwd, file))
  .filter(file => statSync(file, { throwIfNoEntry: false })?.isFile()).sort();

/** Keep actual bundler watch files; glob membership also notices newly added CSS sources. */
export async function cached(directory, name, key, step, cwd) {
  const file = path.join(directory, `${name}.json`);
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    if (kept.key === key && Object.entries(kept.files).every(([input, value]) => inputStamp(input) === value) &&
      Object.entries(kept.globs).every(([pattern, files]) => JSON.stringify(members(pattern, cwd)) === JSON.stringify(files)))
      return kept.value;
  } catch { /* Missing or outdated cache. */ }
  const started = Date.now();
  const { value, inputs, watch = [], observed = {} } = await step();
  const globs = Object.fromEntries(watch.filter(isGlob).map(pattern => [pattern, members(pattern, cwd)]));
  const watchedFiles = watch.filter(input => !isGlob(input)).map(input => path.resolve(cwd, input));
  const files = Object.fromEntries([...new Set([...inputs, ...watchedFiles])].map(input => [input, inputStamp(input)]));
  // Removed watch files or sources changed after scanning must not make stale output reusable.
  const stable = Object.entries(observed).every(([input, value]) => inputStamp(input) === value) &&
    watchedFiles.every(input => files[input] !== 'missing') &&
    [...Object.keys(files), ...Object.values(globs).flat()].every(input => {
      const stats = statSync(input, { throwIfNoEntry: false });
      return !stats || Math.max(stats.mtimeMs, stats.ctimeMs) < started;
    });
  if (stable) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${file}.${process.pid}`, JSON.stringify({ key, files, globs, value }));
    renameSync(`${file}.${process.pid}`, file);
  }
  return value;
}
