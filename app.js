/* Relatório: deputados com projetos convertidos em lei (56ª e 57ª legislaturas).
 *
 * IMPORTANTE:
 * 1) A API /proposicoes NÃO filtra por situação (o parâmetro codSituacao é ignorado).
 *    A única fonte confiável de "virou lei" é o campo ultimoStatus dos ARQUIVOS EM MASSA
 *    oficiais (proposicoes-{ano}.json).
 * 2) Esses arquivos NÃO têm CORS, então o navegador não consegue baixá-los. Por isso o
 *    usuário baixa os arquivos manualmente e os SELECIONA aqui; o app os lê do disco,
 *    filtra os PL/PLP com idSituacao "1140" (Transformado em Norma Jurídica) e, para cada
 *    um, busca os autores em /proposicoes/{id}/autores (a API tem CORS). Credita todos os
 *    autores (coautores inclusive). */

"use strict";

const VERSAO = "v3 (arquivos locais)";
console.log("Relatório de projetos em lei —", VERSAO);

const API = "https://dadosabertos.camara.leg.br/api/v2";
const ID_SITUACAO_LEI = "1140"; // "Transformado em Norma Jurídica" (no ultimoStatus do arquivo)
const CONCORRENCIA = 6;
let ARQUIVOS_SELECIONADOS = []; // File[]

// Cache PERSISTENTE da condição eleitoral (localStorage): depId -> { leg: "Titular"/... }.
// Condição é praticamente fixa, então após a 1ª busca vira instantâneo (mesmo reabrindo).
const COND_STORE_KEY = "condicoes_v1";
let CONDICOES = {};
try { CONDICOES = JSON.parse(localStorage.getItem(COND_STORE_KEY) || "{}"); } catch (e) {}
function salvarCondicoes() {
  try { localStorage.setItem(COND_STORE_KEY, JSON.stringify(CONDICOES)); } catch (e) {}
}
// Bancadas fixas (partidos personalizados): nome -> [depId,...], persistidas no navegador.
const BANCADA_STORE_KEY = "bancadas_v1";
let BANCADAS = {};
try { BANCADAS = JSON.parse(localStorage.getItem(BANCADA_STORE_KEY) || "{}"); } catch (e) {}
function salvarBancadas() {
  try { localStorage.setItem(BANCADA_STORE_KEY, JSON.stringify(BANCADAS)); } catch (e) {}
}
let selecaoBancada = new Set(); // depIds marcados no editor

// Cache PERSISTENTE do roster (lista de deputados) por legislatura: leg -> [{id,nome,partido,uf}].
const ROSTER_STORE_KEY = "rosters_v1";
let ROSTERS = {};
try { ROSTERS = JSON.parse(localStorage.getItem(ROSTER_STORE_KEY) || "{}"); } catch (e) {}
function salvarRosters() {
  try { localStorage.setItem(ROSTER_STORE_KEY, JSON.stringify(ROSTERS)); } catch (e) {}
}

/** Condição do deputado em cada legislatura que ele teve (53–57), a partir do histórico. */
function condicoesTodasLegs(hist) {
  const o = {};
  for (const leg of ["53", "54", "55", "56", "57"]) {
    const c = condicaoDaLegislatura(hist, leg);
    if (c && c !== "—") o[leg] = c;
  }
  return o;
}

// Faixas de data de apresentação + anos de arquivo a baixar por legislatura.
const LEGISLATURAS = {
  "57": { rotulo: "57ª (2023–2027)", inicio: "2023-02-01", fim: "2027-01-31",
          anos: [2023, 2024, 2025, 2026] },
  "56": { rotulo: "56ª (2019–2023)", inicio: "2019-02-01", fim: "2023-01-31",
          anos: [2019, 2020, 2021, 2022, 2023] },
  "55": { rotulo: "55ª (2015–2019)", inicio: "2015-02-01", fim: "2019-01-31",
          anos: [2015, 2016, 2017, 2018, 2019] },
  "54": { rotulo: "54ª (2011–2015)", inicio: "2011-02-01", fim: "2015-01-31",
          anos: [2011, 2012, 2013, 2014, 2015] },
  "53": { rotulo: "53ª (2007–2011)", inicio: "2007-02-01", fim: "2011-01-31",
          anos: [2007, 2008, 2009, 2010, 2011] },
};

const FICHA_URL = (id) =>
  `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${id}`;

// ---- Estado global ----------------------------------------------------------
let DADOS = []; // [{ depId, nome, partido, uf, legislatura, total, projetos: [...] }]
let ordemAtual = { coluna: "total", asc: false };

// ---- Helpers de rede --------------------------------------------------------

/** fetch com retry/backoff em erros transitórios (429 / 5xx / rede). */
async function fetchComRetry(url, tentativas = 5, esperaInicial = 1000) {
  let espera = esperaInicial;
  for (let i = 0; i < tentativas; i++) {
    try {
      const resp = await fetch(url, { headers: { Accept: "application/json" } });
      if (resp.status === 429 || resp.status >= 500) {
        const retryAfter = parseInt(resp.headers.get("retry-after") || "0", 10);
        await dormir(retryAfter ? retryAfter * 1000 : espera);
        espera = Math.min(espera * 2, 16000);
        continue;
      }
      return resp;
    } catch (e) {
      if (i === tentativas - 1) throw e;
      await dormir(espera);
      espera = Math.min(espera * 2, 16000);
    }
  }
  throw new Error(`Falha ao acessar a API após ${tentativas} tentativas: ${url}`);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const CONCORRENCIA_API = 4; // mais suave para redes corporativas em etapas com muitas chamadas
const CONCORRENCIA_CONDICAO = 16; // /historico é HTTP/2 e leve; cache persistente cobre re-runs

/** Lê um arquivo local (File) como texto, mostrando o progresso de leitura, e faz JSON.parse. */
function lerJsonLocalComProgresso(file, onBytes) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => { if (onBytes && e.lengthComputable) onBytes(e.loaded, e.total); };
    reader.onload = () => {
      if (onBytes) onBytes(file.size, file.size);
      try { resolve(JSON.parse(reader.result)); }
      catch (err) { reject(new Error(`"${file.name}" não é um JSON válido: ${err.message}`)); }
    };
    reader.onerror = () => reject(new Error(`Falha ao ler o arquivo "${file.name}".`));
    reader.readAsText(file, "utf-8");
  });
}

