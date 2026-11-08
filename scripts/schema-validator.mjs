import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'description',
  'type',
  'const',
  'enum',
  'oneOf',
  'required',
  'additionalProperties',
  'properties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
]);

const GIT_ENV_VAR_RE =
  /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|SUPER_PREFIX|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|CONFIG(?:_.*)?|AUTHOR_.*|COMMITTER_.*|SSH.*|ASKPASS|TERMINAL_PROMPT)$/i;

/**
 * Returns a copy of `baseEnv` with ambient Git repository/config/author override
 * variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, etc.) stripped so
 * commands run inside hooks or nested Git processes never leak into the outer repo.
 */
export function sanitizeGitEnv(baseEnv = process.env, extraEnv = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !GIT_ENV_VAR_RE.test(key)) {
      cleaned[key] = value;
    }
  }
  return {
    ...cleaned,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extraEnv,
  };
}

const schemaCache = new Map();

export function loadSchema(schemaDir, fileName) {
  const key = `${schemaDir}:${fileName}`;
  if (schemaCache.has(key)) return schemaCache.get(key);
  const fullPath = join(schemaDir, fileName);
  const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
  schemaCache.set(key, parsed);
  return parsed;
}

export function resolveSchemaRef(schemaDir, ref, currentSchemaFile) {
  const [filePart, pointerPart] = ref.split('#');
  const targetFile = filePart && filePart.length > 0 ? filePart : currentSchemaFile;
  const rootSchema = loadSchema(schemaDir, targetFile);
  if (!pointerPart || pointerPart === '' || pointerPart === '/') {
    return { node: rootSchema, file: targetFile };
  }
  const segments = pointerPart.replace(/^\//, '').split('/');
  let cursor = rootSchema;
  for (const seg of segments) {
    if (cursor && typeof cursor === 'object' && seg in cursor) {
      cursor = cursor[seg];
    } else {
      throw new Error(`Unresolved JSON Schema $ref '${ref}' in ${currentSchemaFile}`);
    }
  }
  return { node: cursor, file: targetFile };
}

function assertSupportedSchemaKeywords(schema, schemaFile, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`Invalid JSON Schema node at ${path} in ${schemaFile}`);
  }
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      throw new Error(`Unsupported JSON Schema keyword '${key}' at ${path} in ${schemaFile}`);
    }
  }
}

export function validateSchemaNode(schemaDir, value, schema, schemaFile, path, errors) {
  assertSupportedSchemaKeywords(schema, schemaFile, path);

  if (schema.$ref) {
    const resolved = resolveSchemaRef(schemaDir, schema.$ref, schemaFile);
    validateSchemaNode(schemaDir, value, resolved.node, resolved.file, path, errors);
  }

  if (schema.oneOf) {
    const branchErrors = [];
    let matchedCount = 0;
    for (const branch of schema.oneOf) {
      const localErrs = [];
      validateSchemaNode(schemaDir, value, branch, schemaFile, path, localErrs);
      if (localErrs.length === 0) {
        matchedCount++;
      } else {
        branchErrors.push(localErrs);
      }
    }
    if (matchedCount !== 1) {
      errors.push(
        `${path}: expected value to match exactly 1 oneOf branch (matched ${matchedCount}): ${branchErrors
          .map((b) => b.join('; '))
          .join(' | ')}`,
      );
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    return;
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matchesType = allowedTypes.some((t) => {
      if (t === 'null') return value === null;
      if (t === 'array') return Array.isArray(value);
      if (t === 'integer') return typeof value === 'number' && Number.isInteger(value);
      if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (t === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
      return typeof value === t;
    });
    if (!matchesType) {
      errors.push(
        `${path}: expected type ${JSON.stringify(schema.type)}, got ${value === null ? 'null' : typeof value}`,
      );
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: string ${JSON.stringify(value)} does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path}: number ${value} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path}: number ${value} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path}: number ${value} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(`${path}: number ${value} >= exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: array length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      value.forEach((item, idx) => {
        validateSchemaNode(schemaDir, item, schema.items, schemaFile, `${path}[${idx}]`, errors);
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    if (schema.required) {
      for (const reqKey of schema.required) {
        if (!(reqKey in value) || value[reqKey] === undefined) {
          errors.push(`${path}: missing required property '${reqKey}'`);
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: unexpected additional property '${key}'`);
        }
      }
    }
    if (schema.properties) {
      for (const [propKey, propSchema] of Object.entries(schema.properties)) {
        if (propKey in value && value[propKey] !== undefined) {
          validateSchemaNode(schemaDir, value[propKey], propSchema, schemaFile, `${path}.${propKey}`, errors);
        }
      }
    }
  }
}

export function validateAgainstSchema(schemaDir, payload, schemaFile) {
  const schema = loadSchema(schemaDir, schemaFile);
  const errors = [];
  validateSchemaNode(schemaDir, payload, schema, schemaFile, '$', errors);
  if (errors.length > 0) {
    throw new Error(`Schema validation failed against ${schemaFile}:\n  - ${errors.join('\n  - ')}`);
  }
}
