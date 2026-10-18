/*
 * Auris — player de áudios de estudo no Google Drive
 * Versão 1.0.0
 *
 * Organização deste arquivo:
 *   1. utilidades            7. sincronização (pasta oculta do app no Drive)
 *   2. estado local          8. motor de reprodução
 *   3. login do Google       9. timer de sono e controles do sistema
 *   4. API do Drive         10. interface: menus, diálogos, avisos
 *   5. biblioteca (pastas)  11. interface: vistas
 *   6. cache offline        12. eventos e inicialização
 */
(() => {
'use strict';

const VERSAO = '1.0.0';
const ESCOPO_LEITURA = 'https://www.googleapis.com/auth/drive.readonly';
const ESCOPO_APPDATA = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/';
const MIME_PASTA = 'application/vnd.google-apps.folder';
const MIME_ATALHO = 'application/vnd.google-apps.shortcut';
const ARQUIVO_SYNC = 'auris-estado.json';
const CACHE_AUDIO = 'auris-audio-v1';
const PREFIXO = 'auris:';
const EXT_AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac|weba)$/i;
const VEL_MIN = 0.5, VEL_MAX = 3.5;

/* =====================================================================
 * 1. UTILIDADES
 * ===================================================================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const agora = () => Date.now();
const colador = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });
const comparar = (a, b) => colador.compare(a, b);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ler(chave, padrao) {
  try { const v = localStorage.getItem(PREFIXO + chave); return v ? JSON.parse(v) : padrao; } catch { return padrao; }
}
function gravar(chave, valor) {
  try { localStorage.setItem(PREFIXO + chave, JSON.stringify(valor)); return true; }
  catch (e) { console.warn('Falha ao gravar', chave, e); return false; }
}
function apagar(chave) { try { localStorage.removeItem(PREFIXO + chave); } catch { /* nada */ } }
const uid = () => Math.random().toString(36).slice(2, 9) + agora().toString(36);
const ico = (nome, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="#i-${nome}"/></svg>`;
const semExt = n => String(n || '').replace(EXT_AUDIO, '');
const normalizar = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

function fmtTempo(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function fmtDuracao(s) {
  if (!s) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}
function fmtTamanho(b) {
  if (!b) return '0 MB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + ' GB';
  return (b / 1024 ** 2).toLocaleString('pt-BR', { maximumFractionDigits: b < 10 * 1024 ** 2 ? 1 : 0 }) + ' MB';
}
function fmtVel(v) {
  return (Math.round(v * 100) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + '×';
}
function fmtData(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function textoDuracao(ids) {
  let total = 0, conhecidas = 0;
  for (const id of ids) { const d = estado.posicoes[id]?.d; if (d) { total += d; conhecidas++; } }
  if (!conhecidas) return '';
  return conhecidas === ids.length ? fmtDuracao(total) : `pelo menos ${fmtDuracao(total)}`;
}
function plural(n, um, varios) { return `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`; }
function embaralhar(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function adiar(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function esperarEvento(alvo, evento, ms, eventoErro = 'error') {
  return new Promise((res, rej) => {
    const fim = (ok, v) => { clearTimeout(t); alvo.removeEventListener(evento, aoOk); alvo.removeEventListener(eventoErro, aoErro); ok ? res(v) : rej(v); };
    const aoOk = e => fim(true, e);
    const aoErro = () => fim(false, new Error('Não foi possível abrir este arquivo de áudio (formato não suportado ou arquivo corrompido).'));
    const t = setTimeout(() => fim(false, new Error('O áudio demorou demais para abrir.')), ms);
    alvo.addEventListener(evento, aoOk, { once: true });
    alvo.addEventListener(eventoErro, aoErro, { once: true });
  });
}

/* =====================================================================
 * 2. ESTADO LOCAL
 * ===================================================================== */
const CONFIG_PADRAO = {
  u: 0,                 // momento da última alteração das opções sincronizadas
  raiz: null,           // { id, nome } da pasta da biblioteca
  velocidade: 1,
  preservarTom: true,
  saltoVoltar: 10,
  saltoAvancar: 30,
  retomar: true,
  recuoRetomar: 3,
  avancoAuto: true,
  ordenacao: 'nome',
  // só locais (não sincronizam):
  cacheMB: 1024,
  sync: true,
  tema: 'auto',
  volume: 1,
  repetir: 'nao',       // nao | todas | uma
  aleatorio: false,
  ocultarOuvidos: false,
};
const CHAVES_SYNC = ['raiz', 'velocidade', 'preservarTom', 'saltoVoltar', 'saltoAvancar', 'retomar', 'recuoRetomar', 'avancoAuto', 'ordenacao'];

const estado = ler('estado', {}) || {};
estado.config = { ...CONFIG_PADRAO, ...(estado.config || {}) };
estado.posicoes ||= {};    // id -> { p, d, u, ok, n }
estado.playlists ||= {};   // id -> { id, nome, faixas: [{ id, n, s }], u, criada }
estado.removidas ||= {};   // id da playlist excluída -> momento
const cfg = () => estado.config;

let fila = ler('fila', null) || { itens: [], original: null, indice: -1, origem: null };
let bib = ler('biblioteca', null);   // { raizId, at, pastas: {}, faixas: {} }
let cacheMeta = ler('cache', {}) || {}; // id -> { tam, at, fixo }
let abertas = new Set(ler('abertas', []));

const salvarEstadoLocal = adiar(() => gravar('estado', estado), 400);
function salvarEstado(sincronizar = true) {
  salvarEstadoLocal();
  if (sincronizar) agendarSync();
}
function mudarConfig(chave, valor) {
  estado.config[chave] = valor;
  if (CHAVES_SYNC.includes(chave)) estado.config.u = agora();
  gravar('estado', estado);
  if (CHAVES_SYNC.includes(chave)) agendarSync();
}
const salvarFila = adiar(() => gravar('fila', fila), 300);
function salvarBib() {
  memoContagem.clear();
  if (!gravar('biblioteca', bib)) console.warn('Biblioteca grande demais para o armazenamento local; ela será relida a cada abertura.');
}
const salvarCacheMeta = adiar(() => gravar('cache', cacheMeta), 300);

function posicao(id) { return estado.posicoes[id] || null; }
function registrarPosicao(id, p, d, nome) {
  const atual = estado.posicoes[id] || {};
  const limiar = 0.97;
  const ok = atual.ok || (d > 0 && p / d >= limiar);
  if (!!ok !== !!atual.ok) memoContagem.clear();
  estado.posicoes[id] = { p: Math.round(p * 10) / 10, d: d ? Math.round(d) : (atual.d || 0), u: agora(), ok: !!ok, n: nome || atual.n || '' };
  salvarEstado();
}
function definirOuvido(ids, ok) {
  for (const id of ids) {
    const atual = estado.posicoes[id] || {};
    estado.posicoes[id] = { p: ok ? 0 : (atual.p || 0), d: atual.d || 0, u: agora(), ok: !!ok, n: atual.n || infoFaixa({ id }).nome };
  }
  memoContagem.clear();
  salvarEstado();
}
function zerarPosicao(id) {
  const atual = estado.posicoes[id] || {};
  estado.posicoes[id] = { p: 0, d: atual.d || 0, u: agora(), ok: false, n: atual.n || '' };
  salvarEstado();
}

/** Dados de exibição de uma faixa, a partir da biblioteca ou do que ficou guardado com ela. */
function infoFaixa(item) {
  const f = bib?.faixas?.[item.id];
  const p = estado.posicoes[item.id];
  const pastaId = f?.pasta || null;
  return {
    id: item.id,
    nome: f?.nome || item.n || p?.n || 'Áudio sem nome',
    tam: f?.tam || item.s || 0,
    pasta: pastaId,
    pastaNome: pastaId ? (bib.pastas[pastaId]?.nome || '') : (item.pn || ''),
    naBiblioteca: !!f,
  };
}
const paraItem = id => { const i = infoFaixa({ id }); return { id, n: i.nome, s: i.tam, pn: i.pastaNome }; };

/* =====================================================================
 * 3. LOGIN DO GOOGLE (Google Identity Services, fluxo de token)
 * ===================================================================== */
class ErroSessao extends Error {}
class ErroApi extends Error {
  constructor(msg, status = 0, motivo = '') { super(msg); this.status = status; this.motivo = motivo; }
}

const auth = {
  clientId: (window.AURIS_CONFIG && String(window.AURIS_CONFIG.clientId || '').trim()) || ler('clientId', ''),
  token: null, exp: 0, cliente: null, pendente: null,
  usuario: ler('usuario', null),
  appdata: ler('appdata', true),
};
(() => {
  const t = ler('token', null);
  if (t && t.exp > agora() + 60_000) { auth.token = t.t; auth.exp = t.exp; }
})();
const tokenValido = () => !!auth.token && auth.exp > agora() + 60_000;

function esperarGIS(ms = 15000) {
  return new Promise((res, rej) => {
    const t0 = agora();
    (function verificar() {
      if (window.google?.accounts?.oauth2) return res();
      if (agora() - t0 > ms) return rej(new ErroSessao('Não foi possível carregar o login do Google. Verifique a conexão e recarregue a página.'));
      setTimeout(verificar, 120);
    })();
  });
}

async function iniciarCliente() {
  if (auth.cliente) return;
  await esperarGIS();
  auth.cliente = google.accounts.oauth2.initTokenClient({
    client_id: auth.clientId,
    scope: `${ESCOPO_LEITURA} ${ESCOPO_APPDATA}`,
    callback: resp => {
      const p = auth.pendente; auth.pendente = null;
      if (!p) return;
      clearTimeout(p.timer);
      if (resp.error) return p.rej(new ErroSessao(traduzirErroLogin(resp.error)));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ESCOPO_LEITURA)) {
        return p.rej(new ErroSessao('O acesso de leitura ao Google Drive não foi concedido. Entre de novo e marque a permissão do Drive.'));
      }
      auth.appdata = google.accounts.oauth2.hasGrantedAllScopes(resp, ESCOPO_APPDATA);
      gravar('appdata', auth.appdata);
      auth.token = resp.access_token;
      auth.exp = agora() + (Number(resp.expires_in) || 3599) * 1000;
      gravar('token', { t: auth.token, exp: auth.exp });
      p.res(auth.token);
    },
    error_callback: err => {
      const p = auth.pendente; auth.pendente = null;
      if (!p) return;
      clearTimeout(p.timer);
      p.rej(new ErroSessao(traduzirErroLogin(err?.type || 'desconhecido')));
    },
  });
}

function traduzirErroLogin(tipo) {
  return ({
    popup_closed: 'A janela de login foi fechada antes de terminar. Se o Google exibiu "origin_mismatch" ou "invalid_client", confira o ID de cliente e as origens autorizadas (veja o README).',
    popup_failed_to_open: 'O navegador bloqueou a janela de login. Permita pop-ups para este site e tente de novo.',
    access_denied: 'O acesso foi negado na tela do Google.',
    tempo: 'O login demorou demais. Tente de novo.',
  })[tipo] || `Não foi possível concluir o login (${tipo}).`;
}

async function pedirToken(prompt = '') {
  if (!auth.clientId) throw new ErroSessao('ID de cliente OAuth não configurado.');
  await iniciarCliente();
  if (auth.pendente) return auth.pendente.promessa;
  let res, rej;
  const promessa = new Promise((a, b) => { res = a; rej = b; });
  const timer = setTimeout(() => {
    if (auth.pendente?.promessa === promessa) { auth.pendente = null; rej(new ErroSessao(traduzirErroLogin('tempo'))); }
  }, 180_000);
  auth.pendente = { res, rej, promessa, timer };
  const opcoes = { prompt };
  if (auth.usuario?.email) opcoes.login_hint = auth.usuario.email;
  try { auth.cliente.requestAccessToken(opcoes); }
  catch (e) { clearTimeout(timer); auth.pendente = null; rej(new ErroSessao(e.message)); }
  return promessa;
}

async function garantirToken() {
  if (tokenValido()) return auth.token;
  try { return await pedirToken(''); }
  catch (e) {
    mostrarAvisoSessao();
    throw e instanceof ErroSessao ? e : new ErroSessao(e.message);
  }
}

async function entrar() {
  try {
    await pedirToken(auth.usuario ? '' : 'select_account');
    ocultarAviso();
    await carregarUsuario();
    mostrarTela('app');
    aposLogin();
  } catch (e) {
    toast(e.message, { ms: 9000 });
  }
}

async function sair() {
  const ok = await confirmar('Sair da conta', 'O acesso ao Drive será revogado neste aparelho. Playlists, progresso e áudios offline continuam guardados aqui.', 'Sair');
  if (!ok) return;
  try { if (auth.token) google.accounts.oauth2.revoke(auth.token, () => {}); } catch { /* nada */ }
  auth.token = null; auth.exp = 0; auth.usuario = null;
  apagar('token'); apagar('usuario');
  pausar();
  mostrarTela('login');
}

async function carregarUsuario() {
  try {
    const r = await api('about', { fields: 'user(displayName,emailAddress,photoLink)' });
    auth.usuario = { nome: r.user?.displayName || '', email: r.user?.emailAddress || '', foto: r.user?.photoLink || '' };
    gravar('usuario', auth.usuario);
    renderConta();
  } catch (e) { console.warn(e); }
}

/* =====================================================================
 * 4. API DO GOOGLE DRIVE
 * ===================================================================== */
async function fetchAuth(url, opcoes = {}, tentativa = 0) {
  const token = await garantirToken();
  let r;
  try {
    r = await fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ErroApi(navigator.onLine ? 'Falha de rede ao acessar o Google Drive.' : 'Sem conexão com a internet.', 0, 'rede');
  }
  if (r.status === 401 && tentativa === 0) {
    auth.token = null; auth.exp = 0; apagar('token');
    return fetchAuth(url, opcoes, 1);
  }
  if ((r.status === 429 || r.status >= 500) && tentativa < 3 && !opcoes.semRepetir) {
    await new Promise(ok => setTimeout(ok, 800 * 2 ** tentativa + Math.random() * 400));
    return fetchAuth(url, opcoes, tentativa + 1);
  }
  return r;
}

async function erroDe(r) {
  let motivo = '', msg = `Erro ${r.status} do Google Drive.`;
  try {
    const j = await r.json();
    motivo = j.error?.errors?.[0]?.reason || j.error?.status || '';
    msg = j.error?.message || msg;
  } catch { /* corpo não é JSON */ }
  const mapa = {
    notFound: 'Arquivo não encontrado no Drive (foi apagado ou saiu do seu acesso).',
    downloadQuotaExceeded: 'O Google limitou temporariamente os downloads deste arquivo. Tente mais tarde.',
    cannotDownloadAbusiveFile: 'O Google bloqueou o download deste arquivo.',
    insufficientPermissions: 'Permissão insuficiente: saia e entre de novo, marcando o acesso ao Drive.',
    accessNotConfigured: 'A Google Drive API não está ativada no seu projeto do Google Cloud (veja o README).',
    SERVICE_DISABLED: 'A Google Drive API não está ativada no seu projeto do Google Cloud (veja o README).',
    userRateLimitExceeded: 'Muitas requisições seguidas ao Drive; aguarde alguns segundos.',
    rateLimitExceeded: 'Muitas requisições seguidas ao Drive; aguarde alguns segundos.',
  };
  if (r.status === 404 && !motivo) motivo = 'notFound';
  return new ErroApi(mapa[motivo] || msg, r.status, motivo);
}

async function api(caminho, params = {}, opcoes = {}) {
  const url = new URL(API + caminho);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const r = await fetchAuth(url, opcoes);
  if (!r.ok) throw await erroDe(r);
  return r.status === 204 ? null : r.json();
}

async function listarTudo(q, campos) {
  const itens = [];
  let pageToken;
  do {
    const r = await api('files', {
      q, pageSize: 1000, pageToken,
      fields: `nextPageToken,files(${campos})`,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    itens.push(...(r.files || []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  return itens;
}

const CAMPOS = 'id,name,mimeType,size,modifiedTime,shortcutDetails(targetId,targetMimeType)';

function classificar(arquivos) {
  const pastas = [], faixas = [];
  for (const f of arquivos) {
    let id = f.id, mime = f.mimeType || '';
    const atalho = mime === MIME_ATALHO;
    if (atalho) {
      id = f.shortcutDetails?.targetId; mime = f.shortcutDetails?.targetMimeType || '';
      if (!id) continue;
    }
    if (mime === MIME_PASTA) pastas.push({ id, nome: f.name });
    else if (mime.startsWith('audio/') || EXT_AUDIO.test(f.name)) {
      faixas.push({ id, nome: f.name, tam: Number(f.size) || 0, mod: f.modifiedTime ? Date.parse(f.modifiedTime) : 0, atalho });
    }
  }
  return { pastas, faixas };
}

async function listarFilhos(pastaId) {
  const q = `'${pastaId}' in parents and trashed = false and (mimeType = '${MIME_PASTA}' or mimeType = '${MIME_ATALHO}' or mimeType contains 'audio/')`;
  return classificar(await listarTudo(q, CAMPOS));
}

async function listarSoPastas(pastaId) {
  const q = pastaId === 'compartilhados'
    ? `sharedWithMe and trashed = false and (mimeType = '${MIME_PASTA}' or mimeType = '${MIME_ATALHO}')`
    : `'${pastaId}' in parents and trashed = false and (mimeType = '${MIME_PASTA}' or mimeType = '${MIME_ATALHO}')`;
  return classificar(await listarTudo(q, CAMPOS)).pastas.sort((a, b) => comparar(a.nome, b.nome));
}

/* =====================================================================
 * 5. BIBLIOTECA (árvore de pastas a partir da pasta escolhida)
 * ===================================================================== */
let varredura = null;
const memoContagem = new Map();

function varrerBiblioteca({ silenciosa = false } = {}) {
  const raiz = cfg().raiz;
  if (!raiz) return Promise.resolve();
  if (varredura) return varredura;
  varredura = (async () => {
    const nova = { raizId: raiz.id, at: 0, pastas: {}, faixas: {} };
    nova.pastas[raiz.id] = { id: raiz.id, nome: raiz.nome, pai: null, filhas: [], faixas: [] };
    const pendentes = [raiz.id];
    const vistas = new Set([raiz.id]);
    let lidas = 0;
    status(silenciosa ? 'Atualizando biblioteca…' : 'Lendo a biblioteca no Drive…');

    const processar = async id => {
      const { pastas, faixas } = await listarFilhos(id);
      const p = nova.pastas[id];
      pastas.sort((a, b) => comparar(a.nome, b.nome));
      for (const s of pastas) {
        if (vistas.has(s.id)) continue;
        vistas.add(s.id);
        nova.pastas[s.id] = { id: s.id, nome: s.nome, pai: id, filhas: [], faixas: [] };
        p.filhas.push(s.id);
        pendentes.push(s.id);
      }
      for (const f of faixas) {
        // um mesmo áudio pode aparecer em várias pastas (por atalho); a pasta "dona" é a do arquivo original
        const existente = nova.faixas[f.id];
        if (!existente || (existente.atalho && !f.atalho)) {
          nova.faixas[f.id] = { ...f, tam: f.tam || existente?.tam || 0, pasta: id };
          if (!f.atalho) delete nova.faixas[f.id].atalho;
        }
        if (!p.faixas.includes(f.id)) p.faixas.push(f.id);
      }
      lidas++;
      status(`Lendo a biblioteca… ${plural(lidas, 'pasta', 'pastas')}, ${plural(Object.keys(nova.faixas).length, 'áudio', 'áudios')}`);
    };

    await new Promise((res, rej) => {
      let ativos = 0, falhou = false;
      const puxar = () => {
        if (falhou) return;
        while (ativos < 4 && pendentes.length) {
          const id = pendentes.shift();
          ativos++;
          processar(id).then(() => {
            ativos--;
            if (!pendentes.length && !ativos) res(); else puxar();
          }, e => { falhou = true; rej(e); });
        }
        if (!pendentes.length && !ativos) res();
      };
      puxar();
    });

    nova.at = agora();
    bib = nova;
    salvarBib();
    status(`Biblioteca atualizada: ${plural(Object.keys(bib.faixas).length, 'áudio', 'áudios')} em ${plural(Object.keys(bib.pastas).length, 'pasta', 'pastas')}.`);
    setTimeout(() => status(''), 6000);
    renderLateral();
    renderVista({ manterRolagem: true });
  })().catch(e => {
    status('');
    if (!(e instanceof ErroSessao)) toast('Não foi possível ler a biblioteca: ' + e.message, { ms: 8000 });
  }).finally(() => { varredura = null; });
  return varredura;
}

function contarRec(id) {
  if (!bib?.pastas[id]) return { total: 0, ouvidos: 0 };
  if (memoContagem.has(id)) return memoContagem.get(id);
  const p = bib.pastas[id];
  let total = p.faixas.length, ouvidos = p.faixas.filter(f => estado.posicoes[f]?.ok).length;
  for (const s of p.filhas) { const c = contarRec(s); total += c.total; ouvidos += c.ouvidos; }
  const r = { total, ouvidos };
  memoContagem.set(id, r);
  return r;
}

function ordenarFaixas(ids) {
  const o = cfg().ordenacao;
  const lista = ids.map(id => bib.faixas[id]).filter(Boolean);
  if (o === 'nome-desc') lista.sort((a, b) => comparar(b.nome, a.nome));
  else if (o === 'data') lista.sort((a, b) => (b.mod || 0) - (a.mod || 0));
  else if (o === 'data-asc') lista.sort((a, b) => (a.mod || 0) - (b.mod || 0));
  else lista.sort((a, b) => comparar(a.nome, b.nome));
  return lista.map(f => f.id);
}

function itensDaPasta(id, recursivo = false) {
  const p = bib?.pastas[id];
  if (!p) return [];
  const itens = ordenarFaixas(p.faixas).map(paraItem);
  if (recursivo) for (const s of p.filhas) itens.push(...itensDaPasta(s, true));
  return itens;
}

function caminhoPasta(id) {
  const c = [];
  let p = bib?.pastas[id];
  while (p) { c.unshift(p); p = p.pai ? bib.pastas[p.pai] : null; }
  return c;
}

/* =====================================================================
 * 6. CACHE OFFLINE (Cache Storage do navegador)
 * ===================================================================== */
const temCache = 'caches' in window;
const chaveCache = id => new URL(`__audio__/${encodeURIComponent(id)}`, location.href).href;
const emCache = id => !!cacheMeta[id];

async function lerCache(id) {
  if (!temCache || !cacheMeta[id]) return null;
  try {
    const c = await caches.open(CACHE_AUDIO);
    const r = await c.match(chaveCache(id));
    if (!r) { delete cacheMeta[id]; salvarCacheMeta(); return null; }
    cacheMeta[id].at = agora(); salvarCacheMeta();
    return await r.blob();
  } catch { return null; }
}

async function gravarCache(id, blob, fixo = false) {
  if (!temCache) return;
  try {
    const c = await caches.open(CACHE_AUDIO);
    await c.put(chaveCache(id), new Response(blob, { headers: { 'Content-Type': blob.type || 'audio/mpeg', 'Content-Length': String(blob.size) } }));
    cacheMeta[id] = { tam: blob.size, at: agora(), fixo: fixo || !!cacheMeta[id]?.fixo };
    salvarCacheMeta();
    await podarCache();
  } catch (e) {
    console.warn('Cache cheio ou indisponível', e);
    if (fixo) throw new Error('Sem espaço no aparelho para guardar este áudio offline.');
  }
}

async function removerCache(ids) {
  if (!temCache) return;
  const c = await caches.open(CACHE_AUDIO);
  for (const id of ids) { await c.delete(chaveCache(id)); delete cacheMeta[id]; }
  salvarCacheMeta();
}

async function podarCache() {
  const limite = (Number(cfg().cacheMB) || 0) * 1024 * 1024;
  const automaticos = Object.entries(cacheMeta).filter(([, m]) => !m.fixo).sort((a, b) => a[1].at - b[1].at);
  let total = automaticos.reduce((s, [, m]) => s + (m.tam || 0), 0);
  const remover = [];
  for (const [id, m] of automaticos) {
    if (total <= limite) break;
    if (id === carga.id) continue;
    remover.push(id); total -= m.tam || 0;
  }
  if (remover.length) await removerCache(remover);
}

function usoCache() {
  let fixos = 0, auto = 0, nFixos = 0;
  for (const m of Object.values(cacheMeta)) { if (m.fixo) { fixos += m.tam || 0; nFixos++; } else auto += m.tam || 0; }
  return { fixos, auto, nFixos };
}

async function baixarAudio(id, aoProgresso, sinal, tamanhoEsperado = 0) {
  const r = await fetchAuth(`${API}files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { signal: sinal });
  if (!r.ok) throw await erroDe(r);
  const total = Number(r.headers.get('Content-Length')) || tamanhoEsperado || 0;
  let tipo = (r.headers.get('Content-Type') || '').split(';')[0];
  if (!tipo.startsWith('audio/')) tipo = 'audio/mpeg';
  if (!r.body?.getReader) return new Blob([await r.arrayBuffer()], { type: tipo });
  const leitor = r.body.getReader();
  const partes = [];
  let recebido = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    partes.push(value);
    recebido += value.length;
    if (aoProgresso && total) aoProgresso(Math.min(1, recebido / total));
  }
  return new Blob(partes, { type: tipo });
}

