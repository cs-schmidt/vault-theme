/**
 * @file Node-driven CLI build script.
 *
 * Run `node build.js -h` for usage documentation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { watch } from 'chokidar';
import { program, Option, InvalidArgumentError } from 'commander';
import dotenv from 'dotenv';
import * as esbuild from 'esbuild';
import Joi from 'joi';

if (!import.meta.main) {
  console.error('error: build.js must be executed directly, not imported');
  console.error('Run `node build.js -h` for usage');
  process.exit(1);
}

/** The CSS build failed. esbuild has already printed the details (see `logLevel`). */
class CssBuildError extends Error {}

/** The manifest is missing, malformed, invalid, or has an unexpected name. */
class ManifestError extends Error {}

/* Constants and paths */

// NOTE: Keep manifest's `minAppVersion` aligned with chrome and safari targets.
const CHROME_VERSION = '112';
const SAFARI_VERSION = '16.5';
const MANIFEST_NAME = 'manifest.json';
const CSS_ENTRY_NAME = 'theme.css';
const DEFAULT_OUT_DIR_NAME = 'dist';

const scriptDir = import.meta.dirname;
const envFilePath = path.join(scriptDir, '.env');
const defaultOutDir = path.join(scriptDir, DEFAULT_OUT_DIR_NAME);
const manifestPath = path.join(scriptDir, MANIFEST_NAME);
const cssEntryPath = path.join(scriptDir, CSS_ENTRY_NAME);

/* CLI setup */

// NOTE: `dotenv.config()` does not overwrite pre-set environment variables by default.
const dotenvError = dotenv.config({ path: envFilePath, quiet: true }).error;
if (dotenvError && dotenvError.code !== 'ENOENT')
  console.warn(`Warning: Failed to load env file: ${dotenvError.message}`);

function parseOutDir(value) {
  const outDir = value.trim();
  if (outDir === '') throw new InvalidArgumentError('must be a non-empty valid path');
  return path.resolve(expandTilde(outDir));
}

program
  .name('node build.js')
  .description('Build the Obsidian theme')
  .addOption(
    new Option('-m, --mode <mode>', 'Set build mode')
      .choices(['development', 'production'])
      .default('production'),
  )
  .addOption(
    new Option(
      '-o, --out-dir <path>',
      'Folder to build the theme folder into; relative paths resolve from the CWD',
    )
      .env('OUT_DIR')
      .default(defaultOutDir, `${DEFAULT_OUT_DIR_NAME} beside build.js`)
      .argParser(parseOutDir),
  )
  .option('-w, --watch', 'Rebuild on file changes', false)
  .option('--no-check', 'Skip the confirmation when the theme folder already exists')
  .helpOption('-h, --help', 'Show help text')
  .allowExcessArguments(false)
  .showHelpAfterError()
  .parse(process.argv);

const cliOptions = program.opts();

/* Manifest schema definition */

const manifestVersionRegex = /^\d+\.\d+\.\d+$/;
const manifestSchema = Joi.object({
  // The pattern also keeps `themeDir` safe: no path separators or `.`/`..` segments
  name: Joi.string()
    .pattern(/^[a-z0-9]+(?:[- ][a-z0-9]+)*$/i)
    .required()
    .messages({
      'string.pattern.base':
        '"name" must be a chain of alphanumeric segments joined by hyphens or spaces.',
    }),
  version: Joi.string().pattern(manifestVersionRegex).required(),
  minAppVersion: Joi.string().pattern(manifestVersionRegex).required(),
  author: Joi.string(),
  authorUrl: Joi.string().uri({ scheme: ['http', 'https'] }),
  fundingUrl: Joi.string().uri({ scheme: ['http', 'https'] }),
});

/* Theme directory setup */

const themeName = initThemeName();
const themeDir = path.join(cliOptions.outDir, themeName);

// Unless --no-check is set, ask before overwriting existing theme files
if (cliOptions.check) {
  let themeDirEntries = [];

  try {
    themeDirEntries = fs.readdirSync(themeDir);
  } catch (error) {
    if (error.code !== 'ENOENT') exitWithError(error.message);
  }

  const filesToOverwrite = [MANIFEST_NAME, CSS_ENTRY_NAME].filter((filename) =>
    themeDirEntries.includes(filename),
  );

  if (filesToOverwrite.length > 0) {
    console.log(`Found existing files at ${themeDir}.`);
    const proceed = await confirm(`Overwrite ${filesToOverwrite.join(' and ')}?`);
    if (!proceed) process.exit(0);
  }
}

try {
  fs.mkdirSync(themeDir, { recursive: true });
} catch (error) {
  exitWithError(error.message);
}

/* ESBuild configuration */

const cssBuildContext = await esbuild.context({
  absWorkingDir: scriptDir,
  entryPoints: [cssEntryPath],
  outfile: path.join(themeDir, CSS_ENTRY_NAME),
  bundle: true,
  loader: {
    // Image loaders
    '.avif': 'dataurl',
    '.webp': 'dataurl',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.svg': 'dataurl',
    // Font loaders
    '.woff2': 'dataurl',
    '.woff': 'dataurl',
    '.ttf': 'dataurl',
    '.otf': 'dataurl',
  },
  target: [`chrome${CHROME_VERSION}`, `safari${SAFARI_VERSION}`],
  minify: cliOptions.mode === 'production',
  sourcemap: cliOptions.mode === 'development' ? 'inline' : false,
  metafile: true,
  // esbuild prints CSS build errors itself; see `CssBuildError`
  logLevel: 'info',
});

