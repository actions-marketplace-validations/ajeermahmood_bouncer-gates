import { defineConfig } from "astro/config";
import react from "@astrojs/react";

/**
 * Static output, deployed to Cloudflare Workers.
 *
 * The playground needs a server, but not a rendered one: it posts a snippet to
 * `/api/scan`. On Workers that route is handled by `worker/index.js`, which
 * serves everything else from the assets binding; on Pages the equivalent is
 * `functions/api/scan.js`, picked up by convention. Either way the pages stay
 * static and exactly one endpoint runs code.
 *
 * That endpoint imports the same files `bin/bouncer-gates.mjs` imports. There is no
 * browser reimplementation of the rules to drift out of sync with the real ones,
 * which was the main risk in putting a demo on the site at all.
 */
export default defineConfig({
  site: "https://bouncer-gates.ajeermdk001.workers.dev",
  integrations: [react()],
  build: { inlineStylesheets: "auto" },
  vite: {
    css: {
      preprocessorOptions: {
        scss: { api: "modern-compiler" },
      },
    },
  },
});
