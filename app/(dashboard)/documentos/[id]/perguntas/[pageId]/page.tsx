"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

type Kind = "FORNECEDOR" | "CLIENTE";
type Status = "PAGO" | "A_PAGAR";
type Method = "BOLETO" | "PIX" | "DEBITO_CONTA";

type PageDetail = {
  supplierName: string;
  supplierKnown: boolean;
  needsCategory: boolean;
  // Linha de extrato bancário sem nota correspondente — o dinheiro já se
  // moveu na conta, então não faz sentido perguntar "Pago ou a pagar?".
  fromStatement: boolean;
  // Só vem preenchido quando a forma de pagamento (e a chave pix, quando
  // aplicável) já foram lidas de uma relação de pagamentos — usado pra
  // pré-marcar a pergunta certa.
  knownPaymentMethod: Method | null;
  knownPixKey: string | null;
  installments: { amount: number; dueDate: string | null }[];
};

export default function AnswerPage() {
  const params = useParams<{ id: string; pageId: string }>();
  const router = useRouter();

  const [detail, setDetail] = useState<PageDetail | null>(null);
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>("FORNECEDOR");
  const [status, setStatus] = useState<Status>("A_PAGAR");
  const [method, setMethod] = useState<Method>("BOLETO");
  const [pixKey, setPixKey] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [alwaysAskCategory, setAlwaysAskCategory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Documento não trazia nenhuma indicação de parcelamento (ex: nota mandada
  // por WhatsApp, sem "2x" nem 2 boletos anexos) — só quem recebeu a nota
  // sabe que na verdade são várias parcelas. null = não dividir (padrão).
  const [split, setSplit] = useState<{ amount: string; dueDate: string }[] | null>(null);

  useEffect(() => {
    fetch(`/api/documents/${params.id}/pages/${params.pageId}`)
      .then((res) => res.json())
      .then((data: PageDetail) => {
        setDetail(data);
        if (data.knownPaymentMethod) setMethod(data.knownPaymentMethod);
        if (data.knownPixKey) setPixKey(data.knownPixKey);
      });
    fetch(`/api/categories`)
      .then((res) => res.json())
      .then((data) => setExistingCategories(data.names ?? []));
  }, [params.id, params.pageId]);

  // Uma caixa de data por parcela sem vencimento visível — uma nota
  // parcelada pode ter mais de uma parcela sem data, e cada uma precisa do
  // seu próprio vencimento (não dá pra aplicar a mesma data pras duas).
  const missingDateIndexes =
    detail?.installments.flatMap((i, idx) => (i.dueDate ? [] : [idx])) ?? [];
  const needsDate = missingDateIndexes.length > 0;
  // Categoria é pedida na 1ª nota de qualquer fornecedor, e também de novo
  // em fornecedores marcados como "muda de categoria" (ex: hora extra).
  const needsCategoryQuestion = !detail?.supplierKnown || (detail?.needsCategory ?? false);

  // Divisão manual só faz sentido quando a IA leu 1 valor cheio (nada pra
  // dividir se ela já separou as parcelas certinho).
  const canSplit = (detail?.installments.length ?? 0) === 1;
  const splitSum = split?.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0) ?? 0;
  const originalAmount = detail?.installments[0]?.amount ?? 0;
  const splitSumMatches = split ? Math.abs(splitSum - originalAmount) < 0.01 : true;

  function startSplit() {
    const amount = detail?.installments[0]?.amount ?? 0;
    const each = Math.floor((amount / 2) * 100) / 100;
    const last = Math.round((amount - each) * 100) / 100;
    setSplit([
      { amount: each.toFixed(2), dueDate: "" },
      { amount: last.toFixed(2), dueDate: "" },
    ]);
  }

  function addSplitRow() {
    setSplit((prev) => [...(prev ?? []), { amount: "0.00", dueDate: "" }]);
  }

  function removeSplitRow(index: number) {
    setSplit((prev) => (prev ?? []).filter((_, i) => i !== index));
  }

  function updateSplitRow(index: number, patch: Partial<{ amount: string; dueDate: string }>) {
    setSplit((prev) => (prev ?? []).map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    if (split && !splitSumMatches) {
      setError(
        `A soma das parcelas (${splitSum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}) não bate com o valor da nota (${originalAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}).`
      );
      return;
    }

    setLoading(true);
    setError(null);

    const supplierKnown = detail?.supplierKnown ?? false;

    // Lido direto do DOM via FormData (não controlado pelo React) porque um
    // <input type="date"> controlado por estado perde valor digitado no
    // teclado em alguns navegadores — ver nota no lib/ da memória do projeto.
    const formData = new FormData(e.currentTarget);
    const manualDueDates: Record<number, string> = {};
    if (!split) {
      for (const idx of missingDateIndexes) {
        const value = formData.get(`dueDate-${idx}`);
        if (value) manualDueDates[idx] = String(value);
      }
    }
    const noteDate = formData.get("noteDate");

    const res = await fetch(
      `/api/documents/${params.id}/pages/${params.pageId}/answer`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: supplierKnown ? undefined : kind,
          paymentStatus:
            !supplierKnown && kind === "FORNECEDOR"
              ? detail?.fromStatement
                ? "PAGO"
                : status
              : undefined,
          paymentMethod: !supplierKnown && kind === "FORNECEDOR" ? method : undefined,
          pixKey: !supplierKnown && kind === "FORNECEDOR" && method === "PIX" ? pixKey : undefined,
          categoryName: needsCategoryQuestion ? categoryName : undefined,
          alwaysAskCategory: !supplierKnown ? alwaysAskCategory : undefined,
          manualDueDates: !split && needsDate ? manualDueDates : undefined,
          installmentsOverride: split
            ? split.map((s) => ({ amount: parseFloat(s.amount), dueDate: s.dueDate }))
            : undefined,
          noteDate: noteDate ? String(noteDate) : undefined,
        }),
      }
    );

    setLoading(false);

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Não foi possível salvar. Tente de novo.");
      return;
    }

    router.push(`/documentos/${params.id}`);
  }

  if (!detail) {
    return (
      <div className="min-h-screen bg-neutral-50 px-4 py-10">
        <p className="max-w-md mx-auto text-sm text-neutral-500">Carregando...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <form
        onSubmit={handleSubmit}
        className="max-w-md mx-auto bg-white border border-neutral-200 rounded-lg p-8 space-y-6"
      >
        <div>
          <h1 className="text-lg font-semibold mb-1">
            {!detail.supplierKnown
              ? detail.fromStatement
                ? `Primeiro registro de ${detail.supplierName}`
                : `Primeira nota de ${detail.supplierName}`
              : detail.needsCategory && needsDate
                ? `${detail.supplierName} — confirme a categoria e a data`
                : detail.needsCategory
                  ? `${detail.supplierName} — confirme a categoria`
                  : `${detail.supplierName} — só falta a data`}
          </h1>
          <p className="text-sm text-neutral-500">
            {!detail.supplierKnown
              ? "As respostas ficam salvas — da próxima vez, isso é automático."
              : detail.needsCategory
                ? "Esse fornecedor muda de categoria nota a nota — confirme qual é desta vez."
                : "Já sabemos como lançar esse fornecedor — a nota só não trouxe vencimento visível."}
          </p>
        </div>

        <div className="bg-neutral-50 border border-neutral-200 rounded-md px-3 py-2 text-sm">
          <p className="text-xs font-medium text-neutral-500 mb-1">
            {detail.installments.length > 1 ? "Valores lidos da nota" : "Valor lido da nota"}
          </p>
          {detail.installments.map((installment, i) => (
            <p key={i} className="tabular-nums">
              {installment.amount.toLocaleString("pt-BR", {
                style: "currency",
                currency: "BRL",
              })}
              {installment.dueDate
                ? ` — venc. ${new Date(installment.dueDate + "T00:00:00").toLocaleDateString("pt-BR")}`
                : " — sem data visível"}
            </p>
          ))}
          <p className="text-xs text-neutral-400 mt-1">
            Confira se bate com o documento antes de confirmar — se estiver errado, corrija
            direto na planilha depois de lançar.
          </p>
        </div>

        {canSplit && !split && (
          <button
            type="button"
            onClick={startSplit}
            className="text-xs text-emerald-700 underline"
          >
            O documento não mostra, mas na verdade são várias parcelas — dividir
          </button>
        )}

        {split && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-neutral-500">Parcelas</p>
            {split.map((row, i) => (
              <div key={i} className="flex gap-2 items-start">
                <div className="flex-1">
                  <input
                    type="number"
                    step="0.01"
                    value={row.amount}
                    onChange={(e) => updateSplitRow(i, { amount: e.target.value })}
                    className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                    required
                  />
                </div>
                <div className="flex-1">
                  <input
                    type="date"
                    value={row.dueDate}
                    onChange={(e) => updateSplitRow(i, { dueDate: e.target.value })}
                    className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                    required
                  />
                </div>
                {split.length > 2 && (
                  <button
                    type="button"
                    onClick={() => removeSplitRow(i)}
                    className="text-red-600 text-xs px-1 py-2"
                  >
                    remover
                  </button>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={addSplitRow}
                className="text-xs text-emerald-700 underline"
              >
                + adicionar parcela
              </button>
              <button
                type="button"
                onClick={() => setSplit(null)}
                className="text-xs text-neutral-400 underline"
              >
                cancelar divisão
              </button>
            </div>
            <p className={`text-xs ${splitSumMatches ? "text-neutral-400" : "text-red-600"}`}>
              Soma: {splitSum.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}{" "}
              (nota: {originalAmount.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })})
            </p>
          </div>
        )}

        {!detail.supplierKnown && (
          <>
            <fieldset>
              <legend className="text-sm font-medium mb-2">É Fornecedor ou Cliente?</legend>
              <div className="flex gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={kind === "FORNECEDOR"}
                    onChange={() => setKind("FORNECEDOR")}
                  />
                  Fornecedor (despesa)
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={kind === "CLIENTE"}
                    onChange={() => setKind("CLIENTE")}
                  />
                  Cliente (receita)
                </label>
              </div>
            </fieldset>

            {kind === "FORNECEDOR" && (
              <>
                {!detail.fromStatement && (
                  <fieldset>
                    <legend className="text-sm font-medium mb-2">Pago ou a pagar?</legend>
                    <div className="flex gap-4 text-sm">
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={status === "PAGO"}
                          onChange={() => setStatus("PAGO")}
                        />
                        Pago
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="radio"
                          checked={status === "A_PAGAR"}
                          onChange={() => setStatus("A_PAGAR")}
                        />
                        A pagar
                      </label>
                    </div>
                  </fieldset>
                )}

                <fieldset>
                  <legend className="text-sm font-medium mb-2">Forma de pagamento</legend>
                  <div className="flex gap-4 text-sm mb-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={method === "BOLETO"}
                        onChange={() => setMethod("BOLETO")}
                      />
                      Boleto
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={method === "PIX"}
                        onChange={() => setMethod("PIX")}
                      />
                      Pix
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={method === "DEBITO_CONTA"}
                        onChange={() => setMethod("DEBITO_CONTA")}
                      />
                      Débito em conta
                    </label>
                  </div>
                  {method === "PIX" && (
                    <input
                      placeholder="Chave Pix (opcional)"
                      value={pixKey}
                      onChange={(e) => setPixKey(e.target.value)}
                      className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                    />
                  )}
                </fieldset>
              </>
            )}
          </>
        )}

        {needsCategoryQuestion && (
          <div>
            <label className="block text-sm font-medium mb-1" htmlFor="category">
              Categoria de custo
            </label>
            <input
              id="category"
              list="category-suggestions"
              placeholder="ex: energia, matéria-prima, frete..."
              value={categoryName}
              onChange={(e) => setCategoryName(e.target.value)}
              className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
            />
            <datalist id="category-suggestions">
              {existingCategories.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <p className="text-xs text-neutral-400 mt-1">
              Comece a digitar pra ver categorias já existentes — evita criar uma
              parecida sem querer. Se não existir ainda, o app cria ela agora.
            </p>

            {!detail.supplierKnown && (
              <label className="flex items-start gap-2 mt-3 text-xs text-neutral-500">
                <input
                  type="checkbox"
                  checked={alwaysAskCategory}
                  onChange={(e) => setAlwaysAskCategory(e.target.checked)}
                  className="mt-0.5"
                />
                Esse fornecedor muda de categoria nota a nota (ex: mão de obra normal
                vs hora extra, notas parecidas) — perguntar a categoria de novo toda vez.
              </label>
            )}
          </div>
        )}

        {!split && needsDate && (
          <div>
            <p className="text-xs text-neutral-400 mb-2">
              {missingDateIndexes.length > 1
                ? "Essa nota não trouxe vencimento visível nessas parcelas — informe a data de cada uma."
                : "Essa nota não trouxe uma data de vencimento visível — informe manualmente."}
            </p>
            <div className="space-y-2">
              {missingDateIndexes.map((idx) => (
                <div key={idx}>
                  <label
                    className="block text-sm font-medium mb-1"
                    htmlFor={`dueDate-${idx}`}
                  >
                    {detail.installments.length > 1
                      ? `Vencimento — parcela ${idx + 1}/${detail.installments.length}`
                      : "Data de vencimento"}
                  </label>
                  <input
                    id={`dueDate-${idx}`}
                    name={`dueDate-${idx}`}
                    type="date"
                    defaultValue=""
                    className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
                    required
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1" htmlFor="noteDate">
            Data da nota (opcional)
          </label>
          <p className="text-xs text-neutral-400 mb-1">
            Preencha só se essa nota for antiga e o vencimento estiver bem mais à
            frente (prazo longo) — o custo passa a contar no mês desta data em vez
            do mês do vencimento. O vencimento continua valendo pra saber quando pagar.
          </p>
          <input
            id="noteDate"
            name="noteDate"
            type="date"
            defaultValue=""
            className="w-full border border-neutral-300 rounded-md px-3 py-2 text-sm"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full bg-emerald-700 text-white rounded-md py-2 text-sm font-medium disabled:opacity-50"
        >
          {loading ? "Salvando..." : "Confirmar lançamento"}
        </button>
      </form>
    </div>
  );
}
