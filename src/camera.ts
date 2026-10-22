// ---------------------------------------------------------------------------
// Câmera: lista as câmeras do aparelho (traseira, frontal, webcam externa),
// mostra a escolhida numa janelinha por cima da tela espelhada e, na
// gravação, junta tela + câmera (+ microfone, se ligado) num vídeo só.
// ---------------------------------------------------------------------------

export interface CameraApi {
  isCameraOn(): boolean;
  micTracks(): MediaStreamTrack[];
  createComposite(): { stream: MediaStream; dispose: () => void };
}

interface Options {
  canvas: HTMLCanvasElement;
  fps: number;
  setStatus: (message: string, isError?: boolean) => void;
  onInteract: () => void;
  onPanelToggle: (open: boolean) => void;
}

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

function friendlyLabel(device: MediaDeviceInfo, index: number) {
  const raw = device.label || `Câmera ${index + 1}`;
  return raw.replace(/facing back/i, "traseira").replace(/facing front/i, "frontal");
}

export function initCamera(opts: Options): CameraApi {
  const { canvas, fps, setStatus } = opts;

  const cameraBtn = $<HTMLButtonElement>("camera-btn");
  const panel = $<HTMLDivElement>("camera-panel");
  const select = $<HTMLSelectElement>("camera-select");
  const micCheck = $<HTMLInputElement>("mic-check");
  const pipVideo = $<HTMLVideoElement>("pip-video");

  let cameraStream: MediaStream | null = null;
  let micStream: MediaStream | null = null;
  // Centro do círculo, em fração da área da imagem (null = canto inferior
  // direito, até a pessoa arrastar).
  let center: { fx: number; fy: number } | null = null;
  let sizeFraction = 0.24;
  let permissionGranted = false;
  let layoutRaf = 0;

  // --- geometria compartilhada entre a janelinha na tela e a gravação ------

  // Área que a imagem espelhada ocupa na tela (o canvas usa "contain").
  function stageRect() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch) return { x: 0, y: 0, w: vw, h: vh };
    const s = Math.min(vw / cw, vh / ch);
    const w = cw * s;
    const h = ch * s;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  const clamp = (v: number, min: number, max: number) =>
    Math.min(Math.max(v, min), max);

  // Círculo da câmera dentro de um quadro de frameW x frameH. A mesma conta
  // vale pra tela e pra gravação, então o que se vê é o que sai no arquivo.
  function pipGeometry(frameW: number, frameH: number) {
    const base = Math.min(frameW, frameH);
    const d = base * sizeFraction;
    const r = d / 2;
    const margin = base * 0.03;
    const cx = clamp(center ? center.fx * frameW : frameW - margin - r, r, frameW - r);
    const cy = clamp(center ? center.fy * frameH : frameH - margin - r, r, frameH - r);
    return { cx, cy, d };
  }

  function layoutPip() {
    const r = stageRect();
    const g = pipGeometry(r.w, r.h);
    pipVideo.style.left = `${r.x + g.cx - g.d / 2}px`;
    pipVideo.style.top = `${r.y + g.cy - g.d / 2}px`;
    pipVideo.style.width = `${g.d}px`;
    pipVideo.style.height = `${g.d}px`;
  }

  function layoutLoop() {
    layoutPip();
    layoutRaf = requestAnimationFrame(layoutLoop);
  }

  // --- câmera ---------------------------------------------------------------

  function stopCamera() {
    cancelAnimationFrame(layoutRaf);
    cameraStream?.getTracks().forEach((t) => t.stop());
    cameraStream = null;
    pipVideo.srcObject = null;
    pipVideo.classList.remove("on");
  }

  async function startCamera(deviceId: string) {
    stopCamera();
    if (!deviceId) return;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: deviceId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      pipVideo.srcObject = cameraStream;
      pipVideo.classList.add("on");
      await pipVideo.play().catch(() => {});
      layoutLoop();
    } catch (error) {
      console.error(error);
      stopCamera();
      select.value = "";
      setStatus(
        `Não consegui abrir essa câmera: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  }

  async function ensurePermission() {
    if (permissionGranted) return;
    // Sem permissão o navegador não informa o nome das câmeras.
    const temp = await navigator.mediaDevices.getUserMedia({ video: true });
    temp.getTracks().forEach((t) => t.stop());
    permissionGranted = true;
  }

  async function refreshDevices() {
    const keep = select.value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "videoinput",
    );
    select.innerHTML = "";
    select.add(new Option("Sem câmera", ""));
    devices.forEach((d, i) => select.add(new Option(friendlyLabel(d, i), d.deviceId)));
    select.value = devices.some((d) => d.deviceId === keep) ? keep : "";
  }

  function setPanelOpen(open: boolean) {
    panel.hidden = !open;
    cameraBtn.classList.toggle("active", open);
    opts.onPanelToggle(open);
  }

  cameraBtn.addEventListener("click", async () => {
    const open = panel.hidden;
    setPanelOpen(open);
    if (!open) return;
    try {
      await ensurePermission();
      await refreshDevices();
    } catch (error) {
      console.error(error);
      setStatus(
        `Não consegui acessar as câmeras (permissão negada?): ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
  });

  select.addEventListener("change", () => {
    opts.onInteract();
    void startCamera(select.value);
  });

  navigator.mediaDevices?.addEventListener("devicechange", () => {
    if (permissionGranted) void refreshDevices();
  });

  // --- arrastar o círculo ------------------------------------------------------

  let drag: { dx: number; dy: number } | null = null;

  pipVideo.addEventListener("pointerdown", (event) => {
    const r = stageRect();
    const g = pipGeometry(r.w, r.h);
    drag = { dx: event.clientX - (r.x + g.cx), dy: event.clientY - (r.y + g.cy) };
    pipVideo.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  pipVideo.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const r = stageRect();
    const half = pipGeometry(r.w, r.h).d / 2;
    const cx = clamp(event.clientX - drag.dx - r.x, half, r.w - half);
    const cy = clamp(event.clientY - drag.dy - r.y, half, r.h - half);
    center = { fx: cx / r.w, fy: cy / r.h };
    layoutPip();
  });

  const endDrag = (event: PointerEvent) => {
    drag = null;
    try {
      pipVideo.releasePointerCapture(event.pointerId);
    } catch {
      /* já solto */
    }
  };
  pipVideo.addEventListener("pointerup", endDrag);
  pipVideo.addEventListener("pointercancel", endDrag);
  // Tocar ou arrastar o círculo não deve abrir o menu.
  pipVideo.addEventListener("click", (event) => event.stopPropagation());

  // --- tamanho do círculo ----------------------------------------------------------

  const sizeBtns = panel.querySelectorAll<HTMLButtonElement>("[data-size]");

  function markActive() {
    sizeBtns.forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.size) === sizeFraction),
    );
  }

  sizeBtns.forEach((b) =>
    b.addEventListener("click", () => {
      sizeFraction = Number(b.dataset.size);
      markActive();
      layoutPip();
      opts.onInteract();
    }),
  );
  markActive();

  // --- microfone ---------------------------------------------------------------

  micCheck.addEventListener("change", async () => {
    opts.onInteract();
    if (micCheck.checked) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (error) {
        console.error(error);
        micCheck.checked = false;
        setStatus(
          `Não consegui acessar o microfone: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    } else {
      micStream?.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  });

  // --- composição pra gravação ---------------------------------------------------

  function createComposite() {
    // A tela espelhada entra por um <video> alimentado pela captura do canvas
    // (o mesmo caminho da gravação simples, que já funciona).
    const mirrorStream = canvas.captureStream(fps);
    const mirrorVideo = document.createElement("video");
    mirrorVideo.muted = true;
    mirrorVideo.playsInline = true;
    mirrorVideo.srcObject = mirrorStream;
    mirrorVideo.style.cssText =
      "position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(mirrorVideo);
    void mirrorVideo.play().catch(() => {});

    // Tamanho fixo escolhido no início, com a mesma proporção da tela
    // espelhada. Se o Tab girar durante a gravação, a imagem encolhe pra caber.
    const LONG_SIDE = 1920;
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const aspect = canvas.width && canvas.height ? canvas.width / canvas.height : 16 / 9;
    const width = even(aspect >= 1 ? LONG_SIDE : LONG_SIDE * aspect);
    const height = even(aspect >= 1 ? LONG_SIDE / aspect : LONG_SIDE);

    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d")!;

    let stopped = false;
    let raf = 0;
    let last = 0;
    const interval = 1000 / fps;

    const draw = (now: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(draw);
      if (now - last < interval - 2) return;
      last = now;

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      const mw = mirrorVideo.videoWidth;
      const mh = mirrorVideo.videoHeight;
      if (mw && mh) {
        const s = Math.min(width / mw, height / mh);
        const dw = mw * s;
        const dh = mh * s;
        ctx.drawImage(mirrorVideo, (width - dw) / 2, (height - dh) / 2, dw, dh);
      }

      const cw = pipVideo.videoWidth;
      const ch = pipVideo.videoHeight;
      if (cameraStream && cw && ch && pipVideo.readyState >= 2) {
        const g = pipGeometry(width, height);
        const side = Math.min(cw, ch); // recorte quadrado central, como "cover"
        ctx.save();
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.d / 2, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(
          pipVideo,
          (cw - side) / 2,
          (ch - side) / 2,
          side,
          side,
          g.cx - g.d / 2,
          g.cy - g.d / 2,
          g.d,
          g.d,
        );
        ctx.restore();
        ctx.beginPath();
        ctx.arc(g.cx, g.cy, g.d / 2, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, g.d * 0.008);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);

    const stream = out.captureStream(fps);

    return {
      stream,
      dispose() {
        stopped = true;
        cancelAnimationFrame(raf);
        stream.getVideoTracks().forEach((t) => t.stop()); // não para o microfone
        mirrorStream.getTracks().forEach((t) => t.stop());
        mirrorVideo.srcObject = null;
        mirrorVideo.remove();
      },
    };
  }

  return {
    isCameraOn: () => cameraStream !== null,
    micTracks: () => micStream?.getAudioTracks().filter((t) => t.readyState === "live") ?? [],
    createComposite,
  };
}