/** Executa tarefas (funções que retornam Promise) com limite de concorrência. */
async function poolDeTarefas(itens, limite, worker, onProgresso) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  let concluidos = 0;
  async function executor() {
    while (proximo < itens.length) {
      const i = proximo++;
      resultados[i] = await worker(itens[i], i);
      concluidos++;
      if (onProgresso) onProgresso(concluidos, itens.length);
    }
  }
  const executores = [];
  for (let k = 0; k < Math.min(limite, itens.length); k++) executores.push(executor());
  await Promise.all(executores);
  return resultados;
}

// ---- Coleta de dados --------------------------------------------------------

/** Retorna a chave da legislatura ("56"/"57") para uma data de apresentação, ou null. */
function classificarPorLegislatura(dataApresentacao) {
  if (!dataApresentacao) return null;
  const data = dataApresentacao.slice(0, 10); // "YYYY-MM-DD"
  for (const chave of Object.keys(LEGISLATURAS)) {
    const { inicio, fim } = LEGISLATURAS[chave];
    if (data >= inicio && data <= fim) return chave;
  }
  return null;
}

/** Busca todos os deputados de uma legislatura (paginado), com progresso.
 * Tolerante a falhas: nunca lança; devolve { deputados, completo }. */
async function fetchDeputados(idLegislatura, onProgresso) {
  const deputados = [];
  const ITENS = 1000; // roster inteiro em 1 (ou poucas) chamada(s) — menos chance de falha
  let pagina = 1, total = 0, completo = true;
  while (true) {
    const url = `${API}/deputados?idLegislatura=${idLegislatura}&ordem=ASC&ordenarPor=nome&itens=${ITENS}&pagina=${pagina}`;
    let resp, json;
    try { resp = await fetchComRetry(url, 6, 800); json = await resp.json(); }
    catch (e) { completo = false; break; }
    for (const d of json.dados) {
      deputados.push({ id: d.id, nome: d.nome, partido: d.siglaPartido || "", uf: d.siglaUf || "" });
    }
    total = parseInt(resp.headers.get("x-total-count") || "0", 10);
    if (onProgresso) onProgresso(deputados.length, total || deputados.length);
    if (pagina * ITENS >= total || json.dados.length === 0) break;
    pagina++;
  }
  return { deputados, completo };
}

/** Lê um arquivo em massa e devolve os PL/PLP (tipos) que viraram norma jurídica. */
function filtrarProjetosLei(arquivo, tipos) {
  const arr = Array.isArray(arquivo) ? arquivo : arquivo.dados || [];
  const leis = [];
  for (const p of arr) {
    if (!tipos.includes(p.siglaTipo)) continue;
    const st = p.ultimoStatus || {};
    if (String(st.idSituacao) !== ID_SITUACAO_LEI) continue;
    leis.push({
      id: p.id,
      tipo: p.siglaTipo,
      numero: p.numero,
      ano: p.ano,
      ementa: p.ementa || "",
      dataApresentacao: p.dataApresentacao || "",
    });
  }
  return leis;
}

/** Busca o histórico do deputado (condição eleitoral por legislatura).
 * Retry curto (falha vira "—" rápido, sem travar a coleta em redes instáveis). */
async function fetchHistorico(idDeputado) {
  // OBS: o endpoint /historico NÃO aceita o parâmetro 'itens' (retorna 400).
  const resp = await fetchComRetry(`${API}/deputados/${idDeputado}/historico`, 2, 400);
  const json = await resp.json();
  return json.dados || [];
}

/** Determina a condição (Titular/Efetivado/Suplente) do deputado numa legislatura. */
function condicaoDaLegislatura(historico, leg) {
  const conds = new Set();
  for (const h of historico) {
    if (String(h.idLegislatura) === String(leg) && h.condicaoEleitoral) conds.add(h.condicaoEleitoral);
  }
  if (conds.has("Titular")) return "Titular";
  if (conds.has("Efetivado")) return "Efetivado";
  if (conds.has("Suplente")) return "Suplente";
  return "—";
}

/** Grupo para o filtro: Efetivado conta como titular. */
function grupoCondicao(cond) {
  if (cond === "Titular" || cond === "Efetivado") return "titular";
  if (cond === "Suplente") return "suplente";
  return "";
}

/** Busca os deputados autores de uma proposição (credita todos os autores). */
async function fetchAutoresDeputados(idProposicao) {
  const resp = await fetchComRetry(`${API}/proposicoes/${idProposicao}/autores`);
  const json = await resp.json();
  const autores = [];
  for (const a of json.dados) {
    if (a.codTipo !== 10000) continue; // 10000 = Deputado(a)
    const m = (a.uri || "").match(/\/deputados\/(\d+)/);
    if (!m) continue;
    autores.push({ id: parseInt(m[1], 10), nome: a.nome });
  }
  return autores;
}

