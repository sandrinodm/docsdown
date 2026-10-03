#!/usr/bin/env node
import { Config, Console, Data, Effect, Layer, Option, Redacted } from 'effect';
import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Argument, CliError, Command, Flag } from 'effect/cli';
import { archiveConfigFilename } from './config.js';
import { InvalidOptionsError } from './errors.js';
import { resilientHttpClientLayer } from './http.js';
import type { DownloadSummary } from './providers.js';
import { packageVersion } from './package.js';
import { downloadAndConfigure, updateDocumentationArchives } from './update.js';

/**
 * Required starting URL accepted by the root command.
 */
const url = Argument.String('url').pipe(Argument.withDescription('Documentation URL or path to download'));

/**
 * Required destination directory in which one documentation archive is created.
 */
const outputDirectory = Flag.String('output').pipe(
  Flag.withAlias('o'),
  Flag.withDescription('Required archive destination directory')
);

/**
 * Parent directory searched for managed archives by the update command.
 */
const updateOutputDirectory = Flag.String('output').pipe(
  Flag.withAlias('o'),
  Flag.withDefault('./docs'),
  Flag.withDescription('Directory searched recursively for managed archives')
);

/**
 * Shared request concurrency for page batches, discovery probes, and media downloads.
 */
const concurrency = Flag.Int('concurrency').pipe(
  Flag.withAlias('c'),
  Flag.withDefault(2),
  Flag.withDescription('Maximum number of simultaneous page, discovery index, and media downloads')
);

/**
 * Optional crawl ceiling for callers that intentionally want a partial archive.
 */
const maxPages = Flag.Int('max-pages').pipe(
  Flag.optional,
  Flag.withDescription('Optional limit for the number of pages to crawl; omitted downloads the full scope')
);

/**
 * Per-media response limit expressed in megabytes for human-friendly CLI input.
 */
const maxMediaMb = Flag.Int('max-media-mb').pipe(
  Flag.withDefault(100),
  Flag.withDescription('Skip individual media files larger than this size')
);

/**
 * Opt-out from link traversal for one-page archival workflows.
 */
const singlePage = Flag.Boolean('single-page').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Download only the supplied URL instead of its documentation subtree')
);

/**
 * Opt-out from digest-aware stale-file cleanup after successful crawls.
 */
const keepStale = Flag.Boolean('keep-stale').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Keep files that disappeared since the previous successful crawl')
);

/**
 * Enables request-level progress instead of the default page-level completion messages.
 */
const verbose = Flag.Boolean('verbose').pipe(
  Flag.withDefault(false),
  Flag.withDescription('Show probes, page fetches, and skipped media')
);

/**
 * Source adapter policy; automatic mode recognizes GitHub repository URLs.
 */
const provider = Flag.Literals('provider', ['auto', 'website', 'github']).pipe(
  Flag.withDefault('auto'),
  Flag.withDescription('Source provider')
);

/**
 * Repeatable repository-relative path selection for focused GitHub archives.
 */
const include = Flag.String('include').pipe(
  Flag.atLeast(0),
  Flag.withDescription('GitHub folder to include, relative to the URL scope; repeat for multiple folders')
);

/**
 * Optional GitHub credential read from the environment and redacted before it reaches any other module.
 *
 * An empty variable is treated as absent so `GITHUB_TOKEN= docsdown ...` behaves like an unauthenticated run.
 */
const githubToken = Config.option(Config.Redacted('GITHUB_TOKEN')).pipe(
  Config.map((token) => Option.filter(token, (value) => Redacted.value(value).length > 0)),
  Config.map((token) => Option.getOrUndefined(token))
);

/**
 * Aggregate outcome of an update run in which at least one archive stayed partial or failed.
 */
class IncompleteUpdateError extends Data.TaggedError('IncompleteUpdateError')<{
  /**
   * Summary line shown after the per-archive failure report.
   */
  readonly message: string;
}> {}

/**
 * Presents expected failures as a concise CLI message instead of a stack trace.
 *
 * Domain errors already carry user-facing messages; defects keep their full diagnostic report.
 */
const asUserError = <A, R>(effect: Effect.Effect<A, { readonly message: string }, R>) =>
  Effect.mapError(effect, (error) => new CliError.UserError({ cause: error, userMessage: error.message }));

