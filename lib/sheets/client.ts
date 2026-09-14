import { google, sheets_v4, drive_v3 } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

function getOAuthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET não configurados (.env)"
    );
  }

  return new google.auth.OAuth2(
    clientId,
    clientSecret,
    `${baseUrl}/api/auth/google/callback`
  );
}

/** URL para onde mandar o usuário autorizar o app a mexer no Google Sheets/Drive dele. */
export function getGoogleAuthUrl(state: string): string {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // necessário para ganhar um refresh_token
    prompt: "consent", // força reconsentir, garantindo que o refresh_token venha sempre
    scope: SCOPES,
    state,
  });
}

/** Troca o "code" que o Google devolve no callback por tokens (e devolve o refresh_token). */
export async function exchangeCodeForRefreshToken(code: string): Promise<string> {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      "O Google não devolveu um refresh_token — tente conectar de novo (às vezes é preciso revogar o acesso anterior em myaccount.google.com/permissions e tentar de novo)."
    );
  }
  return tokens.refresh_token;
}

/** Clientes do Sheets/Drive autenticados como a própria empresa (dona real da planilha). */
export function getGoogleClientsForCompany(refreshToken: string): {
  sheets: sheets_v4.Sheets;
  drive: drive_v3.Drive;
} {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });

  return {
    sheets: google.sheets({ version: "v4", auth: client }),
    drive: google.drive({ version: "v3", auth: client }),
  };
}
