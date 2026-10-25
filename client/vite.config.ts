import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const proxyTarget = process.env.VITE_DEV_PROXY_TARGET || "http://127.0.0.1:8787";

/**
 * Sub-Resource Integrity plugin.
 *
 * Runs at `writeBundle` — i.e. AFTER every other plugin has written its final
 * bytes to disk — so the hash we stamp into index.html matches exactly what
 * the browser will later fetch. Doing this in `generateBundle` misses the
 * source-map comment that Vite appends during the write step, producing a
 * same-length but different-bytes file and triggering a browser "integrity
 * mismatch" error on every page load.
 */
function sriPlugin(): Plugin {
  return {
    name: "phantom-sri",
    apply: "build",
    enforce: "post",
    writeBundle(outputOpts, bundle) {
      const outDir = outputOpts.dir ?? path.resolve(__dirname, "dist");
      const hashes = new Map<string, string>();
      for (const fileName of Object.keys(bundle)) {
        if (fileName === "index.html") continue;
        const absPath = path.join(outDir, fileName);
        try {
          const buf = fs.readFileSync(absPath);
          const digest = crypto.createHash("sha384").update(buf).digest("base64");
          hashes.set(fileName, `sha384-${digest}`);
        } catch {
          // Asset might not end up on disk (e.g. inlined data: URLs) — skip it.
        }
      }
      const htmlPath = path.join(outDir, "index.html");
      let html: string;
      try { html = fs.readFileSync(htmlPath, "utf8"); }
      catch { return; }
      const updated = html.replace(
        /<(script|link)\b([^>]*?)(\/?)>/gi,
        (full: string, tag: string, attrs: string, selfClose: string) => {
          const ref = attrs.match(/\s(?:src|href)="([^"]+)"/);
          if (!ref) return full;
          const url = ref[1];
          if (/^(https?:)?\/\//.test(url)) return full;
          const clean = url.replace(/^\/+/, "");
          const digest = hashes.get(clean);
          if (!digest) return full;
          if (/\sintegrity=/.test(attrs)) return full;
          return `<${tag}${attrs} integrity="${digest}" crossorigin="anonymous"${selfClose}>`;
        },
      );
      if (updated !== html) fs.writeFileSync(htmlPath, updated);
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), sriPlugin()],
  // X-08 / S10.8: в production-бандле нет console.* и debugger (dev-сервер не трогаем)
  esbuild: command === "build" ? { drop: ["console", "debugger"] } : undefined,
  build: {
    // WEB-19: шрифты не встраиваем как data: — CSP разрешает только font-src 'self'
    assetsInlineLimit: (filePath: string) => (filePath.endsWith(".woff2") ? false : undefined),
  },
  // WEB-24: dev-сервер по умолчанию только на loopback; для теста с телефона в LAN —
  // VITE_DEV_HOST=0.0.0.0. Мёртвый alias на libsodium-wrappers (нет в зависимостях) удалён.
  server: {
    host: process.env.VITE_DEV_HOST || "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
      },
      "/relay": {
        target: proxyTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
}));
