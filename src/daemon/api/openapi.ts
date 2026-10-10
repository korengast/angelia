import { z } from 'zod';
import { DESK_API_VERSION, DESK_FEATURES, ErrorBody, ROUTES, type Route } from './routes.js';

/** JSON Schema of one zod schema, as OpenAPI 3.1 takes it (no `$schema` line). `input`: what a client
 *  may send (defaults optional); `output`: what it gets. */
function schema(s: z.ZodType, io: 'input' | 'output'): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as Record<string, unknown>;
  return open(rest) as Record<string, unknown>;
}

/** Without `additionalProperties: false`: an answer may gain fields within a version, and a client
 *  that validates against this document must take them. */
function open(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(open);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === 'additionalProperties' && x === false)).map(([k, x]) => [k, open(x)]));
}

const TOKEN = {
  none: 'No token.',
  owner: 'The owner\'s token (`~/.angelia/api.token`) only.',
  any: 'The owner\'s token, or an agent\'s own (`ANGELIA_API_TOKEN`) for its own chat. Where the route says so, an agent\'s token also works for another profile\'s chat, with `from`.',
};

function operation(r: Route): Record<string, unknown> {
  const params = r.query
    ? Object.entries(r.query.shape).map(([name, s]) => {
      const js = schema(s as z.ZodType, 'input');
      const { description, ...rest } = js;
      return { name, in: 'query', required: !(s as z.ZodType).safeParse(undefined).success, ...(description ? { description } : {}), schema: rest };
    })
    : undefined;
  const example = r.answer === undefined ? {} : { example: r.answer };
  const ok = r.stream
    ? { description: 'A server-sent event stream; each `data:` line is one event of this shape.', content: { 'text/event-stream': { schema: schema(r.response, 'output'), ...example } } }
    : { description: 'OK', content: { 'application/json': { schema: schema(r.response, 'output'), ...example } } };
  const errors = [...new Set([...(r.token === 'none' ? [] : [403]), ...(r.body ? [400, 413] : []), ...r.errors])].sort((a, b) => a - b);
  return {
    summary: r.summary,
    description: [r.description, `Token: ${TOKEN[r.token]}`].filter(Boolean).join('\n\n'),
    operationId: `${r.method.toLowerCase()}${r.path.replace(/(^|[/-])(\w)/g, (_, _s, c: string) => c.toUpperCase())}`,
    tags: [r.stability],
    'x-stability': r.stability,
    ...(r.token === 'none' ? { security: [] } : {}),
    ...(params?.length ? { parameters: params } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: schema(r.body, 'input'), ...(r.example ? { example: r.example } : {}) } } } } : {}),
    responses: {
      200: ok,
      ...Object.fromEntries(errors.map((code) => [code, { $ref: '#/components/responses/Error' }])),
    },
  };
}

/** The local API as an OpenAPI 3.1 document: `angelia api spec`, and docs/api/openapi.json. */
export function openApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) (paths[r.path] ??= {})[r.method.toLowerCase()] = operation(r);
  return {
    openapi: '3.1.0',
    info: {
      title: 'Angelia local API',
      version: String(DESK_API_VERSION),
      summary: 'Talk to a running Angelia daemon from scripts and apps on the same machine.',
      description: 'Served over a Unix socket, `~/.angelia/api.sock` (mode 600), never a network port. '
        + 'Example: `curl --unix-socket ~/.angelia/api.sock -H "Authorization: Bearer $(cat ~/.angelia/api.token)" http://localhost/profiles`. '
        + 'A request body is a JSON object of at most 256 KB. '
        + 'Routes tagged `stable` are version 1 of the contract: within it they only gain (new optional fields in, new fields and event types out, new routes). '
        + 'Routes tagged `internal` serve Angelia\'s own clients and may change in any release.',
      license: { name: 'MIT', identifier: 'MIT' },
      'x-features': [...DESK_FEATURES],
    },
    servers: [{ url: 'http://localhost', description: 'Over the Unix socket ~/.angelia/api.sock' }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'stable', description: 'Version 1 of the contract.' },
      { name: 'internal', description: 'For Angelia\'s own clients; may change in any release.' },
    ],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'The owner\'s token from ~/.angelia/api.token, or an agent\'s ANGELIA_API_TOKEN.' } },
      responses: { Error: { description: 'Refused or failed; `error` says why.', content: { 'application/json': { schema: schema(ErrorBody, 'output') } } } },
    },
  };
}
