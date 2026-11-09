/**
 * Diagnóstico complementar (somente leitura, sem PII): esclarece R3 (humano × automação),
 * status reais de agendamento e onde ficam os seguidores. Imprime apenas contagens/enums.
 *   npm run diagnose
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createLcClient } from "../src/integrations/leadconnector/client.ts";
import { RateLimiter } from "../src/integrations/leadconnector/rate-limiter.ts";

const loc = process.env.LC_LOCATION_ID ?? "";
const api = createLcClient({ locationId: loc, token: process.env.LC_PIT ?? "", versions: {}, limiter: new RateLimiter(60, 10_000) });
const tally = (xs: unknown[]) => xs.reduce<Record<string, number>>((a, x) => { const k = x === undefined || x === null || x === "" ? "(vazio)" : typeof x === "object" ? JSON.stringify(x) : String(x); a[k] = (a[k] ?? 0) + 1; return a; }, {});
const out: Record<string, unknown> = {};

async function main() {
  // --- R3: 40 conversas recentes, todas as mensagens da 1ª página
  const cv = await api.get("conversations", "/conversations/search", { locationId: loc, limit: 40, sortBy: "last_message_date", sort: "desc" });
  const convs: any[] = cv.conversations ?? [];
  out["conversa.lastOutboundMessageAction"] = tally(convs.map((c) => c.lastOutboundMessageAction));
  out["conversa.lastChannelAccount (chaves)"] = tally(convs.map((c) => c.lastChannelAccount && typeof c.lastChannelAccount === "object" ? Object.keys(c.lastChannelAccount).sort().join(",") : typeof c.lastChannelAccount));
  out["conversa.inbox"] = tally(convs.map((c) => c.inbox));
  out["conversa.lastManualMessageDate == lastMessageDate (outbound)"] = tally(convs.filter((c) => c.lastMessageDirection === "outbound").map((c) => c.lastManualMessageDate === c.lastMessageDate ? "igual" : c.lastManualMessageDate ? "diferente" : "sem manual"));

  const msgs: any[] = [];
  for (const c of convs) {
    const r = await api.get("messages", `/conversations/${c.id}/messages`, { limit: 100 });
    msgs.push(...(r.messages?.messages ?? []));
  }
  const ob = msgs.filter((m) => m.direction === "outbound");
  out["amostra mensagens"] = { total: msgs.length, outbound: ob.length };
  out["outbound: messageType × source × userId"] = tally(ob.map((m) => `${m.messageType} | ${m.source ?? "-"} | ${m.userId ? "userId" : "sem userId"}`));
  const appNoUser = ob.filter((m) => m.source === "app" && !m.userId && m.messageType === "TYPE_WHATSAPP");
  const appUser = ob.filter((m) => m.source === "app" && m.userId && m.messageType === "TYPE_WHATSAPP");
  for (const [label, set] of [["app SEM userId", appNoUser], ["app COM userId", appUser]] as const) {
    out[`${label}: type(num)`] = tally(set.map((m) => m.type));
    out[`${label}: contentType`] = tally(set.map((m) => m.contentType));
    out[`${label}: status`] = tally(set.map((m) => m.status));
    out[`${label}: tem altId`] = tally(set.map((m) => (m.altId ? "sim" : "não")));
    out[`${label}: chaves`] = tally(set.map((m) => Object.keys(m).sort().join(",")));
    out[`${label}: tem anexo`] = tally(set.map((m) => (Array.isArray(m.attachments) && m.attachments.length ? "sim" : "não")));
  }
  // Mensagens 'app sem userId' são intercaladas com inbound (conversa) ou em rajadas (bot)?
  const gaps: string[] = [];
  for (const c of convs) {
    const ms = msgs.filter((m) => m.conversationId === c.id && m.messageType === "TYPE_WHATSAPP").sort((a, b) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded));
    for (let i = 1; i < ms.length; i++) {
      const m = ms[i], p = ms[i - 1];
      if (m.direction === "outbound" && m.source === "app" && !m.userId && p.direction === "inbound") {
        const s = (Date.parse(m.dateAdded) - Date.parse(p.dateAdded)) / 1000;
        gaps.push(s < 10 ? "<10s" : s < 60 ? "10-60s" : s < 600 ? "1-10min" : ">10min");
      }
    }
  }
  out["app SEM userId: tempo após a inbound anterior"] = tally(gaps);
  out["atividades (TYPE_ACTIVITY_*/INTERNAL): direction × source"] = tally(msgs.filter((m) => /ACTIVITY|INTERNAL/.test(m.messageType)).map((m) => `${m.messageType} | ${m.direction} | ${m.source ?? "-"}`));

  // --- Agendamentos: onde está o status real
  const cals = (await api.get("calendars", "/calendars/", { locationId: loc })).calendars ?? [];
  const evs: any[] = [];
  for (const cal of cals) {
    const r = await api.get("events", "/calendars/events", { locationId: loc, calendarId: cal.id, startTime: Date.now() - 90 * 864e5, endTime: Date.now() + 30 * 864e5 });
    evs.push(...(r.events ?? []));
  }
  out["agendamentos (90d)"] = evs.length;
  out["appointmentStatus"] = tally(evs.map((e) => e.appointmentStatus));
  out["appoinmentStatus (campo com grafia do CRM)"] = tally(evs.map((e) => e.appoinmentStatus));
  out["state"] = tally(evs.map((e) => e.state));
  out["statusId"] = tally(evs.map((e) => e.statusId));
  out["deleted"] = tally(evs.map((e) => e.deleted));
  out["rescheduledAt preenchido"] = tally(evs.map((e) => (e.rescheduledAt ? "sim" : "não")));
  out["appointmentMeta (chaves)"] = tally(evs.map((e) => (e.appointmentMeta ? Object.keys(e.appointmentMeta).sort().join(",") : "(vazio)")));
  out["createdBy (chaves/source)"] = tally(evs.map((e) => (e.createdBy ? `${Object.keys(e.createdBy).sort().join(",")} | source=${e.createdBy.source ?? "-"}` : "(vazio)")));
  out["início no passado × status"] = tally(evs.map((e) => `${Date.parse(e.startTime) < Date.now() ? "passado" : "futuro"} | ${e.appointmentStatus}`));

  // --- Seguidores: conversa × contato
  const withF = convs.filter((c) => (c.followers ?? []).length);
  const cmp: string[] = [];
  for (const c of withF) {
    const ct = await api.get("contacts", `/contacts/${c.contactId}`);
    const cf: string[] = (ct.contact ?? ct).followers ?? [];
    const same = cf.length === c.followers.length && cf.every((x: string) => c.followers.includes(x));
    cmp.push(same ? "iguais" : cf.length ? "diferentes" : "contato sem seguidores");
  }
  out["seguidores conversa × contato"] = { conversasComSeguidores: withF.length, comparacao: tally(cmp) };

  mkdirSync("reports", { recursive: true });
  const file = `reports/diagnose-${loc}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out)) console.log(`${k}: ${JSON.stringify(v)}`);
  console.log(`\nRelatório: ${file}  (requisições: ${api.stats.requests})`);
}

main().catch((e) => { console.error("Falha:", e instanceof Error ? e.message : String(e)); process.exit(1); });
