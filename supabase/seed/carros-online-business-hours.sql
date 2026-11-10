-- Horário comercial da Carros Online (D4), informado pela gestão em 10/11/2026:
--   Segunda a sexta: 08:00–18:00 · Sábado: 08:00–13:00 · Domingo: fechado
-- Fuso: America/Sao_Paulo (units.timezone). Feriados: tabela unit_holidays (ainda não informados).
update units
set business_hours = '{
  "mon": [["08:00","18:00"]],
  "tue": [["08:00","18:00"]],
  "wed": [["08:00","18:00"]],
  "thu": [["08:00","18:00"]],
  "fri": [["08:00","18:00"]],
  "sat": [["08:00","13:00"]]
}'::jsonb,
    updated_at = now()
where slug = 'carros-online';
