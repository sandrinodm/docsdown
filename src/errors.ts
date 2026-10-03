import { Data, Effect } from 'effect';

/**
 * User input, archive configuration, or option combination that cannot start a download.
 */
export class InvalidOptionsError extends Data.TaggedError('InvalidOptionsError')<{
  /**
   * Human-readable explanation suitable for direct CLI output.
   */
  readonly message: string;
}> {}

/**
 * Source-level failure that prevents a provider from producing any archive content.
 */
export class DownloadError extends Data.TaggedError('DownloadError')<{
  /**
   * Source URL or API endpoint associated with the failure.
   */
  readonly url: string;

  /**
   * Human-readable explanation suitable for direct CLI output and manifests.
   */
  readonly message: string;
}> {}

/**
 * Normalizes an unknown thrown value into its human-readable message.
 */
export const causeMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Evaluates synchronous input parsing and turns any thrown validation failure into a typed option error.
 *
 * Parsers such as `new URL` and the GitHub URL model throw on malformed input; lifting them here keeps those failures in
 * the typed error channel instead of surfacing as defects.
 */
export const parseInput = <A>(evaluate: () => A): Effect.Effect<A, InvalidOptionsError> =>
  Effect.try({
    try: evaluate,
    /**
     * Preserves the parser's message while discarding its implementation-specific error class.
     */
    catch: (cause) => new InvalidOptionsError({ message: causeMessage(cause) }),
  });
