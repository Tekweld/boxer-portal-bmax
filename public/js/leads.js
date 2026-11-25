const ANDAMENTO_STATUS = ["Pendente","Sem retorno","Em contato","Proposta enviada","Em negociação","Aguardando pagamento","Aguardando decisão do cliente"];
const MOTIVOS_PERDA = ["Já comprou a máquina","Preço acima do esperado","Sem contato com o cliente","Optou por outra marca","Desistiu da compra","Prazo de entrega","Falta de crédito/financiamento","Outro"];
let API_LEADS = [];
let LEADS_SEM_REVENDA = [];
let isLoadingLeads = false;
let activeAlertFilter = null;

function showLoadError(msg) {
  const grid = $("grid");
  grid.innerHTML = `<div style="grid-column:1/-1;padding:20px;border-radius:12px;background:rgba(227,6,19,.08);border:1px solid rgba(227,6,19,.3);color:#e30613;font-weight:700;font-size:13px;text-align:center;">
    ${msg}<br><button onclick="retryLoad()" style="margin-top:10px;padding:8px 20px;border-radius:10px;border:none;background:#e30613;color:#fff;font-weight:800;cursor:pointer;font-size:13px;">Tentar Novamente</button>
  </div>`;
}

async function retryLoad() {
  await loadLeads();
  setupFilter();
  render();
  setDashHeader();
}

function showSkeleton() {
  $("skeletonGrid").classList.remove("hidden");
  $("grid").classList.add("hidden");
}

function hideSkeleton() {
  $("skeletonGrid").classList.add("hidden");
  $("grid").classList.remove("hidden");
}

async function loadLeads() {
  const token = localStorage.getItem("token");

  if (!token) {
    logout();
    return;
  }

  isLoadingLeads = true;
  showSkeleton();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const res = await fetch(`${API_URL}/leads`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (res.status === 401) {
      toast("Sessao expirada", "warn");
      logout();
      return;
    }

    if (res.status === 403) {
      showLoadError("Acesso negado (403)");
      return;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      showLoadError(`Erro ao carregar leads (${res.status}): ${errBody.substring(0, 100)}`);
      API_LEADS = [];
      return;
    }

    const data = await res.json();

    if (!Array.isArray(data) || data.length === 0) {
      API_LEADS = [];
      return;
    }

    if (session.role === "adm") {
      // "Sem revenda" é só mais um filtro sobre a lista completa — nunca deve
      // remover leads de API_LEADS, senão todo outro alerta (PCI, Oportunidade,
      // Classe, etc.) sub-conta silenciosamente por já não ver esses leads.
      // "Sem Revenda" (valor literal do RD) também conta: lead sem vínculo com nenhuma revenda precisa de correção
      const invalidos = ["", "?????", "?", "Vazio", "N/D", "Sem Revenda"];
      API_LEADS = data;
      LEADS_SEM_REVENDA = data.filter(l => invalidos.includes((l.revenda || "").trim()));
    } else {
      API_LEADS = data;
      LEADS_SEM_REVENDA = [];
    }
  } catch (err) {
    API_LEADS = [];
    if (err.name === 'AbortError') {
      showLoadError("Tempo esgotado ao carregar leads. A API demorou demais. Tente novamente.");
    } else {
      showLoadError("Erro de conexao: " + (err.message || "falha na rede"));
    }
  } finally {
    isLoadingLeads = false;
    hideSkeleton();
  }
}

function setupFilter() {
  const sel = $("filter");
  const data = API_LEADS;

  sel.innerHTML = "";

  if (session.role === "revenda") {
    const opt = document.createElement("option");
    const label = session.name || session.username;
    opt.value = label;
    opt.textContent = label;
    sel.appendChild(opt);
    sel.value = label;
    sel.disabled = true;
    return;
  }

  sel.disabled = false;
  const invalidosRev = ["", "?????", "?", "Vazio", "N/D"];
  // revenda sem loja ativa no cadastro (ex.: inativa) não vira opção do filtro; os cards seguem em "Todas as revendas"
  // O filtro é por GRUPO: lojas do mesmo grupo (ex.: as 4 Luitex) aparecem como uma opção só
  const revendas = uniq(data.filter(l => !l.revendaForaDoCadastro).map(l => l.revendaGrupo || l.revenda).filter(r => !invalidosRev.includes((r || "").trim()))).sort();

  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "Todas as revendas";
  sel.appendChild(optAll);

  revendas.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  });

  sel.value = "all";
}

