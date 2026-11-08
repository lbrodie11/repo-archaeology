export interface JsonSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  oneOf?: JsonSchemaNode[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  $defs?: Record<string, JsonSchemaNode>;
  [key: string]: unknown;
}

export const SUPPORTED_SCHEMA_KEYWORDS: Set<string>;

export function sanitizeGitEnv(
  baseEnv?: NodeJS.ProcessEnv,
  extraEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function loadSchema(schemaDir: string, fileName: string): JsonSchemaNode;

export function resolveSchemaRef(
  schemaDir: string,
  ref: string,
  currentSchemaFile: string,
): { node: JsonSchemaNode; file: string };

export function validateSchemaNode(
  schemaDir: string,
  value: unknown,
  schema: JsonSchemaNode,
  schemaFile: string,
  path: string,
  errors: string[],
): void;

export function validateAgainstSchema(
  schemaDir: string,
  payload: unknown,
  schemaFile: string,
): void;
