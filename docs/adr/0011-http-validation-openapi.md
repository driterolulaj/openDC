# ADR-0011: Fastify + Zod, OpenAPI generated from Zod with no extra dependencies

Status: Proposed · Date: 2026-10-06

## Context
The spec fixes Fastify 5 (plus helmet, rate-limit and cookie) and Zod with an OpenAPI spec generated from the
schemas. The usual glue (`fastify-type-provider-zod`, `@fastify/swagger`, `@fastify/csrf-protection`,
`@fastify/session`) isn't on the approved list.

## Decision
1. Zod 4 schemas live in `packages/shared`. Zod 4 includes `z.toJSONSchema()`.
2. An in-house Fastify `validatorCompiler`/`serializerCompiler` (~60 lines) validates requests and responses
   with Zod. Response validation is on in dev/test and sampled in production.
3. An in-house OpenAPI 3.1 assembler (~200 lines) walks the route table (each route registers
   `{method, url, operationId, permission, schemas}`) and writes `openapi.json` at build time. CI fails if the
   committed spec differs from the generated one (API diff review).
4. Sessions, CSRF and TOTP are implemented in-house (each well under the 100-line threshold or a small,
   tested module) on top of `@fastify/cookie` and `node:crypto`. Details in SECURITY.md §4.
5. SSE for job progress is written directly on `reply.raw`.
6. Public API lives under `/api/v1`. Node RPC lives under `/node/v1` (mTLS listener only). Errors use a stable
   `{code, message, params, fix}` shape; message and fix are i18n keys plus parameters.

## Consequences
- Four fewer dependencies, at the cost of about 500 lines of well-tested glue that we own.
- The CLI and the web app use the same Zod types, so the API contract is type-checked end to end.
