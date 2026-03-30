import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

const queriesCache = new Map();

/**
 * Loads and parses a SQL file into a map of queries.
 * Queries must be separated by "-- name: queryName"
 * 
 * @param {string} relativePath - Relative path from src/schema/queries/ (e.g., 'z0-raw/futures-rest-collector')
 * @returns {Object} Map of query names to SQL strings
 */
export function loadQueries(relativePath) {
  if (queriesCache.has(relativePath)) {
    return queriesCache.get(relativePath);
  }

  const fullPath = resolve(ROOT_DIR, 'schema', 'queries', `${relativePath}.sql`);
  
  if (!existsSync(fullPath)) {
    console.error(`[QueryLoader] File not found: ${fullPath}`);
    return {};
  }

  const content = readFileSync(fullPath, 'utf-8');
  const queries = {};
  
  // Split by "-- name: " and filter out any empty first element
  const blocks = content.split(/--\s*name:\s*/).filter(Boolean);
  
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const name = lines[0].trim();
    const sql = lines.slice(1).join('\n').trim();
    if (name) {
      queries[name] = sql;
    }
  }

  queriesCache.set(relativePath, queries);
  return queries;
}
