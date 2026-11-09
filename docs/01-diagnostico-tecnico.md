# SPV Intelligence — Diagnóstico Técnico

> **Versão 0.2 · 06/11/2026** · Incorpora as decisões oficiais D1 a D4 da gestão.
> Substitui a v0.1. Todas as menções a "fase 2" e "Etapa 4" para webhooks foram unificadas na **Etapa 6** (ver seção 7).
>
> Legenda de confiança:
> - ✅ **confirmado** na documentação oficial (marketplace.gohighlevel.com/docs, consultada em 06/11/2026);
> - ⚠️ **a validar**: o validador (`npm run validate`) comprova na subconta real;
> - ❌ **indisponível** pela API: construído pelo próprio SPV Intelligence.
>
> **Nenhum resultado da API real foi obtido até agora.** A matriz comprovada sai do relatório do validador na Etapa 2.

---

## 0. Decisões oficiais da gestão

| # | Decisão | Como foi implementado |
|---|---|---|
| **D1** | Webhooks aprovados para uma etapa posterior; o piloto roda com polling incremental. | Polling incremental é a base em todas as etapas. Webhooks via app privado do Marketplace na **Etapa 6**. O polling continua ativo como rede de segurança. |
| **D2** | Lead = contato criado no CRM (`dateAdded`). Oportunidades contadas à parte. Diferenciar novos, importados e duplicados quando os dados permitirem. | `contacts.origin_class` (`new` / `imported` / `duplicate` / `unclassified`). **Duplicado:** mesmo telefone ou e-mail normalizado de um contato mais antigo **na mesma unidade**. **Importado:** canal de origem contido em `units.settings.import_sources`. **Comprovado no piloto:** `source` vem vazio em 100% dos contatos; o canal real está em `attributionSource.medium` (whatsapp, whatsapp_coex, instagram, manual). O sistema usa `coalesce(source, attributionSource.medium)`. Enquanto a gestão não definir quais canais indicam importação, o contato fica `unclassified`. Duplicidade é recalculada para o grupo inteiro de mesmo telefone ou e-mail, e os telefones são normalizados com o código 55. |
| **D3** | Conversa ativa = janela de 24 h com ≥ 1 inbound do cliente **e** ≥ 1 outbound **humana**, considerando o estado da conversa. | View `v_active_conversations`. A janela é configurável por unidade (`active_window_hours`). Mensagens de workflow, campanha e bulk **não** contam. A view também informa `is_commercially_open`, que exclui contatos só com oportunidades encerradas. |
| **D4** | Horário comercial individual por unidade. | `units.business_hours`, mais a tabela `unit_holidays` e a função `business_minutes()`. **Sem horário configurado, o SLA em minutos úteis aparece como _indisponível_ (NULL), nunca como zero.** Nenhum horário vem pré-preenchido. |

---

## 1. Arquitetura técnica

### 1.1 Visão geral

```
        WeSales / LeadConnector — 4 subcontas (1 Private Integration por subconta)
                 │ REST v2 (polling incremental)     │ Webhooks (Etapa 6)
                 ▼                                   ▼
 ┌──────────────────────────────────────┐  ┌──────────────────────────────┐
 │ [1] INTEGRAÇÕES  src/integrations/   │  │ [2] RECEPÇÃO DE EVENTOS      │
 │ 1 cliente + 1 rate limiter POR UNIDADE│ │ (Etapa 6) Ed25519, dedupe    │
 │ retry/backoff, versão por recurso    │  │ crm_events (unit_id,event_key)│
 └──────────────────┬───────────────────┘  └──────────────┬───────────────┘
                    ▼                                     ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ WORKER DEDICADO  src/worker/  (processo contínuo, independe da interface)│
 │  fila jobs por unit_id → claim_job(unit) + advisory lock por unidade    │
 └──────────────────────────────┬──────────────────────────────────────────┘
                                ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ [3] PROCESSAMENTO  src/sync/, src/processing/                           │
 │  upsert idempotente (unit_id, crm_id) · diff estado anterior × atual →  │
 │  histórico de responsável, seguidores, etapa/status, agendamentos ·     │
 │  detecção de vendedor seguidor · campos derivados                       │
 └──────────────────────────────┬──────────────────────────────────────────┘
                                ▼
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ [4] BANCO  Supabase Postgres · RLS por unidade · tokens cifrados        │
 └───────┬─────────────────────────────────┬───────────────────────────────┘
         ▼                                 ▼
 [5] INDICADORES (views + snapshots)   [6] ALERTAS (Etapa 7; alerta de integração já ativo)
         └───────────────┬─────────────────┘
                         ▼
 [7] INTERFACE  Next.js + Supabase Realtime (Etapa 5)
```

