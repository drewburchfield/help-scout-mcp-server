/**
 * Cross-model JSON Schema sanitizer (NAS-1307 phase 1).
 *
 * MCP `inputSchema`s that validate cleanly on Claude can silently 400 on other
 * providers because each provider enforces a stricter / different dialect:
 *   - Gemini rejects object-level `anyOf`/`oneOf`/`allOf` (one bad schema in a
 *     `tools/list` 400s the WHOLE request).
 *   - OpenAI strict mode 400s on closed object schemas missing `additionalProperties: false`.
 *   - Some models serialize `$ref` objects as strings.
 *   - Weaker / non-Claude models stringify complex arguments (`"[1,2]"` instead
 *     of `[1,2]`) and the server then rejects them with -32602.
 *
 * `sanitizeJsonSchema` normalizes an emitted schema so it loads across
 * Gemini / OpenAI / GLM / Claude. `coerceJsonStringArgs` repairs stringified
 * argument payloads at dispatch time.
 *
 * Both are PURE (deep-clone, never mutate the input). `sanitizeJsonSchema` is
 * IDEMPOTENT: `sanitize(sanitize(x))` deep-equals `sanitize(x)`. Neither throws.
 */

type Json = unknown;
type JsonObject = Record<string, Json>;

const COMBINATOR_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

function isPlainObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  // structuredClone is available in Node 17+; schemas are plain JSON.
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Resolve a local `#/$defs/...` (or legacy `#/definitions/...`) JSON pointer
 * against the provided defs maps. Returns `undefined` if it can't resolve.
 */
function resolveLocalRef(
  ref: string,
  defs: JsonObject,
  definitions: JsonObject,
): Json | undefined {
  let key: string | undefined;
  let source: JsonObject | undefined;
  if (ref.startsWith('#/$defs/')) {
    key = ref.slice('#/$defs/'.length);
    source = defs;
  } else if (ref.startsWith('#/definitions/')) {
    key = ref.slice('#/definitions/'.length);
    source = definitions;
  }
  if (key === undefined || source === undefined) {
    return undefined;
  }
  // Only support a single-segment pointer (our defs are flat); deeper pointers
  // are left untouched (returns undefined).
  if (key.includes('/')) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function sanitizeNode(
  node: Json,
  defs: JsonObject,
  definitions: JsonObject,
  refStack: ReadonlySet<string>,
): Json {
  if (Array.isArray(node)) {
    return node.map((item) => sanitizeNode(item, defs, definitions, refStack));
  }
  if (!isPlainObject(node)) {
    return node;
  }

  // Inline-deref a local $ref before any other processing.
  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!refStack.has(ref)) {
      const resolved = resolveLocalRef(ref, defs, definitions);
      if (resolved !== undefined) {
        const nextStack = new Set(refStack);
        nextStack.add(ref);
        // Merge any sibling keywords (other than $ref) onto the resolved target.
        const siblings: JsonObject = {};
        for (const [k, v] of Object.entries(node)) {
          if (k !== '$ref') {
            siblings[k] = v;
          }
        }
        const merged = { ...(isPlainObject(resolved) ? resolved : {}), ...siblings };
        return sanitizeNode(merged, defs, definitions, nextStack);
      }
    }
    // Unresolvable (or cyclic) ref: leave the node untouched.
    return node;
  }

  const result: JsonObject = {};

  for (const [key, value] of Object.entries(node)) {
    // Drop object-level combinator keywords wherever they appear. Server-side
    // Zod still enforces the underlying "require one of" constraints.
    if ((COMBINATOR_KEYWORDS as readonly string[]).includes(key)) {
      continue;
    }
    // $defs/definitions are inlined above and then removed from output.
    if (key === '$defs' || key === 'definitions') {
      continue;
    }

    if (key === 'type' && value === 'number') {
      // This Help Scout API has no float params; page/limit/rows/ids/numbers
      // are all integers. Preserve minimum/maximum/default alongside.
      result[key] = 'integer';
      continue;
    }

    result[key] = sanitizeNode(value, defs, definitions, refStack);
  }

  // OpenAI strict mode requires explicit additionalProperties on object schemas.
  // Preserve explicit open bags such as call_tool.arguments.
  const looksLikeObject = result.type === 'object' || isPlainObject(result.properties);
  if (looksLikeObject && !Object.prototype.hasOwnProperty.call(result, 'additionalProperties')) {
    result.additionalProperties = false;
  }

  return result;
}