function render() {
  const qRaw = $("q").value.trim();
  const qText = normalizeText(qRaw);
  const qDigits = normalizeDigits(qRaw);
  const rev = $("filter").value;

  let data = API_LEADS;

  if (activeAlertFilter === "semRevenda") {
    data = LEADS_SEM_REVENDA;
  } else if (activeAlertFilter === "revendaSemLogin") {
    data = API_LEADS.filter(l => l.revendaSemLogin);
  } else if (activeAlertFilter === "semPci") {
    data = API_LEADS.filter(l => !l.pci || l.pci === "N/D" || l.pci === "PCI12");
  } else if (activeAlertFilter === "semOportunidade") {
    data = API_LEADS.filter(l => !l.oportunidadedevendas || l.oportunidadedevendas.trim() === "");
  } else if (activeAlertFilter === "semRepresentante") {
    const inv = ["", "?????", "?", "Vazio", "N/D"];
    data = API_LEADS.filter(l => inv.includes((l.representante || "").trim()));
  } else if (activeAlertFilter === "semClasse") {
    data = API_LEADS.filter(l => !l.classePreco);
  } else if (activeAlertFilter === "produtosNaoBmax") {
    data = API_LEADS.filter(l => ehPciX(l));
  } else if (activeAlertFilter === "repInvalido") {
    const validReps = new Set((APP_CONFIG?.representantes || []).map(r => r.trim()));
    const inv = ["", "?????", "?", "Vazio", "N/D"];
    data = API_LEADS.filter(l => {
      const rep = (l.representante || "").trim();
      return !inv.includes(rep) && rep && !validReps.has(rep);
    });
  }

  // Pra role "revenda" o backend já devolve só os leads dessa revenda (via
  // grupo/bmax_grupos, cobrindo lojas com nomes diferentes no RD) — refiltrar
  // aqui por igualdade exata de nome quebrava qualquer grupo multi-loja além
  // da Luitex (que só "funcionava" por um hack de substring hardcoded). Não
  // há nada a refiltrar: API_LEADS já É a lista certa.
  if (session.role !== "revenda" && rev !== "all") {
    data = data.filter(l => normalizeText(l.revendaGrupo || l.revenda) === normalizeText(rev));
  }

  if (activeQuemFilter) {
    data = data.filter(l => l.quemVende === activeQuemFilter);
  }

  if (activePciFilter && session.role !== "revenda") {
    data = data.filter(l => pciChave(l) === activePciFilter);
  }

  if (qRaw) {
    data = data.filter(l => {
      const textBlob = normalizeText([
        l.nome, l.cidade, l.atividade, l.segmento, l.vinculo, l.tag, l.revenda, l.representante, l.pci
      ].join(" | "));

      const digitsBlob = normalizeDigits([l.cnpj, l.cep, l.id, l.preco, l.valor].join(""));

      const matchText = qText && textBlob.includes(qText);
      const matchDigits = qDigits && digitsBlob.includes(qDigits);

      return matchText || matchDigits;
    });
  }

  const vendas = data.filter(l => {
    const t = (l.tag || "").toLowerCase();
    return t.includes("venda") || t === "vendido";
  });

  $("statLeads").textContent = data.length;
  if (session.role === "revenda") {
    $("statRevendas").parentElement.querySelector(".k").textContent = "Meus Leads";
    $("statRevendas").textContent = data.length;
  } else {
    $("statRevendas").parentElement.querySelector(".k").textContent = "Revendas";
    const invalidosRev = ["", "?????", "?", "Vazio", "N/D"];
    $("statRevendas").textContent = uniq(data.map(l => l.revenda).filter(r => !invalidosRev.includes((r || "").trim()))).length;
  }
  $("statVendas").textContent = vendas.length;

  if (session.role === "adm") {
    // Admin: o Cashback Total é o SALDO CREDITADO do extrato (mesma fonte da aba Extrato de Comissões e da tela da revenda), não uma estimativa
    atualizarCashbackAdmin(rev);
  } else if (session.role !== "revenda") {
    const cashbackTotal = data.reduce((total, card) => total + (card.cashback || 0), 0);
    const cashValEl = $("statCashbackVal");
    cashValEl.textContent = `R$ ${cashbackTotal.toLocaleString("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
    cashValEl.className = cashbackTotal > 0 ? "cashback-positive" : "";
  }
  const cashLabel = $("statCashback")?.querySelector(".k");
  if (cashLabel) cashLabel.textContent = session.role === "representante" ? "Comissao Total" : "Cashback Total";
  // Funcionário Boxer não tem carteira de cashback/comissão: esconde o card (e o atalho para o extrato)
  const cardCash = $("statCashback"); if (cardCash) cardCash.classList.toggle("hidden", session.role === "funcionario");

  const alertPanel = $("alertPanel");
  if (session.role === "adm") {
    let hasAlerts = false;

    const alertRevenda = $("alertaSemRevenda");
    if (LEADS_SEM_REVENDA.length > 0) {
      $("qtdSemRevenda").textContent = LEADS_SEM_REVENDA.length;
      alertRevenda.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertRevenda.classList.add("hidden");
    }

    const semLoginList = API_LEADS.filter(l => l.revendaSemLogin);
    const alertSemLogin = $("alertaRevendaSemLogin");
    if (semLoginList.length > 0) {
      $("qtdRevendaSemLogin").textContent = semLoginList.length;
      alertSemLogin.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertSemLogin.classList.add("hidden");
    }

    const semPci = data.filter(l => !l.pci || l.pci === "N/D" || l.pci === "PCI12");
    const alertPci = $("alertaSemPci");
    if (semPci.length > 0) {
      $("qtdSemPci").textContent = semPci.length;
      alertPci.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertPci.classList.add("hidden");
    }

    const semOportunidade = data.filter(l => !l.oportunidadedevendas || l.oportunidadedevendas.trim() === "");
    const alertOportunidade = $("alertaSemOportunidade");
    if (semOportunidade.length > 0) {
      $("qtdSemOportunidade").textContent = semOportunidade.length;
      alertOportunidade.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertOportunidade.classList.add("hidden");
    }

    const invalidos = ["", "?????", "?", "Vazio", "N/D"];
    const semRep = data.filter(l => invalidos.includes((l.representante || "").trim()));
    const alertRep = $("alertaSemRepresentante");
    if (semRep.length > 0) {
      $("qtdSemRepresentante").textContent = semRep.length;
      alertRep.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertRep.classList.add("hidden");
    }

    const semClasse = data.filter(l => !l.classePreco);
    const alertClasse = $("alertaSemClasse");
    if (semClasse.length > 0) {
      $("qtdSemClasse").textContent = semClasse.length;
      alertClasse.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertClasse.classList.add("hidden");
    }

    const validReps = new Set((APP_CONFIG?.representantes || []).map(r => r.trim()));
    const invRep = ["", "?????", "?", "Vazio", "N/D"];
    const repInvalido = data.filter(l => {
      const rep = (l.representante || "").trim();
      return !invRep.includes(rep) && rep && !validReps.has(rep);
    });
    const alertRepInv = $("alertaRepInvalido");
    if (repInvalido.length > 0) {
      $("qtdRepInvalido").textContent = repInvalido.length;
      alertRepInv.classList.remove("hidden");
      hasAlerts = true;
    } else {
      alertRepInv.classList.add("hidden");
    }

    alertPanel.classList.toggle("hidden", !hasAlerts);
  } else {
    alertPanel.classList.add("hidden");
  }

  renderGrid(data);
}

// Ordem pedida pelo André (22/09/2026): Venda Efetivada primeiro, depois
// Negociação, Em Contato, Demonstração e Lead por último — e dentro de cada
// grupo, do lead mais antigo pro mais novo. "Entrega Técnica"/"Vendido" contam
// como o mesmo grupo de Venda Efetivada (já são vendas fechadas). Qualquer tag
// fora dessa lista (Perdido, Assumido, "??????" etc.) cai no fim, junto.
const TAG_ORDEM = {
  "Venda Efetivada": 0,
  "Vendido": 0,
  "Entrega Técnica": 0,
  "Negociação": 1,
  "Em Contato": 2,
  "Demonstração": 3,
  "Lead": 4
};

function ordenarCards(data) {
  return [...data].sort((a, b) => {
    const oa = TAG_ORDEM[a.tag] ?? 5;
    const ob = TAG_ORDEM[b.tag] ?? 5;
    if (oa !== ob) return oa - ob;
    const da = a.criadoemRaw ? new Date(a.criadoemRaw).getTime() : 0;
    const db = b.criadoemRaw ? new Date(b.criadoemRaw).getTime() : 0;
    return da - db;
  });
}

function renderGrid(data) {
  atualizarBarraPciX();
  atualizarBarraPci();
  atualizarBarraQuem();
  const grid = $("grid");
  grid.innerHTML = "";

  $("empty").classList.toggle("hidden", data.length !== 0);

  ordenarCards(data).forEach(l => {
    const el = document.createElement("div");
    const pcixCard = ehPciX(l);
    el.className = "lead" + (pcixCard ? (l.pcix && l.pcix.vencido && !l.fechado ? " lead-pcix lead-pcix-vencido" : " lead-pcix") : "");
    el.dataset.leadJson = JSON.stringify(l);
    const cb = Number(l.cashback || 0);
    const cbClass = cb > 0 ? "cashback cashback-pos" : "cashback";
    el.innerHTML = `
      ${pcixCard ? `<div class="pcix-tag">Produto não BMax${l.pcix && !l.fechado ? (l.pcix.vencido ? ` &bull; prazo vencido (${l.pcix.dias} dias)` : ` &bull; ${l.pcix.restantes} dia${l.pcix.restantes === 1 ? "" : "s"} restante${l.pcix.restantes === 1 ? "" : "s"}`) : ""}</div>` : ""}
      ${l.quemVende && !l.fechado ? `<div class="quem-tag quem-${l.quemVende}">${QUEM_ROTULO[l.quemVende]}</div>` : ""}
      <div class="lead-top">
        <div class="lead-title">
          <h4 title="${esc(l.nome)}">${esc(l.nome)}</h4>
          <div class="subline">${esc(l.revenda)} &bull; ${esc(l.representante)}</div>
        </div>
        <div class="tag ${tagClass(l.tag)}">${esc(l.tag)}</div>
      </div>

      <div class="meta">
        <div class="pair"><b>CNPJ</b><span title="${esc(l.cnpj)}">${esc(l.cnpj)}</span></div>
        <div class="pair"><b>Cidade/UF</b><span>${esc(l.cidade)}/${esc(l.estado)}</span></div>
        <div class="pair"><b>Maquina</b><span title="${esc(l.maquinainteresse)}">${esc(l.maquinainteresse)}</span></div>
        <div class="pair"><b>Valor</b><span>R$ ${esc(l.valor)}</span></div>
      </div>

      ${l.prazo48hExpirou ? `<div style="font-size:11px;color:var(--muted);margin:-4px 0 6px;">Prazo de 48h úteis expirou — seguiu como Boxer vende</div>` : ""}
      <div class="lead-foot">
        <span style="font-size:11px;color:var(--muted);font-weight:800;">${esc(l.criadoem)}</span>
        <div class="${cbClass}">R$ ${cb.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      ${((session.role === "revenda" && (normalizePci(l.pci) === "PCI12A" || pcixCard)) || (session.role === "adm" && pcixCard)) && !l.fechado ? `
      <div class="lead-resultado" data-id="${esc(l.id)}">
        <div class="resultado-actions">
          <button type="button" class="resultado-btn vendido" data-id="${esc(l.id)}" data-resultado="vendido">Vendido</button>
          <button type="button" class="resultado-btn perdido" data-id="${esc(l.id)}" data-resultado="perdido">Perdido</button>
        </div>
        <input type="number" class="valor-venda" data-id="${esc(l.id)}" placeholder="Valor numerico da venda" step="any" min="0" inputmode="decimal">
        <div class="andamento-box">
          ${l.andamento && l.andamento.tipo === "status" ? `<div class="andamento-chip" title="${esc(l.andamento.observacao || "")}">Andamento: <b>${esc(l.andamento.status)}</b></div>` : ""}
          <select class="andamento-status" data-id="${esc(l.id)}">
            <option value="">Status da negociação…</option>
            ${ANDAMENTO_STATUS.map(s => `<option value="${esc(s)}"${l.andamento && l.andamento.status === s ? " selected" : ""}>${esc(s)}</option>`).join("")}
          </select>
          <textarea class="andamento-obs" data-id="${esc(l.id)}" rows="2" maxlength="1000" placeholder="Observação (opcional)"></textarea>
          <button type="button" class="resultado-btn andamento-salvar" data-id="${esc(l.id)}">Salvar andamento</button>
        </div>
      </div>
      ` : ""}
      ${["revenda", "representante", "adm", "funcionario"].includes(session.role) && normalizePci(l.pci) === "PCI12" && !l.fechado && !["Vendido", "Perdido", "Venda Efetivada", "Entrega Técnica"].includes(l.tag) ? `
      <div class="lead-action">
        <select class="caminho-select" data-id="${esc(l.id)}" data-cidade="${esc(l.cidade)}" data-estado="${esc(l.estado)}">
          <option value="">Como deseja atender este lead?</option>
          <option value="BOX>REV">Eu assumo a venda (revenda atende)</option>
          <option value="BOX+REV>IND">Boxer vende, eu ganho comissao</option>
        </select>
      </div>
      ` : ""}
    `;
    grid.appendChild(el);
  });
}

// Saldo creditado (extrato) da revenda/grupo selecionado no filtro, ou de todas
let _cashAdminChave = null;
async function atualizarCashbackAdmin(rev) {
  const el = $("statCashbackVal"); if (!el) return;
  const chave = rev || "all"; if (_cashAdminChave === chave) return; _cashAdminChave = chave;
  const box = $("statCashback"); if (box) box.title = "Saldo creditado no extrato (igual à aba Extrato de Comissões e à tela da revenda)";
  try {
    const qs = chave === "all" ? "todas=1" : "revenda=" + encodeURIComponent(chave);
    const res = await fetch(`${API_URL}/cashback/saldo?${qs}`, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } });
    if (!res.ok) throw new Error("saldo");
    const d = await res.json(); const v = Number(d.saldo || 0);
    if (_cashAdminChave !== chave) return;
    el.textContent = `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; el.className = v > 0 ? "cashback-positive" : "";
  } catch (_) { _cashAdminChave = null; el.textContent = "R$ —"; }
}

// ── Quem vende nos PCI 13/14/15 (tag + filtro) ──
let activeQuemFilter = null;
const QUEM_ROTULO = { boxer: "Boxer vende · paga comissão", revenda: "Revenda vende · blindagem", indefinido: "Definir quem vende" };
function atualizarBarraQuem() {
  const bar = $("quemBar"); if (!bar) return;
  const cont = { boxer: 0, revenda: 0, indefinido: 0 }; API_LEADS.forEach(l => { if (l.quemVende && !l.fechado) cont[l.quemVende]++; });
  const total = cont.boxer + cont.revenda + cont.indefinido;
  if (!total) { bar.classList.add("hidden"); return; }
  bar.innerHTML = `<span class="pci-bar-tit">PCI 13/14/15:</span>` +
    ["boxer", "revenda", "indefinido"].filter(k => cont[k] || activeQuemFilter === k).map(k => `<button type="button" class="quem-chip quem-${k}${activeQuemFilter === k ? " active" : ""}" data-quem="${k}">${QUEM_ROTULO[k]} (${cont[k]})</button>`).join("");
  bar.classList.remove("hidden");
}
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest(".quem-chip"); if (!b) return;
  activeQuemFilter = activeQuemFilter === b.dataset.quem ? null : b.dataset.quem;
  atualizarBarraQuem(); render();
});

