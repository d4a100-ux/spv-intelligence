# SPV Intelligence

Central de inteligência, monitoramento e gestão operacional do Grupo SPV. O sistema lê as subcontas do WeSales / LeadConnector e **não escreve** no CRM.

- **Diagnóstico técnico e cronograma:** [docs/01-diagnostico-tecnico.md](docs/01-diagnostico-tecnico.md)
- **Guia do piloto (Etapa 2):** [docs/02-guia-piloto.md](docs/02-guia-piloto.md)

## Estrutura

```
src/integrations/leadconnector/  cliente REST por unidade, rate limit, erros
src/sync/                        sincronização incremental por recurso
src/processing/                  histórico (responsáveis, seguidores, etapas, agendamentos) e vendedor seguidor
src/worker/                      fila isolada por unidade, agendamento, logs e monitoramento
src/units/                       carga de credenciais (token cifrado)
scripts/                         validate, unit:register, users, status, sample, key:generate
supabase/migrations/             schema (Postgres/Supabase)
test/                            testes em Postgres real em memória (PGlite)
```

## Comandos

| Comando | Função |
|---|---|
| `npm test` | Testes de schema e de sync (não acessam a API nem o banco real) |
| `npm run typecheck` | Verificação de tipos |
| `npm run validate` | Validador real de uma subconta (somente leitura) |
| `npm run unit:register -- --slug X --name "Y"` | Cadastra a unidade e marca o H0 |
| `npm run worker [-- --unit X] [-- --once]` | Sincronização contínua |
| `npm run status` | Saúde da integração e volume capturado |
| `npm run users -- list/set ...` | Classificação de SDRs e vendedores |
| `npm run sample -- --unit X` | Amostra para conferência manual |

Segredos ficam apenas em `.env.local`, que não entra no git. Veja o modelo em [.env.example](.env.example).