### 1.2 Decisões de arquitetura

| Tema | Decisão | Motivo |
|---|---|---|
| Execução da sync | **Worker Node dedicado e contínuo** (`npm run worker`), em vez de Vercel Cron | A captura histórica precisa rodar sem parar desde o H0, inclusive antes de a interface existir. Funções serverless têm limite de duração. |
| Fila | Tabela `jobs` com `unit_id` obrigatório. `claim_job(unit)` só entrega jobs daquela unidade | Isolamento: uma subconta com 429 ou token inválido não trava as outras. |
| Concorrência | 1 loop por unidade, protegido por `pg_try_advisory_lock` | Dois workers nunca processam a mesma subconta ao mesmo tempo. |
| Limite de requisições | 1 `RateLimiter` por unidade: 70 req / 10 s (margem sobre os 100 documentados), mais pausa automática quando `X-RateLimit-Remaining ≤ 5` | O limite documentado vale por subconta. Com a cota diária abaixo de 20 mil, só rodam jobs essenciais. |
| Tokens | AES-256-GCM. A chave fica em `CREDENTIALS_KEY`, só no worker e no backend | A tabela de credenciais não tem nenhuma policy de RLS: só a service role acessa. |
| Escrita no CRM | **Nenhuma.** Somente leitura | Escopos mínimos e risco zero de alterar dados do CRM. |
| Chave dos registros | PK `(unit_id, crm_id)` | Preserva o ID original e torna impossível misturar unidades. |
| Frontend | Next.js + Tailwind (Etapa 5) | Lê do banco. Nunca chama o CRM diretamente. |

### 1.3 Estratégia de atualização (polling incremental)

| Recurso | Intervalo | Incremental | Prioridade |
|---|---|---|---|
| Health (`/locations`) | 5 min | — | 5 |
| Usuários, pipelines, calendários | 1 h | leitura completa (baixo volume) | 10 |
| **Conversas + mensagens** | **1 min** | `sortBy=last_message_date desc` + `startAfterDate`; mensagens **só das conversas que mudaram** | 20 |
| **Contatos** (responsável, seguidores) | **2 min** | filtro `dateUpdated ≥ cursor`, `sort dateUpdated asc`, `searchAfter` ✅ | 30 |
| Oportunidades (etapa, status, seguidores) | 5 min | varredura das abertas + consulta individual das que deixaram de estar abertas | 40 |
| Agendamentos | 5 min | por calendário, janela de −7 a +60 dias | 50 |
| Manutenção | 24 h | limpeza de jobs antigos | 90 |

**Carga inicial (backfill), configurável por unidade:** contatos atualizados nos últimos 90 dias, conversas dos últimos 30 dias, todas as oportunidades e agendamentos dos últimos 90 dias. A carga é retomável: quando o orçamento de páginas acaba, o cursor é salvo e um job de continuação é enfileirado na hora.

**Sobreposição de 2 min nos cursores.** Reprocessar um registro igual não gera histórico duplicado, porque a comparação é idempotente.

### 1.4 Captura histórica (ajustes 2 e 3)

- **Marco H0** (`units.history_since`): definido na **primeira conexão validada** pelo `unit:register` e **nunca sobrescrito**. A carga inicial começa no mesmo instante, antes de qualquer tela existir.
- **Na primeira captura**, o estado atual é gravado como `snapshot`. Isso não é uma mudança e não entra nos indicadores de movimentação.
- **A cada ciclo**, o estado salvo é comparado com o novo e cada diferença vira uma linha de histórico com a precisão do horário:

| `time_source` | Significado | Exemplo |
|---|---|---|
| `crm_field` | horário exato fornecido pelo CRM | mudança de etapa (`lastStageChangeAt`), status (`lastStatusChangeAt`) |
| `crm_updated` | `dateUpdated` do registro (aproximado) | agendamento remarcado |
| `detected` | momento em que o polling percebeu; `observed_after` guarda o limite inferior | troca de responsável, seguidor adicionado |
| `snapshot` | estado na primeira captura | — |

| Captura prioritária | Tabela |
|---|---|
| Responsáveis | `contact_assignment_history`, `opportunity_history (field='assigned_to')` |
| Seguidores (contato e oportunidade) | `contact_follower_history` |
| Etapas, status e pipeline | `opportunity_history` |
| Mensagens | `messages` (todas, com `first_seen_at`) |
| Agendamentos | `appointment_history` (criação, status, horário, responsável) |

