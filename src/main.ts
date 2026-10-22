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
import { initCamera } from "./camera";

// ---------------------------------------------------------------------------
// Trava de tela ligada: como o Note só fica exibindo a imagem (sem nenhum
// toque), o Android apaga a tela sozinho por inatividade. Isso mantém a
// tela acesa enquanto a transmissão estiver ativa.
// ---------------------------------------------------------------------------
let wakeLock: WakeLockSentinel | null = null;
let isConnected = false;

async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (error) {
    console.error("Não consegui travar a tela ligada:", error);
  }
}

async function releaseWakeLock() {
  try {
    await wakeLock?.release();
  } catch {
    /* já liberado */
  }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && isConnected && !wakeLock) {
    requestWakeLock();
  }
});

// ---------------------------------------------------------------------------
// Ajustes de vídeo. 1080p/24fps (atualizado a pedido do Érick, era 720p
// antes). "maxSize" limita o maior lado da imagem (largura, já que o Tab
// fica deitado). Reajuste esses três valores conforme os testes reais.
// ---------------------------------------------------------------------------
const VIDEO_MAX_SIZE = 1920;
const VIDEO_BIT_RATE = 9_000_000; // 9 Mbps
const VIDEO_MAX_FPS = 24;
// Gravação local no aparelho que está exibindo (Note/Chromebook).
const RECORD_BIT_RATE = 8_000_000; // 8 Mbps

const overlay = document.getElementById("overlay") as HTMLDivElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const fullscreenBtn = document.getElementById(
  "fullscreen-btn",
) as HTMLButtonElement;
const reopenBtn = document.getElementById(
  "reopen-overlay-btn",
) as HTMLButtonElement;
const recordBtn = document.getElementById("record-btn") as HTMLButtonElement;
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
let cameraPanelOpen = false;

function hideOverlay() {
  overlay.classList.add("hidden");
  reopenBtn.classList.add("visible");
}

function showOverlayTemporarily() {
  overlay.classList.remove("hidden");
  reopenBtn.classList.remove("visible");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(hideOverlay, cameraPanelOpen ? 15000 : 4000);
}

function hideOverlaySoon() {
  // Depois de conectar, esconde o texto/botão pra não sujar a gravação da
  // live. O botão discreto no canto (ou um toque na tela) traz de volta.
  window.setTimeout(() => {
    if (!cameraPanelOpen) hideOverlay();
  }, 1500);
}

document.body.addEventListener("click", (event) => {
  if (event.target === reopenBtn) return; // já tem o próprio handler
  if (overlay.classList.contains("hidden")) showOverlayTemporarily();
});

reopenBtn.addEventListener("click", showOverlayTemporarily);

// Tocar no fundo escuro do menu fecha ele (assim dá pra arrastar o círculo da câmera).
overlay.addEventListener("click", (event) => {
  if (event.target === overlay && isConnected) {
    event.stopPropagation();
    window.clearTimeout(hideTimer);
    hideOverlay();
  }
});

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

// ---------------------------------------------------------------------------
// Gravação local: grava o que aparece no canvas e salva no aparelho que está
// exibindo. Os pedaços vão sendo escritos em disco (armazenamento privado do
// navegador) conforme chegam, pra não encher a memória em gravações longas.
// Ao parar, o arquivo é baixado pra pasta Downloads. Não grava áudio.
// ---------------------------------------------------------------------------
let recorder: MediaRecorder | null = null;
let recordingTimer = 0;
let recordingStartedAt = 0;

function pickRecordingFormat(
  hasAudio: boolean,
): { mimeType: string; ext: string } | null {
  const candidates = hasAudio
    ? [
        { mimeType: "video/mp4;codecs=avc1,mp4a.40.2", ext: "mp4" },
        { mimeType: "video/mp4", ext: "mp4" },
        { mimeType: "video/webm;codecs=vp9,opus", ext: "webm" },
        { mimeType: "video/webm;codecs=vp8,opus", ext: "webm" },
        { mimeType: "video/webm", ext: "webm" },
      ]
    : [
        { mimeType: "video/mp4;codecs=avc1", ext: "mp4" },
        { mimeType: "video/mp4", ext: "mp4" },
        { mimeType: "video/webm;codecs=vp9", ext: "webm" },
        { mimeType: "video/webm;codecs=vp8", ext: "webm" },
        { mimeType: "video/webm", ext: "webm" },
      ];
  if (typeof MediaRecorder === "undefined") return null;
  return candidates.find((c) => MediaRecorder.isTypeSupported(c.mimeType)) ?? null;
}