const preCarga = { id: null, promessa: null, ctrl: null };

async function obterBlob(item, aoProgresso, sinal) {
  const doCache = await lerCache(item.id);
  if (doCache) return doCache;
  if (preCarga.id === item.id && preCarga.promessa) {
    const p = preCarga.promessa;
    preCarga.id = null; preCarga.promessa = null; preCarga.ctrl = null;
    try { return await p; } catch { /* tenta de novo abaixo */ }
  }
  const blob = await baixarAudio(item.id, aoProgresso, sinal, infoFaixa(item).tam);
  if (Number(cfg().cacheMB) > 0) gravarCache(item.id, blob).then(() => marcarEstadosNaLista());
  return blob;
}

function preCarregar(item) {
  if (!item || emCache(item.id) || preCarga.id === item.id) return;
  preCarga.ctrl?.abort();
  const ctrl = new AbortController();
  preCarga.id = item.id; preCarga.ctrl = ctrl;
  preCarga.promessa = baixarAudio(item.id, null, ctrl.signal, infoFaixa(item).tam).then(blob => {
    if (Number(cfg().cacheMB) > 0) gravarCache(item.id, blob).then(() => marcarEstadosNaLista());
    return blob;
  });
  preCarga.promessa.catch(() => { if (preCarga.ctrl === ctrl) { preCarga.id = null; preCarga.promessa = null; } });
}

let downloadOffline = null;
async function disponibilizarOffline(itens) {
  if (!temCache) return toast('Este navegador não permite guardar áudios offline.');
  if (downloadOffline) return toast('Já há um download offline em andamento.');
  try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
  const lista = itens.filter((it, i, a) => a.findIndex(x => x.id === it.id) === i);
  const pendentes = [];
  for (const it of lista) {
    if (cacheMeta[it.id]) { cacheMeta[it.id].fixo = true; } else pendentes.push(it);
  }
  salvarCacheMeta();
  if (!pendentes.length) { toast(`${plural(lista.length, 'áudio disponível', 'áudios disponíveis')} offline.`); marcarEstadosNaLista(); return; }
  const ctrl = new AbortController();
  downloadOffline = ctrl;
  const t = toast('', { ms: 0, acao: { rotulo: 'Cancelar', fn: () => ctrl.abort() } });
  let feitos = 0, falhas = 0;
  for (const it of pendentes) {
    if (ctrl.signal.aborted) break;
    const nome = semExt(infoFaixa(it).nome);
    try {
      const blob = await baixarAudio(it.id, p => { t.texto(`Baixando ${feitos + 1} de ${pendentes.length} (${Math.round(p * 100)}%) · ${nome}`); }, ctrl.signal, infoFaixa(it).tam);
      await gravarCache(it.id, blob, true);
      feitos++;
      marcarEstadosNaLista();
    } catch (e) {
      if (e.name === 'AbortError') break;
      falhas++;
      if (e instanceof ErroSessao) break;
    }
  }
  t.fechar();
  downloadOffline = null;
  if (ctrl.signal.aborted) toast(`Download interrompido: ${plural(feitos, 'áudio guardado', 'áudios guardados')}.`);
  else toast(`${plural(feitos + lista.length - pendentes.length, 'áudio disponível', 'áudios disponíveis')} offline${falhas ? ` (${falhas} com erro)` : ''}.`, { ms: 6000 });
  renderVista({ manterRolagem: true });
}

async function removerDoOffline(itens) {
  for (const it of itens) if (cacheMeta[it.id]) cacheMeta[it.id].fixo = false;
  salvarCacheMeta();
  await podarCache();
  marcarEstadosNaLista();
  toast('Removido do modo offline.');
}

/* =====================================================================
 * 7. SINCRONIZAÇÃO (arquivo JSON na pasta oculta do app no Drive)
 * ===================================================================== */
const sync = { id: ler('syncId', null), timer: null, emAndamento: null, ultima: ler('syncUltima', 0), erro: '' };

function agendarSync(atraso = 30_000) {
  if (!cfg().sync) return;
  if (sync.timer) return;
  sync.timer = setTimeout(() => { sync.timer = null; sincronizar(); }, atraso);
}

function dadosSync() {
  const config = { u: cfg().u };
  for (const k of CHAVES_SYNC) config[k] = cfg()[k];
  return { app: 'auris', versao: 1, salvo: agora(), config, posicoes: estado.posicoes, playlists: estado.playlists, removidas: estado.removidas };
}

function mesclar(remoto, { forcar = false } = {}) {
  if (!remoto || typeof remoto !== 'object') return false;
  let mudou = false;
  for (const [id, p] of Object.entries(remoto.posicoes || {})) {
    const l = estado.posicoes[id];
    if (!l || forcar || (p.u || 0) > (l.u || 0)) { estado.posicoes[id] = p; mudou = true; }
  }
  for (const [id, u] of Object.entries(remoto.removidas || {})) {
    if (!estado.removidas[id] || u > estado.removidas[id]) { estado.removidas[id] = u; mudou = true; }
  }
  for (const [id, pl] of Object.entries(remoto.playlists || {})) {
    const l = estado.playlists[id];
    if (!l || forcar || (pl.u || 0) > (l.u || 0)) { estado.playlists[id] = pl; mudou = true; }
  }
  for (const [id, u] of Object.entries(estado.removidas)) {
    if (estado.playlists[id] && (estado.playlists[id].u || 0) <= u) { delete estado.playlists[id]; mudou = true; }
  }
  const rc = remoto.config;
  if (rc && (forcar || (rc.u || 0) > (cfg().u || 0))) {
    const raizAntes = cfg().raiz?.id;
    for (const k of CHAVES_SYNC) if (k in rc) estado.config[k] = rc[k];
    estado.config.u = rc.u || agora();
    mudou = true;
    aplicarVelocidadeNoAudio();
    atualizarRotulosSalto();
    if (cfg().raiz?.id !== raizAntes && cfg().raiz) { bib = null; varrerBiblioteca(); }
  }
  if (mudou) { memoContagem.clear(); gravar('estado', estado); }
  return mudou;
}

