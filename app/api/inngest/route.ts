import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { processDocument } from "@/lib/inngest/functions/processDocument";
import { processStatement } from "@/lib/inngest/functions/processStatement";
import { processPaymentList } from "@/lib/inngest/functions/processPaymentList";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processDocument, processStatement, processPaymentList],
});
