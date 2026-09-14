import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { AdbScrcpyClient, AdbScrcpyOptions2_1 } from "@yume-chan/adb-scrcpy";
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
const canvas = document.getElementById("screen") as HTMLCanvasElement;

function setStatus(message: string, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function hideOverlaySoon() {
  // Depois de conectar, esconde o texto/botão pra não sujar a gravação da
  // live. Um toque na tela traz a barra de volta (por ex. pra desconectar).
  window.setTimeout(() => overlay.classList.add("hidden"), 1500);
}

document.body.addEventListener("click", () => {
  if (overlay.classList.contains("hidden")) {
    overlay.classList.remove("hidden");
    window.setTimeout(() => overlay.classList.add("hidden"), 4000);
  }
});

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
      setStatus(
        error instanceof Error ? error.message : "Falha ao conectar.",
        true,
      );
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
  const options = new AdbScrcpyOptions2_1({
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
  hideOverlaySoon();
}

main();
