const session = {
  role: null,
  username: null,
  name: null,
  revenda: null,
  repName: null,
  repRevendas: []
};

const SCREENS = ["login", "dash", "cadastro", "negociacoes", "extrato", "gestao"];

function show(screen) {
  if (!SCREENS.includes(screen)) screen = "login";
  const hash = "#" + screen;
  if (location.hash !== hash) {
    history.replaceState(null, "", hash);
  }
  SCREENS.forEach(s => {
    const el = $("screen" + s.charAt(0).toUpperCase() + s.slice(1));
    if (el) el.classList.toggle("hidden", s !== screen);
  });
  $("btnGoLogin").classList.toggle("hidden", screen !== "login");
  $("btnLogout").classList.toggle("hidden", screen === "login");
  $("btnExport").classList.toggle("hidden", !(session.role === "adm" && screen === "dash"));
  $("btnGestao").classList.toggle("hidden", !(session.role === "adm" && screen !== "login"));
  $("btnSolicitarSaque").classList.toggle("hidden", !(session.role === "revenda" && screen === "extrato"));
  $("btnRecalcularComissoes").classList.toggle("hidden", !(session.role === "adm" && screen === "extrato"));
  $("blocoCamposRepresentante").classList.toggle("hidden", session.role !== "representante");
  $("blocoCaminhoVenda").classList.toggle("hidden", session.role !== "revenda");
}

function getScreenFromHash() {
  const h = location.hash.replace("#", "");
  return SCREENS.includes(h) ? h : null;
}

window.addEventListener("hashchange", () => {
  const screen = getScreenFromHash();
  if (!screen) return;
  if (screen === "login") {
    show("login");
  } else if (session.role) {
    show(screen);
  } else {
    show("login");
  }
});

function setWhoAmI(user, access) {
  $("whoami").innerHTML = `<span class="whoami-wrap">
    <span class="dot"></span>
    <b>${esc(user)}</b>
    <span class="sep">&bull;</span>
    <span>${esc(access)}</span>
  </span>`;
}

function setDashHeader() {
  const btnNovaNegociacao = $("btnNovaNegociacao");

  switch (session.role) {
    case "adm":
      $("dashTitle").textContent = "Painel • ADM";
      $("dashSub").textContent = "Visibilidade total: todas as negociacoes e revendas";
      setWhoAmI("Admin", "Acesso total");
      btnNovaNegociacao.classList.remove("hidden");
      break;

    case "representante":
      $("dashTitle").textContent = "Painel • Representante";
      $("dashSub").textContent = "Visibilidade: leads de todas as revendas que o representante atende";
      setWhoAmI("Representante", `Revendas: ${uniq(API_LEADS.map(l => l.revenda)).length}`);
      btnNovaNegociacao.classList.remove("hidden");
      break;

    case "revenda":
      $("dashTitle").textContent = "Painel • Revenda";
      $("dashSub").textContent = "Visibilidade: somente leads que atendem os criterios da revenda";
      setWhoAmI("Revenda", "Minha revenda");
      btnNovaNegociacao.classList.remove("hidden");
      break;

    default:
      btnNovaNegociacao.classList.add("hidden");
      break;
  }
}

function setLoginLoading(loading) {
  $("btnLoginText").classList.toggle("hidden", loading);
  $("btnLoginSpinner").classList.toggle("hidden", !loading);
  $("btnLogin").disabled = loading;
  $("btnLogin").style.opacity = loading ? "0.7" : "1";
}