/** Orquestra toda a coleta e monta DADOS. */
async function coletar(legsSelecionadas, tipos, arquivos, usarCondicao) {
  // 1. Buscar os deputados de cada legislatura (nome/partido/UF + para mostrar zeros).
  // Feito ANTES de ler os arquivos grandes (evita competir com a memória do parse).
  // Roster inteiro em 1 chamada (itens=1000), com cache e tolerante a falhas.
  const rosterPorLeg = {};
  const infoDep = new Map();
  let falhasRoster = 0;
  for (let i = 0; i < legsSelecionadas.length; i++) {
    const leg = legsSelecionadas[i];
    let lista;
    if (ROSTERS[leg] && ROSTERS[leg].length) {
      lista = ROSTERS[leg];
    } else {
      setFase(`Buscando deputados da ${LEGISLATURAS[leg].rotulo}...`);
      const r = await fetchDeputados(leg, (f, t) => setProgresso(f, t));
      lista = r.deputados;
      if (r.completo && lista.length) { ROSTERS[leg] = lista; salvarRosters(); }
      else falhasRoster++;
    }
    rosterPorLeg[leg] = new Set(lista.map((d) => d.id));
    for (const d of lista) if (!infoDep.has(d.id)) infoDep.set(d.id, d);
  }

  // 2. Ler os arquivos locais e filtrar os projetos que viraram lei.
  const leisPorId = new Map();
  for (let i = 0; i < arquivos.length; i++) {
    const file = arquivos[i];
    setFase(`Lendo "${file.name}" (arquivo ${i + 1}/${arquivos.length})...`);
    const arquivo = await lerJsonLocalComProgresso(file, (rec, tot) => setProgressoBytes(rec, tot));
    setFase(`Filtrando projetos de "${file.name}"...`);
    for (const lei of filtrarProjetosLei(arquivo, tipos)) {
      const leg = classificarPorLegislatura(lei.dataApresentacao);
      if (leg && legsSelecionadas.includes(leg) && !leisPorId.has(lei.id)) {
        leisPorId.set(lei.id, { ...lei, leg });
      }
    }
    setProgresso(i + 1, arquivos.length);
  }

  const leis = [...leisPorId.values()];
  // 3. Buscar autores de cada lei (credita todos os autores deputados).
  setFase(`Buscando autores de ${leis.length} projetos convertidos em lei...`);
  const buckets = new Map(); // `${depId}|${leg}` -> { info, projetos: [] }
  let falhasAutores = 0;
  await poolDeTarefas(
    leis,
    CONCORRENCIA_API,
    async (lei) => {
      let autores;
      try { autores = await fetchAutoresDeputados(lei.id); }
      catch (e) { falhasAutores++; return; } // não aborta tudo por uma falha
      for (const a of autores) {
        const chave = `${a.id}|${lei.leg}`;
        if (!buckets.has(chave)) buckets.set(chave, { depId: a.id, nome: a.nome, projetos: [] });
        buckets.get(chave).projetos.push(lei);
      }
    },
    (f, t) => setProgresso(f, t)
  );

  // 3.5. (Opcional) Buscar a condição eleitoral (titular/suplente) por deputado.
  const condicaoPorChave = new Map(); // `${depId}|${leg}` -> "Titular"/"Suplente"/"Efetivado"/"—"
  let falhasCondicao = 0;
  if (usarCondicao) {
    const idsCondicao = new Set(infoDep.keys());
    for (const k of buckets.keys()) idsCondicao.add(parseInt(k.split("|")[0], 10));
    const todos = [...idsCondicao];
    // Só busca quem ainda não está no cache persistente (1 fetch por deputado, para sempre).
    const faltam = todos.filter((id) => CONDICOES[id] === undefined);
    setFase(`Buscando condição (titular/suplente) — ${faltam.length} novos de ${todos.length}...`);
    if (faltam.length) {
      await poolDeTarefas(
        faltam,
        CONCORRENCIA_CONDICAO,
        async (depId) => {
          try { CONDICOES[depId] = condicoesTodasLegs(await fetchHistorico(depId)); }
          catch (e) { falhasCondicao++; } // falha não aborta; tenta de novo num próximo Processar
        },
        (f, t) => setProgresso(f, t)
      );
      salvarCondicoes();
    }
    for (const depId of todos) {
      for (const leg of legsSelecionadas) {
        condicaoPorChave.set(`${depId}|${leg}`, (CONDICOES[depId] || {})[leg] || "—");
      }
    }
  }

  // 4. Montar DADOS: todo deputado do roster (mostra zeros) + autores fora do roster.
  setFase("Montando o relatório...");
  DADOS = [];
  for (const leg of legsSelecionadas) {
    const idsLeg = new Set([
      ...(rosterPorLeg[leg] || []),
      ...[...buckets.keys()].filter((k) => k.endsWith(`|${leg}`)).map((k) => parseInt(k.split("|")[0], 10)),
    ]);
    for (const depId of idsLeg) {
      const bucket = buckets.get(`${depId}|${leg}`);
      const info = infoDep.get(depId) || { nome: (bucket && bucket.nome) || `Deputado ${depId}`, partido: "", uf: "" };
      const projetos = bucket ? bucket.projetos : [];
      DADOS.push({
        depId, nome: info.nome, partido: info.partido, uf: info.uf,
        legislatura: leg, total: projetos.length, projetos,
        condicao: usarCondicao ? (condicaoPorChave.get(`${depId}|${leg}`) || "—") : "—",
      });
    }
  }

  mostrarProgresso(false);
  let msg = `Coleta concluída: ${leis.length} projetos convertidos em lei • ` +
    `${DADOS.length} registros (deputado × legislatura). Tipos: ${tipos.join(", ")}.`;
  if (falhasRoster) msg += ` ⚠️ ${falhasRoster} legislatura(s) com lista de deputados incompleta (falha de rede) — clique em Processar de novo para completar.`;
  if (falhasAutores) msg += ` ⚠️ ${falhasAutores} projeto(s) sem autores (falha de rede).`;
  if (falhasCondicao) msg += ` ⚠️ ${falhasCondicao} deputado(s) com condição indefinida (falha de rede) — clique em Processar de novo se quiser completar.`;
  setStatus(msg);
}

