import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// O site é publicado em griseustf.github.io/Cap.T.Frames/
// Por isso "base" precisa apontar pro nome do repositório.
export default defineConfig({
  base: "/Cap.T.Frames/",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "icon-192.png",
        "icon-512.png",
        "icon-512-maskable.png",
      ],
      manifest: {
        lang: "pt-BR",
        name: "Cap.T.Frames",
        short_name: "Cap.T.Frames",
        description:
          "Espelha a tela do tablet no celular via cabo USB-C, funciona sem internet.",
        start_url: ".",
        scope: ".",
        display: "fullscreen",
        background_color: "#050505",
        theme_color: "#050505",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // O servidor do scrcpy (server.bin) e o worker do decodificador de
        // vídeo também precisam ficar disponíveis offline.
        globPatterns: ["**/*.{js,css,html,bin,png,webmanifest}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  optimizeDeps: {
    // Exigido pelo pacote @yume-chan/fetch-scrcpy-server, ver:
    // https://github.com/vitejs/vite/issues/8427
    exclude: ["@yume-chan/fetch-scrcpy-server"],
  },
  build: {
    target: "es2022",
  },
});
