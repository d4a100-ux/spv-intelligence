-- =====================================================================
-- SPV Intelligence — Schema inicial (v0.2)
-- Convenções:
--   * Toda tabela de dados possui unit_id; PK (unit_id, crm_id) preserva o ID original do CRM
--     e impede mistura entre subcontas (o mesmo crm_id em unidades diferentes são linhas distintas).
--   * raw jsonb guarda o payload original (rastreabilidade do indicador até a origem).
--   * Timestamps em timestamptz (UTC); fuso da unidade em units.timezone.
--   * Histórico próprio: a API só fornece estado atual. Cada linha de histórico informa a
--     precisão do horário (time_source) e o limite inferior da janela de detecção (observed_after).
-- Requer: Postgres 15+ (security_invoker em views). Supabase atende.
-- =====================================================================

-- gen_random_uuid() é nativo do Postgres 13+ (não requer pgcrypto).

-- ---------------------------------------------------------------------
-- 1. ORGANIZAÇÃO E INTEGRAÇÃO
-- ---------------------------------------------------------------------
create table units (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9-]+$'),
  name             text not null,
  location_id      text not null unique,
  company_id       text,
  timezone         text not null default 'America/Sao_Paulo',
  -- D4: horário comercial individual. {} = NÃO configurado → métricas em minutos úteis ficam indisponíveis.
  -- Formato: {"mon":[["08:00","12:00"],["13:00","18:00"]], "sat":[["08:00","12:00"]], ...}
  business_hours   jsonb not null default '{}'::jsonb,
  -- Parâmetros da unidade (sem defaults escondidos no código):
  --   active_window_hours (D3, padrão 24), human_sources (padrão ["app"]),
  --   import_sources (D2, lista de valores de `source` que indicam importação; vazio = não classificar),
  --   backfill_contacts_days (90), backfill_conversations_days (30)
  settings         jsonb not null default '{}'::jsonb,
  enabled          boolean not null default true,
  connection_status text not null default 'pending'
    check (connection_status in ('pending','ok','degraded','error','disabled')),
  consecutive_failures int not null default 0,
  last_sync_at        timestamptz,
  last_event_at       timestamptz,
  last_validated_at   timestamptz,
  last_error          text,                 -- sanitizado (sem token/PII)
  -- Marco H0: início da captura histórica = primeira conexão validada. Nunca é sobrescrito.
  history_since       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table unit_holidays (
  unit_id uuid not null references units(id) on delete cascade,
  day     date not null,
  label   text,
  primary key (unit_id, day)
);

