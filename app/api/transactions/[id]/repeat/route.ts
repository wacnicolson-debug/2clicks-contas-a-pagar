import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { syncTransactionToSheet } from "@/lib/sheets/syncTransaction";

// Mesmo dia do mês, N meses pra frente — dia maior que o mês seguinte tem
// (ex: 31 de janeiro -> fevereiro) cai no último dia daquele mês.
function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return target;
}

// "Repetir": clona este lançamento pros próximos N meses, mesmo dia, mesmo
// valor/fornecedor/categoria — pra contas recorrentes (ex: internet, aluguel)
// sem precisar subir nota nenhuma nesses meses. Cada cópia nasce "a pagar"
// (ninguém sabe ainda o valor real do mês seguinte só por repetir a tela).
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado." }, { status: 401 });
  }

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as { months?: number };
  const months = Math.trunc(Number(body.months));
  if (!Number.isFinite(months) || months < 1 || months > 60) {
    return NextResponse.json({ error: "Informe um número de meses entre 1 e 60." }, { status: 400 });
  }

  const original = await prisma.transaction.findFirst({
    where: { id, companyId: session.companyId },
  });
  if (!original) {
    return NextResponse.json({ error: "Lançamento não encontrado." }, { status: 404 });
  }

  // Cria todas as N cópias no banco primeiro — isso nunca depende do Google,
  // então não há por que uma falha de sincronização derrubar lançamentos que
  // ainda nem tentaram sincronizar. A sincronização com a planilha vem
  // DEPOIS, item por item: se uma falhar (ex: conexão com o Google caída),
  // as outras continuam tentando — sem isso, 1 falha no meio abortava o loop
  // inteiro e só os meses já sincronizados ficavam criados, sem aviso claro.
  const created = await Promise.all(
    Array.from({ length: months }, (_, i) =>
      prisma.transaction.create({
        data: {
          companyId: original.companyId,
          kind: original.kind,
          supplierId: original.supplierId,
          amount: original.amount,
          dueDate: addMonthsClamped(original.dueDate, i + 1),
          description: original.description,
          paymentStatus: original.kind === "PAYABLE" ? "A_PAGAR" : null,
          paymentMethod: original.paymentMethod,
          pixKey: original.pixKey,
          categoryId: original.categoryId,
          paid: false,
          createdByUserId: session.userId,
        },
      })
    )
  );

  let syncedCount = 0;
  let syncError: string | null = null;
  for (const t of created) {
    try {
      await syncTransactionToSheet(t.id);
      syncedCount++;
    } catch (err) {
      syncError = err instanceof Error ? err.message : "Falha desconhecida.";
      // Continua tentando o resto — um lançamento sem sincronizar ainda pode
      // ser reenviado depois (botão "Reenviar pra planilha"), não precisa
      // refazer a repetição inteira.
    }
  }

  return NextResponse.json({
    ok: true,
    createdCount: created.length,
    syncedCount,
    syncError,
  });
}
