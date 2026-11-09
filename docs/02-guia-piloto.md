# Etapa 2: Guia do Piloto (Carros Online)

> Objetivo: integração piloto funcionando, matriz de disponibilidade **comprovada com dados reais** e captura histórica iniciada (marco H0).
> Regra de segurança: **token, senha do banco e chave de cifragem só são digitados no arquivo `.env.local` da sua máquina.** Nunca em chat, e-mail, print ou código.

**Informações indispensáveis, todas preenchidas por você no `.env.local`:**

| Variável | Onde obter | Necessária a partir do passo |
|---|---|---|
| `LC_LOCATION_ID` | Location ID da Carros Online | 4 |
| `LC_PIT` | Token da Private Integration | 4 |
| `DATABASE_URL` | Projeto Supabase **do piloto** | 7 |
| `CREDENTIALS_KEY` | `npm run key:generate` | 7 |

Fora do `.env.local`, só preciso de **duas respostas de negócio** (podem vir no chat): o horário comercial da Carros Online (D4) e quem é SDR e quem é vendedor (passo 7).

---

## Passo 1: Repositório Git privado

O repositório local já foi criado com o commit inicial. Para publicá-lo como **privado** no GitHub:

```powershell
gh auth login                       # login interativo no navegador
gh repo create spv-intelligence --private --source . --remote origin --push
```

Confira que o `.gitignore` está protegendo os arquivos sensíveis:

```powershell
git status --ignored                # .env.local e reports/ devem aparecer como ignorados
```

## Passo 2: Revisar o SQL e o validador

Já revisado e testado: `npm test` roda 17 testes num Postgres real em memória, **sem tocar em nenhum banco**. Pontos para a gestão conferir:

| Arquivo | O que conferir |
|---|---|
| [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) | Lista do funil canônico (`canonical_stages`): os 17 estágios do briefing + `sem_contato` (comprovado na Carros Online) |
| [`scripts/validate-unit.ts`](../scripts/validate-unit.ts) | Somente leitura (GET e uma busca POST). Não imprime token nem dados de clientes |

```powershell
npm install
npm test          # esperado: 17 pass, 0 fail
```

## Passo 3: Criar a Private Integration na Carros Online

1. No WeSales, entre na subconta **Carros Online**.
2. Abra **Configurações → Private Integrations → Create new Integration**.
3. Preencha o nome `SPV Intelligence (somente leitura)` e a descrição `Monitoramento operacional — sem escrita`.
4. Marque **somente** estes 9 escopos. O nome exibido na tela pode variar um pouco; confira sempre pelo código do escopo:
   - `View Locations` / `locations.readonly`
   - `View Users` / `users.readonly`
   - `View Contacts` / `contacts.readonly`
   - `View Conversations` / `conversations.readonly`
   - `View Conversation Messages` / `conversations/message.readonly`
   - `View Opportunities` / `opportunities.readonly`
   - `View Calendars` / `calendars.readonly`
   - `View Calendar Events` / `calendars/events.readonly`
   - `View Custom Fields` / `locations/customFields.readonly`
5. Clique em **Create**. O token aparece **uma única vez**. Copie e cole direto no `.env.local` (passo 4), sem salvar em nenhum outro lugar.
6. Anote o **Location ID**. Ele aparece em Configurações → Perfil da Empresa, ou na URL do CRM (`/location/<ID>/`).

## Passo 4: Executar o validador

```powershell
copy .env.example .env.local
notepad .env.local      # preencha LC_PIT e LC_LOCATION_ID; salve
npm run validate
```

O validador faz cerca de 30 requisições de leitura e imprime uma linha por endpoint, depois a **MATRIZ DE DISPONIBILIDADE**. O relatório completo fica em `reports/validation-<LocationID>-<data>.json`.

## Passo 5: Analisar o relatório JSON

O relatório **não contém token nem dados de clientes**. Ele traz apenas:
- status HTTP;
- contagens;
- nomes de campos;
- nomes de etapas e de campos personalizados;
- valores de `source` e `appointmentStatus`.

Antes de enviar, abra e confira. Depois cole o conteúdo aqui no chat. Com ele eu:

1. fecho a matriz (cada ⚠️ vira ✅ ou ❌);
2. defino a regra humano × automação (R3) a partir de `outbound.source × userId`;
3. proponho o mapeamento das etapas reais para o funil canônico (você aprova);
4. proponho `import_sources` (D2) a partir dos valores reais de `source` (você aprova).

## Passo 6: Corrigir autenticação, permissões e paginação

