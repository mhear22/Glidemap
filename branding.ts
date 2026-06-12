// Single source of truth for the product identity. Rename the product here
// and every user-facing surface follows (header, landing page, help, admin,
// server logs, document titles via main.ts).
//
// Two kinds of references intentionally do NOT use this module:
// - Static HTML fallbacks (webapp/index.html, adminapp/index.html,
//   web/index.html <title>/<meta description>): shown only before JS loads;
//   update them by hand on rename.
// - Internal identifiers (postMessage namespace "mapanim", the service worker
//   cache name, tile-cache User-Agent strings, docker image names, and
//   localStorage keys): renaming those breaks running installs for zero
//   user-visible benefit. Leave them.

export interface Credit {
  name: string;
  url?: string;
}

export const branding = {
  name: "Glidemap",
  tagline: "Turn a route into a map flyover video",
  description: "Glidemap - Create animated map route videos",
  builtBy: [
    { name: "Mika" },
    { name: "GLM", url: "https://z.ai/chat" },
    { name: "Codex", url: "https://openai.com/codex" },
    { name: "Claude", url: "https://claude.com/claude-code" }
  ] as Credit[]
} as const;
