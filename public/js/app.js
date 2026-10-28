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
  // Gestão fica escondida pra quem não é adm (linha abaixo), mas o botão
  // escondido não impede alguém de forçar #gestao na URL — o backend já
  // bloqueia toda chamada de API de Gestão pra não-adm (authorize(["adm"])),
  // mas antes disso a TELA em si abria vazia. André, 22/09/2026: Gestão é
  // sensível, só adm deve conseguir nem abrir a tela.
  if (screen === "gestao" && session.role !== "adm") screen = "dash";
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
  $("btnRegras").classList.toggle("hidden", screen === "login");
  $("btnExport").classList.toggle("hidden", !(session.role === "adm" && screen === "dash"));
  $("btnGestao").classList.toggle("hidden", !(session.role === "adm" && screen !== "login"));
  $("btnSolicitarSaque").classList.toggle("hidden", !(session.role === "revenda" && screen === "extrato"));
  $("btnRecalcularComissoes").classList.toggle("hidden", !(session.role === "adm" && screen === "extrato"));
  $("btnAuditoriaComissoes").classList.toggle("hidden", !(session.role === "adm" && screen === "extrato"));
  $("blocoCamposRepresentante").classList.toggle("hidden", !(session.role === "representante" || session.role === "adm"));
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

    case "funcionario":
      // Achado 22/09/2026: role "funcionario" não tinha case aqui — depois do
      // login o header ficava com título/nome em branco (caía no default, que
      // só existe pra estado "sem sessão"). Mesma visibilidade de leads do adm
      // (buildLeadsCards não filtra funcionario), só sem "Nova Negociação" até
      // definirmos se funcionário Boxer também cria negociação.
      $("dashTitle").textContent = "Painel • Funcionário Boxer";
      $("dashSub").textContent = "Visibilidade total: todas as negociacoes e revendas";
      setWhoAmI("Funcionário Boxer", session.username || "");
      btnNovaNegociacao.classList.add("hidden");
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
  // "Sem Representante"/"Sem Revenda" existem de verdade no RD (picklist estrito) como
  // "N/D" e "Sem Revenda" — o valor enviado tem que ser exatamente esse, só o texto
  // mostrado no dropdown é mais amigável.
  populateSelect("negRepresentante", [{ value: "N/D", label: "Sem Representante" }, ...cfg.representantes], "Selecione o Representante");
  populateSelect("negResponsavel", cfg.responsaveis, "Selecione o Responsavel");
  populateSelect("negPci", cfg.pcis, "Selecione o PCI");
  if (cfg.revendas && cfg.revendas.length) {
    populateSelect("negRevenda", [{ value: "Sem Revenda", label: "Sem Revenda" }, ...cfg.revendas.map(r => r.nome)], "Selecione a Revenda");
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

// Esqueci minha senha: avisa os administradores (POST /auth/forgot-password); resposta sempre genérica
$("linkEsqueciSenha").addEventListener("click", e => {
  e.preventDefault();
  const box = $("boxEsqueciSenha");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) {
    $("forgotUser").value = $("user").value || "";
    $("forgotUser").focus();
  }
});
$("btnEnviarEsqueci").addEventListener("click", async () => {
  const email = $("forgotUser").value.trim();
  if (!email) { toast("Informe seu usuario ou e-mail", "warn"); return; }
  const btn = $("btnEnviarEsqueci");
  btn.disabled = true;
  try {
    const res = await fetch(`${API_URL}/auth/forgot-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      toast(data.message || "Solicitacao recebida. Um administrador entrara em contato.", "success");
      $("boxEsqueciSenha").classList.add("hidden");
    } else {
      toast(data.error || "Nao foi possivel enviar a solicitacao", "error");
    }
  } catch (_) {
    toast("API indisponivel", "error");
  } finally {
    btn.disabled = false;
  }
});

// Regras e cashback (modal informativo, igual para todos os perfis)
function setRegrasAberto(aberto) {
  $("regrasOverlay").classList.toggle("show", aberto);
  if (aberto) $("btnRegrasFechar").focus(); else $("btnRegras").focus();
}
$("btnRegras").addEventListener("click", () => setRegrasAberto(true));
$("btnRegrasFechar").addEventListener("click", () => setRegrasAberto(false));
$("regrasOverlay").addEventListener("click", e => { if (e.target === $("regrasOverlay")) setRegrasAberto(false); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("regrasOverlay").classList.contains("show")) setRegrasAberto(false);
});

$("btnGoLogin").addEventListener("click", () => {
  const token = localStorage.getItem("token");
  if (token) {
    logout();
  } else {
    show("login");
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
});
$("btnNovaNegociacao").addEventListener("click", () => { hideNegFormError(); show("negociacoes"); });
const ALERT_LABELS = {
  semRevenda: "Sem revenda",
  revendaSemLogin: "Revenda sem login",
  semPci: "Sem PCI",
  semOportunidade: "Sem Op. de Venda",
  semRepresentante: "Sem Rep.",
  semClasse: "Sem Classe Preço",
  repInvalido: "Nome Rep. Invalido"
};

$("btnExport").addEventListener("click", async () => {
  const btn = $("btnExport");

  // O export reaproveita o alerta ativo na tela — sem essa confirmação, o
  // arquivo baixado é uma fatia filtrada mas com cara de exportação completa.
  let useFilter = !!activeAlertFilter;
  if (activeAlertFilter) {
    const label = ALERT_LABELS[activeAlertFilter] || activeAlertFilter;
    useFilter = confirm(
      `O filtro "${label}" está ativo.\n\nOK = exportar somente esses leads.\nCancelar = limpar o filtro e exportar todos os leads.`
    );
    if (!useFilter) {
      activeAlertFilter = null;
      document.querySelectorAll(".alert-bar").forEach(el => el.classList.remove("active"));
      render();
    }
  }

  btnLoading(btn, true);
  try {
    const token = localStorage.getItem("token");
    const filterParam = useFilter && activeAlertFilter ? `?filter=${encodeURIComponent(activeAlertFilter)}` : "";
    const res = await fetch(`${API_URL}/export/leads${filterParam}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) { toast("Erro ao exportar", "error"); return; }
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "leads_bmax.xlsx";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
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

// Carrossel de imagens da tela de login. Para adicionar/trocar imagens, só
// colocar o arquivo em public/img/ e incluir o caminho neste array — o
// carrossel se ajusta sozinho pra 1, 2 ou N imagens.
const LOGIN_BANNER_IMAGES = [
  "img/bpartner-logo-banner.png",
  "img/imagem-banner-1.png",
  "img/imagem-banner-2.png"
];
const LOGIN_BANNER_INTERVAL_MS = 5000;

function initLoginBanner() {
  const banner = $("loginBanner");
  if (!banner || !LOGIN_BANNER_IMAGES.length) return;

  // object-fit:cover (ver style.css) sempre preenche 100% do container,
  // cortando o excesso da imagem em vez de encolher pra caber — por isso,
  // ao contrario de uma versao anterior deste carrossel, nao precisa de
  // nenhum calculo de altura por imagem: zero chance de sobrar fundo visivel
  // independente da proporcao de cada foto.
  LOGIN_BANNER_IMAGES.forEach((src, i) => {
    const img = document.createElement("img");
    img.alt = "BMAX - Uma Solução 360° Boxer";
    if (i === 0) img.classList.add("active");
    img.src = src;
    banner.appendChild(img);
  });

  if (LOGIN_BANNER_IMAGES.length < 2) return;

  const imgs = banner.querySelectorAll("img");
  let current = 0;
  setInterval(() => {
    imgs[current].classList.remove("active");
    current = (current + 1) % imgs.length;
    imgs[current].classList.add("active");
  }, LOGIN_BANNER_INTERVAL_MS);
}

renderCadastroFields();
applyCadastroMasks();
maskCnpj($("negCnpj"));
maskCep($("negCep"));
initLoginBanner();
init();