// ---- Renderização da tabela -------------------------------------------------

function popularFiltros() {
  const partidos = [...new Set(DADOS.map((d) => d.partido).filter(Boolean))].sort();
  const ufs = [...new Set(DADOS.map((d) => d.uf).filter(Boolean))].sort();
  preencherSelect("filtroPartido", partidos, "Todos os partidos");
  preencherSelect("filtroUf", ufs, "Todas as UFs");
}

function preencherSelect(id, valores, rotuloVazio) {
  const sel = document.getElementById(id);
  const atual = sel.value;
  sel.innerHTML = `<option value="">${rotuloVazio}</option>`;
  for (const v of valores) {
    const opt = document.createElement("option");
    opt.value = v; opt.textContent = v;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === atual)) sel.value = atual;
}

// ---- Bancadas fixas -----------------------------------------------------

/** Deputados únicos (por id) presentes nos dados, para montar a bancada. */
function deputadosUnicos() {
  const m = new Map();
  for (const d of DADOS) if (!m.has(d.depId)) {
    m.set(d.depId, { depId: d.depId, nome: d.nome, partido: d.partido, uf: d.uf });
  }
  return [...m.values()].sort((a, b) => a.nome.localeCompare(b.nome));
}

/** Mapa depId -> [nomes das bancadas a que pertence]. */
function bancadasPorDep() {
  const m = new Map();
  for (const [nome, ids] of Object.entries(BANCADAS)) {
    for (const id of ids) {
      if (!m.has(id)) m.set(id, []);
      m.get(id).push(nome);
    }
  }
  return m;
}

function atualizarSelectsBancada() {
  const nomes = Object.keys(BANCADAS).sort((a, b) => a.localeCompare(b));
  preencherSelect("filtroBancada", nomes, "Todas as bancadas");
  preencherSelect("bancadaExistente", nomes, "— carregar bancada salva —");
}

