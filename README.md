# Relatório — Deputados com projetos convertidos em lei

Interface web (sem backend) que consulta a [API de Dados Abertos da Câmara dos
Deputados](https://dadosabertos.camara.leg.br/) e levanta **quais deputados tiveram projetos
de sua autoria transformados em lei** nas duas últimas legislaturas:

- **57ª legislatura** — 2023 a 2027
- **56ª legislatura** — 2019 a 2023

## Como usar

A página funciona inteiramente no navegador. A API da Câmara permite chamadas diretas do
browser (CORS liberado), então basta abrir a página.

**Opção recomendada** (evita restrições do protocolo `file://`):

```bash
cd Relatorio
python -m http.server 8000
# abra http://localhost:8000 no navegador
```

Você também pode abrir o `index.html` diretamente (duplo clique), mas servir via HTTP é mais
confiável.

### Passo a passo na interface

1. **Configuração** — escolha as legislaturas e os tipos de proposição. O padrão é **PL**
   (Projeto de Lei) e **PLP** (Projeto de Lei Complementar).
2. **Coletar dados** — a coleta **baixa os arquivos oficiais em massa** da Câmara
   (`proposicoes-{ano}.json`) dos anos das legislaturas escolhidas, filtra localmente os
   projetos que viraram lei e busca os autores de cada um. **Atenção:** são arquivos grandes
   (~240 MB por legislatura, ~590 MB para as duas). Uma barra de progresso mostra cada etapa
   (download por MB, filtragem e busca de autores).
3. **Resultados** — tabela ordenável e com filtros (nome, legislatura, partido, UF, "só com
   ≥ 1 projeto"). Clique em "ver N" para listar os projetos de cada deputado, com link para a
   ficha de tramitação.
4. **Exportar Excel (.xlsx)** — gera um arquivo local com duas planilhas: `Ranking` (um
   deputado por legislatura) e `Projetos` (um projeto por linha).
5. **Importar Excel** — recarrega um arquivo exportado anteriormente para filtrar/ordenar
   **sem refazer a coleta**.

## O que conta como "virou lei"

Um projeto é considerado convertido em lei quando sua situação de tramitação é
**"Transformado em Norma Jurídica"** (`idSituacao` `1140`). Por padrão consideramos apenas
**PL** e **PLP**; é possível incluir também PDL, PDC, MPV e PEC pelos checkboxes (PDL/PDC
tendem a inflar o ranking com decretos legislativos de baixa substância, como concessões de
rádio/TV e tratados).

## Por que baixar os arquivos em massa?

A API `/proposicoes` **não filtra por situação de tramitação** — o parâmetro `codSituacao` é
aceito mas **silenciosamente ignorado**. Consultar a situação proposição por proposição
exigiria dezenas de milhares de chamadas. A única fonte confiável e eficiente é o campo
`ultimoStatus` presente nos **arquivos oficiais em massa** (`proposicoes-{ano}.json`), que o
app baixa e filtra localmente. Os autores de cada projeto-lei vêm então de
`/proposicoes/{id}/autores`.

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

## Identidade visual

A interface segue a identidade visual do projeto
[SisPode](https://github.com/srocupado/SisPode): tema escuro, acento teal/ciano, verde
Podemos e tipografia **DM Sans** (carregada via Google Fonts).

## Fonte dos dados

API de Dados Abertos da Câmara dos Deputados — <https://dadosabertos.camara.leg.br/>
