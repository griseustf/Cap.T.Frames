import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import {
  AdbScrcpyClient,
  AdbScrcpyExitedError,
  AdbScrcpyOptionsLatest,
} from "@yume-chan/adb-scrcpy";
import { DefaultServerPath } from "@yume-chan/scrcpy";
import {
  BitmapVideoFrameRenderer,
  WebCodecsVideoDecoder,
  WebGLVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { BIN as SERVER_BIN } from "@yume-chan/fetch-scrcpy-server";

import "./style.css";

// ---------------------------------------------------------------------------
// Ajustes de vídeo. 1080p/24fps (atualizado a pedido do Érick, era 720p
// antes). "maxSize" limita o maior lado da imagem (largura, já que o Tab
// fica deitado). Reajuste esses três valores conforme os testes reais.
// ---------------------------------------------------------------------------
const VIDEO_MAX_SIZE = 1920;
const VIDEO_BIT_RATE = 9_000_000; // 9 Mbps
const VIDEO_MAX_FPS = 24;

const overlay = document.getElementById("overlay") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;
const reopenBtn = document.getElementById(
  "reopen-overlay-btn",
) as HTMLButtonElement;
const canvas = document.getElementById("screen") as HTMLCanvasElement;

let currentStep = "";

function setStatus(message: string, isError = false) {
  if (!isError) currentStep = message;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Erro";
  const message = error instanceof Error ? error.message : String(error);
  const stack =
    error instanceof Error && error.stack
      ? error.stack.split("\n").slice(0, 4).join(" | ")
      : "";
  const serverOutput =
    error instanceof AdbScrcpyExitedError && error.output.length > 0
      ? `\nSaída do servidor no Tab:\n${error.output.join("\n")}`
      : "";
  return `Travou em: "${currentStep}"\n${name}: ${message}${stack ? `\n${stack}` : ""}${serverOutput}`;
}

let hideTimer = 0;

function hideOverlay() {
  overlay.classList.add("hidden");
  reopenBtn.classList.add("visible");
}

function showOverlayTemporarily() {
  overlay.classList.remove("hidden");
  reopenBtn.classList.remove("visible");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideOverlay, 4000);
}

function hideOverlaySoon() {
  // Depois de conectar, esconde o texto/botão pra não sujar a gravação da
  // live. O botão discreto no canto (ou um toque na tela) traz de volta.
  window.setTimeout(hideOverlay, 1500);
}

document.body.addEventListener("click", (event) => {
  if (event.target === reopenBtn) return; // já tem o próprio handler
  if (overlay.classList.contains("hidden")) showOverlayTemporarily();
});

reopenBtn.addEventListener("click", showOverlayTemporarily);

function isFullscreen() {
  return document.fullscreenElement !== null;
}

function updateFullscreenLabel() {
  fullscreenBtn.textContent = isFullscreen()
    ? "Sair da tela cheia"
    : "Tela cheia";
}

fullscreenBtn.addEventListener("click", async () => {
  try {
    if (isFullscreen()) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    console.error("Não consegui alternar tela cheia:", error);
  }
});

document.addEventListener("fullscreenchange", updateFullscreenLabel);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((error) => console.error("Falha ao registrar service worker:", error));
  });
}

async function main() {
  if (!("VideoDecoder" in globalThis)) {
    setStatus(
      "Esse navegador não suporta WebCodecs. Abra essa página no Chrome.",
      true,
    );
    connectBtn.disabled = true;
    return;
  }

  const Manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!Manager) {
    setStatus(
      "WebUSB não disponível. Confirme que está no Chrome e que a página está em HTTPS.",
      true,
    );
    connectBtn.disabled = true;
    return;
  }

  connectBtn.addEventListener("click", async () => {
    connectBtn.disabled = true;
    try {
      await connectAndStream(Manager);
    } catch (error) {
      console.error(error);
      setStatus(describeError(error), true);
      connectBtn.disabled = false;
    }
  });
}

async function connectAndStream(Manager: AdbDaemonWebUsbDeviceManager) {
  setStatus("Escolha o Tab na lista que vai aparecer...");
  const device = await Manager.requestDevice();
  if (!device) {
    setStatus("Nenhum aparelho selecionado.", true);
    connectBtn.disabled = false;
    return;
  }

  setStatus("Conectando na interface USB...");
  const connection = await device.connect();

  setStatus("Autenticando (autorize no Tab se pedir)...");
  const credentialStore = new AdbWebCredentialStore("Cap.T.Frames");
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  const adb = new Adb(transport);

  setStatus("Baixando o servidor do scrcpy...");
  const serverBuffer = await fetch(SERVER_BIN).then((res) => res.arrayBuffer());

  setStatus("Enviando o servidor pro Tab...");
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(serverBuffer));
        controller.close();
      },
    }),
  );

  setStatus("Iniciando a captura de tela no Tab...");
  const options = new AdbScrcpyOptionsLatest({
    video: true,
    audio: false,
    control: false,
    maxSize: VIDEO_MAX_SIZE,
    videoBitRate: VIDEO_BIT_RATE,
    maxFps: VIDEO_MAX_FPS,
  });

  const client = await AdbScrcpyClient.start(
    adb,
    DefaultServerPath,
    options,
  );

  // Não podemos deixar nenhum stream do ADB sem leitura (ver aviso da
  // documentação do Tango), então sempre consumimos a saída do servidor.
  void client.output
    .pipeTo(
      new WritableStream({
        write(chunk) {
          console.log("[scrcpy-server]", chunk);
        },
      }),
    )
    .catch(() => {
      /* servidor encerrado, ignorar */
    });

  if (!client.videoStream) {
    throw new Error("O servidor não retornou vídeo.");
  }

  const { metadata, stream: videoPacketStream } = await client.videoStream;

  const renderer = WebGLVideoFrameRenderer.isSupported
    ? new WebGLVideoFrameRenderer(canvas)
    : new BitmapVideoFrameRenderer(canvas);

  const decoder = new WebCodecsVideoDecoder({
    codec: metadata.codec,
    renderer,
  });

  void videoPacketStream.pipeTo(decoder.writable).catch((error) => {
    console.error("Stream de vídeo encerrado:", error);
    setStatus("A conexão caiu. Recarregue a página e conecte de novo.", true);
    overlay.classList.remove("hidden");
  });

  setStatus("Conectado. Transmitindo a tela do Tab.");
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error("Tela cheia automática não permitida:", error);
  }
  hideOverlaySoon();
}

main();