// ── Filtro por tipo de PCI (visão admin/representante/funcionário) ──
let activePciFilter = null;
const pciChave = l => { const k = normalizePci(l && l.pci); return !k || k === "N/D" || k === "SEMPCI" ? "SEMPCI" : k; };
const pciRotulo = k => k === "SEMPCI" ? "Sem PCI" : k === "PCIX" ? "PCI X" : k.replace(/^PCI(\d+)([AB])?$/, (_, n, x) => "PCI " + n + (x ? x.toLowerCase() : ""));
function ordemPci(k) { const m = /^PCI(\d+)([AB])?$/.exec(k); return m ? Number(m[1]) * 10 + (m[2] ? m[2].charCodeAt(0) - 64 : 0) : (k === "PCIX" ? 9000 : 9999); }
function atualizarBarraPci() {
  const bar = $("pciBar"); if (!bar) return;
  if (session.role === "revenda") { bar.classList.add("hidden"); return; }
  const abertos = API_LEADS;   // contagem sobre todos os leads carregados (ignora a busca/filtro atual para o admin ver o panorama)
  const cont = {}; abertos.forEach(l => { const k = pciChave(l); cont[k] = (cont[k] || 0) + 1; });
  const chaves = Object.keys(cont).sort((a, b) => ordemPci(a) - ordemPci(b));
  if (!chaves.length) { bar.classList.add("hidden"); return; }
  bar.innerHTML = `<span class="pci-bar-tit">Filtrar por PCI:</span>` +
    `<button type="button" class="pci-chip${activePciFilter ? "" : " active"}" data-pci="">Todos (${abertos.length})</button>` +
    chaves.map(k => `<button type="button" class="pci-chip${activePciFilter === k ? " active" : ""}${k === "PCI12" || k === "PCI12A" ? " destaque" : ""}" data-pci="${esc(k)}">${esc(pciRotulo(k))} (${cont[k]})</button>`).join("");
  bar.classList.remove("hidden");
}
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest(".pci-chip"); if (!b) return;
  activePciFilter = b.dataset.pci || null;
  atualizarBarraPci(); render();
});

