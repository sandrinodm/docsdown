import { Data, Duration, Effect, Layer, Schedule } from 'effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientError from 'effect/http/HttpClientError';
import type * as HttpClientResponse from 'effect/http/HttpClientResponse';

/**
 * Transport resilience applied to every documentation, GitHub, and media request.
 */
export interface HttpResiliencePolicy {
  /**
   * Maximum time allowed for one attempt to receive response headers.
   */
  readonly requestTimeout: Duration.Input;

  /**
   * Number of additional attempts after a transient failure.
   */
  readonly retries: number;

  /**
   * Delay before the first retry; later retries back off exponentially.
   */
  readonly retryBaseDelay: Duration.Input;
}

/**
 * Production policy: patient enough for slow documentation hosts, bounded enough that one stalled request cannot hang
 * an archive run indefinitely.
 */
export const defaultHttpResiliencePolicy: HttpResiliencePolicy = {
  /**
   * Generous single-attempt ceiling for large or slow documentation pages.
   */
  requestTimeout: '30 seconds',

  /**
   * Retries ride out brief outages and rate limiting without multiplying permanent failures.
   */
  retries: 3,

  /**
   * Exponential backoff starting point.
   */
  retryBaseDelay: '500 millis',
};

/**
 * Response statuses that signal a temporary condition worth another attempt.
 *
 * HTTP 500 is deliberately excluded: documentation hosts often answer optional probes such as `page.md` or `llms.txt`
 * with a persistent 500, and retrying those would add seconds of backoff to every page without changing the outcome.
 */
const retryableStatuses: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

/**
 * Carries a retryable response through the error channel so responses and transport errors share one retry budget.
 */
class RetryableResponse extends Data.TaggedError('RetryableResponse')<{
  /**
   * Response returned to the caller unchanged when every retry is exhausted.
   */
  readonly response: HttpClientResponse.HttpClientResponse;
}> {}

/**
 * Identifies failures that may succeed on another attempt: retryable responses and transport failures, including
 * per-attempt timeouts. Encoding, decoding, and invalid-URL failures are deterministic and fail immediately.
 */
const isRetryableError = (error: unknown): boolean =>
  error instanceof RetryableResponse ||
  (HttpClientError.isHttpClientError(error) && error.reason._tag === 'TransportError');

/**
 * Adds a per-attempt timeout and bounded exponential retries for transient failures.
 *
 * Transport errors, timed-out attempts, and HTTP 408, 429, 502, 503, and 504 responses share one budget of
 * `policy.retries` additional attempts. A final retryable response is returned unchanged so callers can still report
 * its status code.
 */
export const withResilience = (
  client: HttpClient.HttpClient,
  policy: HttpResiliencePolicy = defaultHttpResiliencePolicy
): HttpClient.HttpClient =>
  client.pipe(
    HttpClient.transform((response, request) =>
      Effect.timeoutOrElse(response, {
        duration: policy.requestTimeout,
        /**
         * Reports a stalled attempt as a retryable transport failure for the timed-out request.
         */
        orElse: () =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                description: `No response within ${Duration.format(Duration.fromInputUnsafe(policy.requestTimeout))}`,
              }),
            })
          ),
      })
    ),
    HttpClient.transformResponse((attempt) =>
      attempt.pipe(
        Effect.flatMap((response) =>
          retryableStatuses.has(response.status)
            ? Effect.fail(new RetryableResponse({ response }))
            : Effect.succeed(response)
        ),
        Effect.retry({
          schedule: Schedule.exponential(policy.retryBaseDelay),
          times: policy.retries,
          while: isRetryableError,
        }),
        Effect.catchTag('RetryableResponse', (error) => Effect.succeed(error.response))
      )
    )
  );

/**
 * Replaces the ambient `HttpClient` with its resilient variant for every downstream request.
 */
export const resilientHttpClientLayer = (policy: HttpResiliencePolicy = defaultHttpResiliencePolicy) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      return withResilience(yield* HttpClient.HttpClient, policy);
    })
  );
