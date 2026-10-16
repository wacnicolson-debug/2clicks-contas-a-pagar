"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "camera" | "uploading" | "error";
type FlashMode = "auto" | "on" | "off";

// Fotos tiradas com a câmera aberta: sobem em segundo plano, uma de cada vez não é preciso esperar.
type Shot = { id: number; status: "uploading" | "done" | "error"; documentId?: string; error?: string };

// ImageCapture (foto em resolução máxima + modo de flash) ainda não está nos tipos do TypeScript.
type PhotoCapabilities = { fillLightMode?: string[] };
type ImageCaptureLike = {
  getPhotoCapabilities(): Promise<PhotoCapabilities>;
  takePhoto(settings?: { fillLightMode?: string }): Promise<Blob>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

const FLASH_LABEL: Record<FlashMode, string> = { auto: "Automático", on: "Ligado", off: "Desligado" };
const STORAGE_KEY = "flash-mode";
// Abaixo disso (0 a 255, brilho médio da imagem) o modo automático acende a lanterna.
const DARK_THRESHOLD = 90;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default function CapturarPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<ImageCaptureLike | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  // lembra o modo escolhido (padrão: automático). O seletor só aparece com a câmera aberta, então não há diferença entre servidor e navegador.
  const [flashMode, setFlashMode] = useState<FlashMode>(() => {
    try {
      const saved = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
      return saved === "on" || saved === "off" ? saved : "auto";
    } catch {
      return "auto";
    }
  });
  const [fillLight, setFillLight] = useState<string[]>([]); // modos de flash que a câmera declara (fillLightMode)
  const [hasTorch, setHasTorch] = useState<boolean | null>(null); // lanterna controlável pelo navegador
  const [ready, setReady] = useState(false);
  const [cameraProblem, setCameraProblem] = useState<string | null>(null); // por que a câmera do app não abriu (a câmera do celular fica como opção)
  const [shooting, setShooting] = useState(false); // tirando a foto agora (lanterna + captura), antes de liberar o botão de novo
  const [shots, setShots] = useState<Shot[]>([]);
  const shotId = useRef(0);

  function chooseFlash(mode: FlashMode) {
    setFlashMode(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {}
  }

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    captureRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  async function upload(file: File) {
    stopCamera();
    setStatus("uploading");
    setError(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: formData,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setError(body.error ?? "Falha ao enviar a foto.");
        return;
      }
      router.push(`/documentos/${body.documentId}`);
    } catch {
      setStatus("error");
      setError("Falha ao enviar a foto.");
    }
  }

  async function sendInBackground(file: File) {
    const id = ++shotId.current;
    setShots((prev) => [...prev, { id, status: "uploading" }]);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch("/api/documents/upload", { method: "POST", body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setShots((prev) => prev.map((x) => (x.id === id ? { ...x, status: "error", error: body.error ?? "Falha ao enviar." } : x)));
        return;
      }
      setShots((prev) => prev.map((x) => (x.id === id ? { ...x, status: "done", documentId: body.documentId } : x)));
    } catch {
      setShots((prev) => prev.map((x) => (x.id === id ? { ...x, status: "error", error: "Falha ao enviar." } : x)));
    }
  }

  function finish() {
    stopCamera();
    const sent = shots.filter((x) => x.status === "done" && x.documentId);
    router.push(sent.length === 1 ? `/documentos/${sent[0].documentId}` : "/dashboard");
  }

  // Câmera do app: é a única forma de a página controlar o flash.
  async function openCamera() {
    setError(null);
    setReady(false);
    setCameraProblem(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraProblem("Este navegador não permite abrir a câmera dentro do app.");
      return;
    }
    let stream: MediaStream;
    try {
      // tenta a melhor qualidade; se o celular recusar as medidas, tenta só a câmera traseira
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
          audio: false,
        });
      } catch (first) {
        if ((first as DOMException)?.name === "NotAllowedError" || (first as DOMException)?.name === "SecurityError") throw first;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      }
    } catch (err) {
      stopCamera();
      const name = (err as DOMException)?.name ?? "erro";
      setCameraProblem(
        name === "NotAllowedError"
          ? "O celular negou o acesso à câmera para este app. Libere a câmera nas permissões do site (cadeado ao lado do endereço) e tente de novo."
          : `Não consegui abrir a câmera do app (${name}).`
      );
      return;
    }
    streamRef.current = stream;

    // O que for detectar sobre flash nunca pode derrubar a câmera: se algo falhar, segue sem controle de flash.
    try {
      const track = stream.getVideoTracks()[0];
      const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean };
      setHasTorch(caps.torch === true);
      const Ctor = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
      if (Ctor && track) {
        const ic = new Ctor(track);
        captureRef.current = ic;
        ic.getPhotoCapabilities()
          .then((c) => setFillLight(Array.isArray(c.fillLightMode) ? c.fillLightMode : []))
          .catch(() => setFillLight([]));
      } else {
        setFillLight([]);
      }
    } catch {
      setHasTorch(false);
      setFillLight([]);
    }
    setStatus("camera");
  }

  useEffect(() => {
    if (status === "camera" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().then(() => setReady(true)).catch(() => setReady(true));
    }
  }, [status]);

  function setTorch(on: boolean) {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return Promise.resolve();
    return track.applyConstraints({ advanced: [{ torch: on } as unknown as MediaTrackConstraintSet] }).catch(() => {});
  }

  // Brilho médio (0 a 255) do que a câmera está vendo agora.
  function sceneBrightness(): number | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0, 64, 48);
    const data = ctx.getImageData(0, 0, 64, 48).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return sum / (data.length / 4);
  }

  // Como o flash vai funcionar nesta foto, conforme o modo e o que o celular permite.
  function planFlash(): { fillLightMode?: string; torch: boolean } {
    if (flashMode === "off") return { fillLightMode: fillLight.includes("off") ? "off" : undefined, torch: false };
    if (flashMode === "on") {
      if (fillLight.includes("flash")) return { fillLightMode: "flash", torch: false };
      return { torch: hasTorch === true };
    }
    // automático
    if (fillLight.includes("auto")) return { fillLightMode: "auto", torch: false };
    if (hasTorch) {
      const b = sceneBrightness();
      return { torch: b !== null && b < DARK_THRESHOLD };
    }
    return { torch: false };
  }

  async function takePhoto() {
    if (shooting) return;
    setShooting(true);
    const plan = planFlash();
    let torchOn = false;
    try {
      if (plan.torch) {
        await setTorch(true);
        torchOn = true;
        await sleep(600); // dá tempo da câmera ajustar a exposição com a luz
      }
      let blob: Blob | null = null;
      const ic = captureRef.current;
      if (ic) {
        try {
          blob = await ic.takePhoto(plan.fillLightMode ? { fillLightMode: plan.fillLightMode } : undefined);
        } catch {
          blob = null;
        }
      }
      if (!blob && videoRef.current) {
        // sem ImageCapture: tira um quadro do vídeo
        const v = videoRef.current;
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext("2d")?.drawImage(v, 0, 0);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      }
      if (!blob) throw new Error("sem imagem");
      if (torchOn) await setTorch(false);
      torchOn = false;
      // a câmera continua aberta: a foto sobe em segundo plano e dá pra tirar a próxima
      void sendInBackground(new File([blob], `nota-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" }));
    } catch {
      if (torchOn) await setTorch(false);
      setShots((prev) => [...prev, { id: ++shotId.current, status: "error", error: "Não consegui tirar a foto. Tente de novo." }]);
    } finally {
      setShooting(false);
    }
  }

  function handleFileSelected(file: File | undefined) {
    if (file) void upload(file);
  }

  function handleRetry() {
    setStatus("idle");
    setError(null);
    void openCamera();
  }

  const canControlFlash = hasTorch === true || fillLight.length > 0;
  const flashInfo = !ready
    ? "Preparando a câmera…"
    : !canControlFlash
      ? "Este celular não deixa o app controlar o flash. Use a câmera do celular abaixo."
      : flashMode === "off"
        ? "Flash desligado"
        : flashMode === "on"
          ? "Flash ligado na foto"
          : fillLight.includes("auto")
            ? "Flash automático"
            : "Flash automático: acende a lanterna só se estiver escuro";

  return (
    <div className="min-h-screen bg-neutral-50 flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center">
        <h1 className="text-lg font-semibold mb-1">Tirar foto da nota</h1>
        <p className="text-sm text-neutral-500 mb-6">
          A foto sobe e é lançada sozinha, na data de vencimento.
        </p>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={status === "uploading"}
          onChange={(e) => handleFileSelected(e.target.files?.[0])}
        />

        {status === "camera" ? (
          <>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full rounded-md bg-black mb-3 aspect-[3/4] object-cover"
            />

            <div className="flex rounded-md border border-neutral-300 overflow-hidden mb-2" role="group" aria-label="Flash">
              {(["auto", "on", "off"] as FlashMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => chooseFlash(m)}
                  className={`flex-1 py-2 text-sm ${flashMode === m ? "bg-emerald-700 text-white" : "bg-white text-neutral-700"}`}
                >
                  {m === "auto" ? "⚡ " : ""}
                  {FLASH_LABEL[m]}
                </button>
              ))}
            </div>
            <p className="text-xs text-neutral-500 mb-3">{flashInfo}</p>

            <button
              type="button"
              onClick={takePhoto}
              disabled={shooting || !ready}
              className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium disabled:opacity-60"
            >
              {shooting ? "Tirando…" : "Tirar foto"}
            </button>

            {shots.length > 0 && (
              <ul className="mt-3 space-y-1 text-left">
                {shots.slice(-5).map((x) => (
                  <li key={x.id} className="flex items-center justify-between text-sm border border-neutral-100 rounded-md px-3 py-1.5 bg-white">
                    <span>Foto {x.id}</span>
                    <span className={x.status === "error" ? "text-red-600" : x.status === "done" ? "text-emerald-700" : "text-neutral-500"}>
                      {x.status === "uploading" ? "Enviando…" : x.status === "done" ? "Enviada ✓" : x.error}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {shots.some((x) => x.status === "done") && (
              <button
                type="button"
                onClick={finish}
                disabled={shots.some((x) => x.status === "uploading")}
                className="w-full mt-3 border border-emerald-700 text-emerald-700 rounded-md py-3 text-sm font-medium disabled:opacity-50"
              >
                {shots.some((x) => x.status === "uploading") ? "Enviando…" : `Concluir (${shots.filter((x) => x.status === "done").length} enviada${shots.filter((x) => x.status === "done").length > 1 ? "s" : ""})`}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setStatus("idle");
                inputRef.current?.click();
              }}
              className="w-full mt-2 text-sm text-emerald-700 underline py-2"
            >
              Usar a câmera do celular
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setStatus("idle");
                setShots([]);
              }}
              className="w-full text-sm text-neutral-500 py-2"
            >
              Cancelar
            </button>
          </>
        ) : status === "error" ? (
          <>
            <p className="text-sm text-red-600 mb-4">{error}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium"
            >
              Tentar de novo
            </button>
          </>
        ) : (
          <>
            {cameraProblem && <p className="text-sm text-amber-700 mb-4">{cameraProblem}</p>}
            <button
              type="button"
              disabled={status === "uploading"}
              onClick={openCamera}
              className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium disabled:opacity-50"
            >
              {status === "uploading" ? "Enviando..." : "Abrir câmera"}
            </button>
            {status !== "uploading" && (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="w-full mt-2 text-sm text-emerald-700 underline py-2"
              >
                Usar a câmera do celular
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
