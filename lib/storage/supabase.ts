import { createClient } from "@supabase/supabase-js";

const BUCKET = "documentos";

function getClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados (.env)"
    );
  }
  return createClient(url, key);
}

export async function uploadDocumentFile(params: {
  storagePath: string;
  fileBuffer: Buffer;
  mimeType: string;
}): Promise<void> {
  const supabase = getClient();
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(params.storagePath, params.fileBuffer, {
      contentType: params.mimeType,
      upsert: false,
    });
  if (error) throw error;
}

export async function downloadDocumentFile(storagePath: string): Promise<Buffer> {
  const supabase = getClient();
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath);
  if (error) throw error;
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