/**
 * Normalize a JSON Schema so it loads across Gemini / OpenAI / GLM / Claude.
 *
 * - Strips object-level `anyOf`/`oneOf`/`allOf` wherever they appear.
 * - Sets `additionalProperties: false` on object nodes missing an explicit
 *   additionalProperties value. Leaves intentional open bags and non-objects alone.
 * - Converts `type: 'number'` -> `type: 'integer'` everywhere, preserving
 *   minimum/maximum/default.
 * - Inline-derefs local `$ref`/`$defs` (then drops `$defs`); unresolvable refs
 *   are left untouched.
 * - Leaves enums, descriptions, required, nested properties/items intact.
 *
 * Pure (deep-clones, never mutates input), idempotent, total (never throws).
 */
export function sanitizeJsonSchema(schema: object): object {
  if (!isPlainObject(schema)) {
    return schema as object;
  }
  const clone = deepClone(schema) as JsonObject;
  const defs = isPlainObject(clone.$defs) ? clone.$defs : {};
  const definitions = isPlainObject(clone.definitions) ? clone.definitions : {};
  return sanitizeNode(clone, defs, definitions, new Set<string>()) as object;
}

function schemaPropertyType(propSchema: Json): string | undefined {
  if (!isPlainObject(propSchema)) {
    return undefined;
  }
  return typeof propSchema.type === 'string' ? propSchema.type : undefined;
}

/**
 * Try to coerce a single stringified-JSON value to native when the schema for
 * that property expects an array or object. Best-effort: only coerces when the
 * string JSON-parses AND the parsed value's shape matches the expected type.
 * Otherwise returns the original value untouched.
 */
function coerceValue(value: Json, expectedType: string | undefined): Json {
  if (typeof value !== 'string') {
    return value;
  }
  if (expectedType !== 'array' && expectedType !== 'object') {
    return value;
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value;
  }
  if (expectedType === 'array' && Array.isArray(parsed)) {
    return parsed;
  }
  if (expectedType === 'object' && isPlainObject(parsed)) {
    return parsed;
  }
  return value;
}

/**
 * Repair stringified complex arguments at dispatch time.
 *
 * When a tool argument is a STRING that JSON-parses to an array/object AND the
 * schema for that property expects `type:'array'`/`'object'`, replace it with
 * the parsed value. Recurses one level into object properties.
 *
 * Best-effort and total: never throws, returns the input shape on any failure,
 * leaves genuine strings and already-native values alone.
 */
export function coerceJsonStringArgs(args: unknown, schema: object): object {
  if (!isPlainObject(args)) {
    return (args ?? {}) as object;
  }
  if (!isPlainObject(schema)) {
    return args;
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : undefined;
  if (!properties) {
    return args;
  }

  const result: JsonObject = { ...args };
  for (const [propName, rawValue] of Object.entries(args)) {
    const propSchema = properties[propName];
    const expectedType = schemaPropertyType(propSchema);
    const coerced = coerceValue(rawValue, expectedType);
    if (coerced !== rawValue) {
      result[propName] = coerced;
      continue;
    }
    // Recurse one level into nested object properties.
    if (expectedType === 'object' && isPlainObject(coerced) && isPlainObject(propSchema)) {
      result[propName] = coerceJsonStringArgs(coerced, propSchema);
    }
  }
  return result;
}