const ehPciX = l => normalizePci(l && l.pci) === "PCIX";
function atualizarBarraPciX() {
  const bar = $("barraPciX"); if (!bar) return;
  const x = API_LEADS.filter(l => ehPciX(l) && !l.fechado);
  const venc = x.filter(l => l.pcix && l.pcix.vencido).length;
  bar.classList.toggle("hidden", x.length === 0 && activeAlertFilter !== "produtosNaoBmax");
  bar.classList.toggle("active", activeAlertFilter === "produtosNaoBmax");
  $("qtdPcix").textContent = x.length + (venc ? ` (${venc} vencido${venc > 1 ? "s" : ""})` : "");
}

function toggleAlertFilter(filterName) {
  document.querySelectorAll(".alert-bar").forEach(el => el.classList.remove("active"));
  if (activeAlertFilter === filterName) {
    activeAlertFilter = null;
  } else {
    activeAlertFilter = filterName;
    const map = { revendaSemLogin: "alertaRevendaSemLogin", semRevenda: "alertaSemRevenda", semPci: "alertaSemPci", semOportunidade: "alertaSemOportunidade", semRepresentante: "alertaSemRepresentante", semClasse: "alertaSemClasse", repInvalido: "alertaRepInvalido" };
    $(map[filterName])?.classList.add("active");
  }
  atualizarBarraPciX();
  render();
}

