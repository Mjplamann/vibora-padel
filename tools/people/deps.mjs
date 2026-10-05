// Bake-time npm dependencies (not shipped): resolved normally, or from $PEOPLE_DEPS (a node_modules dir).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

export async function need(name) {
  try {
    return await import(name);
  } catch {
    const dir = process.env.PEOPLE_DEPS;
    if (!dir) throw new Error(`${name} is needed for the bake: npm i --no-save ${name} (or set PEOPLE_DEPS to a node_modules dir)`);
    const req = createRequire(join(dir, 'noop.js'));
    return import(pathToFileURL(req.resolve(name)).href);
  }
}