| Sintoma no validador | Causa provável | Correção |
|---|---|---|
| `401` em tudo | Token errado, de outra subconta ou com espaço extra | Gere um novo token (passo 3) e cole sem aspas nem espaços |
| `403` num item | Escopo não marcado | Edite a Private Integration e marque o escopo. O token **não muda** ao editar escopos |
| `400/422` com as duas versões | Parâmetro não aceito nesta conta | Me envie o relatório: o campo `versionsTried` e a nota de erro indicam o ajuste |
| `pag=FALHOU` | Cursor de paginação diferente do documentado | Me envie o relatório. O `unit:register` **se recusa** a iniciar a sync com paginação falhando |
| `users` sem `companyId` | `locations.readonly` ausente | Marque o escopo |
| `calendars.events n=0` | Sem agendamentos nos últimos ±30 dias, ou calendários de grupo | Não bloqueia. Avaliamos pelo relatório |

Depois de cada correção, rode `npm run validate` de novo.

## Passo 7: Começar a sincronização real

**7.1 Banco do piloto.** É um projeto Supabase **separado da produção**.
1. Em supabase.com, clique em **New project** e use o nome `spv-intelligence-piloto`. Escolha a região São Paulo (`sa-east-1`) e uma senha forte, guardada no seu cofre de senhas.
2. Vá em **SQL Editor → New query**, cole todo o conteúdo de `supabase/migrations/0001_init.sql` e clique em **Run**. Isso é feito por você, no banco do piloto.
3. Vá em **Project Settings → Database → Connection string → Session pooler**, copie a URL para `DATABASE_URL` no `.env.local` e troque `[YOUR-PASSWORD]` pela senha.

> O histórico capturado neste projeto **é o histórico real** a partir do H0. Na Etapa 3, este projeto é promovido a produção ou tem os dados migrados com `pg_dump`. Ele **não** deve ser apagado.

**7.2 Chave de cifragem**
```powershell
npm run key:generate       # copie a saída para CREDENTIALS_KEY no .env.local e guarde no cofre de senhas
```

**7.3 Cadastrar a unidade (início do H0)**
```powershell
npm run unit:register -- --slug carros-online --name "Carros Online"
```
- O cadastro só funciona com relatório aprovado e paginação OK.
- O token é cifrado e gravado.
- O marco H0 é definido e a carga inicial é enfileirada.
- **Depois disso, apague `LC_PIT` do `.env.local`.**

**7.4 Iniciar o worker (a captura começa aqui)**
```powershell
npm run worker -- --unit carros-online
```
Deixe rodando. Em outro terminal:
```powershell
npm run status              # saúde, última execução por recurso, volume capturado
```

**7.5 Classificar SDRs e vendedores** (necessário para detectar vendedor seguidor)
```powershell
npm run users -- list --unit carros-online
npm run users -- set --unit carros-online --user <ID> --role sdr
npm run users -- set --unit carros-online --user <ID> --role seller
```

**7.6 Horário comercial (D4).** Me informe os horários e feriados da Carros Online e eu gero o SQL do `business_hours` para você aplicar.

**7.7 Worker sempre ligado (R15).** Se o computador desligar, a captura para. O estado é recuperado depois, mas a precisão do horário das mudanças se perde. Antes do fim da Etapa 2, vamos hospedar o worker num serviço sempre ativo.

## Passo 8: Conferir manualmente 20 leads no CRM

Aguarde a carga inicial terminar: no `npm run status`, `jobs_queued` fica perto de zero. Então rode:

```powershell
npm run sample -- --unit carros-online --n 20
```

O comando gera `reports/conferencia-carros-online-<data>.csv`. Esse arquivo **contém dados pessoais**: abra no Excel e **não compartilhe**. Para cada linha:
1. clique no link e abra o lead no CRM;
2. compare entrada, origem, responsável, seguidores, primeira resposta, últimas mensagens e etapa;
3. marque **S** ou **N** e escreva uma observação.

Depois me envie **só o resumo**, sem nomes nem telefones. Por exemplo: "18/20 conferem; 2 divergências na 1ª resposta: no CRM a resposta foi por ligação".

**Teste de captura (R13).** Escolha um lead de teste e faça as três ações abaixo. Em até 5 minutos, `npm run status` deve mostrar `mudancas_responsavel`, `mudancas_seguidor` e `mudancas_oportunidade` incrementados.
- troque o responsável;
- adicione um vendedor como seguidor;
- mova a oportunidade de etapa.

Se o contador de responsável ou de seguidor **não** subir, o `dateUpdated` do contato não está mudando nesses casos, e eu ativo a varredura de contingência.

**Critério de saída da Etapa 2:**
- matriz comprovada;
- 20/20 leads conferidos, ou divergências explicadas;
- teste de captura OK;
- 48 h com a unidade em `ok`.