function openDrawer(leadData) {
  const l = leadData;
  const body = $("drawerBody");
  $("drawerTitle").textContent = l.nome || "Lead";

  body.innerHTML = `
    <div class="drawer-section">
      <h4>Identificacao</h4>
      <div class="drawer-row"><span class="dr-label">Nome</span><span class="dr-value">${esc(l.nome)}</span></div>
      <div class="drawer-row"><span class="dr-label">CNPJ</span><span class="dr-value">${esc(l.cnpj)}</span></div>
      <div class="drawer-row"><span class="dr-label">Cidade</span><span class="dr-value">${esc(l.cidade)}</span></div>
      <div class="drawer-row"><span class="dr-label">Estado</span><span class="dr-value">${esc(l.estado)}</span></div>
    </div>
    <div class="drawer-section">
      <h4>Negociacao</h4>
      <div class="drawer-row"><span class="dr-label">Maquina</span><span class="dr-value">${esc(l.maquinainteresse)}</span></div>
      <div class="drawer-row"><span class="dr-label">PCI</span><span class="dr-value">${esc(l.pci) || "N/D"}</span></div>
      <div class="drawer-row"><span class="dr-label">Valor</span><span class="dr-value">R$ ${esc(l.valor)}</span></div>
      <div class="drawer-row"><span class="dr-label">Cashback</span><span class="dr-value ${Number(l.cashback) > 0 ? "cashback-positive" : ""}">R$ ${Number(l.cashback || 0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
    </div>
    <div class="drawer-section">
      <h4>Responsaveis</h4>
      <div class="drawer-row"><span class="dr-label">Revenda</span><span class="dr-value">${esc(l.revenda)}</span></div>
      <div class="drawer-row"><span class="dr-label">Representante</span><span class="dr-value">${esc(l.representante)}</span></div>
    </div>
    ${(normalizePci(l.pci) === "PCI12A" || normalizePci(l.pci) === "PCIX") && (l.contatoNome || l.contatoTelefone) ? `
    <div class="drawer-section">
      <h4>Contato do Cliente</h4>
      ${l.contatoNome ? `<div class="drawer-row"><span class="dr-label">Nome</span><span class="dr-value">${esc(l.contatoNome)}</span></div>` : ""}
      ${l.contatoTelefone ? `<div class="drawer-row"><span class="dr-label">Telefone</span><span class="dr-value">${esc(l.contatoTelefone)}</span></div>` : ""}
    </div>
    ` : ""}
    <div class="drawer-section">
      <h4>Status</h4>
      <div class="drawer-row"><span class="dr-label">Criado em</span><span class="dr-value">${esc(l.criadoem)}</span></div>
      <div class="drawer-tag"><div class="tag ${tagClass(l.tag)}">${esc(l.tag)}</div></div>
    </div>
  `;

  $("drawerOverlay").classList.remove("hidden");
}

