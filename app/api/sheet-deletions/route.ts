import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { processSheetDeletions } from "@/lib/sheets/sheetDeletions";

// Chamada pela própria tela (AutoRefresh) de tempos em tempos: apaga os
// lançamentos marcados na coluna EXCLUIR da planilha. Nunca devolve erro pra
// tela — uma falha de leitura (Google fora do ar etc.) só tenta de novo na
// próxima rodada.
export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  try {
    const result = await processSheetDeletions(session.companyId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("Falha ao processar exclusões marcadas na planilha:", err);
    return NextResponse.json({ ok: false, deleted: 0, unmatched: 0 });
  }
}
