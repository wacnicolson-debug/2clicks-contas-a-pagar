import { Inngest } from "inngest";

export const inngest = new Inngest({ id: "2clicks-contas-a-pagar" });

export type DocumentUploadedEvent = {
  name: "document/uploaded";
  data: { documentId: string };
};
