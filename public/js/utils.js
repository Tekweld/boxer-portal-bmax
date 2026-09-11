const API_URL = "/api";

const $ = (id) => document.getElementById(id);
const uniq = (arr) => [...new Set(arr)];
const normalizeText = (s) => (s || "").toString().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[\.\-_/]/g, " ").replace(/\s+/g, " ").trim();
const normalizeDigits = (s) => (s || "").toString().replace(/\D/g, "");
const normalizePci = (s) => (s || "").toString().replace(/\s/g, "").toUpperCase();
const esc = (str) => (str ?? "").toString()
  .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
  .replaceAll('"',"&quot;").replaceAll("'","&#039;");

const TOAST_ICONS = { success: "✓", error: "✕", info: "ℹ", warn: "!" };
function toast(msg, type = "success", ms = 3500) {
  const c = $("toastContainer");
  const el = document.createElement("div");
  el.className = "toast toast-" + type;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[type] || ""}</span><span>${esc(msg)}</span>`;
  c.appendChild(el);
  setTimeout(() => {
    el.classList.add("removing");
    el.addEventListener("animationend", () => el.remove());
  }, ms);
}

function btnLoading(btn, loading) {
  if (!btn) return;
  btn.disabled = loading;
  btn.style.opacity = loading ? "0.7" : "1";
  if (loading) {
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = `<span class="spinner"></span> Aguarde...`;
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
  }
}

function maskCnpj(input) {
  input.addEventListener("input", () => {
    let v = input.value.replace(/\D/g, "").slice(0, 14);
    if (v.length > 12) v = v.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{1,2})/, "$1.$2.$3/$4-$5");
    else if (v.length > 8) v = v.replace(/^(\d{2})(\d{3})(\d{3})(\d{1,4})/, "$1.$2.$3/$4");
    else if (v.length > 5) v = v.replace(/^(\d{2})(\d{3})(\d{1,3})/, "$1.$2.$3");
    else if (v.length > 2) v = v.replace(/^(\d{2})(\d{1,3})/, "$1.$2");
    input.value = v;
  });
}

function maskCep(input) {
  input.addEventListener("input", () => {
    let v = input.value.replace(/\D/g, "").slice(0, 8);
    if (v.length > 5) v = v.replace(/^(\d{5})(\d{1,3})/, "$1-$2");
    input.value = v;
  });
}

let APP_CONFIG = null;

async function loadAppConfig() {
  if (APP_CONFIG) return APP_CONFIG;
  try {
    const res = await fetch(`${API_URL}/config`);
    if (res.ok) APP_CONFIG = await res.json();
  } catch (_) {}
  return APP_CONFIG;
}

function populateSelect(selectId, items, placeholder) {
  const sel = $(selectId);
  if (!sel || !items) return;
  sel.innerHTML = "";
  if (placeholder) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = placeholder;
    sel.appendChild(opt);
  }
  items.forEach(item => {
    const opt = document.createElement("option");
    const isObj = item && typeof item === "object";
    opt.value = isObj ? item.value : item;
    opt.textContent = isObj ? item.label : item;
    sel.appendChild(opt);
  });
}

function tagClass(tag) {
  const t = (tag || "").toLowerCase();
  if (t === "lead") return "tag-lead";
  if (t === "em contato") return "tag-em-contato";
  if (t.includes("negocia")) return "tag-negociacao";
  if (t.includes("demonstra")) return "tag-demonstracao";
  if (t === "assumido") return "tag-assumido";
  if (t.includes("venda") || t === "vendido") return "tag-venda";
  if (t.includes("perdid")) return "tag-perdido";
  return "tag-default";
}
