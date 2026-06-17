import { sanitizeJsonSchema, coerceJsonStringArgs } from '../utils/schema-sanitizer';
import { ToolHandler } from '../tools/index';

type JsonObject = Record<string, unknown>;

/** Recursively collect every object node in a sanitized schema tree. */
function walk(node: unknown, visit: (n: JsonObject) => void): void {
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit));
    return;
  }
  if (node && typeof node === 'object') {
    const obj = node as JsonObject;
    visit(obj);
    for (const value of Object.values(obj)) {
      walk(value, visit);
    }
  }
}

describe('sanitizeJsonSchema', () => {
  it('strips object-level anyOf/oneOf/allOf wherever they appear', () => {
    const input = {
      type: 'object',
      anyOf: [{ required: ['a'] }, { required: ['b'] }],
      properties: {
        nested: {
          type: 'object',
          oneOf: [{ required: ['x'] }],
          allOf: [{ required: ['y'] }],
          properties: { x: { type: 'string' }, y: { type: 'string' } },
        },
      },
    };

    const out = sanitizeJsonSchema(input) as JsonObject;

    walk(out, (node) => {
      expect(node).not.toHaveProperty('anyOf');
      expect(node).not.toHaveProperty('oneOf');
      expect(node).not.toHaveProperty('allOf');
    });
  });

  it('adds additionalProperties:false to object nodes (and nested) but not primitives/arrays', () => {
    const input = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        ids: { type: 'array', items: { type: 'integer' } },
        nested: {
          type: 'object',
          properties: { deep: { type: 'string' } },
        },
        // object inferred from presence of a properties map, no explicit type
        inferred: {
          properties: { z: { type: 'string' } },
        },
      },
    };

    const out = sanitizeJsonSchema(input) as JsonObject;
    const props = out.properties as JsonObject;

    expect(out.additionalProperties).toBe(false);
    expect((props.nested as JsonObject).additionalProperties).toBe(false);
    expect((props.inferred as JsonObject).additionalProperties).toBe(false);
    // primitives and arrays must NOT gain additionalProperties
    expect(props.name).not.toHaveProperty('additionalProperties');
    expect(props.ids).not.toHaveProperty('additionalProperties');
  });

  it('converts number -> integer everywhere while preserving min/max/default', () => {
    const input = {
      type: 'object',
      properties: {
        page: { type: 'number', minimum: 1, maximum: 100, default: 1 },
        items: {
          type: 'array',
          items: { type: 'number' },
        },
      },
    };

    const out = sanitizeJsonSchema(input) as JsonObject;
    const props = out.properties as JsonObject;
    const page = props.page as JsonObject;

    expect(page.type).toBe('integer');
    expect(page.minimum).toBe(1);
    expect(page.maximum).toBe(100);
    expect(page.default).toBe(1);
    expect(((props.items as JsonObject).items as JsonObject).type).toBe('integer');

    // no type:'number' survives anywhere
    walk(out, (node) => {
      if ('type' in node) {
        expect(node.type).not.toBe('number');
      }
    });
  });

  it('inline-derefs a local $defs example and removes $defs', () => {
    const input = {
      type: 'object',
      $defs: {
        Id: { type: 'number', minimum: 1 },
      },
      properties: {
        customerId: { $ref: '#/$defs/Id' },
      },
    };

    const out = sanitizeJsonSchema(input) as JsonObject;
    const props = out.properties as JsonObject;

    expect(out).not.toHaveProperty('$defs');
    expect(props.customerId).toEqual({ type: 'integer', minimum: 1 });
  });

  it('leaves an unresolvable $ref untouched', () => {
    const input = {
      type: 'object',
      properties: {
        x: { $ref: '#/$defs/Missing' },
      },
    };
    const out = sanitizeJsonSchema(input) as JsonObject;
    expect((out.properties as JsonObject).x).toEqual({ $ref: '#/$defs/Missing' });
  });

  it('is idempotent', () => {
    const input = {
      type: 'object',
      anyOf: [{ required: ['a'] }],
      properties: {
        page: { type: 'number', minimum: 1, default: 1 },
        nested: { type: 'object', properties: { y: { type: 'string' } } },
      },
    };

    const once = sanitizeJsonSchema(input);
    const twice = sanitizeJsonSchema(once);
    expect(twice).toEqual(once);
  });

  it('does not mutate the input', () => {
    const input = {
      type: 'object',
      anyOf: [{ required: ['a'] }],
      properties: { page: { type: 'number' } },
    };
    const snapshot = JSON.parse(JSON.stringify(input));

    sanitizeJsonSchema(input);

    expect(input).toEqual(snapshot);
    expect(input).toHaveProperty('anyOf');
    expect((input.properties.page as JsonObject).type).toBe('number');
  });
});

describe('coerceJsonStringArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'integer' } },
      filter: { type: 'object', properties: { a: { type: 'integer' } } },
      query: { type: 'string' },
    },
  };

  it('coerces a stringified array when schema expects array', () => {
    const out = coerceJsonStringArgs({ ids: '[1,2]' }, schema);
    expect(out).toEqual({ ids: [1, 2] });
  });

  it('coerces a stringified object when schema expects object', () => {
    const out = coerceJsonStringArgs({ filter: '{"a":1}' }, schema);
    expect(out).toEqual({ filter: { a: 1 } });
  });

  it('leaves a genuine string param alone', () => {
    const out = coerceJsonStringArgs({ query: 'hello world' }, schema);
    expect(out).toEqual({ query: 'hello world' });
  });

  it('leaves an already-native array alone', () => {
    const out = coerceJsonStringArgs({ ids: [1, 2] }, schema);
    expect(out).toEqual({ ids: [1, 2] });
  });

  it('leaves a non-JSON string alone even when array expected', () => {
    const out = coerceJsonStringArgs({ ids: 'not json' }, schema);
    expect(out).toEqual({ ids: 'not json' });
  });
});

describe('listTools() emits provider-safe schemas', () => {
  it('has no object-level anyOf/oneOf/allOf, additionalProperties:false on objects, no type:number', async () => {
    const handler = new ToolHandler();
    const tools = await handler.listTools();

    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      walk(tool.inputSchema, (node) => {
        // no combinators anywhere
        expect(node).not.toHaveProperty('anyOf');
        expect(node).not.toHaveProperty('oneOf');
        expect(node).not.toHaveProperty('allOf');
        // no type:'number' anywhere (all integer)
        if ('type' in node) {
          expect(node.type).not.toBe('number');
        }
        // every object node carries additionalProperties:false
        const isObject = node.type === 'object' ||
          (node.properties && typeof node.properties === 'object');
        if (isObject) {
          expect(node.additionalProperties).toBe(false);
        }
      });
    }
  });
});