### 1.5 Vendedor adicionado como seguidor (ajuste 4)

1. O CRM não distingue SDR de vendedor. Por isso cada usuário é classificado com `npm run users -- set … --role seller|sdr`.
2. Quando um usuário classificado como `seller` aparece como **novo seguidor** de um contato ou oportunidade, o sistema cria um `seller_handoffs` com `status = awaiting_seller` e registra `responsible_at_detection`, que é a SDR atribuída naquele momento.
3. **Isso não é uma transferência concluída.** O status só passa a `seller_acted` quando há atuação real do vendedor depois da adição: uma mensagem outbound humana com `userId = vendedor` ou um agendamento atribuído a ele.
4. Se o seguidor for removido antes de atuar, o status vira `follower_removed`.
5. Se um usuário for classificado como vendedor **depois** de já seguir leads, `rebuild_seller_handoffs()` reconstrói os handoffs a partir do histórico de seguidores.
6. **Limitação:** a API não informa **quem** adicionou o seguidor. `responsible_at_detection` indica a SDR responsável no momento, não prova a autoria.

Papéis diferenciados, conforme o briefing:

| Papel | Fonte |
|---|---|
| Responsável original | primeiro registro de `contact_assignment_history` |
| SDR responsável | `contacts.assigned_to` com papel `sdr` |
| Vendedor seguidor | `seller_handoffs` |
| Responsável comercial | `opportunities.assigned_to` |
| Responsável pela última movimentação | `userId` da última mensagem humana ou autor da última mudança (quando disponível) |

### 1.6 Monitoramento de falhas (ajuste 6)

- **`sync_logs`**: cada execução de job registra duração, número de requisições, registros gravados, mudanças detectadas, cota restante (burst e diária), classe do erro (`auth` / `scope` / `rate_limit` / `bad_request` / `server` / `network` / `internal`) e código HTTP. **Mensagens de erro passam por redação**, sem token e sem PII.
- **Estado da unidade:** `ok` → `degraded` após 3 falhas seguidas → `error` imediatamente em caso de 401 ou 403. Com a unidade em erro, só o health check continua rodando. Quando ele volta a passar, a unidade volta a `ok` automaticamente.
- **Alerta:** `operational_alerts.rule_key = 'integracao_falhando'` (crítico para token ou escopo, alto para falhas repetidas), resolvido automaticamente quando a sync normaliza.
- **Painel antes da interface:** `npm run status` mostra a view `v_integration_health`, a última execução por recurso e o volume capturado.
- **Recuperação:** jobs travados por mais de 15 min voltam para a fila. Retentativas usam backoff exponencial, até 5 tentativas.

---

## 2. Endpoints

Base `https://services.leadconnectorhq.com` · headers: `Authorization: Bearer <PIT>`, `Version`, `Accept: application/json`.
O header `Version` muda conforme a página da documentação: as atuais exigem `v3`, as anteriores usam `2021-07-28`. O validador testa as duas e grava a versão comprovada **por recurso e por subconta**.

| # | Recurso | Método e caminho | Escopo | Paginação | Status |
|---|---|---|---|---|---|
| 1 | Subconta / `companyId` | `GET /locations/{id}` | `locations.readonly` | — | ⚠️ |
| 2 | Usuários | `GET /users/search?companyId&locationId` | `users.readonly` | `skip`/`limit` | ✅ |
| 3 | Contatos | `POST /contacts/search` | `contacts.readonly` | `searchAfter`, sort `dateUpdated` | ✅ |
| 4 | Contato | `GET /contacts/{id}` | `contacts.readonly` | — | ⚠️ |
| 5 | Tarefas | `GET /contacts/{id}/tasks` | `contacts.readonly` | — | ⚠️ (não sincronizado no piloto: 1 chamada por contato) |
| 6 | Conversas | `GET /conversations/search` | `conversations.readonly` | `startAfterDate` | ✅ |
| 7 | Mensagens | `GET /conversations/{id}/messages` | `conversations/message.readonly` | `lastMessageId` + `nextPage` | ✅ |
| 8 | Pipelines | `GET /opportunities/pipelines` | `opportunities.readonly` | — | ⚠️ |
| 9 | Oportunidades | `GET /opportunities/search` | `opportunities.readonly` | `startAfter` + `startAfterId` | ✅ |
| 10 | Oportunidade | `GET /opportunities/{id}` | `opportunities.readonly` | — | ⚠️ |
| 11 | Calendários | `GET /calendars/` | `calendars.readonly` | — | ⚠️ |
| 12 | Eventos | `GET /calendars/events?calendarId&startTime&endTime` | `calendars/events.readonly` | janela (ms) | ✅ |
| 13 | Campos personalizados | `GET /locations/{id}/customFields` | `locations/customFields.readonly` | — | ⚠️ |

