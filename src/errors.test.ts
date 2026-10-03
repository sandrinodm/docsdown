import { Effect } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import { causeMessage, parseInput } from './errors.js';

describe('typed input errors', () => {
  it('returns successfully parsed values unchanged', async () => {
    expect(await parseInput(() => 42).pipe(Effect.runPromise)).toBe(42);
  });

  it('lifts thrown parser failures into InvalidOptionsError', async () => {
    const error = await parseInput(() => new URL('http://[invalid')).pipe(Effect.flip, Effect.runPromise);
    expect(error).toMatchObject({ _tag: 'InvalidOptionsError', message: 'Invalid URL' });
  });

  it('describes non-Error causes by their string form', () => {
    expect(causeMessage(new Error('boom'))).toBe('boom');
    expect(causeMessage('plain failure')).toBe('plain failure');
  });
});