async function login() {
  const role = $("role").value;
  const user = $("user").value;
  const pass = $("pass").value;

  if (!user || !pass) {
    toast("Informe usuario e senha", "warn");
    return;
  }

  setLoginLoading(true);

  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: user, password: pass, role: role })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => null);
      toast(errData?.error || errData?.message || "Falha no login", "error");
      setLoginLoading(false);
      return;
    }

    const data = await res.json();
    localStorage.setItem("token", data.token);
    localStorage.setItem("session", JSON.stringify({
      role: role,
      username: user,
      name: data.user.name
    }));
    session.role = role;
    session.username = user;
    session.name = data.user.name;

    show("dash");
    $("statLeads").textContent = "—";
    $("statRevendas").textContent = "—";
    $("statVendas").textContent = "—";
    $("statCashbackVal").textContent = "R$ —";
    $("statCashbackVal").className = "";
    $("grid").innerHTML = "";
    $("alertPanel").classList.add("hidden");
    setDashHeader();
    await loadLeads();
    setupFilter();
    render();
    setDashHeader();
    await loadNegociacoes();
    loadCashbackSaldo().then(updateDashCashback);
  } catch (err) {
    toast("API indisponivel", "error");
  } finally {
    setLoginLoading(false);
  }
}

function logout() {
  localStorage.removeItem("token");
  localStorage.removeItem("session");

  session.role = null;
  session.username = null;
  session.name = null;
  session.revenda = null;
  session.repName = null;
  session.repRevendas = [];
  API_LEADS = [];
  LEADS_SEM_REVENDA = [];
  CASHBACK_SALDO = 0;
  CASHBACK_EXTRATO = [];
  CASHBACK_SAQUES = [];
  CASHBACK_EXPIRANDO = [];
  activeAlertFilter = null;
  const saldoRepEl = $("statSaldoRevendas");
  if (saldoRepEl) saldoRepEl.classList.add("hidden");

  $("filter").innerHTML = "";
  $("filter").disabled = false;

  setWhoAmI("Desconectado", "faca login");
  show("login");
}

async function populateConfigSelects() {
  const cfg = await loadAppConfig();
  if (!cfg) return;
  populateSelect("negRepresentante", cfg.representantes, "Selecione o Representante");
  populateSelect("negResponsavel", cfg.responsaveis, "Selecione o Responsavel");
  populateSelect("negPci", cfg.pcis, "Selecione o PCI");
  if (cfg.revendas && cfg.revendas.length) {
    populateSelect("negRevenda", cfg.revendas.map(r => r.nome), "Selecione a Revenda");
  }
}

async function init() {
  populateConfigSelects();
  localStorage.removeItem("token");
  localStorage.removeItem("session");
  setWhoAmI("Desconectado", "faca login");
  show("login");
}

// Events
$("btnLogin").addEventListener("click", login);
$("btnLogout").addEventListener("click", logout);
$("btnGoLogin").addEventListener("click", () => {
  const token = localStorage.getItem("token");
  if (token) {
    logout();
  } else {
    show("login");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("btnNovaNegociacao").addEventListener("click", () => show("negociacoes"));
$("btnExport").addEventListener("click", async () => {
  const btn = $("btnExport");
  btnLoading(btn, true);
  try {
    const token = localStorage.getItem("token");
    const filterParam = activeAlertFilter ? `?filter=${encodeURIComponent(activeAlertFilter)}` : "";
    const res = await fetch(`${API_URL}/export/leads${filterParam}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { toast("Erro ao exportar", "error"); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads_bmax.csv";
    a.click();
    URL.revokeObjectURL(url);
    toast("Exportacao concluida");
  } catch (e) {
    toast("Falha na exportacao", "error");
  } finally {
    btnLoading(btn, false);
  }
});
$("btnVoltarCadastro").addEventListener("click", () => show("dash"));
$("btnGestao").addEventListener("click", async () => { show("gestao"); await initGestao(); });
$("btnVoltarGestao").addEventListener("click", () => show("dash"));
$("btnVoltarDash").addEventListener("click", () => show("dash"));
$("btnVoltarExtrato").addEventListener("click", () => show("dash"));
$("btnSolicitarSaque").addEventListener("click", openSaqueModal);
$("statCashback").addEventListener("click", async () => {
    if (!session.role) return;
    show("extrato");
    await refreshCashback();
});
$("q").addEventListener("input", render);
$("filter").addEventListener("change", render);
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("screenLogin").classList.contains("hidden")) {
    login();
  }
});

renderCadastroFields();
applyCadastroMasks();
maskCnpj($("negCnpj"));
maskCep($("negCep"));
init();
