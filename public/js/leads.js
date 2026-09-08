let API_LEADS = [];
let LEADS_SEM_REVENDA = [];
let isLoadingLeads = false;
let activeAlertFilter = null;

function showLoadError(msg) {
  const grid = $("grid");
  grid.innerHTML = `<div style="grid-column:1/-1;padding:20px;border-radius:12px;background:rgba(255,80,80,.1);border:1px solid rgba(255,80,80,.3);color:#ff8a8a;font-weight:700;font-size:13px;text-align:center;">
    ${msg}<br><button onclick="retryLoad()" style="margin-top:10px;padding:8px 20px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;font-weight:800;cursor:pointer;font-size:13px;">Tentar Novamente</button>
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
      const invalidos = ["", "?????", "?", "Vazio", "N/D"];
      LEADS_SEM_REVENDA = data.filter(l => invalidos.includes((l.revenda || "").trim()));
      API_LEADS = data.filter(l => !invalidos.includes((l.revenda || "").trim()));
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
  const revendas = uniq(data.map(l => l.revenda)).sort();

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
  } else if (activeAlertFilter === "semPci") {
    data = API_LEADS.filter(l => !l.pci || l.pci === "N/D" || l.pci === "PCI12");
  } else if (activeAlertFilter === "semOportunidade") {
    data = API_LEADS.filter(l => !l.oportunidadedevendas || l.oportunidadedevendas.trim() === "");
  } else if (activeAlertFilter === "semRepresentante") {
    const inv = ["", "?????", "?", "Vazio", "N/D"];
    data = API_LEADS.filter(l => inv.includes((l.representante || "").trim()));
  } else if (activeAlertFilter === "semClasse") {
    const pcisPorClasse = ["PCI13", "PCI14", "PCI15"];
    data = API_LEADS.filter(l => pcisPorClasse.includes(normalizePci(l.pci)) && !l.classePreco);
  } else if (activeAlertFilter === "repInvalido") {
    const validReps = new Set((APP_CONFIG?.representantes || []).map(r => r.trim()));
    const inv = ["", "?????", "?", "Vazio", "N/D"];
    data = API_LEADS.filter(l => {
      const rep = (l.representante || "").trim();
      return !inv.includes(rep) && rep && !validReps.has(rep);
    });
  }

  if (activeAlertFilter) {
    $("statLeads").textContent = data.length;
    $("statRevendas").textContent = uniq(data.map(l => l.revenda)).length;
    $("statVendas").textContent = data.filter(l => { const t = (l.tag || "").toLowerCase(); return t.includes("venda") || t === "vendido"; }).length;
    renderGrid(data);
    return;
  }

  if (session.role === "revenda") {
    if (normalizeText(rev).includes("luitex")) {
      data = data.filter(l => normalizeText(l.revenda).includes("luitex"));
    } else {
      data = data.filter(l => normalizeText(l.revenda) === normalizeText(rev));
    }
  } else if (rev !== "all") {
    data = data.filter(l => normalizeText(l.revenda) === normalizeText(rev));
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
    $("statRevendas").textContent = uniq(data.map(l => l.revenda)).length;
  }
  $("statVendas").textContent = vendas.length;

  if (session.role !== "revenda") {
    const cashbackTotal = data.reduce((total, card) => total + (card.cashback || 0), 0);
    const cashValEl = $("statCashbackVal");
    cashValEl.textContent = `R$ ${cashbackTotal.toLocaleString("pt-BR", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
    cashValEl.className = cashbackTotal > 0 ? "cashback-positive" : "";
  }
  const cashLabel = $("statCashback")?.querySelector(".k");
  if (cashLabel) cashLabel.textContent = session.role === "representante" ? "Comissao Total" : "Cashback Total";

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

    const pcisPorClasse = ["PCI13", "PCI14", "PCI15"];
    const semClasse = data.filter(l => {
      const pciNorm = normalizePci(l.pci);
      return pcisPorClasse.includes(pciNorm) && !l.classePreco;
    });
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

function renderGrid(data) {
  const grid = $("grid");
  grid.innerHTML = "";

  $("empty").classList.toggle("hidden", data.length !== 0);

  data.forEach(l => {
    const el = document.createElement("div");
    el.className = "lead";
    el.dataset.leadJson = JSON.stringify(l);
    const cb = Number(l.cashback || 0);
    const cbClass = cb > 0 ? "cashback cashback-pos" : "cashback";
    el.innerHTML = `
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

      <div class="lead-foot">
        <span style="font-size:11px;color:var(--muted);font-weight:800;">${esc(l.criadoem)}</span>
        <div class="${cbClass}">R$ ${cb.toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      </div>
      ${session.role === "revenda" && l.tag === "Assumido" && ["PCI12A"].includes(normalizePci(l.pci)) ? `
      <div class="lead-resultado" data-id="${esc(l.id)}">
        <div class="resultado-actions">
          <button type="button" class="resultado-btn vendido" data-id="${esc(l.id)}" data-resultado="vendido">Vendido</button>
          <button type="button" class="resultado-btn perdido" data-id="${esc(l.id)}" data-resultado="perdido">Perdido</button>
        </div>
        <input type="number" class="valor-venda" data-id="${esc(l.id)}" placeholder="Valor numerico da venda" step="any" min="0" inputmode="decimal">
      </div>
      ` : ""}
      ${session.role === "revenda" && l.pci === "PCI12" ? `
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

function toggleAlertFilter(filterName) {
  document.querySelectorAll(".alert-bar").forEach(el => el.classList.remove("active"));
  if (activeAlertFilter === filterName) {
    activeAlertFilter = null;
  } else {
    activeAlertFilter = filterName;
    const map = { semRevenda: "alertaSemRevenda", semPci: "alertaSemPci", semOportunidade: "alertaSemOportunidade", semRepresentante: "alertaSemRepresentante", semClasse: "alertaSemClasse", repInvalido: "alertaRepInvalido" };
    $(map[filterName])?.classList.add("active");
  }
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
  if (session.role !== "revenda") return;

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
  if (!btn || session.role !== "revenda") return;

  const card = btn.closest(".lead");
  const resultado = btn.dataset.resultado;
  const dealId = btn.dataset.id;
  let leadData = {};
  try { leadData = JSON.parse(card.dataset.leadJson || "{}"); } catch(_) {}
  const inputValor = card?.querySelector(".valor-venda");
  const valor = inputValor?.value?.trim();

  if (!valor) {
    toast("Informe um valor antes de marcar o resultado.", "warn");
    inputValor?.focus();
    return;
  }

  const valorNumero = Number(valor.replace(",", "."));

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
      body: JSON.stringify({ dealId, resultado, valor: valorNumero, pci: leadData?.pci || "", classePreco: leadData?.classePreco || "" })
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