/* Build cycle */

if (!cliOptions.watch) {
  let buildResult;
  try {
    buildResult = await tryBuild();
  } finally {
    await cssBuildContext.dispose();
  }
  if (!buildResult) process.exit(1);
} else await runWatchMode();

// ============================================================================

/** Prints an error in Commander's style and exits with code 1. */
function exitWithError(message) {
  program.error(`error: ${message}`);
}

/** Expands leading `~` in a path string, if present. */
function expandTilde(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\'))
    return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Helper for resolving the theme name before starting the build cycle. It returns the
 * theme name from the manifest, or exits with an error if it's invalid.
 */
function initThemeName() {
  try {
    return readManifest().name;
  } catch (error) {
    if (error instanceof ManifestError) exitWithError(error.message);
    throw error;
  }
}

/** Reads and validates the manifest. */
function readManifest() {
  let manifest;
  try {
    // Strip UTF-8 BOM: opening/editing files with some Windows apps may prepend one
    // (JSON.parse rejects it).
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT')
      throw new ManifestError(`manifest could not be read: ${error.message}`, {
        cause: error,
      });
    throw error;
  }

  const validationResult = manifestSchema.validate(manifest, { abortEarly: false });
  if (validationResult.error) {
    const issues = validationResult.error.details
      .map((issue) => `  - ${issue.message}`)
      .join('\n');

    throw new ManifestError(`manifest is invalid:\n${issues}`);
  }

  return validationResult.value;
}

/** Prompts user for confirmation. */
async function confirm(question) {
  if (!process.stdin.isTTY)
    exitWithError(
      [
        'confirmation required, but stdin is not an interactive terminal.',
        'Pass --no-check to skip confirmation.',
      ].join('\n'),
    );

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const response = (await readline.question(`${question} [y/N] `)).trim();
    return /^y(es)?$/i.test(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      process.stdout.write('\n');
      return false;
    }
    throw error;
  } finally {
    readline.close();
  }
}

/** Produces the theme build. */
async function build() {
  console.log('Building...');

  const manifest = readManifest();

  if (manifest.name !== themeName)
    throw new ManifestError(
      [
        `manifest's name property changed from ${themeName} to ${manifest.name}`,
        'Restart the build, or revert the name',
      ].join('\n'),
    );

  // Produce css bundle
  let cssBuildResult;
  try {
    cssBuildResult = await cssBuildContext.rebuild();
  } catch (error) {
    throw new CssBuildError('CSS build failed', { cause: error });
  }

  // Produce manifest (after the CSS build, so a failed build doesn't leave a half-updated
  // theme folder; a failure here, e.g. permissions or disk full, stays fatal)
  fs.writeFileSync(
    path.join(themeDir, MANIFEST_NAME),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  console.log('Build complete');
  return cssBuildResult;
}

/**
 * Runs a build. Returns the result, or `null` on a recoverable failure. Rethrows anything
 * unexpected.
 */
async function tryBuild() {
  try {
    return await build();
  } catch (error) {
    if (error instanceof CssBuildError) return null; // esbuild already printed it
    if (error instanceof ManifestError) {
      console.error(`error: ${error.message}`);
      return null;
    }
    throw error;
  }
}

/**
 * Builds once, then rebuilds (debounced) whenever a dependency changes. Recoverable
 * failures pause until the next change; unexpected errors exit the process.
 */
async function runWatchMode() {
  const rebuildDelayMs = 200;
  const buildInputPaths = [cssEntryPath, manifestPath];
  let buildTimer;
  let isBuilding = false;
  let buildQueued = false;
  let watchedPaths = new Set(buildInputPaths);

  const watcher = watch([...watchedPaths], {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });

  watcher.on('all', (event, targetPath) => {
    console.log(`${event}: ${path.relative(scriptDir, targetPath)}`);
    clearTimeout(buildTimer);
    buildTimer = setTimeout(requestBuild, rebuildDelayMs);
  });
  watcher.on('error', fatal);

  // Exiting skips explicit cleanup; the OS tears down the watcher and esbuild with the process
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

  // A recoverable failure on the first build only pauses: fix the file and it rebuilds.
  await requestBuild();
  console.log('Watching for changes...');

  // ===========================================================================

  /** Produces a build now, or queues another build if one is already running. */
  async function requestBuild() {
    if (isBuilding) {
      buildQueued = true;
      return;
    }
    isBuilding = true;

    try {
      do {
        buildQueued = false;
        const buildResult = await tryBuild(); // null = paused, keep watching
        if (buildResult) syncWatchedPaths(buildResult.metafile);
      } while (buildQueued);
    } catch (error) {
      fatal(error); // unexpected error
    } finally {
      isBuilding = false;
    }
  }

  /** Watches exactly the files the last successful build read. */
  function syncWatchedPaths(metafile) {
    const nextPaths = new Set([
      ...buildInputPaths,
      ...Object.keys(metafile.inputs).map((input) => path.join(scriptDir, input)),
    ]);
    const addedPaths = [...nextPaths].filter((file) => !watchedPaths.has(file));
    const removedPaths = [...watchedPaths].filter((file) => !nextPaths.has(file));

    if (addedPaths.length) watcher.add(addedPaths);
    if (removedPaths.length) watcher.unwatch(removedPaths);
    watchedPaths = nextPaths;
  }

  /** Reports an unexpected error and exits with a failure code. */
  function fatal(error) {
    console.error(error);
    process.exit(1);
  }
}
