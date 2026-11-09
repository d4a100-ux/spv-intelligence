# Matriz de disponibilidade comprovada: Carros Online

> Fonte: `npm run validate` (06/11/2026, 19:30) e `npm run diagnose` (06/11/2026, 19:31). Chamadas reais, somente leitura.
> Os relatórios brutos ficam em `reports/`, fora do git.

## Conexão

| Item | Resultado |
|---|---|
| Endpoints testados | **13/13 OK** (HTTP 200) |
| Versão do header | `v3` em todos os recursos |
| Paginação | Comprovada em contatos (`searchAfter`), conversas (`startAfterDate` = `sort[0]`), mensagens (`lastMessageId`) e oportunidades (`startAfter` + `startAfterId`), sem registros repetidos |
| Rate limit | 100 req / 10 s e 200.000 / dia por subconta (headers confirmam a documentação) |
| Volume | ~1.574 contatos atualizados em 30 dias · 2.003 conversas · 1.511 oportunidades · 16 usuários · 1 calendário |

## Dados

| Dado | Situação | Evidência e decisão |
|---|---|---|
| Entrada do lead (`dateAdded`) | ✅ | 100/100 |
| Origem do lead | ✅ via `attributionSource.medium` | O campo `source` veio vazio em 100/100. A origem real é o `medium`: whatsapp 97, whatsapp_coex 1, instagram 1, manual 1. O D2 passou a usar `coalesce(source, attributionSource.medium)` |
| Campanha (UTM) | ❌ não preenchida | `utmCampaign` 0/100. Será exibida como indisponível |
| Responsável do lead | ✅ | 96/100. Os 4 restantes estão de fato sem responsável |
| Seguidores do lead | ✅ | 2/100 contatos. Os seguidores da conversa **são os mesmos** do contato (2/2) |
| Seguidores da oportunidade | Não usados | 0/100. A detecção de vendedor seguidor usa o contato |
| Tipo do contato | ✅ | `lead` 100/100 |
| Conversa: última mensagem | ✅ | `lastMessageDate` numérico 50/50. Há também `lastManualMessageDate` |
| Mensagens: direção e data | ✅ | 100%. Ordem: mais recente primeiro |
| **Eventos de sistema dentro das mensagens** | ⚠️ tratado | `TYPE_ACTIVITY_OPPORTUNITY` / `_APPOINTMENT` / `_SLA` e `TYPE_INTERNAL_COMMENT` chegam como **outbound + source=app** (78 de 976 na amostra). Agora ficam em `messages.kind` e **não contam** como resposta nem como conversa |
| Resposta humana × automação | ✅ com ressalva | Mensagens WhatsApp outbound: `app` com userId 588 · `app` sem userId 303 · `workflow` 5. Ver R3 abaixo |
| Etapa e horário da mudança | ✅ | `lastStageChangeAt` e `lastStatusChangeAt` em 100/100 (horário exato) |
| Agendamento: status | ✅ | Em 90 dias: `confirmed` 126, `noshow` 2. **Nenhum `showed`**: a visita realizada é registrada pela etapa do funil, não pelo calendário |
| Agendamento: responsável e origem | ✅ | `assignedUserId` 100%. `createdBy.source`: contato 50, celular 39, oportunidade 34, **Conversation AI 5** |
| Pipelines | ✅ | "FUNIL DE VENDAS" (18 etapas) e "Recuperação de Base — Ligação" (5 etapas) |
| Campos personalizados | ✅ | `Carro` (texto) e `Voice AI Reason for Call` |
| Papel SDR × vendedor | ❌ | O CRM só distingue `admin` (6) de `user` (10). A classificação é manual |
| Histórico de responsável, seguidor e etapa | ❌ pela API | Captura própria a partir do H0 |

## R3: mensagens `app` sem `userId` (303 de 891)

Elas têm a mesma estrutura das mensagens com `userId`. O tempo de resposta após a mensagem do cliente varia: menos de 10 s em 8 casos, 10 a 60 s em 15, 1 a 10 min em 23 e mais de 10 min em 15. Esse padrão é **humano**, não de bot. A hipótese mais provável é que sejam mensagens enviadas pelo WhatsApp do celular, fora da tela do CRM. Elas contam como **resposta da equipe**, mas **sem autor identificável**, então não entram no ranking individual de SDRs.

**Confirmação pendente:** abrir 3 dessas mensagens no CRM e verificar quem enviou.

## Mapeamento de etapas (proposta)

Arquivo: [`supabase/seed/carros-online-stage-mapping.sql`](../supabase/seed/carros-online-stage-mapping.sql). As 18 etapas do "FUNIL DE VENDAS" correspondem ao funil canônico. "NÃO CONSEGUIU CONTATO" gerou a etapa canônica `sem_contato` (terminal, perda). "Recuperação de Base" fica fora do funil comercial.