function sincronizar() {
  if (!cfg().sync || !auth.appdata || !tokenValido() || !navigator.onLine) return Promise.resolve(false);
  if (sync.emAndamento) return sync.emAndamento;
  clearTimeout(sync.timer); sync.timer = null;
  sync.emAndamento = (async () => {
    try {
      if (!sync.id) {
        const r = await api('files', { spaces: 'appDataFolder', q: `name = '${ARQUIVO_SYNC}' and trashed = false`, fields: 'files(id,modifiedTime)', orderBy: 'modifiedTime desc' });
        sync.id = r.files?.[0]?.id || null;
        gravar('syncId', sync.id);
      }
      let mudou = false;
      if (sync.id) {
        const r = await fetchAuth(`${API}files/${sync.id}?alt=media`);
        if (r.status === 404) { sync.id = null; gravar('syncId', null); }
        else if (r.ok) mudou = mesclar(await r.json().catch(() => null));
        else throw await erroDe(r);
      }
      const corpo = JSON.stringify(dadosSync());
      if (sync.id) {
        const r = await fetchAuth(`${UPLOAD}files/${sync.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: corpo });
        if (!r.ok) throw await erroDe(r);
      } else {
        const fronteira = 'auris' + uid();
        const meta = JSON.stringify({ name: ARQUIVO_SYNC, parents: ['appDataFolder'], mimeType: 'application/json' });
        const multipart = `--${fronteira}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${fronteira}\r\nContent-Type: application/json\r\n\r\n${corpo}\r\n--${fronteira}--`;
        const r = await fetchAuth(`${UPLOAD}files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${fronteira}` }, body: multipart });
        if (!r.ok) throw await erroDe(r);
        sync.id = (await r.json()).id; gravar('syncId', sync.id);
      }
      sync.ultima = agora(); sync.erro = ''; gravar('syncUltima', sync.ultima);
      if (mudou) { renderLateral(); renderVista({ manterRolagem: true }); atualizarPlayerUI(); }
      return true;
    } catch (e) {
      sync.erro = e.message;
      console.warn('Sincronização falhou', e);
      return false;
    } finally { sync.emAndamento = null; }
  })();
  return sync.emAndamento;
}

/* =====================================================================
 * 8. MOTOR DE REPRODUÇÃO
 * ===================================================================== */
const audio = new Audio();
audio.preload = 'auto';
const carga = { seq: 0, ctrl: null, url: null, id: null, pronto: false, progresso: 0, carregando: false };
let ultimoRegistro = 0;

// Áudio mudo para "destravar" a reprodução programática no iPhone no primeiro toque.
const SILENCIO = (() => {
  const n = 800, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const s = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  s(36, 'data'); v.setUint32(40, n, true);
  for (let i = 0; i < n; i++) v.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
})();
let destravado = false;
function destravarAudio() {
  if (destravado || audio.src) return;
  destravado = true;
  audio.src = SILENCIO;
  audio.play().then(() => {
    if (audio.src === SILENCIO) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  }).catch(() => { destravado = false; });
}

const itemAtual = () => (fila.indice >= 0 ? fila.itens[fila.indice] : null);
const temAudioCarregado = () => carga.pronto && carga.id === itemAtual()?.id;

function tocarLista(itens, inicio = 0, origem = null, { aleatorio = cfg().aleatorio } = {}) {
  if (!itens.length) return toast('Não há áudios para tocar aqui.');
  let lista = itens.map(it => ({ ...it }));
  let indice = limitar(inicio, 0, lista.length - 1);
  fila.original = null;
  if (aleatorio) {
    fila.original = lista.slice();
    const escolhido = lista[indice];
    const resto = lista.filter((_, i) => i !== indice);
    lista = [escolhido, ...embaralhar(resto)];
    indice = 0;
  }
  fila.itens = lista; fila.indice = indice; fila.origem = origem;
  salvarFila();
  tocarIndice(indice);
}

function proximoIndice(passo = 1, manual = false) {
  const n = fila.itens.length;
  if (!n) return -1;
  const i = fila.indice + passo;
  if (i >= 0 && i < n) return i;
  if (cfg().repetir === 'todas' || manual) return (i + n) % n;
  return -1;
}

async function tocarIndice(i, { tocar = true } = {}) {
  if (i < 0 || i >= fila.itens.length) return;
  salvarPosicaoAgora();
  const seq = ++carga.seq;
  carga.ctrl?.abort();
  const ctrl = new AbortController();
  carga.ctrl = ctrl;
  fila.indice = i; salvarFila();
  const item = fila.itens[i];
  carga.id = item.id; carga.pronto = false;
  audio.pause();
  definirCarregando(true, 0);
  atualizarPlayerUI(); marcarFaixaAtual(); atualizarMetadados();

  let blob;
  try {
    blob = await obterBlob(item, p => { if (seq === carga.seq) definirCarregando(true, p); }, ctrl.signal);
  } catch (e) {
    if (seq !== carga.seq || e.name === 'AbortError') return;
    definirCarregando(false);
    return tratarErroCarga(e, item, tocar);
  }
  if (seq !== carga.seq) return;

  if (carga.url) URL.revokeObjectURL(carga.url);
  carga.url = URL.createObjectURL(blob);
  audio.src = carga.url;
  aplicarVelocidadeNoAudio();
  try {
    await esperarEvento(audio, 'loadedmetadata', 30000);
  } catch (e) {
    if (seq !== carga.seq) return;
    definirCarregando(false);
    return tratarErroCarga(e, item, tocar);
  }
  if (seq !== carga.seq) return;

  const p = posicao(item.id);
  const dur = audio.duration;
  if (cfg().retomar && p && p.p > 5 && (!isFinite(dur) || p.p < dur - 5)) {
    audio.currentTime = Math.max(0, p.p - (Number(cfg().recuoRetomar) || 0));
  }
  if (isFinite(dur) && (!p || !p.d)) registrarPosicao(item.id, audio.currentTime, dur, infoFaixa(item).nome);
  aplicarVelocidadeNoAudio();
  carga.pronto = true;
  definirCarregando(false);
  if (tocar) {
    try { await audio.play(); }
    catch { toast('Toque em ▶ para começar.'); }
  }
  atualizarPlayerUI(); atualizarTempoUI();
  const prox = proximoIndice(1);
  if (prox >= 0 && prox !== i) preCarregar(fila.itens[prox]);
}

function tratarErroCarga(e, item, tocar) {
  atualizarPlayerUI();
  if (e instanceof ErroSessao) return;
  const nome = semExt(infoFaixa(item).nome);
  if (e instanceof ErroApi && e.motivo === 'rede') {
    toast(navigator.onLine ? e.message : `“${nome}” não está disponível offline.`, { ms: 6000 });
    return;
  }
  toast(`“${nome}”: ${e.message}`, { ms: 7000 });
  if (tocar && (e.status === 404 || e.status === 403 || !(e instanceof ErroApi))) {
    const prox = proximoIndice(1);
    if (prox >= 0 && prox !== fila.indice) setTimeout(() => tocarIndice(prox), 1200);
  }
}

function alternarPlay() {
  if (!itemAtual()) {
    if (vistaAtualItens().length) return tocarLista(vistaAtualItens().itens, 0, vistaAtualItens().origem);
    return toast('Escolha um áudio na biblioteca.');
  }
  if (!temAudioCarregado()) { if (!carga.carregando) tocarIndice(fila.indice); return; }
  if (audio.paused) audio.play().catch(() => toast('Não foi possível iniciar a reprodução.'));
  else audio.pause();
}
function pausar() { if (!audio.paused) audio.pause(); }

function proxima(manual = true) {
  const i = proximoIndice(1, manual);
  if (i >= 0) tocarIndice(i);
}
function anterior() {
  if (temAudioCarregado() && audio.currentTime > 4) { audio.currentTime = 0; return; }
  const i = proximoIndice(-1, true);
  if (i >= 0) tocarIndice(i);
}
function saltar(seg) {
  if (!temAudioCarregado()) return;
  audio.currentTime = limitar(audio.currentTime + seg, 0, (audio.duration || 0) - 0.2);
  atualizarTempoUI();
}

function aplicarVelocidadeNoAudio() {
  const v = Number(cfg().velocidade) || 1;
  audio.defaultPlaybackRate = v;
  audio.playbackRate = v;
  const tom = !!cfg().preservarTom;
  if ('preservesPitch' in audio) audio.preservesPitch = tom;
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = tom;
  if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = tom;
  audio.volume = limitar(Number(cfg().volume) || 0, 0, 1);
}
function definirVelocidade(v) {
  v = Math.round(limitar(v, VEL_MIN, VEL_MAX) * 100) / 100;
  mudarConfig('velocidade', v);
  aplicarVelocidadeNoAudio();
  atualizarControlesVelocidade();
  atualizarTempoUI();
  atualizarPosicaoSistema();
}

function alternarRepetir() {
  const ordem = ['nao', 'todas', 'uma'];
  const novo = ordem[(ordem.indexOf(cfg().repetir) + 1) % 3];
  mudarConfig('repetir', novo);
  atualizarPlayerUI();
  toast({ nao: 'Repetição desligada', todas: 'Repetir a fila inteira', uma: 'Repetir este áudio' }[novo], { ms: 1800 });
}

function alternarAleatorio() {
  const ligar = !cfg().aleatorio;
  mudarConfig('aleatorio', ligar);
  const atual = itemAtual();
  if (fila.itens.length > 1) {
    if (ligar) {
      fila.original = fila.itens.slice();
      const resto = fila.itens.filter((_, i) => i !== fila.indice);
      fila.itens = atual ? [atual, ...embaralhar(resto)] : embaralhar(resto);
      fila.indice = atual ? 0 : -1;
    } else if (fila.original) {
      fila.itens = fila.original; fila.original = null;
      fila.indice = atual ? Math.max(0, fila.itens.findIndex(x => x.id === atual.id)) : -1;
    }
    salvarFila();
  }
  atualizarPlayerUI();
  if (rotaAtual().tipo === 'fila') renderVista({ manterRolagem: true });
  const prox = proximoIndice(1);
  if (prox >= 0 && temAudioCarregado()) preCarregar(fila.itens[prox]);
  toast(ligar ? 'Ordem aleatória ligada' : 'Ordem aleatória desligada', { ms: 1800 });
}

function salvarPosicaoAgora() {
  const it = itemAtual();
  if (!it || !temAudioCarregado() || !isFinite(audio.duration)) return;
  registrarPosicao(it.id, audio.currentTime, audio.duration, infoFaixa(it).nome);
}

function inserirNaFila(itens, onde = 'fim') {
  if (!itens.length) return;
  const copias = itens.map(it => ({ ...it }));
  if (!fila.itens.length || fila.indice < 0) {
    fila.itens = copias; fila.indice = 0; fila.original = null; fila.origem = { tipo: 'fila', nome: 'Fila' };
    salvarFila(); atualizarPlayerUI(); renderNavFila();
    toast(`${plural(copias.length, 'áudio', 'áudios')} na fila.`, { acao: { rotulo: 'Tocar', fn: () => tocarIndice(0) } });
    return;
  }
  if (onde === 'seguinte') fila.itens.splice(fila.indice + 1, 0, ...copias);
  else fila.itens.push(...copias);
  if (fila.original) fila.original.push(...copias);
  salvarFila(); renderNavFila();
  if (rotaAtual().tipo === 'fila') renderVista({ manterRolagem: true });
  toast(onde === 'seguinte' ? `Tocará em seguida: ${plural(copias.length, 'áudio', 'áudios')}.` : `${plural(copias.length, 'áudio adicionado', 'áudios adicionados')} ao fim da fila.`);
  const prox = proximoIndice(1);
  if (prox >= 0 && temAudioCarregado()) preCarregar(fila.itens[prox]);
}

function removerDaFila(indices) {
  const set = new Set(indices);
  const atual = itemAtual();
  const removeuAtual = set.has(fila.indice);
  const ids = indices.map(i => fila.itens[i]?.id);
  fila.itens = fila.itens.filter((_, i) => !set.has(i));
  if (fila.original) for (const id of ids) { const k = fila.original.findIndex(x => x.id === id); if (k >= 0) fila.original.splice(k, 1); }
  if (removeuAtual) {
    const novo = Math.max(0, Math.min(fila.indice - indices.filter(i => i < fila.indice).length, fila.itens.length - 1));
    fila.indice = novo;
    if (!fila.itens.length) { limparFila(); return; }
    if (!audio.paused) tocarIndice(novo); else { carga.pronto = false; carga.id = null; atualizarPlayerUI(); }
  } else if (atual) {
    fila.indice = fila.itens.indexOf(atual);
  }
  salvarFila(); renderNavFila(); renderVista({ manterRolagem: true }); atualizarPlayerUI();
}

function moverNaFila(de, para) {
  const atual = itemAtual();
  const [x] = fila.itens.splice(de, 1);
  fila.itens.splice(para, 0, x);
  if (atual) fila.indice = fila.itens.indexOf(atual);
  salvarFila();
  const prox = proximoIndice(1);
  if (prox >= 0 && temAudioCarregado()) preCarregar(fila.itens[prox]);
}

function limparFila() {
  salvarPosicaoAgora();
  carga.seq++; carga.ctrl?.abort();
  audio.pause();
  if (carga.url) { URL.revokeObjectURL(carga.url); carga.url = null; }
  audio.removeAttribute('src'); audio.load();
  carga.pronto = false; carga.id = null;
  fila = { itens: [], original: null, indice: -1, origem: null };
  salvarFila(); definirCarregando(false);
  atualizarPlayerUI(); atualizarTempoUI(); renderNavFila(); atualizarMetadados();
  if (rotaAtual().tipo === 'fila') renderVista();
}

audio.addEventListener('timeupdate', () => {
  agendarTempoUI();
  if (temAudioCarregado() && agora() - ultimoRegistro > 5000) { ultimoRegistro = agora(); salvarPosicaoAgora(); }
});
audio.addEventListener('play', () => { atualizarPlayerUI(); atualizarPosicaoSistema(); });
audio.addEventListener('pause', () => { salvarPosicaoAgora(); atualizarPlayerUI(); atualizarPosicaoSistema(); agendarSync(15_000); });
audio.addEventListener('ratechange', () => { if (Math.abs(audio.playbackRate - cfg().velocidade) > 0.001 && audio.playbackRate > 0 && temAudioCarregado()) aplicarVelocidadeNoAudio(); });
audio.addEventListener('ended', aoTerminar);

function aoTerminar() {
  const it = itemAtual();
  if (!it || !temAudioCarregado() || audio.src !== carga.url) return;
  const dur = audio.duration || 0;
  estado.posicoes[it.id] = { p: 0, d: Math.round(dur), u: agora(), ok: true, n: infoFaixa(it).nome };
  salvarEstado(); memoContagem.clear();
  marcarEstadosNaLista();
  if (cfg().repetir === 'uma') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (sono.fimFaixa) { cancelarSono(); atualizarPlayerUI(); toast('Timer de sono: reprodução encerrada.'); return; }
  if (!cfg().avancoAuto) { atualizarPlayerUI(); return; }
  const prox = proximoIndice(1);
  if (prox >= 0) tocarIndice(prox);
  else { atualizarPlayerUI(); toast('Fim da fila.'); }
}

/* =====================================================================
 * 9. TIMER DE SONO E CONTROLES DO SISTEMA (tela de bloqueio, fones)
 * ===================================================================== */
const sono = { fim: 0, timer: null, fimFaixa: false };

function definirSono(min) {
  cancelarSono(false);
  if (min === 'faixa') sono.fimFaixa = true;
  else if (min > 0) { sono.fim = agora() + min * 60_000; sono.timer = setInterval(tickSono, 1000); }
  atualizarRotuloSono();
  toast(min === 'faixa' ? 'A reprodução vai parar ao fim deste áudio.' : `A reprodução vai parar em ${min} min.`);
}
function cancelarSono(rotulo = true) {
  clearInterval(sono.timer); sono.timer = null; sono.fim = 0; sono.fimFaixa = false;
  aplicarVelocidadeNoAudio();
  if (rotulo) atualizarRotuloSono();
}
function tickSono() {
  const resta = sono.fim - agora();
  if (resta <= 0) { audio.pause(); cancelarSono(); toast('Timer de sono: reprodução pausada.'); return; }
  if (resta < 10_000 && !audio.paused) audio.volume = limitar(Number(cfg().volume) || 1, 0, 1) * (resta / 10_000);
  atualizarRotuloSono();
}
function atualizarRotuloSono() {
  let t = '';
  if (sono.fimFaixa) t = 'fim';
  else if (sono.fim) t = String(Math.ceil((sono.fim - agora()) / 60_000));
  $$('[data-ref="sono"]').forEach(el => { el.textContent = t; });
  $$('[data-ref="bt-sono"]').forEach(el => el.classList.toggle('ativo', !!t));
}

const temMediaSession = 'mediaSession' in navigator;
function configurarControlesSistema() {
  if (!temMediaSession) return;
  const ms = navigator.mediaSession;
  const def = (acao, fn) => { try { ms.setActionHandler(acao, fn); } catch { /* sem suporte */ } };
  def('play', () => alternarPlay());
  def('pause', () => pausar());
  def('previoustrack', () => anterior());
  def('nexttrack', () => proxima());
  def('seekbackward', d => saltar(-(d?.seekOffset || cfg().saltoVoltar)));
  def('seekforward', d => saltar(d?.seekOffset || cfg().saltoAvancar));
  def('seekto', d => { if (temAudioCarregado() && d?.seekTime != null) { audio.currentTime = d.seekTime; atualizarTempoUI(); } });
  def('stop', () => pausar());
}
function atualizarMetadados() {
  if (!temMediaSession) return;
  const it = itemAtual();
  if (!it) { navigator.mediaSession.metadata = null; return; }
  const info = infoFaixa(it);
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: semExt(info.nome),
      artist: info.pastaNome || fila.origem?.nome || 'Auris',
      album: fila.origem?.nome || 'Auris',
      artwork: [
        { src: new URL('icone-192.png', location.href).href, sizes: '192x192', type: 'image/png' },
        { src: new URL('icone-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch { /* sem suporte */ }
}
function atualizarPosicaoSistema() {
  if (!temMediaSession) return;
  navigator.mediaSession.playbackState = temAudioCarregado() ? (audio.paused ? 'paused' : 'playing') : 'none';
  if (temAudioCarregado() && isFinite(audio.duration) && audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate || 1, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* nada */ }
  }
}

/* =====================================================================
 * 10. INTERFACE: TELAS, AVISOS, MENUS, DIÁLOGOS
 * ===================================================================== */
function mostrarTela(qual) {
  $('#tela-config').hidden = qual !== 'config';
  $('#tela-login').hidden = qual !== 'login';
  $('#app').hidden = qual !== 'app';
  if (qual === 'config') {
    $('#origem-atual').textContent = location.origin;
    $('#campo-client-id').value = auth.clientId || '';
  }
}

function status(texto) { const el = $('#status'); if (el) { el.textContent = texto; el.title = texto; } }

function mostrarAviso(html, { tipo = '', botao = null } = {}) {
  const el = $('#aviso');
  el.className = 'aviso ' + tipo;
  el.innerHTML = `<span>${html}</span>` + (botao ? `<button type="button" class="botao primario pequeno" data-acao="${botao.acao}">${esc(botao.rotulo)}</button>` : '');
  el.hidden = false;
}
function ocultarAviso() { $('#aviso').hidden = true; }
function mostrarAvisoSessao() {
  if ($('#app').hidden) return;
  mostrarAviso(navigator.onLine
    ? 'A conexão com o Google Drive expirou. Os áudios guardados offline continuam disponíveis.'
    : 'Você está sem internet. Só os áudios guardados offline podem ser tocados.',
  navigator.onLine ? { botao: { rotulo: 'Reconectar', acao: 'reconectar' } } : {});
}

function toast(texto, { ms = 3200, acao = null } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  const span = document.createElement('span');
  span.textContent = texto;
  el.appendChild(span);
  if (acao) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = acao.rotulo;
    b.onclick = () => { fechar(); acao.fn(); };
    el.appendChild(b);
  }
  $('#toasts').appendChild(el);
  let t = ms ? setTimeout(fechar, ms) : null;
  function fechar() { clearTimeout(t); el.remove(); }
  const r = { fechar, texto: s => { span.textContent = s; } };
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  return r;
}

/* ---- menus contextuais e popovers ---- */
let menuAberto = null;
function abrirMenu(ancora, itens, { aoMontar = null, largura = null } = {}) {
  fecharMenu();
  const m = $('#menu'), veu = $('#menu-veu');
  const movel = matchMedia('(max-width: 860px)').matches;
  m.innerHTML = itens.filter(Boolean).map((it, i) => {
    if (it === '-') return '<div class="sep"></div>';
    if (it.cab) return `<div class="cab">${esc(it.cab)}</div>`;
    if (it.html) return it.html;
    return `<button type="button" class="item ${it.perigo ? 'perigo' : ''} ${it.marcado ? 'marcado' : ''}" data-mi="${i}" role="menuitem">${it.icone ? ico(it.icone) : '<span style="width:20px;flex:none"></span>'}<span>${esc(it.rotulo)}</span></button>`;
  }).join('');
  const lista = itens.filter(Boolean);
  m.onclick = e => {
    const b = e.target.closest('[data-mi]');
    if (!b) return;
    const it = lista[+b.dataset.mi];
    fecharMenu();
    it?.acao?.();
  };
  m.classList.toggle('folha', movel);
  veu.classList.toggle('escuro', movel);
  m.style.width = largura ? largura + 'px' : '';
  m.hidden = false; veu.hidden = false;
  if (!movel) {
    const r = ancora.getBoundingClientRect();
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = r.right - mw; if (x < 8) x = Math.min(r.left, innerWidth - mw - 8);
    let y = r.bottom + 6; if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
    m.style.left = Math.max(8, x) + 'px'; m.style.top = y + 'px';
  } else { m.style.left = m.style.top = ''; }
  menuAberto = { ancora };
  aoMontar?.(m);
  m.querySelector('.item, button, input')?.focus({ preventScroll: true });
}
function fecharMenu() {
  if (!menuAberto) return;
  $('#menu').hidden = true; $('#menu-veu').hidden = true; $('#menu').innerHTML = '';
  menuAberto = null;
}

/* ---- diálogos ---- */
function mostrarDialogo({ titulo, corpo, botoes = [{ rotulo: 'OK', valor: true, primario: true }], aoMontar = null }) {
  return new Promise(resolver => {
    const d = $('#dialogo');
    fecharMenu();
    d.innerHTML = `<form method="dialog">
      <div class="d-cab">${esc(titulo)}</div>
      <div class="d-corpo">${corpo}</div>
      <div class="d-rodape">${botoes.map((b, i) => `<button type="submit" class="botao ${b.primario ? 'primario' : ''} ${b.perigo ? 'perigo' : ''}" value="${i}">${esc(b.rotulo)}</button>`).join('')}</div>
    </form>`;
    let resolvido = false;
    const concluir = v => { if (resolvido) return; resolvido = true; resolver(v); };
    d.onclose = () => {
      if (d.open) return; // evento atrasado do diálogo anterior
      const b = botoes[d.returnValue === '' ? -1 : +d.returnValue];
      concluir(b ? (typeof b.valor === 'function' ? b.valor(d) : b.valor) : null);
    };
    d.returnValue = '';
    d.showModal();
    aoMontar?.(d, v => { concluir(v); d.onclose = null; d.close(); });
  });
}
function confirmar(titulo, mensagem, rotuloOk = 'Confirmar', perigo = false) {
  return mostrarDialogo({ titulo, corpo: `<p>${esc(mensagem)}</p>`, botoes: [{ rotulo: rotuloOk, valor: true, primario: !perigo, perigo }, { rotulo: 'Cancelar', valor: false }] });
}
function pedirTexto(titulo, valor = '', rotuloOk = 'Salvar', dica = '') {
  return mostrarDialogo({
    titulo,
    corpo: `${dica ? `<p>${esc(dica)}</p>` : ''}<input class="campo" id="d-texto" type="text" value="${esc(valor)}" autocomplete="off" maxlength="120">`,
    botoes: [{ rotulo: rotuloOk, valor: d => $('#d-texto', d).value.trim() || null, primario: true }, { rotulo: 'Cancelar', valor: null }],
    aoMontar: (d, fechar) => {
      const c = $('#d-texto', d);
      c.focus(); c.select();
      c.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); fechar(c.value.trim() || null); } });
    },
  });
}

/* ---- playlists ---- */
function criarPlaylist(nome, faixas = []) {
  const id = uid();
  estado.playlists[id] = { id, nome, faixas: faixas.map(({ id, n, s }) => ({ id, n, s })), u: agora(), criada: agora() };
  salvarEstado(); renderPlaylistsLateral();
  return id;
}
function marcarPlaylistAlterada(id) {
  estado.playlists[id].u = agora();
  salvarEstado(); renderPlaylistsLateral();
}
function adicionarAPlaylist(id, itens) {
  const pl = estado.playlists[id];
  if (!pl) return;
  const existentes = new Set(pl.faixas.map(f => f.id));
  const novos = itens.filter(it => !existentes.has(it.id));
  pl.faixas.push(...novos.map(({ id, n, s }) => ({ id, n, s })));
  marcarPlaylistAlterada(id);
  const repetidos = itens.length - novos.length;
  toast(`${plural(novos.length, 'áudio adicionado', 'áudios adicionados')} a “${pl.nome}”${repetidos ? ` (${repetidos} já estava${repetidos > 1 ? 'm' : ''} lá)` : ''}.`, { acao: { rotulo: 'Abrir', fn: () => navegar(`#/playlist/${id}`) } });
  if (rotaAtual().tipo === 'playlist' && rotaAtual().id === id) renderVista({ manterRolagem: true });
}
async function novaPlaylist(itens = []) {
  const nome = await pedirTexto('Nova playlist', '', 'Criar', 'Dê um nome à playlist (por exemplo, “Revisão de Processo Civil”).');
  if (!nome) return null;
  const id = criarPlaylist(nome, itens);
  if (itens.length) toast(`Playlist “${nome}” criada com ${plural(itens.length, 'áudio', 'áudios')}.`, { acao: { rotulo: 'Abrir', fn: () => navegar(`#/playlist/${id}`) } });
  else navegar(`#/playlist/${id}`);
  return id;
}
async function escolherPlaylist(itens) {
  const lista = playlistsOrdenadas();
  const corpo = `<p>${plural(itens.length, 'áudio selecionado', 'áudios selecionados')}.</p>
    <div class="lista-escolha">
      <button type="button" data-pl="__nova">${ico('mais')}<span>Nova playlist…</span></button>
      ${lista.map(p => `<button type="button" data-pl="${esc(p.id)}">${ico('playlist')}<span>${esc(p.nome)}</span><small>${p.faixas.length}</small></button>`).join('')}
    </div>`;
  const escolha = await mostrarDialogo({
    titulo: 'Adicionar à playlist', corpo,
    botoes: [{ rotulo: 'Cancelar', valor: null }],
    aoMontar: (d, fechar) => d.querySelector('.lista-escolha').addEventListener('click', e => {
      const b = e.target.closest('[data-pl]'); if (b) fechar(b.dataset.pl);
    }),
  });
  if (!escolha) return;
  if (escolha === '__nova') return novaPlaylist(itens);
  adicionarAPlaylist(escolha, itens);
}
async function renomearPlaylist(id) {
  const pl = estado.playlists[id]; if (!pl) return;
  const nome = await pedirTexto('Renomear playlist', pl.nome);
  if (!nome || nome === pl.nome) return;
  pl.nome = nome; marcarPlaylistAlterada(id); renderVista({ manterRolagem: true });
}
async function excluirPlaylist(id) {
  const pl = estado.playlists[id]; if (!pl) return;
  if (!await confirmar('Excluir playlist', `Excluir “${pl.nome}”? Os áudios continuam no Drive; só a lista é apagada.`, 'Excluir', true)) return;
  delete estado.playlists[id];
  estado.removidas[id] = agora();
  salvarEstado(); renderPlaylistsLateral();
  if (rotaAtual().id === id) navegar('#/');
  toast('Playlist excluída.');
}
function duplicarPlaylist(id) {
  const pl = estado.playlists[id]; if (!pl) return;
  const novo = criarPlaylist(`${pl.nome} (cópia)`, pl.faixas);
  navegar(`#/playlist/${novo}`);
}
function playlistsOrdenadas() { return Object.values(estado.playlists).sort((a, b) => comparar(a.nome, b.nome)); }

/** Primeiro áudio não ouvido de uma lista (para o botão “Continuar”). */
function indiceContinuar(itens) {
  const parcial = itens.findIndex(it => { const p = estado.posicoes[it.id]; return p && !p.ok && p.p > 5; });
  if (parcial >= 0) return parcial;
  const naoOuvido = itens.findIndex(it => !estado.posicoes[it.id]?.ok);
  return naoOuvido >= 0 ? naoOuvido : 0;
}

/* ---- seletor da pasta da biblioteca ---- */
async function escolherPastaRaiz() {
  if (!tokenValido()) { try { await garantirToken(); } catch { return; } }
  const pilha = [];
  let atual = null; // null = início (Meu Drive / Compartilhados)
  const corpo = `<div class="navegador-pastas">
      <p>Escolha a pasta onde ficam os seus áudios. As subpastas dela viram as categorias do player.</p>
      <div class="migalhas" id="np-migalhas"></div>
      <div class="lista-escolha" id="np-lista"></div>
      <p style="margin-top:14px">Ou cole o link da pasta do Drive:</p>
      <div style="display:flex;gap:8px"><input class="campo" id="np-link" placeholder="https://drive.google.com/drive/folders/…"><button type="button" class="botao" id="np-usar-link">Usar</button></div>
    </div>`;
  const escolha = await mostrarDialogo({
    titulo: 'Pasta da biblioteca', corpo,
    botoes: [
      { rotulo: 'Usar esta pasta', primario: true, valor: () => (atual ? { id: atual.id, nome: atual.nome } : null) },
      { rotulo: 'Cancelar', valor: null },
    ],
    aoMontar: (d, fechar) => {
      const botaoUsar = d.querySelector('.d-rodape .primario');
      const lista = $('#np-lista', d), mig = $('#np-migalhas', d);
      const desenhar = async () => {
        botaoUsar.disabled = !atual || atual.id === 'compartilhados';
        mig.innerHTML = [`<a href="#" data-np="-1">Início</a>`, ...pilha.map((p, i) => `${ico('direita')}<a href="#" data-np="${i}">${esc(p.nome)}</a>`)].join('');
        if (!atual) {
          lista.innerHTML = `<button type="button" data-entrar="root">${ico('drive')}<span>Meu Drive</span></button>
            <button type="button" data-entrar="compartilhados">${ico('pasta')}<span>Compartilhados comigo</span></button>`;
          return;
        }
        lista.innerHTML = '<div class="carregando-texto">Carregando pastas…</div>';
        try {
          const pastas = await listarSoPastas(atual.id);
          if (atual && pilha[pilha.length - 1] === atual) {
            lista.innerHTML = pastas.length
              ? pastas.map(p => `<button type="button" data-entrar="${esc(p.id)}" data-nome="${esc(p.nome)}">${ico('pasta')}<span>${esc(p.nome)}</span>${ico('direita')}</button>`).join('')
              : '<div class="carregando-texto">Nenhuma subpasta aqui.</div>';
          }
        } catch (e) { lista.innerHTML = `<div class="carregando-texto">${esc(e.message)}</div>`; }
      };
      lista.addEventListener('click', e => {
        const b = e.target.closest('[data-entrar]'); if (!b) return;
        const id = b.dataset.entrar;
        const nome = id === 'root' ? 'Meu Drive' : id === 'compartilhados' ? 'Compartilhados comigo' : b.dataset.nome;
        atual = { id, nome }; pilha.push(atual); desenhar();
      });
      mig.addEventListener('click', e => {
        const a = e.target.closest('[data-np]'); if (!a) return;
        e.preventDefault();
        const i = +a.dataset.np;
        pilha.length = i + 1; atual = i < 0 ? null : pilha[i]; desenhar();
      });
      $('#np-usar-link', d).addEventListener('click', async () => {
        const v = $('#np-link', d).value.trim();
        const m = v.match(/folders\/([\w-]+)/) || v.match(/[?&]id=([\w-]+)/) || v.match(/^([\w-]{15,})$/);
        if (!m) return toast('Link de pasta não reconhecido.');
        try {
          const f = await api(`files/${m[1]}`, { fields: 'id,name,mimeType', supportsAllDrives: true });
          if (f.mimeType !== MIME_PASTA) return toast('O link não é de uma pasta.');
          fechar({ id: f.id, nome: f.name });
        } catch (e) { toast(e.message); }
      });
      desenhar();
    },
  });
  if (!escolha) return;
  mudarConfig('raiz', escolha);
  bib = null; salvarBib(); abertas = new Set(); gravar('abertas', []);
  renderLateral();
  navegar('#/');
  renderVista();
  await varrerBiblioteca();
}

/* =====================================================================
 * 11. INTERFACE: VISTAS
 * ===================================================================== */
let listas = {};             // registro das listas exibidas: chave -> { itens, origem, tipo, id }
let selecao = { lista: null, idx: new Set() };
let rotaRenderizada = '';

function rotaAtual() {
  const h = location.hash.replace(/^#\/?/, '');
  const [tipo = '', ...resto] = h.split('/');
  return { tipo: tipo || 'inicio', id: decodeURIComponent(resto.join('/')) };
}
function navegar(hash) {
  if (location.hash === hash) renderVista();
  else location.hash = hash;
}
function vistaAtualItens() {
  const k = Object.keys(listas).find(k => listas[k].principal) || Object.keys(listas)[0];
  const L = k ? listas[k] : null;
  return { itens: L?.itens || [], origem: L?.origem || null, length: L?.itens?.length || 0 };
}

function renderVista({ manterRolagem = false } = {}) {
  if ($('#app').hidden) return;
  const r = rotaAtual();
  const chave = r.tipo + '/' + r.id;
  const vista = $('#vista');
  const rolagem = vista.scrollTop;
  if (chave !== rotaRenderizada) limparSelecao(false);
  listas = {};
  let html = '';
  if (r.tipo === 'pasta') html = vistaPasta(r.id);
  else if (r.tipo === 'playlist') html = vistaPlaylist(r.id);
  else if (r.tipo === 'fila') html = vistaFila();
  else if (r.tipo === 'andamento') html = vistaAndamento();
  else if (r.tipo === 'busca') html = vistaBusca(r.id);
  else if (r.tipo === 'ajustes') html = vistaAjustes();
  else html = vistaInicio();
  vista.innerHTML = html;
  vista.scrollTop = manterRolagem && chave === rotaRenderizada ? rolagem : 0;
  rotaRenderizada = chave;
  marcarNavAtiva();
  renderSelecao();
  if (r.tipo === 'ajustes') aposRenderAjustes();
}

function registrarLista(itens, origem, extra = {}) {
  const k = 'l' + Object.keys(listas).length;
  listas[k] = { itens, origem, ...extra };
  return k;
}

function htmlLista(k, { arrastavel = false, mostrarPasta = false, numerar = true } = {}) {
  const L = listas[k];
  if (!L.itens.length) return '';
  return `<div class="faixas ${arrastavel ? 'com-alca' : ''}" data-lista="${k}">${L.itens.map((it, i) => htmlFaixa(it, i, k, { arrastavel, mostrarPasta, numerar })).join('')}</div>`;
}

function htmlFaixa(it, i, k, { arrastavel, mostrarPasta, numerar }) {
  const info = infoFaixa(it);
  const p = estado.posicoes[it.id];
  const atual = itemAtual()?.id === it.id && (listas[k].tipo !== 'fila' || fila.indice === i);
  const sel = selecao.lista === k && selecao.idx.has(i);
  const d = p?.d || 0;
  const pct = p && d ? limitar(p.p / d, 0, 1) : 0;
  const metaPartes = [];
  if (mostrarPasta && info.pastaNome) metaPartes.push(esc(info.pastaNome));
  if (p?.ok) metaPartes.push('ouvido');
  else if (pct > 0.005) metaPartes.push(`<span class="prog">parou em ${fmtTempo(p.p)}</span>`);
  if (!info.naBiblioteca && bib) metaPartes.push('fora da biblioteca');
  const num = atual ? `<span class="equalizador"><i></i><i></i><i></i></span>` : (numerar ? i + 1 : '');
  return `<div class="faixa ${atual ? 'atual' : ''} ${sel ? 'sel' : ''} ${p?.ok ? 'ouvida' : ''} ${atual && audio.paused ? 'pausado' : ''}" data-i="${i}" data-id="${esc(it.id)}">
    <label class="col-sel" title="Selecionar"><input type="checkbox" data-acao="selecionar" ${sel ? 'checked' : ''} aria-label="Selecionar"></label>
    ${arrastavel ? `<button type="button" class="alca" data-arrastar aria-label="Arrastar para reordenar">${ico('alca')}</button>` : ''}
    <div class="col-num">${num}</div>
    <div class="col-titulo">
      <div class="nome" title="${esc(info.nome)}">${esc(semExt(info.nome))}</div>
      ${metaPartes.length ? `<div class="meta">${metaPartes.join(' · ')}</div>` : ''}
      ${pct > 0.005 && !p.ok ? `<div class="barra-mini"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>` : ''}
    </div>
    <div class="col-estado">${p?.ok ? ico('ok', 'ok') : ''}${emCache(it.id) ? `<span title="${cacheMeta[it.id]?.fixo ? 'Disponível offline' : 'Guardado no aparelho'}">${ico('offline')}</span>` : ''}</div>
    <div class="col-dur">${d ? fmtTempo(d) : ''}</div>
    <button type="button" class="icone-botao col-mais" data-acao="menu-faixa" aria-label="Opções">${ico('opcoes')}</button>
  </div>`;
}

function htmlVazio(icone, titulo, texto, botao = '') {
  return `<div class="vazio">${ico(icone)}<h2>${esc(titulo)}</h2><p>${texto}</p>${botao}</div>`;
}

function emAndamento(limite = Infinity) {
  return Object.entries(estado.posicoes)
    .filter(([, p]) => !p.ok && p.p > 5 && (!p.d || p.p < p.d - 5))
    .sort((a, b) => b[1].u - a[1].u)
    .slice(0, limite)
    .map(([id]) => paraItem(id));
}

function vistaInicio() {
  const raiz = cfg().raiz;
  if (!raiz) {
    return htmlVazio('drive', 'Escolha a pasta dos seus áudios',
      'Indique a pasta do Google Drive onde você guarda os MP3. As subpastas dela viram as categorias do player.',
      `<button type="button" class="botao primario grande" data-acao="escolher-raiz">${ico('pasta')} Escolher pasta</button>`);
  }
  if (!bib || bib.raizId !== raiz.id) {
    return htmlVazio('atualizar', 'Lendo a biblioteca…', 'Estou listando as pastas e os áudios do seu Drive. Na próxima abertura isso aparece na hora.',
      tokenValido() ? '' : `<button type="button" class="botao primario" data-acao="reconectar">Conectar ao Google Drive</button>`);
  }
  const c = contarRec(raiz.id);
  let html = `<div class="cabecalho"><div class="icone-grande">${ico('fila')}</div><div class="textos-cab">
    <h1>${esc(raiz.nome)}</h1>
    <div class="detalhes">${plural(Object.keys(bib.faixas).length, 'áudio', 'áudios')} · ${plural(Object.keys(bib.faixas).filter(id => estado.posicoes[id]?.ok).length, 'ouvido', 'ouvidos')} · biblioteca lida em ${fmtData(bib.at)}</div>
  </div></div>`;
  const andamento = emAndamento(5);
  if (andamento.length) {
    const k = registrarLista(andamento, { tipo: 'andamento', nome: 'Continuar ouvindo' });
    html += `<h2 class="titulo-bloco">Continuar ouvindo <a href="#/andamento">ver tudo</a></h2>${htmlLista(k, { mostrarPasta: true, numerar: false })}`;
  }
  const pls = playlistsOrdenadas();
  html += `<h2 class="titulo-bloco">Playlists <a href="#" data-acao="nova-playlist">+ nova</a></h2>`;
  html += pls.length ? `<div class="grade">${pls.map(cartaoPlaylist).join('')}</div>`
    : `<p style="color:var(--texto-3)">Nenhuma playlist ainda. Use <em>Adicionar à playlist</em> no menu de qualquer áudio ou pasta.</p>`;
  const r = bib.pastas[raiz.id];
  if (r.filhas.length) html += `<h2 class="titulo-bloco">Pastas</h2><div class="grade">${r.filhas.map(cartaoPasta).join('')}</div>`;
  if (r.faixas.length) {
    const k = registrarLista(itensDaPasta(raiz.id), { tipo: 'pasta', id: raiz.id, nome: raiz.nome }, { principal: true });
    html += `<h2 class="titulo-bloco">Áudios soltos em ${esc(raiz.nome)}</h2>${htmlLista(k)}`;
  }
  if (!c.total && !r.filhas.length) html += htmlVazio('pasta', 'Pasta vazia', 'Nenhum áudio encontrado. Coloque arquivos MP3 nesta pasta do Drive e toque em atualizar.', `<button type="button" class="botao" data-acao="atualizar-biblioteca">${ico('atualizar')} Atualizar</button>`);
  return html;
}

function cartaoPasta(id) {
  const p = bib.pastas[id];
  const c = contarRec(id);
  const pct = c.total ? c.ouvidos / c.total : 0;
  return `<a class="cartao" href="#/pasta/${encodeURIComponent(id)}">
    <div class="ic">${ico('pasta')}</div>
    <div class="tx"><div class="t" title="${esc(p.nome)}">${esc(p.nome)}</div>
      <div class="s">${plural(c.total, 'áudio', 'áudios')}${c.ouvidos ? ` · ${Math.round(pct * 100)}% ouvido` : ''}</div>
      ${c.ouvidos ? `<div class="barra-mini"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>` : ''}
    </div></a>`;
}
function cartaoPlaylist(pl) {
  const dur = textoDuracao(pl.faixas.map(f => f.id));
  const ouvidos = pl.faixas.filter(f => estado.posicoes[f.id]?.ok).length;
  return `<a class="cartao" href="#/playlist/${encodeURIComponent(pl.id)}">
    <div class="ic">${ico('playlist')}</div>
    <div class="tx"><div class="t" title="${esc(pl.nome)}">${esc(pl.nome)}</div>
      <div class="s">${plural(pl.faixas.length, 'áudio', 'áudios')}${dur ? ' · ' + dur : ''}${ouvidos ? ` · ${ouvidos} ouvido${ouvidos > 1 ? 's' : ''}` : ''}</div>
    </div></a>`;
}

function vistaPasta(id) {
  if (!bib?.pastas[id]) {
    if (varredura || !bib) return htmlVazio('atualizar', 'Lendo a biblioteca…', 'Aguarde enquanto as pastas do Drive são listadas.');
    return htmlVazio('pasta', 'Pasta não encontrada', 'Ela pode ter sido movida ou a biblioteca ainda está sendo lida.', `<a class="botao" href="#/">Voltar ao início</a>`);
  }
  const p = bib.pastas[id];
  const caminho = caminhoPasta(id);
  const c = contarRec(id);
  let itens = itensDaPasta(id);
  const totalAqui = itens.length;
  if (cfg().ocultarOuvidos) itens = itens.filter(it => !estado.posicoes[it.id]?.ok);
  const dur = textoDuracao(p.faixas);
  const k = registrarLista(itens, { tipo: 'pasta', id, nome: p.nome }, { principal: true });
  const temParcial = itens.some(it => estado.posicoes[it.id]?.p > 5 || estado.posicoes[it.id]?.ok);
  let html = `<div class="migalhas">${caminho.slice(0, -1).map(x => `<a href="#/pasta/${encodeURIComponent(x.id)}">${esc(x.nome)}</a>${ico('direita')}`).join('')}</div>
  <div class="cabecalho"><div class="icone-grande">${ico('pasta')}</div><div class="textos-cab">
    <h1>${esc(p.nome)}</h1>
    <div class="detalhes">${plural(totalAqui, 'áudio', 'áudios')}${p.filhas.length ? ` · ${plural(p.filhas.length, 'subpasta', 'subpastas')} (${plural(c.total, 'áudio', 'áudios')} no total)` : ''}${dur ? ` · ${dur}` : ''} · ${plural(c.ouvidos, 'ouvido', 'ouvidos')}</div>
  </div></div>
  <div class="acoes">
    ${totalAqui ? `<button type="button" class="botao primario" data-acao="tocar-lista" data-lista="${k}">${ico('play')} Tocar</button>` : ''}
    ${temParcial && totalAqui ? `<button type="button" class="botao" data-acao="continuar-lista" data-lista="${k}">${ico('historico')} Continuar</button>` : ''}
    ${p.filhas.length ? `<button type="button" class="botao" data-acao="tocar-pasta-rec" data-id="${esc(id)}">${ico('playlist')} Tocar com subpastas</button>` : ''}
    <button type="button" class="icone-botao" data-acao="menu-pasta" data-id="${esc(id)}" aria-label="Mais opções">${ico('opcoes')}</button>
    <span class="espaco"></span>
    ${totalAqui ? `<label class="alternador"><input type="checkbox" data-config="ocultarOuvidos" ${cfg().ocultarOuvidos ? 'checked' : ''}> Ocultar ouvidos</label>
    <label class="seletor">Ordem <select data-config="ordenacao">
      <option value="nome" ${cfg().ordenacao === 'nome' ? 'selected' : ''}>Nome (A→Z)</option>
      <option value="nome-desc" ${cfg().ordenacao === 'nome-desc' ? 'selected' : ''}>Nome (Z→A)</option>
      <option value="data" ${cfg().ordenacao === 'data' ? 'selected' : ''}>Mais recentes</option>
      <option value="data-asc" ${cfg().ordenacao === 'data-asc' ? 'selected' : ''}>Mais antigos</option>
    </select></label>` : ''}
  </div>`;
  if (p.filhas.length) {
    html += `<div class="subpastas">${p.filhas.map(f => {
      const cf = contarRec(f);
      return `<a class="chip" href="#/pasta/${encodeURIComponent(f)}">${ico('pasta')}<span>${esc(bib.pastas[f].nome)}</span><small>${cf.ouvidos ? `${cf.ouvidos}/` : ''}${cf.total}</small></a>`;
    }).join('')}</div>`;
  }
  if (itens.length) html += htmlLista(k);
  else if (totalAqui) html += `<p style="color:var(--texto-3)">Todos os áudios desta pasta já foram ouvidos.</p>`;
  else if (!p.filhas.length) html += htmlVazio('pasta', 'Nenhum áudio aqui', 'Coloque arquivos MP3 nesta pasta do Drive e atualize a biblioteca.', `<button type="button" class="botao" data-acao="atualizar-biblioteca">${ico('atualizar')} Atualizar</button>`);
  return html;
}

function vistaPlaylist(id) {
  const pl = estado.playlists[id];
  if (!pl) return htmlVazio('playlist', 'Playlist não encontrada', 'Ela pode ter sido excluída em outro aparelho.', `<a class="botao" href="#/">Voltar ao início</a>`);
  const itens = pl.faixas.map(f => ({ id: f.id, n: f.n, s: f.s }));
  const k = registrarLista(itens, { tipo: 'playlist', id, nome: pl.nome }, { principal: true, tipo: 'playlist', id });
  const dur = textoDuracao(pl.faixas.map(f => f.id));
  const ouvidos = pl.faixas.filter(f => estado.posicoes[f.id]?.ok).length;
  const offline = pl.faixas.filter(f => cacheMeta[f.id]?.fixo).length;
  let html = `<div class="migalhas"><a href="#/">Início</a>${ico('direita')}<span>Playlist</span></div>
  <div class="cabecalho"><div class="icone-grande">${ico('playlist')}</div><div class="textos-cab">
    <h1><span class="editavel" data-acao="renomear-playlist" data-id="${esc(id)}" title="Clique para renomear">${esc(pl.nome)}</span></h1>
    <div class="detalhes">${plural(itens.length, 'áudio', 'áudios')}${dur ? ` · ${dur}` : ''} · ${plural(ouvidos, 'ouvido', 'ouvidos')}${offline ? ` · ${offline} offline` : ''}</div>
  </div></div>
  <div class="acoes">
    ${itens.length ? `<button type="button" class="botao primario" data-acao="tocar-lista" data-lista="${k}">${ico('play')} Tocar</button>
    <button type="button" class="botao" data-acao="continuar-lista" data-lista="${k}">${ico('historico')} Continuar</button>
    <button type="button" class="botao" data-acao="aleatorio-lista" data-lista="${k}">${ico('aleatorio')} Aleatório</button>` : ''}
    <button type="button" class="icone-botao" data-acao="menu-playlist" data-id="${esc(id)}" aria-label="Mais opções">${ico('opcoes')}</button>
  </div>`;
  if (itens.length) html += `<p style="color:var(--texto-3);font-size:13px;margin:-6px 0 12px">Arraste pela alça ${ico('alca', 'ico-inline')} para mudar a ordem.</p>` + htmlLista(k, { arrastavel: true, mostrarPasta: true });
  else html += htmlVazio('playlist', 'Playlist vazia', 'Abra uma pasta, toque no menu ⋮ de um áudio (ou selecione vários) e escolha “Adicionar à playlist”.', `<a class="botao" href="#/">Ir à biblioteca</a>`);
  return html;
}

function vistaFila() {
  const k = registrarLista(fila.itens, fila.origem, { principal: true, tipo: 'fila' });
  const restantes = fila.indice >= 0 ? fila.itens.length - fila.indice - 1 : fila.itens.length;
  let html = `<div class="cabecalho"><div class="icone-grande">${ico('fila')}</div><div class="textos-cab">
    <h1>Fila de reprodução</h1>
    <div class="detalhes">${fila.itens.length ? `${plural(fila.itens.length, 'áudio', 'áudios')} · ${plural(Math.max(0, restantes), 'restante', 'restantes')}${fila.origem?.nome ? ` · origem: ${esc(fila.origem.nome)}` : ''}${cfg().aleatorio ? ' · ordem aleatória' : ''}` : 'vazia'}</div>
  </div></div>`;
  if (!fila.itens.length) return html + htmlVazio('fila', 'Nada na fila', 'Toque num áudio, numa pasta ou numa playlist para começar. Use “Tocar em seguida” para encaixar áudios na ordem que quiser.');
  html += `<div class="acoes">
    <button type="button" class="botao" data-acao="salvar-fila">${ico('playlist')} Salvar como playlist</button>
    <button type="button" class="botao perigo" data-acao="limpar-fila">${ico('lixo')} Limpar fila</button>
  </div>` + htmlLista(k, { arrastavel: true, mostrarPasta: true });
  return html;
}

function vistaAndamento() {
  const itens = emAndamento();
  const k = registrarLista(itens, { tipo: 'andamento', nome: 'Continuar ouvindo' }, { principal: true });
  let html = `<div class="cabecalho"><div class="icone-grande">${ico('historico')}</div><div class="textos-cab">
    <h1>Continuar ouvindo</h1><div class="detalhes">Áudios começados e não terminados, do mais recente ao mais antigo.</div></div></div>`;
  if (!itens.length) return html + htmlVazio('historico', 'Nada em andamento', 'Os áudios que você começar a ouvir e não terminar aparecem aqui, com o ponto onde pararam.');
  return html + htmlLista(k, { mostrarPasta: true, numerar: false });
}

function vistaBusca(q) {
  const termos = normalizar(q).split(/\s+/).filter(Boolean);
  let html = `<div class="cabecalho"><div class="icone-grande">${ico('busca')}</div><div class="textos-cab"><h1>Busca</h1><div class="detalhes">“${esc(q)}”</div></div></div>`;
  if (!bib || !termos.length) return html + '<p style="color:var(--texto-3)">Digite algo para buscar.</p>';
  const casa = texto => { const n = normalizar(texto); return termos.every(t => n.includes(t)); };
  const pastas = Object.values(bib.pastas).filter(p => p.pai && casa(p.nome)).slice(0, 40);
  const faixas = Object.values(bib.faixas).filter(f => casa(f.nome + ' ' + (bib.pastas[f.pasta]?.nome || ''))).sort((a, b) => comparar(a.nome, b.nome)).slice(0, 400);
  if (pastas.length) html += `<h2 class="titulo-bloco">Pastas</h2><div class="subpastas">${pastas.map(p => `<a class="chip" href="#/pasta/${encodeURIComponent(p.id)}">${ico('pasta')}<span>${esc(p.nome)}</span><small>${contarRec(p.id).total}</small></a>`).join('')}</div>`;
  const itens = faixas.map(f => paraItem(f.id));
  const k = registrarLista(itens, { tipo: 'busca', nome: `Busca: ${q}` }, { principal: true });
  if (itens.length) html += `<h2 class="titulo-bloco">Áudios <span style="font-size:14px;color:var(--texto-3);font-family:var(--fonte)">${itens.length}${itens.length === 400 ? '+' : ''}</span></h2>
    <div class="acoes"><button type="button" class="botao primario" data-acao="tocar-lista" data-lista="${k}">${ico('play')} Tocar resultados</button></div>${htmlLista(k, { mostrarPasta: true })}`;
  if (!itens.length && !pastas.length) html += htmlVazio('busca', 'Nada encontrado', 'Nenhum áudio ou pasta corresponde à busca.');
  return html;
}

function vistaAjustes() {
  const c = cfg();
  const sel = (chave, opcoes) => `<select data-config="${chave}" data-tipo="num">${opcoes.map(([v, r]) => `<option value="${v}" ${Number(c[chave]) === v ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
  const interruptor = (chave, ligado = c[chave]) => `<label class="interruptor"><input type="checkbox" data-config="${chave}" ${ligado ? 'checked' : ''}><span></span></label>`;
  const u = usoCache();
  return `<div class="ajustes">
  <div class="cabecalho"><div class="icone-grande">${ico('ajustes')}</div><div class="textos-cab"><h1>Ajustes</h1><div class="detalhes">Auris ${VERSAO}</div></div></div>

  <div class="grupo"><h3>Conta e biblioteca</h3>
    <div class="opcao"><div class="rot"><b>${esc(auth.usuario?.nome || 'Conta Google')}</b><small>${esc(auth.usuario?.email || (tokenValido() ? '' : 'desconectada'))}</small></div>
      ${tokenValido() ? `<button type="button" class="botao" data-acao="sair">${ico('sair')} Sair</button>` : `<button type="button" class="botao primario" data-acao="reconectar">Conectar</button>`}</div>
    <div class="opcao"><div class="rot"><b>Pasta da biblioteca</b><small>${c.raiz ? esc(c.raiz.nome) : 'nenhuma escolhida'}${bib?.at ? ` · lida em ${fmtData(bib.at)}` : ''}</small></div>
      <button type="button" class="botao" data-acao="escolher-raiz">Trocar</button>
      <button type="button" class="icone-botao" data-acao="atualizar-biblioteca" title="Atualizar biblioteca">${ico('atualizar')}</button></div>
  </div>

  <div class="grupo"><h3>Reprodução</h3>
    <div class="opcao"><div class="rot"><b>Velocidade</b><small>Vale para todos os áudios. Atalhos: [ e ] no teclado.</small></div>
      <button type="button" class="botao-vel" data-acao="menu-velocidade" data-ref="bt-vel">${fmtVel(c.velocidade)}</button></div>
    <div class="opcao"><div class="rot"><b>Manter o tom da voz</b><small>Evita a voz “de desenho animado” em velocidades altas.</small></div>${interruptor('preservarTom')}</div>
    <div class="opcao"><div class="rot"><b>Botão voltar</b></div>${sel('saltoVoltar', [[5, '5 segundos'], [10, '10 segundos'], [15, '15 segundos'], [30, '30 segundos']])}</div>
    <div class="opcao"><div class="rot"><b>Botão avançar</b></div>${sel('saltoAvancar', [[10, '10 segundos'], [15, '15 segundos'], [30, '30 segundos'], [60, '60 segundos']])}</div>
    <div class="opcao"><div class="rot"><b>Retomar de onde parou</b><small>Cada áudio guarda a posição e volta a ela ao ser tocado de novo.</small></div>${interruptor('retomar')}</div>
    <div class="opcao"><div class="rot"><b>Recuo ao retomar</b><small>Volta alguns segundos para recuperar o contexto.</small></div>${sel('recuoRetomar', [[0, 'Nenhum'], [3, '3 segundos'], [5, '5 segundos'], [10, '10 segundos'], [30, '30 segundos']])}</div>
    <div class="opcao"><div class="rot"><b>Seguir para o próximo áudio</b><small>Desligado, o player para ao fim de cada áudio.</small></div>${interruptor('avancoAuto')}</div>
  </div>

  <div class="grupo"><h3>Offline e armazenamento</h3>
    <div class="opcao"><div class="rot"><b>Guardar automaticamente os áudios tocados</b><small>Os mais antigos saem quando o limite é atingido. Áudios marcados como “disponível offline” não contam no limite.</small></div>
      ${sel('cacheMB', [[0, 'Não guardar'], [256, 'Até 256 MB'], [512, 'Até 512 MB'], [1024, 'Até 1 GB'], [2048, 'Até 2 GB'], [5120, 'Até 5 GB']])}</div>
    <div class="opcao"><div class="rot"><b>Espaço usado</b><small id="uso-cache">${fmtTamanho(u.auto)} automáticos · ${fmtTamanho(u.fixos)} offline (${plural(u.nFixos, 'áudio', 'áudios')})</small><div class="medidor"><span id="medidor-cache" style="width:0"></span></div></div>
      <button type="button" class="botao" data-acao="limpar-cache">Limpar automáticos</button>
      <button type="button" class="botao perigo" data-acao="limpar-offline">Limpar tudo</button></div>
  </div>

  <div class="grupo"><h3>Sincronização entre aparelhos</h3>
    <div class="opcao"><div class="rot"><b>Sincronizar playlists e progresso</b><small>Guarda tudo num arquivo da pasta oculta do Auris no seu Drive, para continuar do mesmo ponto no celular e no computador.${!auth.appdata ? ' <b style="display:inline;color:var(--perigo)">Permissão da pasta do app não concedida: saia e entre de novo marcando todas as permissões.</b>' : ''}</small></div>${interruptor('sync')}</div>
    <div class="opcao"><div class="rot"><b>Última sincronização</b><small>${sync.ultima ? fmtData(sync.ultima) : 'nunca'}${sync.erro ? ` · erro: ${esc(sync.erro)}` : ''}</small></div>
      <button type="button" class="botao" data-acao="sincronizar">${ico('atualizar')} Sincronizar agora</button></div>
  </div>

  <div class="grupo"><h3>Aparência</h3>
    <div class="opcao"><div class="rot"><b>Tema</b></div><select data-config="tema">
      <option value="auto" ${c.tema === 'auto' ? 'selected' : ''}>Automático</option>
      <option value="claro" ${c.tema === 'claro' ? 'selected' : ''}>Claro</option>
      <option value="escuro" ${c.tema === 'escuro' ? 'selected' : ''}>Escuro</option></select></div>
  </div>

  <div class="grupo"><h3>Cópia de segurança</h3>
    <div class="opcao"><div class="rot"><b>Exportar ou importar</b><small>Arquivo JSON com playlists, progresso e opções.</small></div>
      <button type="button" class="botao" data-acao="exportar">${ico('baixar')} Exportar</button>
      <button type="button" class="botao" data-acao="importar">Importar</button></div>
    <div class="opcao"><div class="rot"><b>Zerar progresso</b><small>Marca todos os áudios como não ouvidos e esquece as posições.</small></div>
      <button type="button" class="botao perigo" data-acao="zerar-progresso">Zerar</button></div>
  </div>

  <div class="grupo"><h3>Avançado</h3>
    <div class="opcao"><div class="rot"><b>ID de cliente OAuth</b><small style="word-break:break-all">${esc(auth.clientId || '—')}${window.AURIS_CONFIG?.clientId ? ' (definido no config.js)' : ''}</small></div>
      <button type="button" class="botao" data-acao="trocar-client-id">Alterar</button></div>
  </div>

  <div class="grupo"><h3>Atalhos de teclado</h3>
    <div class="atalhos">
      <kbd>espaço</kbd><span>tocar / pausar</span>
      <kbd>←</kbd> <span>voltar ${c.saltoVoltar} s</span>
      <kbd>→</kbd> <span>avançar ${c.saltoAvancar} s</span>
      <kbd>Shift + ←/→</kbd><span>áudio anterior / próximo</span>
      <kbd>[ ]</kbd><span>diminuir / aumentar a velocidade em 0,1×</span>
      <kbd>0</kbd><span>velocidade normal (1,0×)</span>
      <kbd>S</kbd><span>ordem aleatória</span>
      <kbd>R</kbd><span>modo de repetição</span>
      <kbd>/</kbd><span>buscar</span>
    </div>
  </div>
  </div>`;
}

async function aposRenderAjustes() {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.quota) {
      const el = $('#medidor-cache');
      if (el) el.style.width = Math.min(100, (est.usage / est.quota) * 100).toFixed(1) + '%';
      const tx = $('#uso-cache');
      if (tx) tx.textContent += ` · aparelho: ${fmtTamanho(est.usage)} de ${fmtTamanho(est.quota)} permitidos ao navegador`;
    }
  } catch { /* opcional */ }
}

/* ---- barra lateral ---- */
function renderLateral() { renderArvore(); renderPlaylistsLateral(); renderNavFila(); renderConta(); marcarNavAtiva(); }

function renderArvore() {
  const el = $('#arvore');
  const raiz = cfg().raiz;
  if (!raiz) { el.innerHTML = `<div class="vazio-lateral"><button type="button" class="link" data-acao="escolher-raiz">Escolher pasta do Drive</button></div>`; return; }
  if (!bib || bib.raizId !== raiz.id || !bib.pastas[raiz.id]) { el.innerHTML = `<div class="vazio-lateral">${esc(raiz.nome)} · lendo…</div>`; return; }
  const no = (id, nivel) => {
    const p = bib.pastas[id];
    const aberta = abertas.has(id) || nivel === 0;
    const temFilhas = p.filhas.length > 0;
    return `<div class="no ${aberta && temFilhas ? 'aberto' : ''}" data-no="${esc(id)}">
        <button type="button" class="seta ${temFilhas && nivel > 0 ? '' : 'vazia'}" data-acao="alternar-no" aria-label="Expandir">${ico('direita')}</button>
        <span class="nome-no" title="${esc(p.nome)}">${esc(p.nome)}</span><span class="n">${contarRec(id).total}</span>
      </div>${temFilhas && aberta ? `<div class="filhos">${p.filhas.map(f => no(f, nivel + 1)).join('')}</div>` : ''}`;
  };
  el.innerHTML = no(raiz.id, 0);
}
function renderPlaylistsLateral() {
  const el = $('#lista-playlists');
  const pls = playlistsOrdenadas();
  el.innerHTML = pls.length
    ? pls.map(p => `<a href="#/playlist/${encodeURIComponent(p.id)}" data-pl="${esc(p.id)}">${ico('playlist')}<span>${esc(p.nome)}</span><small class="contador">${p.faixas.length}</small></a>`).join('')
    : `<div class="vazio-lateral">Nenhuma playlist. <button type="button" class="link" data-acao="nova-playlist">Criar</button></div>`;
  marcarNavAtiva();
}
function renderNavFila() { const n = fila.itens.length; $('#nav-fila-n').textContent = n ? n : ''; }
function renderConta() {
  const b = $('#botao-conta');
  const u = auth.usuario;
  if (u?.foto) b.innerHTML = `<img src="${esc(u.foto)}" alt="" referrerpolicy="no-referrer">`;
  else b.textContent = (u?.nome || u?.email || '?').trim().charAt(0).toUpperCase();
  b.title = u ? `${u.nome} (${u.email})` : 'Conta';
}
function marcarNavAtiva() {
  const r = rotaAtual();
  $$('[data-nav]').forEach(a => a.classList.toggle('ativo', a.dataset.nav === r.tipo));
  $$('#arvore .no').forEach(n => n.classList.toggle('ativo', r.tipo === 'pasta' && n.dataset.no === r.id));
  $$('#lista-playlists a').forEach(a => a.classList.toggle('ativo', r.tipo === 'playlist' && a.dataset.pl === r.id));
}

/* ---- player ---- */
function definirCarregando(sim, progresso = 0) {
  carga.carregando = sim; carga.progresso = progresso;
  document.body.classList.toggle('carregando', sim);
  const sub = sim ? `Baixando do Drive… ${progresso ? Math.round(progresso * 100) + '%' : ''}` : null;
  if (sub) $$('[data-ref="sub"]').forEach(el => { el.textContent = sub; });
  else atualizarPlayerUI();
}

function atualizarPlayerUI() {
  const it = itemAtual();
  const info = it ? infoFaixa(it) : null;
  const tocando = temAudioCarregado() && !audio.paused;
  $$('[data-ref="titulo"]').forEach(el => { el.textContent = info ? semExt(info.nome) : 'Nada tocando'; el.title = info?.nome || ''; });
  if (!carga.carregando) {
    const sub = info ? [info.pastaNome, fila.itens.length > 1 ? `${fila.indice + 1} de ${fila.itens.length}` : ''].filter(Boolean).join(' · ') : 'Escolha um áudio na biblioteca';
    $$('[data-ref="sub"]').forEach(el => { el.textContent = sub; });
  }
  $$('[data-ref="origem"]').forEach(el => { el.textContent = fila.origem?.nome ? `Tocando de ${fila.origem.nome}` : 'Tocando agora'; });
  $$('[data-ref="bt-play"]').forEach(b => {
    b.innerHTML = ico(tocando ? 'pausa' : 'play');
    b.setAttribute('aria-label', tocando ? 'Pausar' : 'Tocar');
  });
  $$('[data-ref="bt-repetir"]').forEach(b => {
    b.innerHTML = ico(cfg().repetir === 'uma' ? 'repetir1' : 'repetir');
    b.classList.toggle('ativo', cfg().repetir !== 'nao');
    b.title = { nao: 'Repetir: desligado', todas: 'Repetir: fila inteira', uma: 'Repetir: este áudio' }[cfg().repetir] + ' (R)';
  });
  $$('[data-ref="bt-aleatorio"]').forEach(b => b.classList.toggle('ativo', !!cfg().aleatorio));
  atualizarControlesVelocidade();
  atualizarRotulosSalto();
  atualizarRotuloSono();
  $$('input[data-acao="volume"]').forEach(v => { v.value = cfg().volume; v.style.setProperty('--pct', (cfg().volume * 100) + '%'); });
  document.title = info ? `${tocando ? '▶ ' : ''}${semExt(info.nome)} — Auris` : 'Auris — áudios de estudo';
  marcarFaixaAtual();
  atualizarPosicaoSistema();
  if (!temAudioCarregado()) atualizarTempoUI();
}

function atualizarControlesVelocidade() {
  const v = Number(cfg().velocidade) || 1;
  $$('[data-ref="bt-vel"]').forEach(b => { b.textContent = fmtVel(v); b.classList.toggle('alterada', Math.abs(v - 1) > 0.001); });
  $$('.pop-vel output').forEach(o => { o.textContent = fmtVel(v); });
  $$('.pop-vel input[type=range]').forEach(r => { r.value = v; r.style.setProperty('--pct', ((v - VEL_MIN) / (VEL_MAX - VEL_MIN) * 100) + '%'); });
  $$('.vel-presets button').forEach(b => b.classList.toggle('ativo', Math.abs(Number(b.dataset.vel) - v) < 0.001));
}
function atualizarRotulosSalto() {
  $$('[data-ref="salto-voltar"]').forEach(el => { el.textContent = cfg().saltoVoltar; });
  $$('[data-ref="salto-avancar"]').forEach(el => { el.textContent = cfg().saltoAvancar; });
}

let arrastandoBusca = false, tempoPendente = false;
function agendarTempoUI() {
  if (tempoPendente) return;
  tempoPendente = true;
  requestAnimationFrame(() => { tempoPendente = false; atualizarTempoUI(); });
}
function atualizarTempoUI() {
  let atual = 0, dur = 0;
  if (temAudioCarregado()) { atual = audio.currentTime; dur = isFinite(audio.duration) ? audio.duration : 0; }
  else if (itemAtual()) { const p = posicao(itemAtual().id); if (p) { atual = p.p; dur = p.d; } }
  const pct = dur ? atual / dur : 0;
  if (!arrastandoBusca) {
    $$('.barra-busca').forEach(r => { r.value = Math.round(pct * 1000); r.style.setProperty('--pct', (pct * 100) + '%'); });
    $$('[data-ref="atual"]').forEach(el => { el.textContent = fmtTempo(atual); });
  }
  const vel = Number(cfg().velocidade) || 1;
  $$('[data-ref="restante"]').forEach(el => {
    el.textContent = dur ? '−' + fmtTempo((dur - atual) / vel) : '0:00';
    el.title = dur ? `Duração: ${fmtTempo(dur)} · restante na velocidade atual` : '';
  });
  $$('[data-ref="progresso-mini"]').forEach(el => { el.style.width = (pct * 100) + '%'; });
  if (temMediaSession && !audio.paused && Math.random() < 0.05) atualizarPosicaoSistema();
}

/** Destaca a linha do áudio atual sem redesenhar a vista inteira. */
function marcarFaixaAtual() {
  const it = itemAtual();
  const pausado = audio.paused || !temAudioCarregado();
  $$('#vista .faixas').forEach(lista => {
    const L = listas[lista.dataset.lista];
    if (!L) return;
    $$('.faixa', lista).forEach(linha => {
      const i = +linha.dataset.i;
      const atual = !!it && linha.dataset.id === it.id && (L.tipo !== 'fila' || i === fila.indice);
      if (linha.classList.contains('atual') !== atual) {
        linha.classList.toggle('atual', atual);
        $('.col-num', linha).innerHTML = atual ? '<span class="equalizador"><i></i><i></i><i></i></span>' : (L.origem?.tipo === 'andamento' ? '' : i + 1);
      }
      linha.classList.toggle('pausado', atual && pausado);
    });
  });
}
/** Atualiza ícones de “ouvido” e “offline” nas linhas visíveis. */
function marcarEstadosNaLista() {
  $$('#vista .faixa').forEach(linha => {
    const id = linha.dataset.id;
    const p = estado.posicoes[id];
    linha.classList.toggle('ouvida', !!p?.ok);
    const est = $('.col-estado', linha);
    if (est) est.innerHTML = `${p?.ok ? ico('ok', 'ok') : ''}${emCache(id) ? `<span title="${cacheMeta[id]?.fixo ? 'Disponível offline' : 'Guardado no aparelho'}">${ico('offline')}</span>` : ''}`;
    const dur = $('.col-dur', linha);
    if (dur && p?.d) dur.textContent = fmtTempo(p.d);
  });
}

/* ---- menus específicos ---- */
function menuVelocidade(ancora) {
  const presets = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  abrirMenu(ancora, [{
    html: `<div class="pop-vel">
      <div class="vel-topo">
        <button type="button" class="icone-botao" data-acao="vel-menos" aria-label="Mais devagar">−</button>
        <output>${fmtVel(cfg().velocidade)}</output>
        <button type="button" class="icone-botao" data-acao="vel-mais" aria-label="Mais rápido">+</button>
      </div>
      <input type="range" min="${VEL_MIN}" max="${VEL_MAX}" step="0.05" value="${cfg().velocidade}" data-acao="vel-slider" aria-label="Velocidade">
      <div class="vel-presets">${presets.map(v => `<button type="button" data-acao="vel-preset" data-vel="${v}">${fmtVel(v)}</button>`).join('')}</div>
      <label><input type="checkbox" data-config="preservarTom" ${cfg().preservarTom ? 'checked' : ''}> Manter o tom da voz</label>
    </div>`,
  }], { aoMontar: () => atualizarControlesVelocidade() });
}

function menuSono(ancora) {
  const ativo = sono.fim || sono.fimFaixa;
  abrirMenu(ancora, [
    { cab: ativo ? (sono.fimFaixa ? 'Para ao fim do áudio' : `Para em ${Math.ceil((sono.fim - agora()) / 60000)} min`) : 'Timer de sono' },
    ...[10, 15, 30, 45, 60, 90].map(m => ({ rotulo: `${m} minutos`, icone: 'sono', acao: () => definirSono(m) })),
    { rotulo: 'Ao fim deste áudio', icone: 'proxima', acao: () => definirSono('faixa') },
    ativo ? '-' : null,
    ativo ? { rotulo: 'Desligar timer', icone: 'fechar', acao: () => { cancelarSono(); toast('Timer de sono desligado.'); } } : null,
  ]);
}

function menuFaixa(k, i, ancora) {
  const L = listas[k];
  if (!L) return;
  const it = L.itens[i];
  const info = infoFaixa(it);
  const p = estado.posicoes[it.id];
  const fixo = cacheMeta[it.id]?.fixo;
  const itens = [
    { cab: semExt(info.nome) },
    { rotulo: 'Tocar agora', icone: 'play', acao: () => tocarLinha(k, i) },
    L.tipo !== 'fila' ? { rotulo: 'Tocar em seguida', icone: 'seguinte', acao: () => inserirNaFila([it], 'seguinte') } : null,
    L.tipo !== 'fila' ? { rotulo: 'Adicionar ao fim da fila', icone: 'fila', acao: () => inserirNaFila([it], 'fim') } : null,
    { rotulo: 'Adicionar à playlist…', icone: 'playlist', acao: () => escolherPlaylist([it]) },
    '-',
    p?.ok ? { rotulo: 'Marcar como não ouvido', icone: 'desmarcar', acao: () => { definirOuvido([it.id], false); memoContagem.clear(); renderVista({ manterRolagem: true }); } }
      : { rotulo: 'Marcar como ouvido', icone: 'ok', acao: () => { definirOuvido([it.id], true); memoContagem.clear(); renderVista({ manterRolagem: true }); } },
    p?.p > 0 ? { rotulo: 'Recomeçar do início', icone: 'recomecar', acao: () => { zerarPosicao(it.id); if (itemAtual()?.id === it.id && temAudioCarregado()) audio.currentTime = 0; renderVista({ manterRolagem: true }); } } : null,
    fixo ? { rotulo: 'Remover do modo offline', icone: 'lixo', acao: () => removerDoOffline([it]) }
      : { rotulo: 'Disponibilizar offline', icone: 'baixar', acao: () => disponibilizarOffline([it]) },
    info.pasta && L.origem?.tipo !== 'pasta' ? { rotulo: 'Ir para a pasta', icone: 'pasta', acao: () => navegar(`#/pasta/${encodeURIComponent(info.pasta)}`) } : null,
  ];
  if (L.tipo === 'playlist') {
    itens.push('-',
      i > 0 ? { rotulo: 'Mover para o topo', icone: 'cima', acao: () => reordenar(k, i, 0) } : null,
      i < L.itens.length - 1 ? { rotulo: 'Mover para o fim', icone: 'desce', acao: () => reordenar(k, i, L.itens.length - 1) } : null,
      { rotulo: 'Remover da playlist', icone: 'lixo', perigo: true, acao: () => removerDaPlaylist(L.id, [i]) });
  }
  if (L.tipo === 'fila') {
    itens.push('-',
      i !== fila.indice && i !== fila.indice + 1 ? { rotulo: 'Tocar em seguida', icone: 'seguinte', acao: () => reordenar(k, i, i < fila.indice ? fila.indice : fila.indice + 1) } : null,
      { rotulo: 'Remover da fila', icone: 'lixo', perigo: true, acao: () => removerDaFila([i]) });
  }
  abrirMenu(ancora, itens);
}

function menuPasta(id, ancora) {
  const p = bib?.pastas[id];
  if (!p) return;
  const aqui = itensDaPasta(id);
  const todas = itensDaPasta(id, true);
  const temSub = p.filhas.length > 0;
  const fixos = todas.filter(it => cacheMeta[it.id]?.fixo).length;
  const origem = { tipo: 'pasta', id, nome: p.nome };
  abrirMenu(ancora, [
    { cab: p.nome },
    aqui.length ? { rotulo: 'Tocar em ordem aleatória', icone: 'aleatorio', acao: () => tocarLista(aqui, Math.floor(Math.random() * aqui.length), origem, { aleatorio: true }) } : null,
    temSub ? { rotulo: 'Tocar com subpastas, aleatório', icone: 'aleatorio', acao: () => tocarLista(todas, Math.floor(Math.random() * todas.length), origem, { aleatorio: true }) } : null,
    { rotulo: temSub ? 'Adicionar tudo (com subpastas) à fila' : 'Adicionar à fila', icone: 'fila', acao: () => inserirNaFila(todas) },
    { rotulo: temSub ? 'Adicionar tudo (com subpastas) à playlist…' : 'Adicionar à playlist…', icone: 'playlist', acao: () => escolherPlaylist(todas) },
    { rotulo: 'Criar playlist com esta pasta', icone: 'mais', acao: () => { const nid = criarPlaylist(p.nome, todas); navegar(`#/playlist/${nid}`); } },
    '-',
    { rotulo: `Disponibilizar offline (${plural(todas.length, 'áudio', 'áudios')})`, icone: 'baixar', acao: async () => {
      const tam = todas.reduce((s, it) => s + (infoFaixa(it).tam || 0), 0);
      if (tam > 300 * 1024 * 1024 && !await confirmar('Baixar para uso offline', `Serão baixados cerca de ${fmtTamanho(tam)}. Prefira uma rede Wi-Fi. Continuar?`, 'Baixar')) return;
      disponibilizarOffline(todas);
    } },
    fixos ? { rotulo: 'Remover do modo offline', icone: 'lixo', acao: () => removerDoOffline(todas) } : null,
    { rotulo: 'Marcar tudo como ouvido', icone: 'ok', acao: () => { definirOuvido(todas.map(x => x.id), true); memoContagem.clear(); renderVista({ manterRolagem: true }); renderArvore(); } },
    { rotulo: 'Marcar tudo como não ouvido', icone: 'desmarcar', acao: () => { definirOuvido(todas.map(x => x.id), false); memoContagem.clear(); renderVista({ manterRolagem: true }); renderArvore(); } },
    '-',
    { rotulo: 'Abrir no Google Drive', icone: 'drive', acao: () => window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(id)}`, '_blank', 'noopener') },
  ]);
}

function menuPlaylist(id, ancora) {
  const pl = estado.playlists[id];
  if (!pl) return;
  const itens = pl.faixas.map(f => ({ id: f.id, n: f.n, s: f.s }));
  const fixos = itens.filter(it => cacheMeta[it.id]?.fixo).length;
  abrirMenu(ancora, [
    { cab: pl.nome },
    itens.length ? { rotulo: 'Adicionar à fila', icone: 'fila', acao: () => inserirNaFila(itens) } : null,
    itens.length ? { rotulo: 'Tocar em seguida', icone: 'seguinte', acao: () => inserirNaFila(itens, 'seguinte') } : null,
    { rotulo: 'Renomear', icone: 'editar', acao: () => renomearPlaylist(id) },
    { rotulo: 'Duplicar', icone: 'mais', acao: () => duplicarPlaylist(id) },
    itens.length ? { rotulo: 'Ordenar por nome', icone: 'playlist', acao: () => { pl.faixas.sort((a, b) => comparar(infoFaixa(a).nome, infoFaixa(b).nome)); marcarPlaylistAlterada(id); renderVista({ manterRolagem: true }); } } : null,
    itens.length ? '-' : null,
    itens.length ? { rotulo: 'Disponibilizar offline', icone: 'baixar', acao: () => disponibilizarOffline(itens) } : null,
    fixos ? { rotulo: 'Remover do modo offline', icone: 'lixo', acao: () => removerDoOffline(itens) } : null,
    itens.length ? { rotulo: 'Marcar tudo como não ouvido', icone: 'desmarcar', acao: () => { definirOuvido(itens.map(x => x.id), false); renderVista({ manterRolagem: true }); } } : null,
    '-',
    { rotulo: 'Excluir playlist', icone: 'lixo', perigo: true, acao: () => excluirPlaylist(id) },
  ]);
}

function menuConta(ancora) {
  const u = auth.usuario;
  abrirMenu(ancora, [
    { cab: u ? (u.email || u.nome) : 'Conta Google' },
    tokenValido() ? null : { rotulo: 'Conectar ao Google Drive', icone: 'drive', acao: () => reconectar() },
    cfg().sync && auth.appdata ? { rotulo: 'Sincronizar agora', icone: 'atualizar', acao: () => sincronizarComAviso() } : null,
    { rotulo: 'Atualizar biblioteca', icone: 'atualizar', acao: () => varrerBiblioteca() },
    { rotulo: 'Ajustes', icone: 'ajustes', acao: () => navegar('#/ajustes') },
    tokenValido() ? '-' : null,
    tokenValido() ? { rotulo: 'Sair', icone: 'sair', acao: () => sair() } : null,
  ]);
}

/* ---- ações sobre listas ---- */
function tocarLinha(k, i) {
  const L = listas[k];
  if (!L) return;
  if (L.tipo === 'fila') {
    if (i === fila.indice && temAudioCarregado()) return alternarPlay();
    return tocarIndice(i);
  }
  const it = L.itens[i];
  if (itemAtual()?.id === it.id && temAudioCarregado()) return alternarPlay();
  tocarLista(L.itens, i, L.origem);
}

function reordenar(k, de, para) {
  if (de === para) return;
  const L = listas[k];
  if (L.tipo === 'playlist') {
    const pl = estado.playlists[L.id];
    const [x] = pl.faixas.splice(de, 1);
    pl.faixas.splice(para, 0, x);
    marcarPlaylistAlterada(L.id);
  } else if (L.tipo === 'fila') {
    moverNaFila(de, para);
  }
  renderVista({ manterRolagem: true });
}

function removerDaPlaylist(id, indices) {
  const pl = estado.playlists[id];
  if (!pl) return;
  const set = new Set(indices);
  const removidas = pl.faixas.filter((_, i) => set.has(i));
  pl.faixas = pl.faixas.filter((_, i) => !set.has(i));
  marcarPlaylistAlterada(id);
  limparSelecao(false);
  renderVista({ manterRolagem: true });
  toast(`${plural(removidas.length, 'áudio removido', 'áudios removidos')} da playlist.`, {
    acao: { rotulo: 'Desfazer', fn: () => { const p = estado.playlists[id]; if (!p) return; indices.slice().sort((a, b) => a - b).forEach((i, n) => p.faixas.splice(i, 0, removidas[n])); marcarPlaylistAlterada(id); renderVista({ manterRolagem: true }); } },
  });
}

/* ---- seleção múltipla ---- */
function alternarSelecao(k, i, marcar) {
  if (selecao.lista !== k) selecao = { lista: k, idx: new Set() };
  if (marcar) selecao.idx.add(i); else selecao.idx.delete(i);
  if (!selecao.idx.size) selecao.lista = null;
  $$(`#vista .faixas`).forEach(lista => {
    $$('.faixa', lista).forEach(l => {
      const sel = lista.dataset.lista === selecao.lista && selecao.idx.has(+l.dataset.i);
      l.classList.toggle('sel', sel);
      const cb = $('input[data-acao="selecionar"]', l); if (cb) cb.checked = sel;
    });
  });
  renderSelecao();
}
function limparSelecao(redesenhar = true) {
  selecao = { lista: null, idx: new Set() };
  if (redesenhar) { $$('#vista .faixa.sel').forEach(l => { l.classList.remove('sel'); const cb = $('input[data-acao="selecionar"]', l); if (cb) cb.checked = false; }); }
  renderSelecao();
}
function itensSelecionados() {
  const L = listas[selecao.lista];
  if (!L) return [];
  return [...selecao.idx].sort((a, b) => a - b).map(i => L.itens[i]).filter(Boolean);
}
function renderSelecao() {
  const el = $('#barra-selecao');
  const n = selecao.idx.size;
  if (!n || !listas[selecao.lista]) { el.hidden = true; return; }
  const L = listas[selecao.lista];
  el.innerHTML = `<strong>${plural(n, 'selecionado', 'selecionados')}</strong>
    <button type="button" class="botao" data-acao="sel-tocar">${ico('play')} Tocar</button>
    <button type="button" class="botao" data-acao="sel-fila">${ico('fila')} Fila</button>
    <button type="button" class="botao" data-acao="sel-playlist">${ico('playlist')} Playlist</button>
    <button type="button" class="botao" data-acao="sel-ouvido">${ico('ok')} Ouvido</button>
    <button type="button" class="botao" data-acao="sel-offline">${ico('baixar')} Offline</button>
    ${L.tipo === 'playlist' || L.tipo === 'fila' ? `<button type="button" class="botao" data-acao="sel-remover">${ico('lixo')} Remover</button>` : ''}
    <button type="button" class="botao" data-acao="sel-todos">Todos</button>
    <button type="button" class="icone-botao" data-acao="sel-limpar" aria-label="Limpar seleção" style="color:inherit">${ico('fechar')}</button>`;
  el.hidden = false;
}

/* ---- arrastar para reordenar (mouse e toque) ---- */
function iniciarArraste(e, alca) {
  const linha = alca.closest('.faixa');
  const cont = linha.parentElement;
  const k = cont.dataset.lista;
  const linhas = $$('.faixa', cont);
  const de = linhas.indexOf(linha);
  const caixas = linhas.map(l => l.getBoundingClientRect());
  const h = caixas[de].height;
  const rolador = $('#vista');
  const r0 = rolador.scrollTop, y0 = e.clientY;
  let ultimoY = y0, para = de, ativo = true;
  cont.classList.add('reordenando');
  linha.classList.add('arrastando');
  try { alca.setPointerCapture(e.pointerId); } catch { /* nada */ }

  const atualizar = () => {
    const dy = ultimoY - y0 + (rolador.scrollTop - r0);
    linha.style.transform = `translateY(${dy}px)`;
    const centro = caixas[de].top + h / 2 + dy;
    para = de;
    for (let j = 0; j < linhas.length; j++) {
      if (j === de) continue;
      const c = caixas[j].top + caixas[j].height / 2;
      if (j < de && centro < c) para = Math.min(para, j);
      if (j > de && centro > c) para = Math.max(para, j);
    }
    linhas.forEach((l, j) => {
      if (j === de) return;
      let t = 0;
      if (de < para && j > de && j <= para) t = -h;
      if (para < de && j >= para && j < de) t = h;
      l.style.transform = t ? `translateY(${t}px)` : '';
    });
  };
  const laco = () => {
    if (!ativo) return;
    const rv = rolador.getBoundingClientRect();
    if (ultimoY < rv.top + 50) { rolador.scrollTop -= 10; atualizar(); }
    else if (ultimoY > rv.bottom - 50) { rolador.scrollTop += 10; atualizar(); }
    requestAnimationFrame(laco);
  };
  requestAnimationFrame(laco);
  const mover = ev => { ultimoY = ev.clientY; atualizar(); };
  const soltar = () => {
    ativo = false;
    alca.removeEventListener('pointermove', mover);
    alca.removeEventListener('pointerup', soltar);
    alca.removeEventListener('pointercancel', soltar);
    linhas.forEach(l => { l.style.transform = ''; });
    cont.classList.remove('reordenando');
    linha.classList.remove('arrastando');
    if (para !== de) reordenar(k, de, para);
  };
  alca.addEventListener('pointermove', mover);
  alca.addEventListener('pointerup', soltar);
  alca.addEventListener('pointercancel', soltar);
}

/* ---- ações gerais ---- */
async function reconectar() {
  try {
    await pedirToken('');
    ocultarAviso();
    if (!auth.usuario) await carregarUsuario();
    aposLogin();
  } catch (e) { toast(e.message, { ms: 8000 }); }
}
async function sincronizarComAviso() {
  if (!cfg().sync) return toast('A sincronização está desligada nos Ajustes.');
  if (!auth.appdata) return toast('Falta a permissão da pasta do app. Saia e entre de novo marcando todas as permissões.', { ms: 7000 });
  if (!tokenValido()) { try { await garantirToken(); } catch { return; } }
  const t = toast('Sincronizando…', { ms: 0 });
  const ok = await sincronizar();
  t.fechar();
  toast(ok ? 'Sincronizado.' : `Falha ao sincronizar${sync.erro ? ': ' + sync.erro : '.'}`);
  if (rotaAtual().tipo === 'ajustes') renderVista({ manterRolagem: true });
}
function exportarBackup() {
  const dados = { ...dadosSync(), configLocal: { cacheMB: cfg().cacheMB, tema: cfg().tema } };
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `auris-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function importarBackup() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files?.[0]; if (!f) return;
    try {
      const dados = JSON.parse(await f.text());
      if (dados.app !== 'auris') throw new Error('o arquivo não é um backup do Auris');
      const substituir = await confirmar('Importar backup', 'Quer que o backup prevaleça sobre o que está neste aparelho? Escolha Cancelar para só acrescentar o que for mais recente.', 'Prevalecer o backup');
      mesclar(dados, { forcar: !!substituir });
      if (substituir) { for (const id of Object.keys(dados.playlists || {})) delete estado.removidas[id]; estado.config.u = agora(); for (const p of Object.values(estado.playlists)) p.u = agora(); }
      salvarEstado(); memoContagem.clear();
      renderLateral(); renderVista(); atualizarPlayerUI();
      toast('Backup importado.');
    } catch (e) { toast('Não foi possível importar: ' + e.message, { ms: 7000 }); }
  };
  inp.click();
}
async function zerarProgresso() {
  if (!await confirmar('Zerar progresso', 'Todos os áudios voltarão a “não ouvidos” e as posições salvas serão esquecidas, inclusive nos outros aparelhos sincronizados.', 'Zerar', true)) return;
  const t = agora();
  for (const [id, p] of Object.entries(estado.posicoes)) estado.posicoes[id] = { p: 0, d: p.d || 0, u: t, ok: false, n: p.n || '' };
  salvarEstado(); memoContagem.clear();
  renderLateral(); renderVista();
  toast('Progresso zerado.');
}
async function limparCacheAutomatico(tudo) {
  if (tudo && !await confirmar('Limpar armazenamento', 'Apagar do aparelho todos os áudios guardados, inclusive os marcados como offline? Eles continuam no Drive.', 'Apagar', true)) return;
  const ids = Object.entries(cacheMeta).filter(([id, m]) => (tudo || !m.fixo) && id !== carga.id).map(([id]) => id);
  await removerCache(ids);
  toast(`${plural(ids.length, 'áudio apagado', 'áudios apagados')} do aparelho.`);
  renderVista({ manterRolagem: true });
}
function aplicarTema() {
  const t = cfg().tema;
  if (t === 'auto') document.documentElement.removeAttribute('data-tema');
  else document.documentElement.setAttribute('data-tema', t);
  const escuro = t === 'escuro' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]').setAttribute('content', escuro ? '#16181d' : '#f5f3ee');
}

/* =====================================================================
 * 12. EVENTOS E INICIALIZAÇÃO
 * ===================================================================== */
function abrirTocando() { $('#tocando').hidden = false; atualizarPlayerUI(); atualizarTempoUI(); }
function fecharTocando() { $('#tocando').hidden = true; }

const ACOES = {
  'entrar': () => entrar(),
  'reconectar': () => reconectar(),
  'sair': () => sair(),
  'trocar-client-id': () => { mostrarTela('config'); },
  'copiar-origem': () => { navigator.clipboard?.writeText(location.origin).then(() => toast('Endereço copiado.'), () => toast(location.origin)); },
  'abrir-lateral': () => $('#app').classList.add('lateral-aberta'),
  'fechar-lateral': () => $('#app').classList.remove('lateral-aberta'),
  'escolher-raiz': () => escolherPastaRaiz(),
  'atualizar-biblioteca': () => { if (!tokenValido()) return reconectar(); varrerBiblioteca(); },
  'nova-playlist': () => novaPlaylist(),
  'menu-conta': el => menuConta(el),
  'play': () => alternarPlay(),
  'anterior': () => anterior(),
  'proxima': () => proxima(),
  'voltar': () => saltar(-cfg().saltoVoltar),
  'avancar': () => saltar(cfg().saltoAvancar),
  'alternar-repetir': () => alternarRepetir(),
  'alternar-aleatorio': () => alternarAleatorio(),
  'menu-velocidade': el => menuVelocidade(el),
  'menu-sono': el => menuSono(el),
  'vel-menos': () => definirVelocidade(cfg().velocidade - 0.05),
  'vel-mais': () => definirVelocidade(cfg().velocidade + 0.05),
  'vel-preset': el => definirVelocidade(Number(el.dataset.vel)),
  'abrir-tocando': () => abrirTocando(),
  'fechar-tocando': () => fecharTocando(),
  'ir-fila': () => { fecharTocando(); navegar('#/fila'); },
  'menu-faixa-atual': el => {
    const it = itemAtual(); if (!it) return;
    const k = registrarLista(fila.itens, fila.origem, { tipo: 'fila' });
    menuFaixa(k, fila.indice, el);
  },
  'menu-faixa': el => { const linha = el.closest('.faixa'); menuFaixa(linha.parentElement.dataset.lista, +linha.dataset.i, el); },
  'menu-pasta': el => menuPasta(el.dataset.id, el),
  'menu-playlist': el => menuPlaylist(el.dataset.id, el),
  'renomear-playlist': el => renomearPlaylist(el.dataset.id),
  'tocar-lista': el => { const L = listas[el.dataset.lista]; if (L) tocarLista(L.itens, 0, L.origem); },
  'continuar-lista': el => { const L = listas[el.dataset.lista]; if (L) tocarLista(L.itens, indiceContinuar(L.itens), L.origem, { aleatorio: false }); },
  'aleatorio-lista': el => { const L = listas[el.dataset.lista]; if (L) tocarLista(L.itens, Math.floor(Math.random() * L.itens.length), L.origem, { aleatorio: true }); },
  'tocar-pasta-rec': el => { const p = bib.pastas[el.dataset.id]; tocarLista(itensDaPasta(el.dataset.id, true), 0, { tipo: 'pasta', id: p.id, nome: `${p.nome} (com subpastas)` }); },
  'alternar-no': el => {
    const id = el.closest('[data-no]').dataset.no;
    if (abertas.has(id)) abertas.delete(id); else abertas.add(id);
    gravar('abertas', [...abertas]);
    renderArvore(); marcarNavAtiva();
  },
  'salvar-fila': async () => { if (fila.itens.length) await novaPlaylist(fila.itens); },
  'limpar-fila': async () => { if (await confirmar('Limpar fila', 'Remover todos os áudios da fila de reprodução?', 'Limpar', true)) limparFila(); },
  'sel-tocar': () => { const its = itensSelecionados(); limparSelecao(); tocarLista(its, 0, { tipo: 'selecao', nome: 'Seleção' }); },
  'sel-fila': () => { const its = itensSelecionados(); limparSelecao(); inserirNaFila(its); },
  'sel-playlist': () => { const its = itensSelecionados(); limparSelecao(); escolherPlaylist(its); },
  'sel-ouvido': () => {
    const its = itensSelecionados();
    const todosOuvidos = its.every(it => estado.posicoes[it.id]?.ok);
    definirOuvido(its.map(x => x.id), !todosOuvidos); memoContagem.clear();
    limparSelecao(); renderVista({ manterRolagem: true }); renderArvore();
  },
  'sel-offline': () => { const its = itensSelecionados(); limparSelecao(); disponibilizarOffline(its); },
  'sel-remover': () => {
    const L = listas[selecao.lista]; const idx = [...selecao.idx];
    limparSelecao(false);
    if (L.tipo === 'playlist') removerDaPlaylist(L.id, idx);
    else if (L.tipo === 'fila') removerDaFila(idx);
  },
  'sel-todos': () => { const L = listas[selecao.lista]; if (!L) return; L.itens.forEach((_, i) => selecao.idx.add(i)); alternarSelecao(selecao.lista, 0, true); },
  'sel-limpar': () => limparSelecao(),
  'sincronizar': () => sincronizarComAviso(),
  'exportar': () => exportarBackup(),
  'importar': () => importarBackup(),
  'zerar-progresso': () => zerarProgresso(),
  'limpar-cache': () => limparCacheAutomatico(false),
  'limpar-offline': () => limparCacheAutomatico(true),
};

document.addEventListener('click', e => {
  const alvo = e.target.closest('[data-acao]');
  // clique numa linha de áudio (fora dos controles) toca o áudio
  if (!alvo || alvo.dataset.acao === 'selecionar') {
    const linha = e.target.closest('#vista .faixa');
    if (linha && !e.target.closest('.col-sel, .alca, .col-mais') && !alvo) {
      tocarLinha(linha.parentElement.dataset.lista, +linha.dataset.i);
      return;
    }
    if (!alvo) {
      const no = e.target.closest('#arvore .no');
      if (no) { navegar(`#/pasta/${encodeURIComponent(no.dataset.no)}`); $('#app').classList.remove('lateral-aberta'); }
      return;
    }
  }
  const acao = alvo.dataset.acao;
  if (acao === 'selecionar' || acao === 'volume' || acao === 'vel-slider') return;
  const fn = ACOES[acao];
  if (!fn) return;
  if (alvo.tagName === 'A') e.preventDefault();
  fn(alvo, e);
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.acao === 'selecionar') {
    const linha = el.closest('.faixa');
    alternarSelecao(linha.parentElement.dataset.lista, +linha.dataset.i, el.checked);
    return;
  }
  if (el.classList.contains('barra-busca')) {
    arrastandoBusca = false;
    if (temAudioCarregado() && isFinite(audio.duration)) { audio.currentTime = (Number(el.value) / 1000) * audio.duration; salvarPosicaoAgora(); }
    else if (itemAtual()) { const p = posicao(itemAtual().id); if (p?.d) { registrarPosicao(itemAtual().id, (Number(el.value) / 1000) * p.d, p.d); } }
    atualizarTempoUI();
    return;
  }
  const chave = el.dataset.config;
  if (!chave) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (el.dataset.tipo === 'num') v = Number(v);
  mudarConfig(chave, v);
  if (chave === 'tema') aplicarTema();
  if (chave === 'preservarTom') aplicarVelocidadeNoAudio();
  if (chave === 'saltoVoltar' || chave === 'saltoAvancar') { atualizarRotulosSalto(); renderVista({ manterRolagem: true }); }
  if (chave === 'cacheMB') podarCache();
  if (chave === 'sync' && v) agendarSync(1000);
  if (chave === 'ordenacao' || chave === 'ocultarOuvidos') renderVista({ manterRolagem: true });
});

document.addEventListener('input', e => {
  const el = e.target;
  if (el.classList.contains('barra-busca')) {
    arrastandoBusca = true;
    const pct = Number(el.value) / 1000;
    el.style.setProperty('--pct', (pct * 100) + '%');
    const dur = temAudioCarregado() ? audio.duration : (itemAtual() ? posicao(itemAtual().id)?.d : 0);
    if (dur) $$('[data-ref="atual"]').forEach(s => { s.textContent = fmtTempo(pct * dur); });
    return;
  }
  if (el.dataset.acao === 'vel-slider') { definirVelocidade(Number(el.value)); return; }
  if (el.dataset.acao === 'volume') {
    cfg().volume = Number(el.value); gravar('estado', estado);
    audio.volume = cfg().volume;
    el.style.setProperty('--pct', (cfg().volume * 100) + '%');
  }
});

document.addEventListener('pointerdown', e => {
  const alca = e.target.closest('[data-arrastar]');
  if (alca) { e.preventDefault(); iniciarArraste(e, alca); }
  destravarAudio();
}, true);

// renova a sessão do Google aproveitando um clique, pouco antes de ela expirar
document.addEventListener('click', () => {
  if (auth.token && auth.exp - agora() < 5 * 60_000 && !auth.pendente && navigator.onLine && !$('#app').hidden) {
    pedirToken('').then(() => ocultarAviso()).catch(() => {});
  }
}, true);

$('#menu-veu').addEventListener('click', fecharMenu);
window.addEventListener('resize', () => fecharMenu());
$('#vista').addEventListener('scroll', () => { if (menuAberto && !$('#menu').classList.contains('folha')) fecharMenu(); }, { passive: true });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (menuAberto) { fecharMenu(); return; }
    if (!$('#tocando').hidden) { fecharTocando(); return; }
    if (selecao.idx.size) { limparSelecao(); return; }
    $('#app').classList.remove('lateral-aberta');
    return;
  }
  const t = e.target;
  if (t.closest('input, textarea, select, [contenteditable], dialog') && !(t.type === 'range' && (e.key === ' ' || e.key === 'k'))) return;
  if (e.metaKey || e.ctrlKey || e.altKey || $('#app').hidden) return;
  const k = e.key;
  let tratado = true;
  if (k === ' ' || k === 'k') alternarPlay();
  else if (k === 'ArrowLeft' && e.shiftKey) anterior();
  else if (k === 'ArrowRight' && e.shiftKey) proxima();
  else if (k === 'ArrowLeft' || k === 'j') saltar(-cfg().saltoVoltar);
  else if (k === 'ArrowRight' || k === 'l') saltar(cfg().saltoAvancar);
  else if (k === '[' || k === '{') definirVelocidade(cfg().velocidade - 0.1);
  else if (k === ']' || k === '}') definirVelocidade(cfg().velocidade + 0.1);
  else if (k === '0') definirVelocidade(1);
  else if (k === 's' || k === 'S') alternarAleatorio();
  else if (k === 'r' || k === 'R') alternarRepetir();
  else if (k === '/') { $('#campo-busca').focus(); }
  else tratado = false;
  if (tratado) e.preventDefault();
});

