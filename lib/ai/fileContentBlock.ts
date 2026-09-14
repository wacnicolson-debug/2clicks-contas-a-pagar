import Anthropic from "@anthropic-ai/sdk";

const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Monta o content block (PDF nativo ou imagem) pra mandar pra API da Anthropic. */
export function buildFileContentBlock(
  fileBase64: string,
  mimeType: string
): Anthropic.DocumentBlockParam | Anthropic.ImageBlockParam {
  if (mimeType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: fileBase64 },
    };
  }

  const imageType = SUPPORTED_IMAGE_TYPES.find((t) => t === mimeType);
  if (!imageType) {
    throw new Error(`Tipo de arquivo não suportado: ${mimeType}`);
  }

  return {
    type: "image",
    source: { type: "base64", media_type: imageType, data: fileBase64 },
  };
}
