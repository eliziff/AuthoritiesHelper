import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createEngine} from './engine.mjs';
import {captionStyleOfCause} from './domain.mjs';

const engine = await createEngine(await readFile(new URL('./vendor/legal-structure.wasm', import.meta.url)));
const record = {citation: '2001 SCC 1', aliases: ['2001 SCC 1']};

test('a caption names the decision its own citation follows', () => {
  assert.equal(captionStyleOfCause('SUPREME COURT OF CANADA\nCitation: R. v. Latimer, 2001 SCC 1, [2001] 1 S.C.R. 3\nDate: 20010118\n', record, engine), 'R. v. Latimer');
});
test('a caption of another decision, or a label read into the name, names nothing', () => {
  assert.equal(captionStyleOfCause('Citation: R. v. Sharpe, 2001 SCC 2\n', record, engine), null);
  assert.equal(captionStyleOfCause('Indexed as: R. v. Latimer\nNeutral citation: 2001 SCC 1\n', record, engine), null);
  assert.equal(captionStyleOfCause('2001 SCC 1 (CanLII)\n', record, engine), null);
});