-- Tokens: SOMENTE service role (RLS ligada e nenhuma policy).
create table integration_credentials (
  unit_id          uuid primary key references units(id) on delete cascade,
  token_ciphertext bytea not null,          -- AES-256-GCM, chave em CREDENTIALS_KEY (env)
  token_iv         bytea not null,
  token_tag        bytea not null,
  token_last4      text not null,
  api_versions     jsonb not null default '{}'::jsonb,   -- {"contacts":"v3", ...} comprovado pelo validador
  scopes_validated jsonb not null default '{}'::jsonb,   -- {"contacts.readonly":true, ...}
  validation_report jsonb,                               -- resumo do relatório que habilitou a unidade
  rotate_before    date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table app_users (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  role        text not null default 'viewer' check (role in ('admin','manager','viewer')),
  created_at  timestamptz not null default now()
);

create table app_user_units (
  app_user_id uuid references app_users(id) on delete cascade,
  unit_id     uuid references units(id) on delete cascade,
  primary key (app_user_id, unit_id)
);

-- ---------------------------------------------------------------------
-- 2. ESPELHO DO CRM
-- ---------------------------------------------------------------------
create table crm_users (
  unit_id          uuid not null references units(id) on delete cascade,
  crm_id           text not null,
  name             text,
  email            text,
  crm_role         text,
  -- O CRM não distingue SDR de vendedor: classificação manual (scripts/users.ts / tela Configurações).
  operational_role text not null default 'unclassified'
    check (operational_role in ('sdr','seller','manager','other','unclassified')),
  role_updated_at  timestamptz,
  active           boolean not null default true,
  raw              jsonb,
  synced_at        timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table contacts (
  unit_id              uuid not null references units(id) on delete cascade,
  crm_id               text not null,
  name                 text,
  phone                text,
  phone_normalized     text,          -- só dígitos, para detecção de duplicidade (D2)
  email                text,
  email_normalized     text,
  contact_type         text,          -- campo `type` do CRM (lead/customer...)
  source               text,
  attribution          jsonb,
  tags                 text[] not null default '{}',
  assigned_to          text,
  followers            text[] not null default '{}',
  date_added           timestamptz,
  date_updated         timestamptz,
  -- D2: classificação de origem. 'unclassified' até haver regra comprovada.
  origin_class         text not null default 'unclassified'
    check (origin_class in ('new','imported','duplicate','unclassified')),
  duplicate_of         text,          -- crm_id do contato mais antigo com mesmo telefone/e-mail na MESMA unidade
  first_seen_at        timestamptz not null default now(),  -- primeira vez que o SPV Intelligence viu o contato
  captured_live        boolean not null default false,       -- true = criado após H0 (não veio de backfill)
  -- derivados (refresh_contact_derived)
  first_inbound_at         timestamptz,
  first_human_reply_at     timestamptz,
  first_human_reply_by     text,
  last_customer_msg_at     timestamptz,
  last_team_msg_at         timestamptz,
  last_automated_msg_at    timestamptz,
  last_operational_activity_at timestamptz,
  waiting_on               text check (waiting_on in ('team','customer','none')),
  raw                  jsonb,
  synced_at            timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table conversations (
  unit_id            uuid not null references units(id) on delete cascade,
  crm_id             text not null,
  contact_id         text,
  type               text,
  assigned_to        text,
  unread_count       int,
  last_message_at    timestamptz,
  last_message_direction text,
  last_message_type  text,
  messages_synced_at timestamptz,
  raw                jsonb,
  synced_at          timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table messages (
  unit_id          uuid not null references units(id) on delete cascade,
  crm_id           text not null,
  conversation_id  text not null,
  contact_id       text,
  direction        text check (direction in ('inbound','outbound')),
  source           text,
  is_human         boolean,           -- null = não determinável (source ausente)
  user_id          text,
  message_type     text,
  status           text,
  body_preview     text,              -- truncado (LGPD)
  date_added       timestamptz not null,
  raw              jsonb,
  first_seen_at    timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table pipelines (
  unit_id    uuid not null references units(id) on delete cascade,
  crm_id     text not null,
  name       text not null,
  raw        jsonb,
  synced_at  timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table pipeline_stages (
  unit_id     uuid not null references units(id) on delete cascade,
  crm_id      text not null,
  pipeline_id text not null,
  name        text not null,
  position    int,
  primary key (unit_id, crm_id),
  foreign key (unit_id, pipeline_id) references pipelines(unit_id, crm_id) on delete cascade
);

create table canonical_stages (
  key         text primary key,
  label       text not null,
  position    int not null,
  is_terminal boolean not null default false,
  outcome     text check (outcome in ('won','lost') or outcome is null)
);

insert into canonical_stages (key,label,position,is_terminal,outcome) values
 ('novo_lead','Novo lead',10,false,null),
 ('em_atendimento','Em atendimento',20,false,null),
 ('nao_respondeu','Não respondeu',30,false,null),
 ('qualificado','Qualificado',40,false,null),
 ('negociacao','Negociação ativa',50,false,null),
 ('transferencia','Transferência SDR/vendedor',60,false,null),
 ('nutrir','Nutrir',70,false,null),
 ('visita_agendada','Visita agendada',80,false,null),
 ('visita_confirmada','Visita confirmada',90,false,null),
 ('visita_realizada','Visita realizada',100,false,null),
 ('nao_compareceu','Não compareceu',110,false,null),
 ('proposta','Proposta',120,false,null),
 ('aguardando_carro','Aguardando carro',130,false,null),
 ('ficha_negada','Ficha negada',140,true,'lost'),
 ('vendido','Vendido',150,true,'won'),
 ('sem_interesse','Sem interesse',160,true,'lost'),
 ('perdido','Perdido',170,true,'lost');

create table stage_mappings (
  unit_id       uuid not null,
  stage_id      text not null,
  canonical_key text not null references canonical_stages(key),
  primary key (unit_id, stage_id),
  foreign key (unit_id, stage_id) references pipeline_stages(unit_id, crm_id) on delete cascade
);

create table opportunities (
  unit_id               uuid not null references units(id) on delete cascade,
  crm_id                text not null,
  contact_id            text,
  pipeline_id           text,
  stage_id              text,
  status                text,
  assigned_to           text,
  followers             text[] not null default '{}',
  monetary_value        numeric,
  source                text,
  lost_reason_id        text,
  created_at_crm        timestamptz,
  updated_at_crm        timestamptz,
  last_stage_change_at  timestamptz,
  last_status_change_at timestamptz,
  last_action_at        timestamptz,
  first_seen_at         timestamptz not null default now(),
  last_seen_in_scan_at  timestamptz,
  raw                   jsonb,
  synced_at             timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table calendars (
  unit_id    uuid not null references units(id) on delete cascade,
  crm_id     text not null,
  name       text,
  active     boolean not null default true,
  raw        jsonb,
  synced_at  timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table appointments (
  unit_id            uuid not null references units(id) on delete cascade,
  crm_id             text not null,
  calendar_id        text,
  contact_id         text,
  assigned_user_id   text,
  users              text[] not null default '{}',
  title              text,
  appointment_status text,
  start_time         timestamptz,
  end_time           timestamptz,
  date_added         timestamptz,
  date_updated       timestamptz,
  raw                jsonb,
  first_seen_at      timestamptz not null default now(),
  synced_at          timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

create table tasks (
  unit_id      uuid not null references units(id) on delete cascade,
  crm_id       text not null,
  contact_id   text,
  assigned_to  text,
  title        text,
  completed    boolean,
  due_date     timestamptz,
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  primary key (unit_id, crm_id)
);

-- ---------------------------------------------------------------------
-- 3. HISTÓRICO PRÓPRIO (prioridade: responsáveis, seguidores, etapas, agendamentos)
--   time_source: 'crm_field'  = horário exato vindo do CRM (ex.: lastStageChangeAt)
--                'crm_updated'= dateUpdated do registro (limite superior aproximado)
--                'detected'   = momento em que o polling percebeu a mudança
--                'snapshot'   = estado inicial na primeira captura (não é uma mudança)
--   observed_after: última vez que o valor anterior foi observado (limite inferior da janela)
-- ---------------------------------------------------------------------
create table contact_assignment_history (
  id             bigint generated always as identity primary key,
  unit_id        uuid not null references units(id) on delete cascade,
  contact_id     text not null,
  from_user      text,
  to_user        text,
  changed_at     timestamptz not null,
  observed_after timestamptz,
  time_source    text not null check (time_source in ('crm_field','crm_updated','detected','snapshot','webhook')),
  detected_by    text not null check (detected_by in ('webhook','poll','backfill'))
);

create table contact_follower_history (
  id             bigint generated always as identity primary key,
  unit_id        uuid not null references units(id) on delete cascade,
  contact_id     text not null,
  opportunity_id text,               -- null = seguidor do contato; preenchido = seguidor da oportunidade
  user_id        text not null,
  action         text not null check (action in ('added','removed','snapshot')),
  changed_at     timestamptz not null,
  observed_after timestamptz,
  time_source    text not null check (time_source in ('crm_field','crm_updated','detected','snapshot','webhook')),
  detected_by    text not null check (detected_by in ('webhook','poll','backfill'))
);

create table opportunity_history (
  id              bigint generated always as identity primary key,
  unit_id         uuid not null references units(id) on delete cascade,
  opportunity_id  text not null,
  contact_id      text,
  field           text not null check (field in ('stage','status','assigned_to','pipeline')),
  old_value       text,
  new_value       text,
  changed_at      timestamptz not null,
  observed_after  timestamptz,
  time_source     text not null check (time_source in ('crm_field','crm_updated','detected','snapshot','webhook')),
  detected_by     text not null check (detected_by in ('webhook','poll','backfill'))
);

create table appointment_history (
  id              bigint generated always as identity primary key,
  unit_id         uuid not null references units(id) on delete cascade,
  appointment_id  text not null,
  contact_id      text,
  field           text not null check (field in ('appointment_status','start_time','assigned_user_id','created')),
  old_value       text,
  new_value       text,
  changed_at      timestamptz not null,
  observed_after  timestamptz,
  time_source     text not null check (time_source in ('crm_field','crm_updated','detected','snapshot','webhook')),
  detected_by     text not null check (detected_by in ('webhook','poll','backfill'))
);

-- Vendedor adicionado como seguidor (prática das SDRs para compartilhar sem trocar a atribuição).
-- NÃO é uma transferência concluída: status começa em 'awaiting_seller' e só muda com atuação real.
create table seller_handoffs (
  id                     bigint generated always as identity primary key,
  unit_id                uuid not null references units(id) on delete cascade,
  contact_id             text not null,
  opportunity_id         text,
  seller_user_id         text not null,
  responsible_at_detection text,      -- assignedTo (SDR) no momento da detecção — não prova quem adicionou
  follower_history_id    bigint references contact_follower_history(id),
  added_at               timestamptz not null,
  observed_after         timestamptz,
  first_seller_action_at timestamptz,
  first_seller_action    text,        -- 'message' | 'appointment' | 'stage_change'
  status                 text not null default 'awaiting_seller'
    check (status in ('awaiting_seller','seller_acted','follower_removed')),
  updated_at             timestamptz not null default now()
);
create unique index uq_handoff_open on seller_handoffs (unit_id, contact_id, seller_user_id)
  where status = 'awaiting_seller';

-- ---------------------------------------------------------------------
-- 4. INGESTÃO, FILAS E MONITORAMENTO
-- ---------------------------------------------------------------------
create table crm_events (
  id           bigint generated always as identity primary key,
  unit_id      uuid not null references units(id) on delete cascade,
  event_key    text not null,
  event_type   text not null,
  origin       text not null check (origin in ('webhook','poll')),
  occurred_at  timestamptz,
  received_at  timestamptz not null default now(),
  payload      jsonb not null,
  processed_at timestamptz,
  error        text,
  unique (unit_id, event_key)
);

-- Fila isolada por unidade: cada worker reivindica jobs de UMA unidade por vez (claim_job),
-- sob advisory lock por unidade. Falha/limite de uma subconta não bloqueia as demais.
create table jobs (
  id          bigint generated always as identity primary key,
  unit_id     uuid not null references units(id) on delete cascade,
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  priority    int not null default 100,          -- menor = mais urgente
  status      text not null default 'queued' check (status in ('queued','running','done','failed','skipped')),
  attempts    int not null default 0,
  max_attempts int not null default 5,
  run_after   timestamptz not null default now(),
  locked_at   timestamptz,
  finished_at timestamptz,
  last_error  text,
  created_at  timestamptz not null default now(),
  dedupe_key  text unique
);

create table sync_cursors (
  unit_id     uuid not null references units(id) on delete cascade,
  resource    text not null,
  cursor      jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (unit_id, resource)
);

create table sync_logs (
  id               bigint generated always as identity primary key,
  unit_id          uuid not null references units(id) on delete cascade,
  job_id           bigint references jobs(id) on delete set null,
  resource         text not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  duration_ms      int,
  status           text not null check (status in ('running','ok','partial','error')),
  requests         int not null default 0,
  records_upserted int not null default 0,
  changes_detected int not null default 0,
  rate_limit_remaining int,
  daily_remaining  int,
  error_class      text check (error_class in ('auth','scope','rate_limit','bad_request','server','network','internal') or error_class is null),
  http_status      int,
  error            text             -- sanitizado: nunca contém token ou PII
);

-- ---------------------------------------------------------------------
-- 5. INTELIGÊNCIA
-- ---------------------------------------------------------------------
create table operational_alerts (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units(id) on delete cascade,
  rule_key       text not null,
  priority       text not null check (priority in ('critical','high','medium','low')),
  contact_id     text,
  opportunity_id text,
  responsible_user text,
  title          text not null,
  details        jsonb not null default '{}'::jsonb,
  started_at     timestamptz not null,
  detected_at    timestamptz not null default now(),
  status         text not null default 'open' check (status in ('open','acknowledged','resolved','auto_resolved')),
  resolved_at    timestamptz
);
create unique index uq_alert_open on operational_alerts
  (unit_id, rule_key, coalesce(contact_id,''), coalesce(opportunity_id,''))
  where status in ('open','acknowledged');

create table alert_events (
  id         bigint generated always as identity primary key,
  alert_id   uuid not null references operational_alerts(id) on delete cascade,
  action     text not null,
  actor      uuid references app_users(id),
  note       text,
  created_at timestamptz not null default now()
);

create table metric_definitions (
  key          text primary key,
  name         text not null,
  kind         text not null check (kind in ('stock','flow')),
  objective    text not null,
  formula      text not null,
  data_source  text not null,
  periodicity  text not null,
  inclusion    text,
  exclusion    text,
  availability text not null default 'available' check (availability in ('available','partial','unavailable')),
  availability_note text
);

create table metric_snapshots (
  id           bigint generated always as identity primary key,
  unit_id      uuid references units(id) on delete cascade,   -- null = consolidado
  metric_key   text not null references metric_definitions(key),
  dimension    jsonb not null default '{}'::jsonb,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  value        numeric,
  computed_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 6. ÍNDICES
-- ---------------------------------------------------------------------
create index on contacts (unit_id, date_added desc);
create index on contacts (unit_id, date_updated desc);
create index on contacts (unit_id, assigned_to);
create index on contacts (unit_id, last_operational_activity_at);
create index on contacts (unit_id, waiting_on) where waiting_on is not null;
create index on contacts (unit_id) where first_human_reply_at is null;
create index on contacts (unit_id, phone_normalized) where phone_normalized is not null;
create index on contacts (unit_id, email_normalized) where email_normalized is not null;
create index on contacts using gin (followers);
create index on conversations (unit_id, last_message_at desc);
create index on conversations (unit_id, contact_id);
create index on messages (unit_id, conversation_id, date_added);
create index on messages (unit_id, contact_id, date_added);
create index on messages (unit_id, user_id, date_added) where is_human;
create index on opportunities (unit_id, stage_id);
create index on opportunities (unit_id, status);
create index on opportunities (unit_id, assigned_to);
create index on opportunities (unit_id, contact_id);
create index on opportunities (unit_id, last_stage_change_at desc);
create index on appointments (unit_id, start_time);
create index on appointments (unit_id, appointment_status);
create index on appointments (unit_id, contact_id);
create index on opportunity_history (unit_id, opportunity_id, changed_at);
create index on contact_assignment_history (unit_id, contact_id, changed_at);
create index on contact_follower_history (unit_id, contact_id, changed_at);
create index on appointment_history (unit_id, appointment_id, changed_at);
create index on seller_handoffs (unit_id, seller_user_id, status);
create index on crm_events (unit_id, received_at desc);
create index on crm_events (processed_at) where processed_at is null;
create index on jobs (unit_id, status, priority, run_after) where status = 'queued';
create index on jobs (unit_id, kind, created_at desc);
create index on sync_logs (unit_id, resource, started_at desc);
create index on operational_alerts (unit_id, status, priority);
create index on metric_snapshots (metric_key, unit_id, period_start desc);

-- ---------------------------------------------------------------------
-- 7. FUNÇÕES
-- ---------------------------------------------------------------------

-- D4: minutos úteis entre dois instantes, no fuso e horário da unidade, descontando feriados.
-- Retorna NULL quando a unidade não tem horário configurado (indicador = indisponível, não zero).
create or replace function business_minutes(p_unit uuid, p_start timestamptz, p_end timestamptz)
returns numeric language plpgsql stable as $$
declare
  tz text; bh jsonb; d date; total numeric := 0; win jsonb; ws timestamptz; we timestamptz; dow text;
begin
  if p_start is null or p_end is null then return null; end if;
  select timezone, business_hours into tz, bh from units where id = p_unit;
  if bh is null or bh = '{}'::jsonb then return null; end if;
  if p_end <= p_start then return 0; end if;
  for d in select generate_series((p_start at time zone tz)::date, (p_end at time zone tz)::date, interval '1 day')::date loop
    continue when exists (select 1 from unit_holidays h where h.unit_id = p_unit and h.day = d);
    dow := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
    for win in select value from jsonb_array_elements(coalesce(bh->dow, '[]'::jsonb)) loop
      ws := (d + (win->>0)::time) at time zone tz;
      we := (d + (win->>1)::time) at time zone tz;
      total := total + greatest(0, extract(epoch from (least(we, p_end) - greatest(ws, p_start))) / 60.0);
    end loop;
  end loop;
  return round(total, 1);
end $$;

-- Recalcula os campos derivados de um contato a partir de messages/opportunities/appointments.
create or replace function refresh_contact_derived(p_unit uuid, p_contact text)
returns void language sql as $$
  with m as (
    select
      min(date_added) filter (where direction = 'inbound')                as first_in,
      max(date_added) filter (where direction = 'inbound')                as last_in,
      max(date_added) filter (where direction = 'outbound' and is_human)  as last_team,
      max(date_added) filter (where direction = 'outbound' and is_human is not true) as last_auto
    from messages where unit_id = p_unit and contact_id = p_contact
  ), fr as (
    select date_added, user_id from messages
    where unit_id = p_unit and contact_id = p_contact and direction = 'outbound' and is_human
    order by date_added asc limit 1
  ), o as (
    select max(last_stage_change_at) as last_stage from opportunities where unit_id = p_unit and contact_id = p_contact
  ), a as (
    select max(greatest(date_added, date_updated)) as last_appt from appointments where unit_id = p_unit and contact_id = p_contact
  )
  update contacts c set
    first_inbound_at      = m.first_in,
    last_customer_msg_at  = m.last_in,
    last_team_msg_at      = m.last_team,
    last_automated_msg_at = m.last_auto,
    first_human_reply_at  = (select date_added from fr),
    first_human_reply_by  = (select user_id from fr),
    waiting_on = case
      when m.last_in is not null and (m.last_team is null or m.last_in > m.last_team) then 'team'
      when m.last_team is not null then 'customer'
      else 'none' end,
    -- automação NÃO conta como movimentação operacional
    last_operational_activity_at = greatest(c.date_added, m.last_team, m.last_in, o.last_stage, a.last_appt)
  from m, o, a
  where c.unit_id = p_unit and c.crm_id = p_contact;
$$;

-- D2: duplicidade = mesmo telefone ou e-mail normalizado de um contato MAIS ANTIGO na MESMA unidade.
-- Importação = `source` contido em units.settings.import_sources (só quando a gestão configurar).
create or replace function classify_contact_origin(p_unit uuid, p_contact text)
returns void language sql as $$
  update contacts c set
    duplicate_of = d.crm_id,
    origin_class = case
      when d.crm_id is not null then 'duplicate'
      when c.source is not null and coalesce(u.settings->'import_sources','[]'::jsonb) ? c.source then 'imported'
      when jsonb_array_length(coalesce(u.settings->'import_sources','[]'::jsonb)) > 0 then 'new'
      else 'unclassified' end
  from units u
  left join lateral (
    select o.crm_id from contacts o, contacts me
    where me.unit_id = p_unit and me.crm_id = p_contact
      and o.unit_id = p_unit and o.crm_id <> p_contact
      and o.date_added < me.date_added
      and ((me.phone_normalized is not null and o.phone_normalized = me.phone_normalized)
        or (me.email_normalized is not null and o.email_normalized = me.email_normalized))
    order by o.date_added asc limit 1
  ) d on true
  where u.id = p_unit and c.unit_id = p_unit and c.crm_id = p_contact;
$$;

-- Atualiza handoffs pendentes quando o vendedor atua (mensagem humana, agendamento ou mudança de etapa).
create or replace function refresh_seller_handoffs(p_unit uuid, p_contact text)
returns void language sql as $$
  with acts as (
    select h.id,
      (select min(m.date_added) from messages m
        where m.unit_id = h.unit_id and m.contact_id = h.contact_id and m.is_human
          and m.direction = 'outbound' and m.user_id = h.seller_user_id and m.date_added >= coalesce(h.observed_after, h.added_at)) as msg_at,
      (select min(coalesce(a.date_added, a.first_seen_at)) from appointments a
        where a.unit_id = h.unit_id and a.contact_id = h.contact_id
          and (a.assigned_user_id = h.seller_user_id) and coalesce(a.date_added, a.first_seen_at) >= coalesce(h.observed_after, h.added_at)) as appt_at
    from seller_handoffs h
    where h.unit_id = p_unit and h.contact_id = p_contact and h.status = 'awaiting_seller'
  )
  update seller_handoffs h set
    status = 'seller_acted',
    first_seller_action_at = least(acts.msg_at, acts.appt_at),
    first_seller_action = case when acts.msg_at is not null and (acts.appt_at is null or acts.msg_at <= acts.appt_at) then 'message' else 'appointment' end,
    updated_at = now()
  from acts
  where h.id = acts.id and (acts.msg_at is not null or acts.appt_at is not null);
$$;

-- Reconstrói handoffs a partir do histórico de seguidores (usado quando um usuário é
-- classificado como vendedor DEPOIS de já ter sido adicionado como seguidor).
create or replace function rebuild_seller_handoffs(p_unit uuid)
returns int language plpgsql as $$
declare n int;
begin
  insert into seller_handoffs (unit_id, contact_id, opportunity_id, seller_user_id, follower_history_id, added_at, observed_after)
  select distinct on (f.contact_id, f.user_id)
         f.unit_id, f.contact_id, f.opportunity_id, f.user_id, f.id, f.changed_at, f.observed_after
  from contact_follower_history f
  join crm_users u on u.unit_id = f.unit_id and u.crm_id = f.user_id and u.operational_role = 'seller'
  where f.unit_id = p_unit and f.action in ('added','snapshot')
    and not exists (select 1 from seller_handoffs s where s.unit_id = f.unit_id and s.contact_id = f.contact_id and s.seller_user_id = f.user_id)
  order by f.contact_id, f.user_id, f.changed_at desc
  on conflict do nothing;
  get diagnostics n = row_count;
  perform refresh_seller_handoffs(p_unit, c) from (select distinct contact_id c from seller_handoffs where unit_id = p_unit and status='awaiting_seller') x;
  return n;
end $$;

-- Reivindica o próximo job de UMA unidade (fila isolada por subconta).
create or replace function claim_job(p_unit uuid)
returns setof jobs language sql as $$
  update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
  where id = (
    select id from jobs
    where unit_id = p_unit and status = 'queued' and run_after <= now()
    order by priority, run_after, id
    for update skip locked limit 1)
  returning *;
$$;

-- ---------------------------------------------------------------------
-- 8. VIEWS
-- ---------------------------------------------------------------------

-- D3: conversa ativa = na janela (padrão 24h) há >= 1 inbound do cliente E >= 1 outbound HUMANA.
-- Estado da conversa: expõe se o contato está só com oportunidades em etapa terminal
-- (os indicadores comerciais filtram is_commercially_open = true).
create view v_active_conversations with (security_invoker = true) as
select c.unit_id, c.crm_id as conversation_id, c.contact_id, c.assigned_to,
       w.last_in, w.last_team,
       not exists (
         select 1 from opportunities o
         where o.unit_id = c.unit_id and o.contact_id = c.contact_id and o.status = 'open'
       ) and exists (
         select 1 from opportunities o where o.unit_id = c.unit_id and o.contact_id = c.contact_id
       ) as all_opportunities_closed,
       coalesce((select o.status = 'open' from opportunities o
                 where o.unit_id = c.unit_id and o.contact_id = c.contact_id
                 order by o.status = 'open' desc limit 1), true) as is_commercially_open
from conversations c
join units u on u.id = c.unit_id
cross join lateral (
  select max(m.date_added) filter (where m.direction = 'inbound') as last_in,
         max(m.date_added) filter (where m.direction = 'outbound' and m.is_human) as last_team
  from messages m
  where m.unit_id = c.unit_id and m.conversation_id = c.crm_id
    and m.date_added >= now() - make_interval(hours => coalesce((u.settings->>'active_window_hours')::int, 24))
) w
where w.last_in is not null and w.last_team is not null;

-- Saúde da integração por unidade (monitoramento antes da interface existir).
create view v_integration_health with (security_invoker = true) as
select u.id as unit_id, u.slug, u.name, u.enabled, u.connection_status, u.consecutive_failures,
       u.last_sync_at, u.last_validated_at, u.history_since, u.last_error,
       (select count(*) from jobs j where j.unit_id = u.id and j.status = 'queued') as jobs_queued,
       (select count(*) from jobs j where j.unit_id = u.id and j.status = 'failed' and j.finished_at > now() - interval '24 hours') as jobs_failed_24h,
       (select count(*) from sync_logs s where s.unit_id = u.id and s.status = 'error' and s.started_at > now() - interval '1 hour') as sync_errors_1h,
       (select min(s.daily_remaining) from sync_logs s where s.unit_id = u.id and s.started_at > now() - interval '1 hour') as min_daily_remaining_1h,
       (select jsonb_object_agg(resource, last_ok) from (
          select s.resource, max(s.finished_at) as last_ok from sync_logs s
          where s.unit_id = u.id and s.status in ('ok','partial') group by s.resource) r) as last_ok_by_resource
from units u;

-- ---------------------------------------------------------------------
-- 9. SEGURANÇA (RLS)
-- ---------------------------------------------------------------------
create or replace function public.has_unit_access(u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users au
    where au.id = auth.uid()
      and (au.role = 'admin'
           or exists (select 1 from app_user_units x where x.app_user_id = au.id and x.unit_id = u))
  );
$$;

do $$
declare t text;
begin
  foreach t in array array[
    'crm_users','contacts','conversations','messages','pipelines','pipeline_stages',
    'stage_mappings','opportunities','calendars','appointments','tasks','unit_holidays',
    'contact_assignment_history','contact_follower_history','opportunity_history',
    'appointment_history','seller_handoffs','operational_alerts','sync_logs'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I for select to authenticated using (public.has_unit_access(unit_id))',
                   t || '_read', t);
  end loop;
end $$;

alter table units enable row level security;
create policy units_read on units for select to authenticated using (public.has_unit_access(id));

alter table metric_snapshots enable row level security;
create policy metric_snapshots_read on metric_snapshots for select to authenticated
  using (unit_id is null or public.has_unit_access(unit_id));

alter table alert_events enable row level security;
create policy alert_events_read on alert_events for select to authenticated
  using (exists (select 1 from operational_alerts a where a.id = alert_id and public.has_unit_access(a.unit_id)));

alter table app_users enable row level security;
create policy app_users_self on app_users for select to authenticated using (id = auth.uid());
alter table app_user_units enable row level security;
create policy app_user_units_self on app_user_units for select to authenticated using (app_user_id = auth.uid());

alter table canonical_stages enable row level security;
create policy canonical_read on canonical_stages for select to authenticated using (true);
alter table metric_definitions enable row level security;
create policy metric_defs_read on metric_definitions for select to authenticated using (true);

-- Sem policies = inacessível a anon/authenticated (somente service role / worker):
alter table integration_credentials enable row level security;
alter table crm_events enable row level security;
alter table jobs enable row level security;
alter table sync_cursors enable row level security;

-- Funções de escrita: não expor via API pública
revoke execute on function claim_job(uuid) from public;
revoke execute on function rebuild_seller_handoffs(uuid) from public;
revoke execute on function refresh_contact_derived(uuid, text) from public;
revoke execute on function classify_contact_origin(uuid, text) from public;
revoke execute on function refresh_seller_handoffs(uuid, text) from public;

-- Realtime para a UI
alter publication supabase_realtime add table operational_alerts, metric_snapshots, units;
