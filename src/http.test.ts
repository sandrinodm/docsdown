import { NodeHttpClient } from '@effect/platform-node';
import { Effect, Layer } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import { createServer, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { resilientHttpClientLayer, type HttpResiliencePolicy } from './http.js';

/**
 * Fast retry policy whose timeout is generous enough that a slow test machine never triggers an unintended retry.
 */
const testPolicy: HttpResiliencePolicy = {
  requestTimeout: '10 seconds',
  retries: 2,
  retryBaseDelay: '1 millis',
};

/**
 * Same retry policy with a short timeout for exercising stalled requests.
 */
const stallPolicy: HttpResiliencePolicy = { ...testPolicy, requestTimeout: '100 millis' };

/**
 * Servers closed after each test.
 */
const closers: Array<() => Promise<void>> = [];

const listen = async (handler: RequestListener) => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Missing test server address');
  }

  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
};

const get = (url: string, policy: HttpResiliencePolicy = testPolicy) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    return { status: response.status, body: yield* response.text };
  }).pipe(Effect.provide(resilientHttpClientLayer(policy).pipe(Layer.provide(NodeHttpClient.layerFetch))));

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('resilient HTTP client', () => {
  it('passes successful responses through the production policy unchanged', async () => {
    let attempts = 0;
    const origin = await listen((_request, response) => {
      attempts += 1;
      response.writeHead(200).end('ok');
    });

    const defaultLayer = resilientHttpClientLayer().pipe(Layer.provide(NodeHttpClient.layerFetch));
    const result = await Effect.gen(function* () {
      const response = yield* HttpClient.get(`${origin}/page`);
      return { status: response.status, body: yield* response.text };
    }).pipe(Effect.provide(defaultLayer), Effect.runPromise);

    expect(result).toEqual({ status: 200, body: 'ok' });
    expect(attempts).toBe(1);
  });

  it('retries transient responses until one succeeds', async () => {
    let attempts = 0;
    const origin = await listen((_request, response) => {
      attempts += 1;
      if (attempts < 3) {
        response.writeHead(503).end('busy');
      } else {
        response.writeHead(200).end('ready');
      }
    });

    expect(await get(`${origin}/page`).pipe(Effect.runPromise)).toEqual({ status: 200, body: 'ready' });
    expect(attempts).toBe(3);
  });

  it('returns the final transient response after exhausting retries', async () => {
    let attempts = 0;
    const origin = await listen((_request, response) => {
      attempts += 1;
      response.writeHead(429).end('slow down');
    });

    expect(await get(`${origin}/page`).pipe(Effect.runPromise)).toEqual({ status: 429, body: 'slow down' });
    expect(attempts).toBe(3);
  });

  it.each([404, 500])('does not retry HTTP %i responses', async (status) => {
    let attempts = 0;
    const origin = await listen((_request, response) => {
      attempts += 1;
      response.writeHead(status).end('permanent');
    });

    expect(await get(`${origin}/page`).pipe(Effect.runPromise)).toEqual({ status, body: 'permanent' });
    expect(attempts).toBe(1);
  });

  it('shares one retry budget between retryable responses and transport failures', async () => {
    let attempts = 0;
    const origin = await listen((request, response) => {
      attempts += 1;
      if (attempts === 1) {
        response.writeHead(503).end('busy');
      } else {
        request.socket.destroy();
      }
    });

    const error = await get(`${origin}/page`).pipe(Effect.flip, Effect.runPromise);
    expect(error).toMatchObject({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } });
    expect(attempts).toBe(3);
  });

  it('times out stalled attempts and reports a transport error once retries are exhausted', async () => {
    let attempts = 0;
    const origin = await listen(() => {
      attempts += 1;
    });

    const error = await get(`${origin}/stalled`, stallPolicy).pipe(Effect.flip, Effect.runPromise);
    expect(error).toMatchObject({ _tag: 'HttpClientError', reason: { _tag: 'TransportError' } });
    expect(error.message).toContain('No response within 100ms');
    expect(attempts).toBe(3);
  });
});