function renderBancadaLista() {
  const busca = document.getElementById("bancadaBusca").value.trim().toLowerCase();
  const cont = document.getElementById("bancadaLista");
  cont.innerHTML = "";
  const lista = deputadosUnicos().filter((d) => !busca || d.nome.toLowerCase().includes(busca));
  for (const d of lista) {
    const lab = document.createElement("label");
    lab.className = "bancada-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selecaoBancada.has(d.depId);
    cb.addEventListener("change", () => {
      if (cb.checked) selecaoBancada.add(d.depId); else selecaoBancada.delete(d.depId);
      atualizarContadorBancada();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(` ${d.nome} (${d.partido || "—"}/${d.uf || "—"})`));
    cont.appendChild(lab);
  }
  atualizarContadorBancada();
}

function atualizarContadorBancada() {
  document.getElementById("bancadaContador").textContent =
    `${selecaoBancada.size} deputado(s) selecionado(s)`;
}

function carregarBancada(nome) {
  if (!nome || !BANCADAS[nome]) { selecaoBancada = new Set(); }
  else { selecaoBancada = new Set(BANCADAS[nome]); document.getElementById("bancadaNome").value = nome; }
  renderBancadaLista();
}

function salvarBancadaAtual() {
  const nome = document.getElementById("bancadaNome").value.trim();
  if (!nome) return setStatus("Dê um nome à bancada fixa antes de salvar.", true);
  if (selecaoBancada.size === 0) return setStatus("Selecione ao menos um deputado para a bancada.", true);
  BANCADAS[nome] = [...selecaoBancada];
  salvarBancadas();
  atualizarSelectsBancada();
  document.getElementById("filtroBancada").value = nome;
  renderTabela();
  setStatus(`Bancada "${nome}" salva com ${BANCADAS[nome].length} deputado(s).`);
}

function excluirBancada() {
  const sel = document.getElementById("bancadaExistente").value ||
    document.getElementById("bancadaNome").value.trim();
  if (!sel || !BANCADAS[sel]) return setStatus("Selecione uma bancada salva para excluir.", true);
  if (!confirm(`Excluir a bancada fixa "${sel}"?`)) return;
  delete BANCADAS[sel];
  salvarBancadas();
  selecaoBancada = new Set();
  document.getElementById("bancadaNome").value = "";
  atualizarSelectsBancada();
  renderBancadaLista();
  renderTabela();
  setStatus(`Bancada "${sel}" excluída.`);
}

function prepararBancadas() {
  atualizarSelectsBancada();
  renderBancadaLista();
}

function dadosFiltrados() {
  const nome = document.getElementById("filtroNome").value.trim().toLowerCase();
  const leg = document.getElementById("filtroLeg").value;
  const partido = document.getElementById("filtroPartido").value;
  const uf = document.getElementById("filtroUf").value;
  const condicao = document.getElementById("filtroCondicao").value;
  const bancada = document.getElementById("filtroBancada").value;
  const soComLei = document.getElementById("filtroComLei").checked;
  const membros = bancada && BANCADAS[bancada] ? new Set(BANCADAS[bancada]) : null;

  let linhas = DADOS.filter((d) => {
    if (nome && !d.nome.toLowerCase().includes(nome)) return false;
    if (leg && d.legislatura !== leg) return false;
    if (partido && d.partido !== partido) return false;
    if (uf && d.uf !== uf) return false;
    if (condicao && grupoCondicao(d.condicao) !== condicao) return false;
    if (membros && !membros.has(d.depId)) return false;
    if (soComLei && d.total === 0) return false;
    return true;
  });

  const { coluna, asc } = ordemAtual;
  linhas.sort((a, b) => {
    let va = a[coluna], vb = b[coluna];
    if (typeof va === "string") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    if (b.total !== a.total) return b.total - a.total;
    return a.nome.localeCompare(b.nome);
  });
  return linhas;
}

function renderTabela() {
  const linhas = dadosFiltrados();
  const tbody = document.querySelector("#tabela tbody");
  tbody.innerHTML = "";
  linhas.forEach((d, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="num">${idx + 1}</td>
      <td>${escapar(d.nome)}</td>
      <td>${escapar(d.partido)}</td>
      <td class="num">${escapar(d.uf)}</td>
      <td class="num">${escapar(d.condicao || "—")}</td>
      <td class="num">${LEGISLATURAS[d.legislatura].rotulo}</td>
      <td class="total">${d.total}</td>
      <td></td>`;
    const tdBtn = tr.lastElementChild;
    const btn = document.createElement("button");
    btn.className = "btn-projetos";
    btn.textContent = d.total ? `ver ${d.total}` : "—";
    btn.disabled = d.total === 0;
    btn.addEventListener("click", () => alternarProjetos(tr, d));
    tdBtn.appendChild(btn);
    tbody.appendChild(tr);
  });
  const bancada = document.getElementById("filtroBancada").value;
  const prefixo = bancada ? `Bancada "${bancada}": ` : "";
  document.getElementById("resultCount").textContent =
    `${prefixo}${linhas.length} registros • ${linhas.reduce((s, d) => s + d.total, 0)} projetos`;
  renderGrafico(linhas);
}

// Paleta (tons do tema teal + cores de apoio) para as fatias do donut.
const CORES_PIZZA = [
  "#1fa5a5", "#26c9c9", "#00A859", "#3ad97d", "#6eaaff",
  "#f0c040", "#f08a40", "#f05454", "#b06ef0", "#9aa7ab",
];
let chartPizza = null;

// Plugin: escreve o percentual em cada fatia do donut.
const pluginPercentFatias = {
  id: "percentFatias",
  afterDraw(chart) {
    const ds = chart.data.datasets[0];
    if (!ds) return;
    const total = ds.data.reduce((a, b) => a + b, 0);
    if (!total) return;
    const meta = chart.getDatasetMeta(0);
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '700 12px "DM Sans", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    meta.data.forEach((arc, i) => {
      const pct = Math.round((ds.data[i] / total) * 100);
      if (pct < 1) return;
      const { startAngle, endAngle, innerRadius, outerRadius, x, y } =
        arc.getProps(["startAngle", "endAngle", "innerRadius", "outerRadius", "x", "y"], true);
      const mid = (startAngle + endAngle) / 2;
      const r = (innerRadius + outerRadius) / 2;
      const px = x + Math.cos(mid) * r;
      const py = y + Math.sin(mid) * r;
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.strokeText(pct + "%", px, py);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(pct + "%", px, py);
    });
    ctx.restore();
  },
};

/** Desenha o donut com o Top 10 (por projetos) dos dados atualmente filtrados. */
function renderGrafico(linhas) {
  if (typeof Chart === "undefined") return; // lib não carregada
  const top = [...linhas].sort((a, b) => b.total - a.total).filter((d) => d.total > 0).slice(0, 10);
  const vazio = document.getElementById("graficoVazio");
  const wrap = document.querySelector(".grafico-wrap");
  if (top.length === 0) {
    if (chartPizza) { chartPizza.destroy(); chartPizza = null; }
    wrap.style.display = "none"; vazio.hidden = false; return;
  }
  wrap.style.display = ""; vazio.hidden = true;

  // Inclui a legislatura no rótulo quando há mais de uma nos dados filtrados.
  const multiLeg = new Set(linhas.map((d) => d.legislatura)).size > 1;
  const rotulo = (d) => d.nome + (multiLeg ? ` (${d.legislatura}ª)` : "");
  const labels = top.map(rotulo);
  const valores = top.map((d) => d.total);

  if (chartPizza) chartPizza.destroy();
  chartPizza = new Chart(document.getElementById("grafico"), {
    type: "doughnut",
    data: { labels, datasets: [{ data: valores, backgroundColor: CORES_PIZZA, borderColor: "#0e1c1f", borderWidth: 2 }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      layout: { padding: 4 },
      plugins: {
        legend: {
          position: "right",
          labels: {
            color: "#ffffff",
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 8,
            padding: 10,
            font: { size: 12 },
            generateLabels(chart) {
              const d = chart.data;
              return d.labels.map((label, i) => ({
                text: `${label}   ${d.datasets[0].data[i]}`,
                fillStyle: d.datasets[0].backgroundColor[i],
                strokeStyle: d.datasets[0].backgroundColor[i],
                fontColor: "#ffffff",
                index: i,
              }));
            },
          },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const arr = ctx.dataset.data;
              const total = arr.reduce((a, b) => a + b, 0);
              const pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
              return ` ${ctx.label}: ${ctx.parsed} projeto(s) (${pct}%)`;
            },
          },
        },
      },
    },
    plugins: [pluginPercentFatias],
  });
}

function alternarProjetos(tr, d) {
  const proxima = tr.nextElementSibling;
  if (proxima && proxima.classList.contains("projetos-row")) { proxima.remove(); return; }
  const row = document.createElement("tr");
  row.className = "projetos-row";
  const td = document.createElement("td");
  td.colSpan = 8;
  const ol = document.createElement("ol");
  ol.className = "projetos-list";
  for (const p of d.projetos) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="pj-titulo">` +
      `<a href="${FICHA_URL(p.id)}" target="_blank" rel="noopener">${p.tipo} ${p.numero}/${p.ano}</a></span> ` +
      `<small>(apresentado em ${escapar((p.dataApresentacao || "").slice(0, 10))})</small>` +
      `<div class="pj-ementa">${escapar(p.ementa)}</div>`;
    ol.appendChild(li);
  }
  td.appendChild(ol); row.appendChild(td); tr.after(row);
}

function escapar(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---- Exportar / importar Excel ---------------------------------------------

function exportarXlsx() {
  if (!DADOS.length) return;
  const bpd = bancadasPorDep();
  const banc = (id) => (bpd.get(id) || []).join("; ");
  const ranking = DADOS.map((d) => ({
    Deputado: d.nome, Partido: d.partido, UF: d.uf,
    "Condição": d.condicao || "—",
    "Bancada(s) fixa(s)": banc(d.depId),
    Legislatura: LEGISLATURAS[d.legislatura].rotulo,
    "Projetos convertidos em lei": d.total,
    Leg: d.legislatura, idDeputado: d.depId,
  }));
  const projetos = [];
  for (const d of DADOS) for (const p of d.projetos) {
    projetos.push({
      Deputado: d.nome, Partido: d.partido, UF: d.uf,
      "Bancada(s) fixa(s)": banc(d.depId),
      Legislatura: LEGISLATURAS[d.legislatura].rotulo,
      Tipo: p.tipo, Numero: p.numero, Ano: p.ano,
      "Data apresentacao": (p.dataApresentacao || "").slice(0, 10),
      Ementa: p.ementa, Link: FICHA_URL(p.id),
      idProposicao: p.id, Leg: d.legislatura, idDeputado: d.depId,
    });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ranking), "Ranking");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(projetos), "Projetos");
  XLSX.writeFile(wb, `deputados-projetos-em-lei-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function importarXlsx(file) {
  mostrarProgresso(true);
  setFase(`Importando "${file.name}"...`);
  setProgresso(0, 1);
  const reader = new FileReader();
  reader.onprogress = (e) => { if (e.lengthComputable) setProgresso(e.loaded, e.total); };
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: "array" });
      reconstruirDeXlsx(wb);
      mostrarProgresso(false);
      finalizarRender();
      setStatus(`Importado de "${file.name}": ${DADOS.length} registros.`);
    } catch (err) {
      mostrarProgresso(false);
      setStatus("Erro ao importar o arquivo: " + err.message, true);
    }
  };
  reader.readAsArrayBuffer(file);
}

/** Reconstrói DADOS a partir das planilhas Ranking + Projetos de um xlsx exportado. */
function reconstruirDeXlsx(wb) {
  const rankingSheet = wb.Sheets["Ranking"];
  const projetosSheet = wb.Sheets["Projetos"];
  if (!rankingSheet) throw new Error('Planilha "Ranking" não encontrada.');
  const ranking = XLSX.utils.sheet_to_json(rankingSheet);
  const projetos = projetosSheet ? XLSX.utils.sheet_to_json(projetosSheet) : [];

  const rotuloParaChave = {};
  for (const [chave, info] of Object.entries(LEGISLATURAS)) rotuloParaChave[info.rotulo] = chave;
  const legDe = (r) =>
    r.Leg != null ? String(r.Leg) : rotuloParaChave[r.Legislatura] || String(r.Legislatura);

  const projetosPorChave = new Map();
  for (const r of projetos) {
    const chave = `${r.idDeputado}|${legDe(r)}`;
    if (!projetosPorChave.has(chave)) projetosPorChave.set(chave, []);
    projetosPorChave.get(chave).push({
      id: r.idProposicao, tipo: r.Tipo, numero: r.Numero, ano: r.Ano,
      ementa: r.Ementa || "", dataApresentacao: r["Data apresentacao"] || "",
    });
  }
  DADOS = ranking.map((r) => {
    const leg = legDe(r);
    const projetosLinha = projetosPorChave.get(`${r.idDeputado}|${leg}`) || [];
    return {
      depId: r.idDeputado, nome: r.Deputado, partido: r.Partido || "", uf: r.UF || "",
      condicao: r["Condição"] || r["Condicao"] || "—",
      legislatura: leg, total: Number(r["Projetos convertidos em lei"]) || projetosLinha.length,
      projetos: projetosLinha,
    };
  });
}

// ---- Banco de dados SQLite (sql.js / WebAssembly, sem instalar nada) --------

let SQLJS = null;
async function getSqlJs() {
  if (!SQLJS) SQLJS = await initSqlJs({ locateFile: (f) => `vendor/${f}` });
  return SQLJS;
}

/** Faz o download de um Blob como arquivo. */
function baixarBlob(blob, nome) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Exporta DADOS para um arquivo de banco SQLite (.db) com as tabelas ranking e projetos. */
async function exportarSqlite() {
  if (!DADOS.length) return;
  try {
    setStatus("Gerando banco SQLite...");
    const SQL = await getSqlJs();
    const db = new SQL.Database();
    db.run(`
      CREATE TABLE ranking (
        id_deputado INTEGER, deputado TEXT, partido TEXT, uf TEXT, condicao TEXT,
        legislatura TEXT, legislatura_desc TEXT, projetos_em_lei INTEGER, bancada_fixa TEXT
      );
      CREATE TABLE projetos (
        id_proposicao INTEGER, id_deputado INTEGER, deputado TEXT, partido TEXT, uf TEXT,
        legislatura TEXT, legislatura_desc TEXT, tipo TEXT, numero INTEGER, ano INTEGER,
        data_apresentacao TEXT, ementa TEXT, link TEXT, bancada_fixa TEXT
      );`);

    const bpd = bancadasPorDep();
    const banc = (id) => (bpd.get(id) || []).join("; ");
    db.run("BEGIN");
    const r = db.prepare("INSERT INTO ranking VALUES (?,?,?,?,?,?,?,?,?)");
    for (const d of DADOS) {
      r.run([d.depId, d.nome, d.partido, d.uf, d.condicao || "—",
        d.legislatura, LEGISLATURAS[d.legislatura].rotulo, d.total, banc(d.depId)]);
    }
    r.free();
    const p = db.prepare("INSERT INTO projetos VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const d of DADOS) for (const pj of d.projetos) {
      p.run([pj.id, d.depId, d.nome, d.partido, d.uf, d.legislatura,
        LEGISLATURAS[d.legislatura].rotulo, pj.tipo, pj.numero, pj.ano,
        (pj.dataApresentacao || "").slice(0, 10), pj.ementa, FICHA_URL(pj.id), banc(d.depId)]);
    }
    p.free();
    db.run("COMMIT");

    const bytes = db.export();
    db.close();
    baixarBlob(new Blob([bytes], { type: "application/x-sqlite3" }),
      `deputados-projetos-em-lei-${new Date().toISOString().slice(0, 10)}.db`);
    setStatus(`Banco SQLite gerado (${DADOS.length} registros na tabela 'ranking').`);
  } catch (err) {
    setStatus("Erro ao gerar o banco: " + err.message, true);
    console.error(err);
  }
}

/** Reconstrói DADOS a partir de um arquivo de banco SQLite exportado. */
async function importarSqlite(file) {
  mostrarProgresso(true);
  setFase(`Importando banco "${file.name}"...`);
  setProgresso(0, 1);
  try {
    const SQL = await getSqlJs();
    const buf = new Uint8Array(await file.arrayBuffer());
    const db = new SQL.Database(buf);
    // 'condicao' pode não existir em bancos antigos; tenta com, cai sem.
    let rk;
    try {
      rk = db.exec("SELECT id_deputado, deputado, partido, uf, condicao, legislatura, projetos_em_lei FROM ranking");
    } catch (e) {
      const r0 = db.exec("SELECT id_deputado, deputado, partido, uf, legislatura, projetos_em_lei FROM ranking");
      rk = r0.length ? [{ values: r0[0].values.map((v) => [v[0], v[1], v[2], v[3], "—", v[4], v[5]]) }] : [];
    }
    const pj = db.exec("SELECT id_proposicao, id_deputado, legislatura, tipo, numero, ano, data_apresentacao, ementa FROM projetos");
    db.close();

    const porChave = new Map();
    if (pj.length) for (const [id, idDep, leg, tipo, numero, ano, data, ementa] of pj[0].values) {
      const chave = `${idDep}|${leg}`;
      if (!porChave.has(chave)) porChave.set(chave, []);
      porChave.get(chave).push({ id, tipo, numero, ano, ementa: ementa || "", dataApresentacao: data || "" });
    }
    DADOS = [];
    if (rk.length) for (const [idDep, nome, partido, uf, condicao, leg, total] of rk[0].values) {
      const projetos = porChave.get(`${idDep}|${leg}`) || [];
      DADOS.push({
        depId: idDep, nome, partido: partido || "", uf: uf || "", condicao: condicao || "—",
        legislatura: String(leg), total: total != null ? total : projetos.length, projetos,
      });
    }
    mostrarProgresso(false);
    finalizarRender();
    setStatus(`Importado do banco "${file.name}": ${DADOS.length} registros.`);
  } catch (err) {
    mostrarProgresso(false);
    setStatus("Erro ao importar o banco: " + err.message, true);
    console.error(err);
  }
}

// ---- UI / progresso ---------------------------------------------------------

function getSelecionados(classe) {
  return [...document.querySelectorAll(`.${classe}:checked`)].map((c) => c.value);
}

function setStatus(msg, erro = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.toggle("error", erro);
}

let faseAtual = "";
function setFase(texto) { faseAtual = texto; document.getElementById("progressText").textContent = texto; }

function mostrarProgresso(mostrar) {
  document.getElementById("progressWrap").hidden = !mostrar;
  if (mostrar) { document.getElementById("progressFill").style.width = "0%"; }
}

function setProgresso(feitos, total) {
  const pct = total ? Math.round((feitos / total) * 100) : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressText").textContent = `${faseAtual} ${feitos}/${total} (${pct}%)`;
}

function setProgressoBytes(recebido, total) {
  const mb = (b) => (b / 1048576).toFixed(1);
  if (total) {
    const pct = Math.round((recebido / total) * 100);
    document.getElementById("progressFill").style.width = pct + "%";
    document.getElementById("progressText").textContent =
      `${faseAtual} ${mb(recebido)}/${mb(total)} MB (${pct}%)`;
  } else {
    document.getElementById("progressText").textContent = `${faseAtual} ${mb(recebido)} MB`;
  }
}

function finalizarRender() {
  document.getElementById("results").hidden = false;
  document.getElementById("btnExportar").disabled = DADOS.length === 0;
  document.getElementById("btnExportarDb").disabled = DADOS.length === 0;
  popularFiltros();
  prepararBancadas();
  renderTabela();
}

/** Anos de arquivo necessários para as legislaturas marcadas. */
function anosNecessarios(legs) {
  return new Set(legs.flatMap((l) => (LEGISLATURAS[l] ? LEGISLATURAS[l].anos : [])));
}

/** Extrai o ano (AAAA) do nome de cada arquivo selecionado. */
function anosDosArquivos(files) {
  const anos = new Set();
  for (const f of files) {
    const m = f.name.match(/(20\d{2})/);
    if (m) anos.add(parseInt(m[1], 10));
  }
  return anos;
}

/** Mostra quais anos ainda faltam (ou confirma que está completo). */
function atualizarStatusArquivos() {
  const el = document.getElementById("statusArquivos");
  const legs = getSelecionados("leg");
  if (!legs.length || !ARQUIVOS_SELECIONADOS.length) {
    el.textContent = ""; el.className = "hint"; return;
  }
  const necessarios = anosNecessarios(legs);
  const presentes = anosDosArquivos(ARQUIVOS_SELECIONADOS);
  const faltam = [...necessarios].filter((a) => !presentes.has(a)).sort();
  if (faltam.length === 0) {
    el.className = "hint ok";
    el.textContent = "✓ Todos os arquivos das legislaturas marcadas estão selecionados.";
  } else {
    el.className = "hint faltando";
    el.textContent = "⚠️ Faltam os arquivos: " +
      faltam.map((a) => `proposicoes-${a}.json`).join(", ") +
      " — baixe-os no passo 1 e inclua na seleção.";
  }
}

function configurarEventos() {
  const fileArquivos = document.getElementById("fileArquivos");
  const btnProcessar = document.getElementById("btnProcessar");

  fileArquivos.addEventListener("change", (e) => {
    ARQUIVOS_SELECIONADOS = [...e.target.files];
    btnProcessar.disabled = ARQUIVOS_SELECIONADOS.length === 0;
    const nomes = ARQUIVOS_SELECIONADOS.map((f) => f.name).join(", ");
    document.getElementById("arquivosSelecionados").textContent =
      ARQUIVOS_SELECIONADOS.length ? `${ARQUIVOS_SELECIONADOS.length} arquivo(s): ${nomes}` : "";
    atualizarStatusArquivos();
  });

  document.querySelectorAll(".leg").forEach((c) =>
    c.addEventListener("change", atualizarStatusArquivos));

  btnProcessar.addEventListener("click", async () => {
    const legs = getSelecionados("leg");
    const tipos = getSelecionados("tipo");
    if (!legs.length) return setStatus("Selecione ao menos uma legislatura.", true);
    if (!tipos.length) return setStatus("Selecione ao menos um tipo de proposição.", true);
    if (!ARQUIVOS_SELECIONADOS.length)
      return setStatus("Selecione os arquivos proposicoes-AAAA.json baixados (passo 1).", true);

    const usarCondicao = document.getElementById("chkCondicao").checked;
    btnProcessar.disabled = true;
    setStatus("");
    mostrarProgresso(true);
    setFase("Iniciando...");
    try {
      await coletar(legs, tipos, ARQUIVOS_SELECIONADOS, usarCondicao);
      finalizarRender();
    } catch (err) {
      mostrarProgresso(false);
      setStatus("Erro ao processar: " + err.message, true);
      console.error(err);
    } finally {
      btnProcessar.disabled = false;
    }
  });

  document.getElementById("btnExportar").addEventListener("click", exportarXlsx);
  document.getElementById("btnExportarDb").addEventListener("click", exportarSqlite);
  document.getElementById("btnLimparCache").addEventListener("click", () => {
    CONDICOES = {}; ROSTERS = {};
    try { localStorage.removeItem(COND_STORE_KEY); localStorage.removeItem(ROSTER_STORE_KEY); } catch (e) {}
    setStatus("Cache de deputados e de condição (titular/suplente) apagado. O próximo Processar buscará tudo de novo.");
  });
  document.getElementById("fileImportar").addEventListener("change", (e) => {
    if (e.target.files[0]) importarXlsx(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("fileImportarDb").addEventListener("change", (e) => {
    if (e.target.files[0]) importarSqlite(e.target.files[0]);
    e.target.value = "";
  });

  // Bancadas fixas
  document.getElementById("btnSalvarBancada").addEventListener("click", salvarBancadaAtual);
  document.getElementById("btnExcluirBancada").addEventListener("click", excluirBancada);
  document.getElementById("btnLimparSelecao").addEventListener("click", () => {
    selecaoBancada = new Set();
    document.getElementById("bancadaNome").value = "";
    renderBancadaLista();
  });
  document.getElementById("bancadaExistente").addEventListener("change", (e) => carregarBancada(e.target.value));
  document.getElementById("bancadaBusca").addEventListener("input", renderBancadaLista);

  ["filtroNome", "filtroLeg", "filtroPartido", "filtroUf", "filtroCondicao", "filtroBancada", "filtroComLei"].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener("input", renderTabela);
    el.addEventListener("change", renderTabela);
  });

  document.querySelectorAll("#tabela th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const coluna = th.dataset.sort;
      if (coluna === "rank") return;
      if (ordemAtual.coluna === coluna) ordemAtual.asc = !ordemAtual.asc;
      else ordemAtual = { coluna, asc: coluna !== "total" };
      document.querySelectorAll("#tabela th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(ordemAtual.asc ? "sorted-asc" : "sorted-desc");
      renderTabela();
    });
  });
}

configurarEventos();