/**
 * Prints the outcome of one documentation archive download.
 */
const printDownloadSummary = (summary: DownloadSummary) =>
  Effect.gen(function* () {
    yield* Console.log('');
    yield* Console.log(
      `Saved ${summary.pagesDownloaded} page(s), ${summary.indexesDownloaded} discovery index(es), and ${summary.mediaDownloaded} media file(s).`
    );
    yield* Console.log(`Archive: ${summary.rootDirectory}`);
    yield* Console.log(`Provider: ${summary.provider}`);
    if (summary.filesRemoved > 0) {
      yield* Console.log(`Removed ${summary.filesRemoved} stale file(s) from the previous archive.`);
    }

    if (summary.filesPreserved > 0) {
      yield* Console.log(`Preserved ${summary.filesPreserved} locally modified stale file(s).`);
    }

    if (summary.cleanupFailures > 0) {
      yield* Console.log(`${summary.cleanupFailures} stale file(s) could not be cleaned; see manifest.json.`);
    }

    if (summary.truncated) {
      yield* Console.log('The crawl reached --max-pages; stale files were not cleaned.');
    }

    if (summary.failures.length > 0) {
      yield* Console.log(`${summary.failures.length} item(s) could not be downloaded; see manifest.json.`);
    }
  });

/**
 * Root download command with an output flag inherited by maintenance subcommands.
 */
const downloadCommand = Command.make('docsdown', {
  url,
  concurrency,
  maxPages,
  maxMediaMb,
  singlePage,
  keepStale,
  verbose,
  provider,
  include,
  outputDirectory,
}).pipe(
  Command.withHandler(
    ({ url, outputDirectory, concurrency, maxPages, maxMediaMb, singlePage, keepStale, verbose, provider, include }) =>
      Effect.gen(function* () {
        const pageLimit = Option.getOrUndefined(maxPages);
        const token = yield* githubToken;
        const summary = yield* downloadAndConfigure({
          url,
          outputDirectory,
          concurrency,
          ...(pageLimit === undefined ? {} : { maxPages: pageLimit }),
          maxMediaBytes: maxMediaMb * 1024 * 1024,
          singlePage,
          keepStale,
          verbose,
          provider,
          githubPaths: include,
          ...(token === undefined ? {} : { githubToken: token }),
        });
        yield* printDownloadSummary(summary);
      }).pipe(asUserError)
  ),
  Command.withDescription(
    'Download a documentation path as local Markdown, preferring native Markdown and preserving media.'
  )
);

/**
 * Maintenance subcommand that refreshes all configured archives under the shared output directory.
 */
const updateCommand = Command.make('update', { outputDirectory: updateOutputDirectory }, ({ outputDirectory }) =>
  Effect.gen(function* () {
    const token = yield* githubToken;
    const summary = yield* updateDocumentationArchives({
      outputDirectory,
      ...(token === undefined ? {} : { githubToken: token }),
    });
    yield* Console.log('');
    yield* Console.log(`Updated ${summary.archivesUpdated} of ${summary.configsFound} configured archive(s).`);
    for (const failure of summary.failures) {
      yield* Console.log(`Failed ${failure.configPath}: ${failure.message}`);
    }

    if (summary.configsFound === 0) {
      return yield* new InvalidOptionsError({
        message: `No ${archiveConfigFilename} files found beneath ${outputDirectory}`,
      });
    }

    if (summary.failures.length > 0) {
      return yield* new IncompleteUpdateError({ message: `${summary.failures.length} archive update(s) failed` });
    }
  }).pipe(asUserError)
).pipe(Command.withDescription('Refresh every configured documentation archive beneath --output'));

/**
 * Public CLI command supporting direct downloads and recursive managed updates.
 */
export const cli = downloadCommand.pipe(Command.withSubcommands([updateCommand]));

/**
 * Production adapters for filesystem, terminal, and Fetch-based HTTP with per-request timeouts and transient retries.
 */
const MainLayer = Layer.mergeAll(
  NodeServices.layer,
  resilientHttpClientLayer().pipe(Layer.provide(NodeHttpClient.layerFetch))
);

Command.run(cli, { version: packageVersion }).pipe(Effect.provide(MainLayer), NodeRuntime.runMain);
