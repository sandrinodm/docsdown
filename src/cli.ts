#!/usr/bin/env node
import { Console, Effect, Layer } from 'effect';
import { NodeHttpClient, NodeRuntime, NodeServices } from '@effect/platform-node';
import { Argument, Command, Flag } from 'effect/unstable/cli';
import { archiveConfigFilename } from './config.js';
import type { DownloadSummary } from './downloader.js';
import { packageVersion } from './package.js';
import { downloadAndConfigure, updateDocumentationArchives } from './update.js';

/**
 * Required starting URL accepted by the root command.
 */
const url = Argument.string('url').pipe(Argument.withDescription('Documentation URL or path to download'));

/**
 * Exact destination directory in which one documentation archive is created.
 */
const outputDirectory = Flag.string('output').pipe(
  Flag.withAlias('o'),
  Flag.withDefault('./docs'),
  Flag.withDescription('Archive destination, or directory searched by the update command')
);

/**
 * Shared request concurrency for page batches and media downloads.
 */
const concurrency = Flag.integer('concurrency').pipe(
  Flag.withAlias('c'),
  Flag.withDefault(6),
  Flag.withDescription('Maximum number of simultaneous page and media downloads')
);

/**
 * Crawl ceiling that prevents unexpectedly broad documentation sites from running without bound.
 */
const maxPages = Flag.integer('max-pages').pipe(
  Flag.withDefault(500),
  Flag.withDescription('Safety limit for the number of pages to crawl')
);

/**
 * Per-media response limit expressed in megabytes for human-friendly CLI input.
 */
const maxMediaMb = Flag.integer('max-media-mb').pipe(
  Flag.withDefault(100),
  Flag.withDescription('Skip individual media files larger than this size')
);

/**
 * Opt-out from link traversal for one-page archival workflows.
 */
const singlePage = Flag.boolean('single-page').pipe(
  Flag.withDescription('Download only the supplied URL instead of its documentation subtree')
);

/**
 * Opt-out from digest-aware stale-file cleanup after successful crawls.
 */
const keepStale = Flag.boolean('keep-stale').pipe(
  Flag.withDescription('Keep files that disappeared since the previous successful crawl')
);

/**
 * Enables request-level progress instead of the default page-level completion messages.
 */
const verbose = Flag.boolean('verbose').pipe(Flag.withDescription('Show probes, page fetches, and skipped media'));

/**
 * Source adapter policy; automatic mode recognizes GitHub repository URLs.
 */
const provider = Flag.string('provider').pipe(
  Flag.withDefault('auto'),
  Flag.withDescription('Source provider: auto, website, or github')
);

/**
 * Repeatable repository-relative path selection for focused GitHub archives.
 */
const include = Flag.string('include').pipe(
  Flag.atLeast(0),
  Flag.withDescription('GitHub folder to include, relative to the URL scope; repeat for multiple folders')
);

/**
 * Prints the outcome of one documentation archive download.
 */
const printDownloadSummary = (summary: DownloadSummary) =>
  Effect.gen(function* () {
    yield* Console.log('');
    yield* Console.log(`Saved ${summary.pagesDownloaded} page(s) and ${summary.mediaDownloaded} media file(s).`);
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
}).pipe(
  Command.withSharedFlags({ outputDirectory }),
  Command.withHandler(
    ({ url, outputDirectory, concurrency, maxPages, maxMediaMb, singlePage, keepStale, verbose, provider, include }) =>
      Effect.gen(function* () {
        const summary = yield* downloadAndConfigure({
          url,
          outputDirectory,
          concurrency,
          maxPages,
          maxMediaBytes: maxMediaMb * 1024 * 1024,
          singlePage,
          keepStale,
          verbose,
          provider,
          githubPaths: include,
          ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
        });
        yield* printDownloadSummary(summary);
      })
  ),
  Command.withDescription(
    'Download a documentation path as local Markdown, preferring native Markdown and preserving media.'
  )
);

/**
 * Maintenance subcommand that refreshes all configured archives under the shared output directory.
 */
const updateCommand = Command.make('update', {}, () =>
  Effect.gen(function* () {
    const { outputDirectory } = yield* downloadCommand;
    const summary = yield* updateDocumentationArchives({
      outputDirectory,
      ...(process.env.GITHUB_TOKEN ? { githubToken: process.env.GITHUB_TOKEN } : {}),
    });
    yield* Console.log('');
    yield* Console.log(`Updated ${summary.archivesUpdated} of ${summary.configsFound} configured archive(s).`);
    for (const failure of summary.failures) {
      yield* Console.log(`Failed ${failure.configPath}: ${failure.message}`);
    }
    if (summary.configsFound === 0) {
      return yield* Effect.fail(new Error(`No ${archiveConfigFilename} files found beneath ${outputDirectory}`));
    }
    if (summary.failures.length > 0) {
      return yield* Effect.fail(new Error(`${summary.failures.length} archive update(s) failed`));
    }
  })
).pipe(Command.withDescription('Refresh every configured documentation archive beneath --output'));

/**
 * Public CLI command supporting direct downloads and recursive managed updates.
 */
export const cli = downloadCommand.pipe(Command.withSubcommands([updateCommand]));

/**
 * Production adapters for filesystem, terminal, and Fetch-based HTTP capabilities required by the command.
 */
const MainLayer = Layer.mergeAll(NodeServices.layer, NodeHttpClient.layerFetch);

Command.run(cli, { version: packageVersion }).pipe(Effect.provide(MainLayer), NodeRuntime.runMain);