function closeDrawer() {
  $("drawerOverlay").classList.add("hidden");
}

document.addEventListener("click", (e) => {
  const card = e.target.closest(".lead");
  if (!card) return;
  if (e.target.closest(".caminho-select, .resultado-btn, .valor-venda, .lead-action, .lead-resultado")) return;

  try {
    const data = JSON.parse(card.dataset.leadJson);
    openDrawer(data);
  } catch(err) {}
});

$("drawerOverlay").addEventListener("click", (e) => {
  if (e.target === $("drawerOverlay")) closeDrawer();
});
$("drawerClose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("drawerOverlay").classList.contains("hidden")) closeDrawer();
});

document.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("caminho-select")) return;
  if (!["revenda", "representante", "adm", "funcionario"].includes(session.role)) return;

  const dealId = e.target.dataset.id;
  const caminho = e.target.value;
  let cidade = e.target.dataset.cidade || "";
  const estado = e.target.dataset.estado || "";

  if (cidade.includes(" - ")) {
    cidade = cidade.split(" - ")[0];
  }

  if (!caminho) return;

  const token = localStorage.getItem("token");

  try {
    const res = await fetch("/api/leads/pci", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ dealId, caminho, cidade, estado })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      toast(errData?.error || `Erro ao Definir Caminho de Venda (${res.status})`, "error");
      return;
    }

    const leadAction = e.target.closest(".lead-action");
    await loadLeads();
    render();

    if (leadAction) {
      leadAction.remove();
    } else {
      e.target.remove();
    }

    toast("Caminho de Venda Definido Com Sucesso");
  } catch (err) {
    toast("Erro de conexão ao definir caminho de venda.", "error");
  }
});

