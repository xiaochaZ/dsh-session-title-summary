/**
 * Standalone build config for @xiaochaz/dsh-session-title-summary.
 *
 * Host-only plugin (no src/client entry): emits the node-half lib/ only.
 * The cordis framework plus every @deepseek-ai service stay external —
 * they resolve at runtime from the dsh profile tree, never from this repo's
 * install. Self-contained: no monorepo shared preset.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: '@xiaochaz/dsh-session-title-summary',
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-session-title',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-subagent',
  ],
})
