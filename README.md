# Relatório — Deputados com projetos convertidos em lei

Interface web (sem backend) que usa os [Dados Abertos da Câmara dos
Deputados](https://dadosabertos.camara.leg.br/) e levanta **quais deputados tiveram projetos
de sua autoria transformados em lei**, da 53ª à 57ª legislatura:

- **57ª legislatura** — 2023 a 2027
- **56ª legislatura** — 2019 a 2023
- **55ª legislatura** — 2015 a 2019
- **54ª legislatura** — 2011 a 2015
- **53ª legislatura** — 2007 a 2011

## Como usar

A página funciona inteiramente no navegador. A API da Câmara permite chamadas diretas do
browser (CORS liberado), então basta servir a pasta localmente.

**Windows (mais simples):** dê **duplo clique em `iniciar.bat`**. Ele sobe um servidor local
e abre o navegador em `http://localhost:8000` automaticamente. Deixe a janela preta aberta
enquanto usa o programa; para encerrar, feche-a ou tecle **Ctrl+C**. (Requer Python — veja
abaixo.)

**Alternativa (qualquer sistema):**

```bash
cd Relatorio
python -m http.server 8000
# abra http://localhost:8000 no navegador
```

> **Python**: o `iniciar.bat` e o comando acima precisam do Python. Baixe em
> <https://www.python.org/downloads/> e, na instalação, **marque "Add Python to PATH"**.

## Acessar de outra máquina na rede

1. Rode o `iniciar.bat` na máquina que servirá o site. Ele **mostra os endereços IPv4** desta
   máquina (ex.: `http://192.168.0.15:8000/`). Use esse endereço na outra máquina — **não use
   um IP terminado em `.1`**, que normalmente é o roteador, nem `localhost` (que só funciona na
   própria máquina). Para conferir manualmente, rode `ipconfig` e procure o "Endereço IPv4".
2. Se ainda não acessar, o **Firewall do Windows** está bloqueando a porta. Rode uma única vez
   o **`liberar-firewall.bat`** com o botão direito → **Executar como administrador**. Ele
   libera a porta 8000 (TCP) para a rede local.
3. As duas máquinas precisam estar **na mesma rede** (mesmo Wi‑Fi/LAN). Redes corporativas com
   "isolamento de cliente" podem bloquear o acesso entre máquinas — nesse caso, fale com a TI.

> Os arquivos `proposicoes-AAAA.json` são lidos **no navegador de quem está acessando**, então
> baixe-os na máquina que vai abrir a página (não na que serve o site).

### Passo a passo na interface

1. **Baixe os arquivos oficiais** — clique nos links da página (passo 1) para baixar os
   arquivos `proposicoes-AAAA.json` dos anos das legislaturas desejadas e salve no computador.
   São grandes (90–160 MB cada). Anos: 56ª → 2019–2023; 57ª → 2023–2026.
2. **Configuração** — escolha as legislaturas e os tipos de proposição (padrão: **PL** e
   **PLP**).
3. **Selecione os arquivos baixados e processe** — clique em "Selecionar arquivos…", escolha
   os `proposicoes-AAAA.json` baixados (pode marcar vários) e clique em **Processar**. O app
   lê os arquivos do disco, filtra os projetos que viraram lei e busca os autores na API. Uma
   barra de progresso mostra cada etapa.
4. **Resultados** — tabela ordenável e com filtros (nome, legislatura, partido, UF, "só com
   ≥ 1 projeto"). Clique em "ver N" para listar os projetos de cada deputado, com link para a
   ficha de tramitação.
5. **Exportar Excel (.xlsx)** — gera um arquivo local com duas planilhas: `Ranking` (um
   deputado por legislatura) e `Projetos` (um projeto por linha).
6. **Importar Excel** — recarrega um arquivo exportado anteriormente para filtrar/ordenar
   **sem refazer o processamento**.
7. **Exportar SQLite (.db)** — gera um **banco de dados local** (SQLite) com as tabelas
   `ranking` e `projetos`. Não precisa instalar nada nem ser administrador: o arquivo `.db`
   pode ser aberto no Python (módulo `sqlite3`, já embutido), no
   [DB Browser for SQLite](https://sqlitebrowser.org/), Power BI, etc.
8. **Importar SQLite** — recarrega um `.db` exportado antes, repovoando a interface **sem
   reprocessar os arquivos**.

### Usando o banco no Python

```python
import sqlite3
con = sqlite3.connect("deputados-projetos-em-lei-2026-06-22.db")
cur = con.cursor()
for nome, partido, uf, qtd in cur.execute(
    "SELECT deputado, partido, uf, projetos_em_lei FROM ranking "
    "WHERE legislatura='57' ORDER BY projetos_em_lei DESC LIMIT 10"):
    print(qtd, nome, partido, uf)
```

Tabelas: `ranking` (id_deputado, deputado, partido, uf, legislatura, legislatura_desc,
projetos_em_lei) e `projetos` (id_proposicao, id_deputado, deputado, partido, uf,
legislatura, legislatura_desc, tipo, numero, ano, data_apresentacao, ementa, link).

## O que conta como "virou lei"

Um projeto é considerado convertido em lei quando sua situação de tramitação é
**"Transformado em Norma Jurídica"** (`idSituacao` `1140`). Por padrão consideramos apenas
**PL** e **PLP**; é possível incluir também PDL, PDC, MPV e PEC pelos checkboxes (PDL/PDC
tendem a inflar o ranking com decretos legislativos de baixa substância, como concessões de
rádio/TV e tratados).

## Por que selecionar arquivos manualmente?

Dois motivos técnicos:

1. A API `/proposicoes` **não filtra por situação de tramitação** — o parâmetro `codSituacao`
   é aceito mas **silenciosamente ignorado**. Consultar a situação proposição por proposição
   exigiria dezenas de milhares de chamadas. A única fonte confiável é o campo `ultimoStatus`
   dos **arquivos oficiais em massa** (`proposicoes-{ano}.json`).
2. Esses arquivos **não enviam cabeçalho CORS**, então o navegador **não consegue baixá-los
   via JavaScript** (dá "Failed to fetch"). Por isso o app não baixa sozinho: você baixa os
   arquivos pelos links (um download normal do navegador funciona, pois não é uma leitura via
   `fetch`) e os seleciona no app, que então os lê do seu disco.

Os autores de cada projeto-lei vêm da API `/proposicoes/{id}/autores` (essa parte tem CORS e
funciona no navegador).

## Detalhes metodológicos

- **Autoria**: todos os autores (deputados) listados de um projeto recebem crédito — inclusive
  coautores. Isso significa que projetos com muitas assinaturas creditam todos os signatários,
  e coassinantes prolíficos tendem a aparecer no topo do ranking.
- **Atribuição por legislatura**: usa a **data de apresentação** do projeto, não a data em
  que virou lei. Um projeto apresentado numa legislatura mas convertido em lei na seguinte é
  contado na legislatura em que foi apresentado.
- **513 vs. ~900**: a Câmara tem 513 cadeiras simultâneas, mas ao longo de uma legislatura
  mais pessoas ocupam essas cadeiras (suplentes que assumem). A API lista todos eles, então o
  número de deputados por legislatura é maior que 513. Use o filtro de partido/UF/nome para
  navegar. Deputados sem projetos aparecem com total 0.

## Arquivos

| Arquivo | Função |
| --- | --- |
| `index.html` | Estrutura da página e painel de configuração |
| `app.js` | Coleta na API, agregação, tabela, exportar/importar Excel |
| `styles.css` | Estilos |
| `vendor/xlsx.full.min.js` | Biblioteca [SheetJS](https://sheetjs.com) (gera/lê `.xlsx`) |
| `vendor/sql-wasm.js` + `.wasm` | [sql.js](https://sql.js.org) — SQLite em WebAssembly (gera/lê `.db`) |

## Identidade visual

A interface segue a identidade visual do projeto
[SisPode](https://github.com/srocupado/SisPode): tema escuro, acento teal/ciano, verde
Podemos e tipografia **DM Sans** (carregada via Google Fonts).

## Fonte dos dados

API de Dados Abertos da Câmara dos Deputados — <https://dadosabertos.camara.leg.br/>
