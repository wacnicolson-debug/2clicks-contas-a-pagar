/**
 * Arquivos colados com Ctrl+V: PDFs e imagens copiados no Explorador (Ctrl+C no
 * arquivo) ou prints da área de transferência. Devolve [] quando o que foi
 * colado não é arquivo (texto etc.), pra página deixar o colar normal em paz.
 */
export function filesFromClipboard(e: ClipboardEvent): File[] {
  const data = e.clipboardData;
  if (!data) return [];

  let files = Array.from(data.files ?? []);
  if (files.length === 0) {
    files = Array.from(data.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  }

  return files
    .filter((file) => file.type === "application/pdf" || file.type.startsWith("image/") || /\.pdf$/i.test(file.name))
    .map((file, i) => {
      // Print colado vem com nome genérico ("image.png") — dá um nome com
      // timestamp pra distinguir vários prints na lista. Arquivo copiado do
      // Explorador mantém o nome dele.
      if (/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name) || !file.name) {
        const ext = file.type.split("/")[1] ?? "png";
        return new File([file], `print-${Date.now()}-${i}.${ext}`, { type: file.type });
      }
      return file.type ? file : new File([file], file.name, { type: "application/pdf" });
    });
}