## 3. Permissões da Private Integration (por subconta)

Somente leitura: `locations.readonly`, `users.readonly`, `contacts.readonly`, `conversations.readonly`, `conversations/message.readonly`, `opportunities.readonly`, `calendars.readonly`, `calendars/events.readonly`, `locations/customFields.readonly`.
**Nenhum escopo `.write`.** A documentação recomenda rotacionar o token a cada 90 dias; o sistema registra `rotate_before` com 85 dias.

## 4. Banco de dados

O DDL completo está em [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql), validado por testes automáticos num Postgres real em memória (PGlite), **sem aplicar em nenhum banco**. Os testes cobrem:
- RLS por unidade;
- tokens inacessíveis ao usuário autenticado;
- fila isolada;
- minutos úteis com fuso e feriado;
- duplicidade restrita à mesma unidade;
- definição de conversa ativa.

| Grupo | Tabelas |
|---|---|
| Organização | `units`, `unit_holidays`, `integration_credentials`, `app_users`, `app_user_units` |
| Espelho do CRM | `crm_users`, `contacts`, `conversations`, `messages`, `pipelines`, `pipeline_stages`, `opportunities`, `calendars`, `appointments`, `tasks` |
| Histórico próprio | `contact_assignment_history`, `contact_follower_history`, `opportunity_history`, `appointment_history`, `seller_handoffs` |
| Mapeamento | `canonical_stages`, `stage_mappings` |
| Ingestão e monitoramento | `crm_events`, `jobs`, `sync_cursors`, `sync_logs`, view `v_integration_health` |
| Inteligência | `operational_alerts`, `alert_events`, `metric_definitions`, `metric_snapshots`, view `v_active_conversations` |

## 5. Matriz de indicadores

Tipo: **E** = estoque (fotografia do momento) · **F** = fluxo (ocorrido no período).

| Indicador | Tipo | Regra | Fonte | Situação |
|---|---|---|---|---|
| Leads recebidos | F | contatos com `dateAdded` no período, no fuso da unidade, separados por `origin_class` (D2) | contacts | ✅ data · ⚠️ separação de importados depende de `import_sources` |
| Novas oportunidades | F | `created_at_crm` no período (contado à parte, D2) | opportunities | ✅ |
| Sem responsável | E | `assigned_to IS NULL` | contacts | ✅ |
| Sem primeira resposta | E | sem outbound humana (`first_human_reply_at IS NULL`), ignorando eventos de sistema (`messages.kind <> 'message'`) | messages | ✅ · autoria das mensagens sem `userId` pendente (R3) |
| Tempo de 1ª resposta | F | `first_human_reply_at − date_added`, por coorte de entrada. Exibe minutos corridos e minutos úteis (D4) | messages + business_minutes | ⚠️ minutos úteis = indisponível até configurar o horário |
| Conversas ativas | E | D3 (`v_active_conversations`), só `kind = 'message'` | messages | ✅ |
| Aguardando equipe / cliente | E | `waiting_on` + `waiting_since` (equipe: 1ª mensagem do cliente sem resposta; cliente: última resposta humana) | derivado | ✅ |
| Leads parados | E | `now − last_operational_activity_at` = última ação **da equipe** (mensagem humana, etapa ou agendamento). Mensagem do cliente e automação **não** zeram o tempo. "Sem qualquer movimentação" usa `last_any_activity_at` | derivado | ✅ |
| Vendedor seguidor sem atuação | E | `seller_handoffs.status = awaiting_seller` | histórico próprio | ❌ antes do H0 · ✅ depois |
| Mudanças de fase | F | `opportunity_history` (exclui snapshot) | histórico próprio | ❌ antes do H0 · ✅ depois |
| Tempo em cada etapa | F | diferença entre mudanças consecutivas | histórico próprio | ❌ antes do H0 |
| Agendamentos / confirmações | F | `appointment_status` (comprovado: `confirmed`, `noshow`) | appointments | ✅ |
| Visitas realizadas / não comparecimentos | F | entrada nas etapas canônicas `visita_realizada` / `nao_compareceu`. O calendário **não** registra `showed` (0 em 128 agendamentos) | opportunity_history + stage_mappings | ✅ após aprovar o mapeamento |
| Vendas / perdas | F | `status = won/lost` com `lastStatusChangeAt` no período, ou etapa canônica | opportunities | ✅ |
| SDR × vendedor | — | classificação manual | crm_users | ❌ cadastro manual |