$('#player .player-info').addEventListener('keydown', e => { if (e.key === 'Enter') abrirTocando(); });

// busca
const aplicarBusca = adiar(q => {
  q = q.trim();
  if (!q) { if (rotaAtual().tipo === 'busca') history.back(); return; }
  const hash = '#/busca/' + encodeURIComponent(q);
  if (rotaAtual().tipo === 'busca') { history.replaceState(null, '', hash); renderVista(); }
  else location.hash = hash;
}, 250);
$('#campo-busca').addEventListener('input', e => aplicarBusca(e.target.value));

window.addEventListener('hashchange', () => {
  fecharMenu();
  $('#app').classList.remove('lateral-aberta');
  if (!$('#tocando').hidden) fecharTocando();
  if (rotaAtual().tipo !== 'busca') $('#campo-busca').value = '';
  renderVista();
});

window.addEventListener('online', () => { ocultarAviso(); if (tokenValido()) agendarSync(2000); else mostrarAvisoSessao(); });
window.addEventListener('offline', () => mostrarAvisoSessao());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    salvarPosicaoAgora(); gravar('estado', estado); gravar('fila', fila);
    if (sync.timer) sincronizar();
  } else if (tokenValido()) agendarSync(3000);
});
window.addEventListener('pagehide', () => { salvarPosicaoAgora(); gravar('estado', estado); gravar('fila', fila); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', aplicarTema);

$('#form-config').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#campo-client-id').value.trim();
  if (!/\.apps\.googleusercontent\.com$/.test(v)) { toast('O ID de cliente deve terminar em .apps.googleusercontent.com'); return; }
  auth.clientId = v; gravar('clientId', v);
  auth.cliente = null;
  mostrarTela('login');
});

