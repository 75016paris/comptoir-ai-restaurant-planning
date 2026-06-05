import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const buildVersion = createBuildVersion();

function createBuildVersion(): string {
  const commit = readGitCommit();
  return `${commit}-${Date.now()}`;
}

function readGitCommit(): string {
  try {
    return execSync("git rev-parse --short=12 HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "local";
  }
}

function versionFilePlugin(version: string): Plugin {
  return {
    name: "comptoir-version-file",
    configureServer(server) {
      server.middlewares.use("/version.json", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ version }) + "\n");
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ version }) + "\n",
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
  },
  plugins: [react(), tailwindcss(), versionFilePlugin(buildVersion)],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("react-router-dom") || id.includes("@remix-run")) return "vendor-router";
          if (id.includes("react-dom")) return "vendor-react-dom";
          if (id.includes("react")) return "vendor-react";
          if (id.includes("@tanstack")) return "vendor-query";
          if (id.includes("@base-ui") || id.includes("@radix-ui") || id.includes("lucide-react") || id.includes("@tabler")) return "vendor-ui";
          if (id.includes("i18next") || id.includes("date-fns") || id.includes("zod")) return "vendor-utils";
          return "vendor";
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