## 6. Riscos e limitações

| # | Risco | Mitigação | Status |
|---|---|---|---|
| R1 | Webhooks nativos dependem de app no Marketplace | D1: polling agora, app privado na Etapa 6 | Decidido |
| R2 | API sem histórico de responsável, seguidor ou etapa | Captura própria desde o H0 com precisão declarada (`time_source`) | Implementado |
| R3 | Separar resposta humana de automação | **Comprovado:** eventos de sistema (`TYPE_ACTIVITY_*`, `TYPE_INTERNAL_COMMENT`) chegam como outbound + `source=app` e agora ficam em `messages.kind`, fora do cálculo. `is_human` = mensagem real com `source ∈ human_sources` (padrão `["app"]`). Pendente: 303 de 891 mensagens `app` não têm `userId`; o padrão de tempo é humano e elas contam como resposta da equipe **sem autor** | Confirmar autoria no CRM |
| R4 | Header `Version` divergente | Versão comprovada por recurso e por subconta | Implementado |
| R5 | Limites de requisição | Limitador por unidade, headers autoritativos, reserva diária | Implementado |
| R6 | Campos da busca de conversas não documentados | Validador mede presença; fallback para `sort[0]` e `dateUpdated` | Validar na Etapa 2 |
| R7 | Eventos exigem `calendarId` | Iteração por calendário | Implementado |
| R8 | Etapas diferentes por unidade | `stage_mappings`; etapas não mapeadas aparecem em `status` | Mapear na Etapa 2 |
| R9 | Horário comercial | D4: `business_minutes()` retorna NULL sem configuração | Implementado |
| R10 | LGPD | Corpo das mensagens truncado em 160 caracteres e fora do `raw`; logs com redação; RLS por unidade | Implementado |
| R11 | Token exibido uma só vez e rotação de 90 dias | `rotate_before`, alerta crítico ao primeiro 401 | Implementado |
| R12 | Assinatura legada `X-WH-Signature` descontinuada | Etapa 6 usa somente Ed25519 (`X-GHL-Signature`) | Etapa 6 |
| **R13** | **Não comprovado** que `dateUpdated` do contato muda quando só o responsável ou os seguidores mudam | Teste manual no passo 8 do guia piloto. Se não mudar, entra uma varredura periódica de contatos abertos | Validar na Etapa 2 |
| **R14** | Mudanças entre dois ciclos de polling se perdem: A → B → A em menos de 2 min não aparece | Aceito no polling. Os webhooks da Etapa 6 cobrem esse caso | Aceito |
| **R15** | O worker precisa ficar ligado. Uma lacuna perde a precisão do horário, mas não o estado | Hospedar o worker num serviço sempre ativo (Railway, Render ou Fly) antes do fim da Etapa 2 | Planejado |

## 7. Cronograma padronizado (fonte única)

| Etapa | Escopo | Critério de saída |
|---|---|---|
| **1. Diagnóstico** ✔ | Este documento, schema, validador, motor de sync | Decisões D1 a D4 tomadas ✔ |
| **2. Piloto Carros Online** ▶ | Banco do piloto (não produção) + validador real + cadastro da unidade + **início da captura (H0)** + classificação de usuários + mapeamento de etapas + conferência de 20 leads | Matriz comprovada; 48 h de sync sem erro; 20/20 leads conferidos |
| **3. Banco consolidado** | Projeto Supabase de produção, Auth dos gestores, backups, política de retenção, `metric_definitions` | Testes de RLS no ambiente real |
| **4. Demais unidades** | Matriz, SPV3 e Shopping (validador → cadastro → sync), por polling | 4 unidades `ok` por 48 h, sem cruzamento de dados |
| **5. Dashboard** | Next.js: Visão Geral, Unidades, Leads, Conversas, SDRs, Vendedores, Funil | Cada número leva aos registros de origem |
| **6. Webhooks** | App privado no Marketplace (Agency only), endpoint com Ed25519 e deduplicação por `webhookId`, polling mantido como rede de segurança | Latência menor que 30 s; nenhum evento duplicado |
| **7. Alertas e auditoria** | Motor de regras, central de alertas, linha do tempo do lead | Uma semana de alertas conferidos com a operação |
| **8. Testes finais e implantação** | Relatórios CSV/PDF, carga, segurança, deploy | Go-live |

O passo a passo da Etapa 2 está em [`02-guia-piloto.md`](02-guia-piloto.md).