function aposLogin() {
  renderLateral();
  renderVista({ manterRolagem: true });
  atualizarPlayerUI();
  sincronizar().then(() => {
    if (!cfg().raiz) { renderVista(); escolherPastaRaiz(); return; }
    varrerBiblioteca({ silenciosa: !!bib });
  });
}

function registrarServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (!reg) return;
    reg.addEventListener('updatefound', () => {
      const novo = reg.installing;
      novo?.addEventListener('statechange', () => {
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Nova versão do Auris disponível.', { ms: 0, acao: { rotulo: 'Atualizar', fn: () => location.reload() } });
        }
      });
    });
  }).catch(e => console.warn('Service worker não registrado', e));
}

function iniciar() {
  aplicarTema();
  registrarServiceWorker();
  configurarControlesSistema();
  if (!auth.clientId) { mostrarTela('config'); return; }
  if (!tokenValido() && !auth.usuario) { mostrarTela('login'); return; }
  mostrarTela('app');
  renderLateral();
  renderVista();
  atualizarPlayerUI();
  atualizarTempoUI();
  atualizarMetadados();
  if (tokenValido()) aposLogin();
  else mostrarAvisoSessao();
}

// API mínima para depuração no console do navegador
window.auris = { versao: VERSAO, estado, audio, get fila() { return fila; }, get biblioteca() { return bib; }, sincronizar, varrerBiblioteca };

iniciar();
})();
