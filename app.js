/* Relatório: deputados com projetos convertidos em lei (56ª e 57ª legislaturas)
 * Consulta a API de Dados Abertos da Câmara dos Deputados diretamente do navegador. */

"use strict";

const API = "https://dadosabertos.camara.leg.br/api/v2";
const COD_TRANSFORMADO_EM_LEI = "1140"; // "Transformado em Norma Jurídica"
const CONCORRENCIA = 5;

// Faixas de data de apresentação por legislatura (usadas para classificar os projetos).
const LEGISLATURAS = {
  "57": { rotulo: "57ª (2023–2027)", inicio: "2023-02-01", fim: "2027-01-31" },
  "56": { rotulo: "56ª (2019–2023)", inicio: "2019-02-01", fim: "2023-01-31" },
};

const FICHA_URL = (id) =>
  `https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=${id}`;

// ---- Estado global ----------------------------------------------------------
let DADOS = []; // [{ depId, nome, partido, uf, legislatura, total, projetos: [...] }]
let ordemAtual = { coluna: "total", asc: false };

// ---- Helpers de rede --------------------------------------------------------

/** fetch com retry/backoff em erros transitórios (429 / 5xx / rede). */
async function fetchComRetry(url, tentativas = 5) {
  let espera = 1000;
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

/** Busca todos os deputados de uma legislatura (paginado). */
async function fetchDeputados(idLegislatura) {
  const deputados = [];
  let pagina = 1;
  while (true) {
    const url = `${API}/deputados?idLegislatura=${idLegislatura}&ordem=ASC&ordenarPor=nome&itens=100&pagina=${pagina}`;
    const resp = await fetchComRetry(url);
    const json = await resp.json();
    for (const d of json.dados) {
      deputados.push({
        id: d.id,
        nome: d.nome,
        partido: d.siglaPartido || "",
        uf: d.siglaUf || "",
      });
    }
    const total = parseInt(resp.headers.get("x-total-count") || "0", 10);
    if (pagina * 100 >= total || json.dados.length === 0) break;
    pagina++;
  }
  return deputados;
}

/** Busca todos os projetos (dos tipos dados) de autoria do deputado que viraram lei. */
async function fetchProjetosAprovados(idDeputado, tipos) {
  const tipoParam = encodeURIComponent(tipos.join(","));
  const projetos = [];
  let pagina = 1;
  while (true) {
    const url =
      `${API}/proposicoes?idDeputadoAutor=${idDeputado}` +
      `&codSituacao=${COD_TRANSFORMADO_EM_LEI}&siglaTipo=${tipoParam}` +
      `&itens=100&ordenarPor=id&ordem=ASC&pagina=${pagina}`;
    const resp = await fetchComRetry(url);
    const json = await resp.json();
    for (const p of json.dados) {
      projetos.push({
        id: p.id,
        tipo: p.siglaTipo,
        numero: p.numero,
        ano: p.ano,
        ementa: p.ementa || "",
        dataApresentacao: p.dataApresentacao || "",
      });
    }
    const total = parseInt(resp.headers.get("x-total-count") || "0", 10);
    if (pagina * 100 >= total || json.dados.length === 0) break;
    pagina++;
  }
  return projetos;
}

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

/** Orquestra toda a coleta e monta DADOS. */
async function coletar(legsSelecionadas, tipos) {
  // 1. Rosters de cada legislatura selecionada + união por id.
  setStatus("Buscando lista de deputados...");
  const rosterPorLeg = {}; // leg -> Set(depId)
  const infoDep = new Map(); // depId -> { nome, partido, uf }
  for (const leg of legsSelecionadas) {
    const lista = await fetchDeputados(leg);
    rosterPorLeg[leg] = new Set(lista.map((d) => d.id));
    for (const d of lista) if (!infoDep.has(d.id)) infoDep.set(d.id, d);
  }

  const idsUnicos = [...infoDep.keys()];
  setStatus(`Consultando projetos de ${idsUnicos.length} deputados...`);
  mostrarProgresso(true);

  // 2. Para cada deputado, buscar projetos aprovados e separar por legislatura.
  const bucketsPorDep = new Map(); // depId -> { "56": [...], "57": [...] }
  await poolDeTarefas(
    idsUnicos,
    CONCORRENCIA,
    async (depId) => {
      const projetos = await fetchProjetosAprovados(depId, tipos);
      const buckets = {};
      for (const p of projetos) {
        const leg = classificarPorLegislatura(p.dataApresentacao);
        if (leg && legsSelecionadas.includes(leg)) {
          (buckets[leg] = buckets[leg] || []).push(p);
        }
      }
      bucketsPorDep.set(depId, buckets);
    },
    (feitos, total) => atualizarProgresso(feitos, total)
  );

  // 3. Montar linhas: uma por (deputado, legislatura) quando faz parte do roster
  //    ou possui ao menos um projeto naquela legislatura.
  DADOS = [];
  for (const depId of idsUnicos) {
    const info = infoDep.get(depId);
    const buckets = bucketsPorDep.get(depId) || {};
    for (const leg of legsSelecionadas) {
      const projetos = buckets[leg] || [];
      const noRoster = rosterPorLeg[leg] && rosterPorLeg[leg].has(depId);
      if (!noRoster && projetos.length === 0) continue;
      DADOS.push({
        depId,
        nome: info.nome,
        partido: info.partido,
        uf: info.uf,
        legislatura: leg,
        total: projetos.length,
        projetos,
      });
    }
  }

  mostrarProgresso(false);
  setStatus(
    `Coleta concluída: ${DADOS.length} registros (deputado × legislatura). ` +
      `Tipos: ${tipos.join(", ")}.`
  );
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
  sel.innerHTML = `<option value="">${rotuloVazio}</option>`;
  for (const v of valores) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
}

function dadosFiltrados() {
  const nome = document.getElementById("filtroNome").value.trim().toLowerCase();
  const leg = document.getElementById("filtroLeg").value;
  const partido = document.getElementById("filtroPartido").value;
  const uf = document.getElementById("filtroUf").value;
  const soComLei = document.getElementById("filtroComLei").checked;

  let linhas = DADOS.filter((d) => {
    if (nome && !d.nome.toLowerCase().includes(nome)) return false;
    if (leg && d.legislatura !== leg) return false;
    if (partido && d.partido !== partido) return false;
    if (uf && d.uf !== uf) return false;
    if (soComLei && d.total === 0) return false;
    return true;
  });

  const { coluna, asc } = ordemAtual;
  linhas.sort((a, b) => {
    let va = a[coluna], vb = b[coluna];
    if (coluna === "total") { va = a.total; vb = b.total; }
    if (typeof va === "string") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    // desempate estável por total desc e depois nome
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

  document.getElementById("resultCount").textContent =
    `${linhas.length} registros • ${linhas.reduce((s, d) => s + d.total, 0)} projetos`;
}

function alternarProjetos(tr, d) {
  const proxima = tr.nextElementSibling;
  if (proxima && proxima.classList.contains("projetos-row")) {
    proxima.remove();
    return;
  }
  const row = document.createElement("tr");
  row.className = "projetos-row";
  const td = document.createElement("td");
  td.colSpan = 7;
  const ol = document.createElement("ol");
  ol.className = "projetos-list";
  for (const p of d.projetos) {
    const li = document.createElement("li");
    li.innerHTML =
      `<span class="pj-titulo">` +
      `<a href="${FICHA_URL(p.id)}" target="_blank" rel="noopener">${p.tipo} ${p.numero}/${p.ano}</a>` +
      `</span> <small>(apresentado em ${escapar((p.dataApresentacao || "").slice(0, 10))})</small>` +
      `<div class="pj-ementa">${escapar(p.ementa)}</div>`;
    ol.appendChild(li);
  }
  td.appendChild(ol);
  row.appendChild(td);
  tr.after(row);
}

function escapar(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Exportar / importar Excel ---------------------------------------------

function exportarXlsx() {
  if (!DADOS.length) return;

  const ranking = DADOS.map((d) => ({
    Deputado: d.nome,
    Partido: d.partido,
    UF: d.uf,
    Legislatura: LEGISLATURAS[d.legislatura].rotulo,
    "Projetos convertidos em lei": d.total,
    Leg: d.legislatura,
    idDeputado: d.depId,
  }));

  const projetos = [];
  for (const d of DADOS) {
    for (const p of d.projetos) {
      projetos.push({
        Deputado: d.nome,
        Partido: d.partido,
        UF: d.uf,
        Legislatura: LEGISLATURAS[d.legislatura].rotulo,
        Tipo: p.tipo,
        Numero: p.numero,
        Ano: p.ano,
        "Data apresentacao": (p.dataApresentacao || "").slice(0, 10),
        Ementa: p.ementa,
        Link: FICHA_URL(p.id),
        idProposicao: p.id,
        Leg: d.legislatura,
        idDeputado: d.depId,
      });
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(ranking), "Ranking");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(projetos), "Projetos");

  const hoje = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `deputados-projetos-em-lei-${hoje}.xlsx`);
}

function importarXlsx(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(e.target.result, { type: "array" });
      reconstruirDeXlsx(wb);
      finalizarRender();
      setStatus(`Importado de "${file.name}": ${DADOS.length} registros.`);
    } catch (err) {
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

  // Mapeia o rótulo da legislatura de volta para a chave "56"/"57".
  const rotuloParaChave = {};
  for (const [chave, info] of Object.entries(LEGISLATURAS)) rotuloParaChave[info.rotulo] = chave;
  const legDe = (r) =>
    r.Leg != null ? String(r.Leg) : rotuloParaChave[r.Legislatura] || String(r.Legislatura);

  // Agrupa os projetos por (idDeputado | legislatura).
  const projetosPorChave = new Map();
  for (const r of projetos) {
    const chave = `${r.idDeputado}|${legDe(r)}`;
    if (!projetosPorChave.has(chave)) projetosPorChave.set(chave, []);
    projetosPorChave.get(chave).push({
      id: r.idProposicao,
      tipo: r.Tipo,
      numero: r.Numero,
      ano: r.Ano,
      ementa: r.Ementa || "",
      dataApresentacao: r["Data apresentacao"] || "",
    });
  }

  DADOS = ranking.map((r) => {
    const leg = legDe(r);
    const projetosLinha = projetosPorChave.get(`${r.idDeputado}|${leg}`) || [];
    return {
      depId: r.idDeputado,
      nome: r.Deputado,
      partido: r.Partido || "",
      uf: r.UF || "",
      legislatura: leg,
      total: Number(r["Projetos convertidos em lei"]) || projetosLinha.length,
      projetos: projetosLinha,
    };
  });
}

// ---- UI / eventos -----------------------------------------------------------

function getSelecionados(classe) {
  return [...document.querySelectorAll(`.${classe}:checked`)].map((c) => c.value);
}

function setStatus(msg, erro = false) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.classList.toggle("error", erro);
}

function mostrarProgresso(mostrar) {
  document.getElementById("progressWrap").hidden = !mostrar;
  if (mostrar) atualizarProgresso(0, 1);
}

function atualizarProgresso(feitos, total) {
  const pct = total ? Math.round((feitos / total) * 100) : 0;
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressText").textContent = `${feitos}/${total} (${pct}%)`;
}

function finalizarRender() {
  document.getElementById("results").hidden = false;
  document.getElementById("btnExportar").disabled = DADOS.length === 0;
  popularFiltros();
  renderTabela();
}

function configurarEventos() {
  document.getElementById("btnColetar").addEventListener("click", async () => {
    const legs = getSelecionados("leg");
    const tipos = getSelecionados("tipo");
    if (!legs.length) return setStatus("Selecione ao menos uma legislatura.", true);
    if (!tipos.length) return setStatus("Selecione ao menos um tipo de proposição.", true);

    const btn = document.getElementById("btnColetar");
    btn.disabled = true;
    try {
      await coletar(legs, tipos);
      finalizarRender();
    } catch (err) {
      mostrarProgresso(false);
      setStatus("Erro na coleta: " + err.message, true);
      console.error(err);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btnExportar").addEventListener("click", exportarXlsx);
  document.getElementById("fileImportar").addEventListener("change", (e) => {
    if (e.target.files[0]) importarXlsx(e.target.files[0]);
    e.target.value = "";
  });

  ["filtroNome", "filtroLeg", "filtroPartido", "filtroUf", "filtroComLei"].forEach((id) => {
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
      document.querySelectorAll("#tabela th").forEach((h) =>
        h.classList.remove("sorted-asc", "sorted-desc")
      );
      th.classList.add(ordemAtual.asc ? "sorted-asc" : "sorted-desc");
      renderTabela();
    });
  });
}

configurarEventos();
