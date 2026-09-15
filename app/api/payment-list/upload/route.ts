import { NextRequest, NextResponse } from "next/server";
import { randomUUID, createHash } from "crypto";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { uploadDocumentFile } from "@/lib/storage/supabase";
import { inngest } from "@/lib/inngest/client";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Nenhum arquivo enviado." }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const contentHash = createHash("sha256").update(buffer).digest("hex");

  // Mesmo arquivo já enviado antes por essa empresa e ainda não deu erro —
  // provável duplo envio: recusa antes de gastar IA e lançar os mesmos
  // pagamentos duas vezes.
  const duplicate = await prisma.document.findFirst({
    where: { companyId: session.companyId, contentHash, status: { not: "ERROR" } },
  });
  if (duplicate) {
    return NextResponse.json(
      {
        error: `Esse arquivo já foi enviado antes (${duplicate.originalFilename}).`,
        duplicateDocumentId: duplicate.id,
      },
      { status: 409 }
    );
  }

  const safeFileName = file.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.\-_]/g, "_");
  const storagePath = `${session.companyId}/${randomUUID()}-${safeFileName}`;

  await uploadDocumentFile({
    storagePath,
    fileBuffer: buffer,
    mimeType: file.type || "application/octet-stream",
  });

  const document = await prisma.document.create({
    data: {
      companyId: session.companyId,
      uploadedById: session.userId,
      originalFilename: file.name,
      storagePath,
      mimeType: file.type || "application/octet-stream",
      contentHash,
      kind: "PAYMENT_LIST",
    },
  });

  await inngest.send({
    name: "payment-list/uploaded",
    data: { documentId: document.id },
  });

  return NextResponse.json({ documentId: document.id });
}
