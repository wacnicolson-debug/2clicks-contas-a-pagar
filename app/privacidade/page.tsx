export default function PrivacidadePage() {
  return (
    <div className="min-h-screen bg-neutral-50 px-4 py-10">
      <div className="max-w-2xl mx-auto bg-white border border-neutral-200 rounded-lg p-8 space-y-4 text-sm text-neutral-700">
        <h1 className="text-lg font-semibold text-neutral-900">
          Política de Privacidade — 2 Clicks Contas a Pagar
        </h1>
        <p>
          O 2 Clicks Contas a Pagar é um aplicativo de uso interno da GLM Confecções
          Ltda para controle de contas a pagar e a receber. Não é distribuído
          publicamente nem usado por terceiros.
        </p>
        <p>
          O app usa o Google Sign-In apenas para autorizar o acesso a uma
          planilha (Google Sheets) e a uma pasta do Google Drive pertencentes
          à própria empresa, com o único objetivo de criar e atualizar essa
          planilha com os lançamentos financeiros registrados no app.
        </p>
        <p>
          Nenhum dado obtido através dessa autorização é vendido,
          compartilhado ou usado para qualquer finalidade além dessa
          sincronização. O app não acessa outros arquivos do Google Drive do
          usuário além dos que ele mesmo cria através do app.
        </p>
        <p>
          Dúvidas: wacnicolson@gmail.com
        </p>
      </div>
    </div>
  );
}
