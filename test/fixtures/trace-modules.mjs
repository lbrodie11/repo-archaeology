/**
 * `node --import ./test/fixtures/trace-modules.mjs …` appends every resolved module URL to the
 * file named by `RA_TRACE_FILE` (RA-21: proves the rich path never loads ink or react).
 */
import { register } from 'node:module';

const file = process.env.RA_TRACE_FILE;
if (file) {
  const hooks = `
    import { appendFileSync } from 'node:fs';
    let out;
    export function initialize(data) { out = data.file; }
    export async function resolve(specifier, context, next) {
      const result = await next(specifier, context);
      appendFileSync(out, result.url + '\\n');
      return result;
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { file } });
}