document.addEventListener("click", async (e) => {
  const btn = e.target.closest(".resultado-btn");
  if (!btn || !["revenda", "adm"].includes(session.role)) return;

  if (btn.classList.contains("andamento-salvar")) {
    const box = btn.closest(".andamento-box");
    const status = box.querySelector(".andamento-status").value;
    const observacao = box.querySelector(".andamento-obs").value.trim();
    if (!status) { toast("Escolha o status da negociação.", "warn"); return; }
    btn.disabled = true;
    try {
      const res = await fetch("/api/leads/andamento", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${localStorage.getItem("token")}` }, body: JSON.stringify({ dealId: btn.dataset.id, tipo: "status", status, observacao }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { toast(d.error || `Erro ao salvar andamento (${res.status})`, "error"); return; }
      box.querySelector(".andamento-obs").value = "";
      let chip = box.querySelector(".andamento-chip");
      if (!chip) { chip = document.createElement("div"); chip.className = "andamento-chip"; box.prepend(chip); }
      chip.innerHTML = `Andamento: <b>${esc(status)}</b>`;
      toast(d.notaGravada === false ? "Andamento salvo no Portal; a anotação no card será reenviada." : "Andamento salvo e registrado na anotação do card.", d.notaGravada === false ? "warn" : "success");
    } catch (_) { toast("Erro de conexão ao salvar andamento.", "error"); }
    finally { btn.disabled = false; }
    return;
  }

  const card = btn.closest(".lead");
  const resultado = btn.dataset.resultado;
  const dealId = btn.dataset.id;
  let leadData = {};
  try { leadData = JSON.parse(card.dataset.leadJson || "{}"); } catch(_) {}
  const inputValor = card?.querySelector(".valor-venda");
  const valor = inputValor?.value?.trim();

  let motivo = "", observacaoPerda = "";
  if (resultado === "perdido") {
    const r = await pedirMotivoPerda();
    if (!r) return;
    motivo = r.motivo; observacaoPerda = r.observacao;
  }

  if (resultado !== "perdido" && !valor) {
    toast("Informe um valor antes de marcar o resultado.", "warn");
    inputValor?.focus();
    return;
  }

  const valorNumero = resultado === "perdido" ? 0 : Number(valor.replace(",", "."));

  if (!Number.isFinite(valorNumero) || valorNumero < 0) {
    toast("Informe um valor numerico valido.", "warn");
    inputValor?.focus();
    return;
  }

  const token = localStorage.getItem("token");

  try {
    const res = await fetch("/api/leads/resultado", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ dealId, resultado, valor: valorNumero, motivo, observacao: observacaoPerda, pci: leadData?.pci || "", classePreco: leadData?.classePreco || "" })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      toast(errData?.error || `Erro ao atualizar resultado (${res.status})`, "error");
      return;
    }

    const resultadoArea = card?.querySelector(".lead-resultado");
    if (resultadoArea) resultadoArea.remove();

    toast(resultado === "vendido" ? "Lead marcado como Vendido." : "Lead marcado como Perdido.");
  } catch (err) {
    toast("Erro de conexão ao atualizar resultado.", "error");
  }
});


// Modal do motivo da perda (obrigatório). Devolve {motivo, observacao} ou null se cancelar.
function pedirMotivoPerda() {
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:3000;display:flex;align-items:center;justify-content:center;padding:16px";
    ov.innerHTML = `<div style="background:var(--card,#fff);color:inherit;border-radius:12px;padding:22px;width:100%;max-width:420px;box-shadow:0 20px 60px rgba(0,0,0,.3)">
      <h3 style="margin:0 0 12px;font-size:17px">Por que o lead foi perdido?</h3>
      <select id="mpMotivo" style="width:100%;margin-bottom:10px"><option value="">Escolha o motivo…</option>${MOTIVOS_PERDA.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("")}</select>
      <textarea id="mpObs" rows="3" maxlength="1000" style="width:100%" placeholder="Observação (obrigatória se o motivo for Outro)"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button type="button" id="mpCancel" class="btn-secondary">Cancelar</button><button type="button" id="mpOk" class="resultado-btn perdido">Confirmar perda</button></div></div>`;
    document.body.appendChild(ov);
    const fim = v => { ov.remove(); resolve(v); };
    ov.querySelector("#mpCancel").onclick = () => fim(null);
    ov.onclick = e => { if (e.target === ov) fim(null); };
    ov.querySelector("#mpOk").onclick = () => {
      const motivo = ov.querySelector("#mpMotivo").value, observacao = ov.querySelector("#mpObs").value.trim();
      if (!motivo) { toast("Escolha o motivo da perda.", "warn"); return; }
      if (motivo === "Outro" && !observacao) { toast("Descreva o motivo na observação.", "warn"); return; }
      fim({ motivo, observacao });
    };
  });
}
