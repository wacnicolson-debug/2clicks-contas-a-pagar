"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Status = "idle" | "camera" | "uploading" | "error";

// ImageCapture (foto em resolução máxima + modo de flash) ainda não está nos tipos do TypeScript.
type PhotoCapabilities = { fillLightMode?: string[] };
type ImageCaptureLike = {
  getPhotoCapabilities(): Promise<PhotoCapabilities>;
  takePhoto(settings?: { fillLightMode?: string }): Promise<Blob>;
};
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike;

export default function CapturarPage() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const captureRef = useRef<ImageCaptureLike | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [flashAuto, setFlashAuto] = useState<boolean | null>(null); // null = ainda não sabe

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

  // Câmera do app: é a única forma de a página pedir o flash em modo AUTOMÁTICO
  // (a câmera do sistema usa a configuração dela e a página não controla).
  async function openCamera() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        audio: false,
      });
      streamRef.current = stream;
      const Ctor = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture;
      const track = stream.getVideoTracks()[0];
      if (Ctor && track) {
        const ic = new Ctor(track);
        captureRef.current = ic;
        ic.getPhotoCapabilities()
          .then((caps) => setFlashAuto(Array.isArray(caps.fillLightMode) && caps.fillLightMode.includes("auto")))
          .catch(() => setFlashAuto(false));
      } else {
        setFlashAuto(false);
      }
      setStatus("camera");
    } catch {
      // sem permissão ou sem câmera no navegador: cai na câmera do sistema
      stopCamera();
      inputRef.current?.click();
    }
  }

  useEffect(() => {
    if (status === "camera" && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.play().catch(() => {});
    }
  }, [status]);

  async function takePhoto() {
    try {
      let blob: Blob | null = null;
      const ic = captureRef.current;
      if (ic) {
        try {
          blob = await ic.takePhoto(flashAuto ? { fillLightMode: "auto" } : undefined);
        } catch {
          blob = null;
        }
      }
      if (!blob && videoRef.current) {
        // sem ImageCapture: tira um quadro do vídeo (sem flash)
        const v = videoRef.current;
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        canvas.getContext("2d")?.drawImage(v, 0, 0);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      }
      if (!blob) throw new Error("sem imagem");
      await upload(new File([blob], `nota-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" }));
    } catch {
      setStatus("error");
      setError("Não consegui tirar a foto. Tente de novo.");
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
            <p className="text-xs text-neutral-500 mb-3">
              {flashAuto === null
                ? "Preparando a câmera…"
                : flashAuto
                  ? "Flash: automático"
                  : "Flash automático indisponível neste celular"}
            </p>
            <button
              type="button"
              onClick={takePhoto}
              className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium"
            >
              Tirar foto
            </button>
            <button
              type="button"
              onClick={() => {
                stopCamera();
                setStatus("idle");
              }}
              className="w-full mt-2 text-sm text-neutral-500 py-2"
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
          <button
            type="button"
            disabled={status === "uploading"}
            onClick={openCamera}
            className="w-full bg-emerald-700 text-white rounded-md py-4 text-base font-medium disabled:opacity-50"
          >
            {status === "uploading" ? "Enviando..." : "Abrir câmera"}
          </button>
        )}
      </div>
    </div>
  );
}
