import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/prisma";
import { isGoogleTokenValid } from "@/lib/sheets/client";
import { LogoutButton } from "./logout-button";
import { AutoRefresh } from "./auto-refresh";
import { DeletePendingButton } from "./delete-pending-button";
import { RemoveSheetButton } from "./remove-sheet-button";

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) return null;

  const params = await searchParams;
  const googleError = typeof params.google_error === "string" ? params.google_error : null;
  const googleConnected = params.google_connected === "1";

  const company = await prisma.company.findUniqueOrThrow({
    where: { id: session.companyId },
    include: { sheets: { orderBy: { year: "desc" } } },
  });

  // Existe um token guardado, mas ele ainda funciona? Pode ter expirado ou
  // sido revogado — sem essa checagem o painel mostrava tudo certo mesmo com
  // a sincronização quebrada, e só dava pra notar quando um lançamento
  // sumia da planilha.
  const googleTokenValid = company.googleRefreshToken
    ? await isGoogleTokenValid(company.googleRefreshToken)
    : null;

  const today = startOfDay(new Date());
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dayAfterTomorrow = new Date(tomorrow);
  dayAfterTomorrow.setUTCDate(dayAfterTomorrow.getUTCDate() + 1);
  const in7Days = new Date(today);
  in7Days.setUTCDate(in7Days.getUTCDate() + 7);
  const in1Month = new Date(today);
  in1Month.setUTCMonth(in1Month.getUTCMonth() + 1);

  const [dueToday, dueTomorrow, due7Days, due1Month, expectedIncome, pendingPages] =
    await Promise.all([
      sumPayables(session.companyId, today, tomorrow),
      // "Amanhã" é só o dia de amanhã (1 dia) — não de amanhã até 7 dias, que
      // batia igualzinho com "Próximos 7 dias" e confundia o painel.
      sumPayables(session.companyId, tomorrow, dayAfterTomorrow),
      sumPayables(session.companyId, today, in7Days),
      sumPayables(session.companyId, today, in1Month),
      sumReceivables(session.companyId, today, in1Month),
      prisma.documentPage.findMany({
        where: { status: "AWAITING_USER_INPUT", document: { companyId: session.companyId } },
        include: { supplier: true, document: true },
        orderBy: { id: "asc" },
      }),
    ]);

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <AutoRefresh />
      <div className="max-w-3xl mx-auto">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-lg font-semibold">2 Clicks Contas a Pagar</h1>
            <p className="text-sm text-neutral-500">Olá, {session.username}</p>
          </div>
          <LogoutButton />
        </header>

        {googleError && (
          <p className="mb-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
            Não foi possível conectar o Google: {googleError}
          </p>
        )}
        {googleConnected && (
          <p className="mb-4 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md px-3 py-2">
            Google conectado! A planilha já foi criada no seu Drive.
          </p>
        )}

        {!company.googleRefreshToken ? (
          <div className="mb-8 bg-amber-50 border border-amber-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold mb-1">Conecte seu Google</h2>
            <p className="text-sm text-neutral-600 mb-3">
              Pra gerar sua planilha viva de contas a pagar, autorize o app a criar e
              editar uma planilha no seu Google Drive.
            </p>
            <a
              href="/api/auth/google/connect"
              className="inline-block bg-emerald-700 text-white rounded-md px-4 py-2 text-sm font-medium"
            >
              Conectar Google Sheets
            </a>
          </div>
        ) : googleTokenValid === false ? (
          <div className="mb-8 bg-red-50 border border-red-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold mb-1">A conexão com o Google caiu</h2>
            <p className="text-sm text-neutral-600 mb-3">
              O acesso à sua planilha expirou ou foi revogado — os lançamentos
              não estão mais sendo sincronizados. Reconecte pra normalizar.
            </p>
            <a
              href="/api/auth/google/connect"
              className="inline-block bg-red-700 text-white rounded-md px-4 py-2 text-sm font-medium"
            >
              Reconectar Google Sheets
            </a>
          </div>
        ) : (
          <div className="mb-8 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {company.sheets.map((sheet) => (
              <span key={sheet.id} className="inline-flex items-center gap-1">
                <a
                  href={`https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-700 underline"
                >
                  Planilha {sheet.year} ↗
                </a>
                <RemoveSheetButton id={sheet.id} year={sheet.year} />
              </span>
            ))}
          </div>
        )}

        {pendingPages.length > 0 && (
          <div className="mb-8 bg-amber-50 border border-amber-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold mb-3">
              Esperando sua resposta ({pendingPages.length})
            </h2>
            <ul className="space-y-2">
              {pendingPages.map((page) => (
                <li key={page.id} className="flex items-center justify-between text-sm gap-3">
                  <span>
                    {page.supplier?.name ?? "Fornecedor não identificado"} —{" "}
                    {page.document.originalFilename}
                  </span>
                  <span className="flex items-center gap-3 shrink-0">
                    <Link
                      href={`/documentos/${page.documentId}/perguntas/${page.id}`}
                      className="text-emerald-700 font-medium underline"
                    >
                      Responder
                    </Link>
                    <DeletePendingButton
                      documentId={page.documentId}
                      pageId={page.id}
                      label={page.supplier?.name ?? page.document.originalFilename}
                    />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap gap-3 mb-8">
          <Link
            href="/documentos/capturar"
            className="bg-emerald-800 text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Tirar foto
          </Link>
          <Link
            href="/documentos/upload"
            className="bg-emerald-700 text-white rounded-md px-4 py-2 text-sm font-medium"
          >
            Adicionar Documentos
          </Link>
          <Link
            href="/pagamentos/upload"
            className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium"
          >
            Adicionar Relação de Pagamentos
          </Link>
          <Link
            href="/extrato/upload"
            className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium"
          >
            Adicionar Extrato
          </Link>
          <Link
            href="/lancamentos/manual"
            className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium"
          >
            Lançamento Manual
          </Link>
          <Link
            href="/custos"
            className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium"
          >
            Distribuição de custos
          </Link>
          <Link
            href="/lancamentos"
            className="bg-white border border-neutral-300 text-neutral-700 rounded-md px-4 py-2 text-sm font-medium"
          >
            Lançamentos
          </Link>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <section className="bg-white border border-neutral-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-neutral-600 mb-3">
              Pagamentos a vencer
            </h2>
            <dl className="space-y-2 text-sm">
              <Row label="Hoje" value={dueToday} />
              <Row label="Amanhã" value={dueTomorrow} />
              <Row label="Próximos 7 dias" value={due7Days} />
              <Row label="Próximos 30 dias" value={due1Month} />
            </dl>
          </section>

          <section className="bg-white border border-neutral-200 rounded-lg p-5">
            <h2 className="text-sm font-semibold text-neutral-600 mb-3">
              Receitas esperadas
            </h2>
            <dl className="space-y-2 text-sm">
              <Row label="Próximos 30 dias" value={expectedIncome} />
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="font-medium tabular-nums">
        {value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
      </dd>
    </div>
  );
}

async function sumPayables(companyId: string, from: Date, to: Date) {
  const result = await prisma.transaction.aggregate({
    where: { companyId, kind: "PAYABLE", paid: false, dueDate: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  return Number(result._sum.amount ?? 0);
}

async function sumReceivables(companyId: string, from: Date, to: Date) {
  const result = await prisma.transaction.aggregate({
    where: { companyId, kind: "RECEIVABLE", dueDate: { gte: from, lt: to } },
    _sum: { amount: true },
  });
  return Number(result._sum.amount ?? 0);
}