function formatElapsed(ms: number) {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function updateRecordButton() {
  if (recorder) {
    recordBtn.textContent = `Parar gravação (${formatElapsed(Date.now() - recordingStartedAt)})`;
    recordBtn.classList.add("recording");
    reopenBtn.classList.add("recording");
  } else {
    recordBtn.textContent = "Gravar";
    recordBtn.classList.remove("recording");
    reopenBtn.classList.remove("recording");
  }
}

function timestampForFileName() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
}

const camera = initCamera({
  canvas,
  fps: VIDEO_MAX_FPS,
  setStatus,
  onInteract: () => {
    if (isConnected) showOverlayTemporarily();
  },
  onPanelToggle: (open) => {
    cameraPanelOpen = open;
    if (isConnected) showOverlayTemporarily();
  },
});

async function startRecording() {
  if (recorder || !isConnected) return;

  const micTracks = camera.micTracks();
  const format = pickRecordingFormat(micTracks.length > 0);
  if (!format) {
    setStatus("Esse navegador não consegue gravar vídeo.", true);
    showOverlayTemporarily();
    return;
  }

  const fileName = `cap-t-frames-${timestampForFileName()}.${format.ext}`;

  // Tenta escrever direto em disco (armazenamento privado do navegador).
  // Se não der, cai pra memória (serve pra gravações curtas).
  let handle: FileSystemFileHandle | null = null;
  let writable: FileSystemWritableFileStream | null = null;
  try {
    const root = await navigator.storage.getDirectory();
    handle = await root.getFileHandle(fileName, { create: true });
    writable = await handle.createWritable();
  } catch (error) {
    console.warn("Gravando em memória (sem armazenamento em disco):", error);
    handle = null;
    writable = null;
  }

  const memoryChunks: Blob[] = [];
  let writeQueue: Promise<void> = Promise.resolve();

  // Com a câmera ligada, grava tela + câmera juntas; senão, só a tela.
  const composite = camera.isCameraOn() ? camera.createComposite() : null;
  const stream = composite ? composite.stream : canvas.captureStream(VIDEO_MAX_FPS);
  micTracks.forEach((track) => stream.addTrack(track));
  const rec = new MediaRecorder(stream, {
    mimeType: format.mimeType,
    videoBitsPerSecond: RECORD_BIT_RATE,
    ...(micTracks.length > 0 ? { audioBitsPerSecond: 128_000 } : {}),
  });

  rec.addEventListener("dataavailable", (event) => {
    if (event.data.size === 0) return;
    if (writable) {
      const w = writable;
      writeQueue = writeQueue
        .then(() => w.write(event.data))
        .catch((error) => console.error("Erro ao gravar em disco:", error));
    } else {
      memoryChunks.push(event.data);
    }
  });

  rec.addEventListener("stop", async () => {
    window.clearInterval(recordingTimer);
    composite?.dispose();
    recorder = null;
    updateRecordButton();
    try {
      await writeQueue;
      let blob: Blob;
      if (writable && handle) {
        await writable.close();
        blob = await handle.getFile();
      } else {
        blob = new Blob(memoryChunks, { type: format.mimeType });
      }
      downloadBlob(blob, fileName);
      setStatus(`Gravação salva em Downloads: ${fileName}`);
    } catch (error) {
      console.error(error);
      setStatus(describeError(error), true);
    }
    showOverlayTemporarily();
  });

  rec.start(1000); // entrega um pedaço por segundo
  recorder = rec;
  recordingStartedAt = Date.now();
  updateRecordButton();
  recordingTimer = window.setInterval(updateRecordButton, 1000);
  setStatus(
    composite
      ? "Gravando tela + câmera."
      : "Gravando. Não gire o Tab durante a gravação.",
  );
}

function stopRecording() {
  if (recorder && recorder.state !== "inactive") recorder.stop();
}

recordBtn.addEventListener("click", () => {
  if (recorder) stopRecording();
  else void startRecording();
});

// Remove sobras de gravações antigas do armazenamento privado do navegador
// (os arquivos que importam já foram pra pasta Downloads).
async function cleanOldRecordings() {
  try {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith("cap-t-frames-")) {
        await root.removeEntry(name).catch(() => {});
      }
    }
  } catch {
    /* sem suporte, ignorar */
  }
}
void cleanOldRecordings();

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
    isConnected = false;
    stopRecording();
    recordBtn.disabled = true;
    void releaseWakeLock();
    setStatus("A conexão caiu. Recarregue a página e conecte de novo.", true);
    overlay.classList.remove("hidden");
  });

  setStatus("Conectado. Transmitindo a tela do Tab.");
  isConnected = true;
  recordBtn.disabled = false;
  await requestWakeLock();
  try {
    await document.documentElement.requestFullscreen();
  } catch (error) {
    console.error("Tela cheia automática não permitida:", error);
  }
  hideOverlaySoon();
}

main();
