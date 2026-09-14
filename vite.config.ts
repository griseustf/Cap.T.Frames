import { defineConfig } from "vite";

// O site é publicado em griseustf.github.io/Cap.T.Frames/
// Por isso "base" precisa apontar pro nome do repositório.
export default defineConfig({
  base: "/Cap.T.Frames/",
  optimizeDeps: {
    // Exigido pelo pacote @yume-chan/fetch-scrcpy-server, ver:
    // https://github.com/vitejs/vite/issues/8427
    exclude: ["@yume-chan/fetch-scrcpy-server"],
  },
  build: {
    target: "es2022",
  },
});
