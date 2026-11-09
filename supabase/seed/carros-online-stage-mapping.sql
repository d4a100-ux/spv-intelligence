-- Mapeamento das etapas reais da Carros Online → funil canônico do Grupo SPV.
-- Fonte: relatório do validador de 06/11/2026 (pipeline "FUNIL DE VENDAS").
-- STATUS: PROPOSTA — aplicar somente após aprovação da gestão e após o 1º sync de pipelines
-- (stage_mappings exige que pipeline_stages já exista).
-- O pipeline "Recuperação de Base — Ligação" fica FORA do funil comercial de propósito
-- (reativação de base; será analisado separadamente).

with u as (select id from units where slug = 'carros-online')
insert into stage_mappings (unit_id, stage_id, canonical_key)
select u.id, m.stage_id, m.canonical_key from u, (values
  ('361b4d24-de26-4d78-9cd5-34f412f59207', 'novo_lead'),          -- NOVO LEAD
  ('ecb467eb-1377-454d-b7f5-a2afb392cff6', 'em_atendimento'),     -- EM ATENDIMENTO
  ('5c507454-3f72-435a-b03e-e53893c2c4d5', 'nao_respondeu'),      -- NÃO RESPONDEU
  ('4a8f43ab-2238-4f38-a441-d18b0c8c0fd8', 'qualificado'),        -- QUALIFICADO
  ('23037061-b4c4-4453-8114-cc07c20d6633', 'negociacao'),         -- EM NEGOCIAÇÃO ATIVA
  ('738f1ba1-94ff-461c-9af5-743342ab843d', 'transferencia'),      -- TRANSFERÊNCIA SDR - VENDEDOR
  ('faf47788-2382-4119-aad4-9aebb6a5dc20', 'nutrir'),             -- PESQUISANDO - NUTRIR LEAD
  ('80526784-f73c-4b97-80e2-55146295b02a', 'visita_agendada'),    -- VISITA AGENDADA
  ('0ce0aa39-6392-4421-98af-d7cf86de0e43', 'visita_confirmada'),  -- VISITA CONFIRMADA - D1
  ('f8d44076-facc-4d22-892d-2a58f2ccf24f', 'visita_realizada'),   -- VISITA REALIZADA
  ('6804f102-2b72-4c47-9d52-a8c7ed7583fb', 'nao_compareceu'),     -- NÃO COMPARECEU
  ('ab3b0ad3-9f2b-48ce-897a-08460d8d1873', 'proposta'),           -- PROPOSTA/NEGOCIAÇÃO
  ('eb91418f-5b8b-470b-ad0b-66a7eb52dabd', 'vendido'),            -- VENDIDO
  ('841cf758-0ec9-48f5-87b5-3aba3b0c4d86', 'sem_interesse'),      -- NÃO TEM INTERESSE
  ('3ebe187c-8c65-4e38-8da6-a5e73ef78873', 'sem_contato'),        -- NÃO CONSEGUIU CONTATO
  ('d74f23a7-9b48-4aab-94c2-85d2001333dd', 'perdido'),            -- PERDIDO
  ('eea9df3b-5e57-4404-837e-7f518e7260a2', 'ficha_negada'),       -- FICHA NEGADA
  ('1b5641c1-49b7-4420-b1c6-8a2b7195b17f', 'aguardando_carro')    -- AGUARDANDO CARRO NO ESTOQUE
) as m(stage_id, canonical_key)
on conflict (unit_id, stage_id) do update set canonical_key = excluded.canonical_key;
