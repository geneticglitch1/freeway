#!/usr/bin/env node
/**
 * Entry point: wire the registry, store and router together and listen.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ContextStore, ExactCache, KeyVault, Registry, Router, SemanticCache, Store, Tokenizer, consoleLogger, loadConfig } from '@freeway/core';

import { createGateway } from './server.ts';
import { isLoopback } from './http.ts';

const logger = consoleLogger;

const root = resolve(process.env['FREEWAY_ROOT'] ?? process.cwd());
const providersDir = resolve(process.env['FREEWAY_PROVIDERS'] ?? join(root, 'providers'));
const dataDir = resolve(process.env['FREEWAY_DATA'] ?? join(root, 'data'));
const configPath = resolve(process.env['FREEWAY_CONFIG'] ?? join(root, 'freeway.config.json'));

loadDotEnv(join(root, '.env'));

const { config, issues: configIssues } = loadConfig(configPath, process.env);
for (const issue of configIssues) {
  logger.warn(`config ${issue.path ? `${issue.path}: ` : ''}${issue.message}`);
}

// Accepting pasted keys is safe on loopback; on any other interface it needs an
// admin key, or anyone who can reach the port could add credentials.
const vault = new KeyVault({
  file: join(dataDir, 'keys.json'),
  logger,
  writable: isLoopback(config.host) || config.adminKey !== null,
});

const registry = new Registry({ dir: providersDir, env: process.env, logger, extraKeys: vault.all() });
const store = new Store({ file: join(dataDir, 'usage.json'), cooldownMs: config.cooldownSeconds * 1000, logger });
const router = new Router(registry, store, config);

// An open gateway on a public interface hands every provider key you own to
// anyone who can reach the port. Refusing to bind is the only safe default.
if (config.keys.length === 0) {
  if (!isLoopback(config.host)) {
    logger.error(
      `refusing to bind ${config.host}:${config.port} with no virtual keys configured.\n` +
        `  Anyone who can reach that address could spend every provider quota you have.\n` +
        `  Fix: set FREEWAY_KEYS=fw-<something-random> (or "keys" in ${configPath}), or bind 127.0.0.1.`,
    );
    process.exit(1);
  }
  logger.warn('no virtual keys configured — the gateway is OPEN to anything that can reach localhost.');
  logger.warn('  set FREEWAY_KEYS=fw-… before exposing this beyond your own machine.');
}

// Conversation history lives in sqlite so a thread survives both a restart and
// a failover to a model with a much smaller window.
const contextStore = config.context.enabled ? new ContextStore(join(dataDir, 'freeway.db')) : undefined;
const tokenizer = new Tokenizer();

const cache = config.cache.mode !== 'off'
  ? new ExactCache({ file: join(dataDir, 'cache.db'), mode: config.cache.mode, ttlMs: config.cache.ttlMs, maxEntries: config.cache.maxEntries })
  : undefined;
const semanticCache = config.cache.semantic.enabled
  ? new SemanticCache({
      enabled: true,
      threshold: config.cache.semantic.threshold,
      maxEntries: config.cache.semantic.maxEntries,
      ttlMs: config.cache.ttlMs,
    })
  : undefined;

// Exposed gateways get real defaults. Leaving every limit null is fine on
// loopback, where the only caller is you; on any other interface it means a
// single leaked key can drain every free tier you own before you notice.
const exposed = !isLoopback(config.host);
if (exposed) {
  const g = config.guard;
  if (g.perKey.rpm === null) g.perKey.rpm = 120;
  if (g.perKey.concurrency === null) g.perKey.concurrency = 8;
  if (g.perIp.rpm === null) g.perIp.rpm = 240;
  if (g.perIp.concurrency === null) g.perIp.concurrency = 16;
  logger.info(`bound to ${config.host} — applied default inbound limits (perKey ${g.perKey.rpm}/min, perIp ${g.perIp.rpm}/min)`);

  if (config.adminKey === null) {
    logger.warn('no FREEWAY_ADMIN_KEY set — /api/* is refused entirely on a non-loopback bind.');
    logger.warn('  Set one to use the dashboard remotely:  node -e "console.log(\'fw-admin-\'+crypto.randomUUID())"');
  }
  if (config.corsOrigins.length === 0) {
    logger.info('no corsOrigins configured — browsers on other origins cannot call this gateway (this is the safe default).');
  }
}

const stopAutosave = store.startAutosave();
const server = createGateway({
  registry, store, router, config, logger, vault,
  ...(contextStore ? { contextStore, tokenizer } : {}),
  ...(cache ? { cache } : {}),
  ...(semanticCache ? { semanticCache } : {}),
  onReload: () => router.setConfig(config),
});

server.listen(config.port, config.host, () => {
  const providers = registry.all();
  const usable = registry.usable();
  logger.info(`listening on http://${config.host}:${config.port}`);
  logger.info(`  dashboard   http://${config.host}:${config.port}/`);
  logger.info(`  OpenAI base http://${config.host}:${config.port}/v1`);
  logger.info(`strategy=${config.strategy} providers=${providers.length} usable=${usable.length} models=${registry.allModels().length}`);

  for (const p of providers) {
    if (p.configured) {
      logger.info(`  ✓ ${p.id} — ${p.keys.length} key${p.keys.length === 1 ? '' : 's'}, ${p.models.length} models`);
    } else {
      logger.info(`  ○ ${p.id} — ${p.configError ?? 'not configured'}`);
    }
  }
  for (const issue of registry.issues()) {
    logger[issue.level === 'error' ? 'warn' : 'info'](`  ${issue.level}: ${issue.file}: ${issue.message}`);
  }
});

function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  stopAutosave();
  store.save();
  contextStore?.close();
  cache?.close();
  server.close(() => process.exit(0));
  // Do not let a hung keep-alive connection block a container restart.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Minimal `.env` reader.
 *
 * A runtime dotenv dependency would be the first crack in the zero-dependency
 * rule, and the format we actually need is three lines of parsing.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
