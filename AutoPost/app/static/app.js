// AutoPost — SPA sem build step. Vanilla ES modules.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ─────────────────────────────────────────────────────────── api

async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) {
    opts.body = form;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.detail;
    throw new Error(
      typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map((d) => d.msg).join('; ')
          : `Erro ${res.status}`,
    );
  }
  return data;
}

// ─────────────────────────────────────────────────────────── ui utils

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('is-out'), 3200);
  setTimeout(() => el.remove(), 3600);
}

let modalCloseOnlyByX = false;
function openModal(title, bodyHTML, footHTML, { closeOnlyByX = false } = {}) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-foot').innerHTML = footHTML ?? '';
  modalCloseOnlyByX = closeOnlyByX;
  $('#modal').hidden = false;
}
const closeModal = (fromX = false) => {
  if (modalCloseOnlyByX && !fromX) return;
  $('#modal').hidden = true;
  modalCloseOnlyByX = false;
};

function confirmDialog(title, message, onConfirm, { danger = true } = {}) {
  openModal(title, `<p class="dialog-text">${esc(message)}</p>`,
    `<button class="btn btn-ghost" data-act="cancel">Cancelar</button>
     <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">Confirmar</button>`);
  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
  $('[data-act="ok"]', $('#modal-foot')).onclick = async () => {
    closeModal();
    await onConfirm();
  };
}

const fmtDate = (iso) => (iso
  ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  : '—');

const STATUS_LABEL = {
  draft: 'Rascunho', scheduled: 'Agendado', publishing: 'Publicando',
  published: 'Publicado', failed: 'Falhou', missed: 'Perdido', canceled: 'Cancelado',
};

const badge = (status) =>
  `<span class="badge badge-${status}">${STATUS_LABEL[status] ?? status}</span>`;

const accountBadge = (status) => {
  const map = { connected: 'Conectada', expired: 'Token expirado', revoked: 'Revogada', error: 'Erro' };
  return `<span class="badge badge-acc-${status}">${map[status] ?? status}</span>`;
};

function empty(icon, title, hint) {
  return `<div class="empty">
    <div class="empty-icon">${icon}</div>
    <h3>${esc(title)}</h3>
    <p>${esc(hint)}</p>
  </div>`;
}

// Converte um <input type="datetime-local"> para o formato aceito pela API.
const localInputToISO = (v) => (v ? `${v}:00`.slice(0, 19) : '');
// E o inverso, para preencher o campo ao reagendar.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─────────────────────────────────────────────────────────── estado

const state = {
  user: null, view: 'posts', posts: [], accounts: [], media: [], templates: [],
  credentials: [], credentialsTab: 'meta', mcpTokens: [],
};

const PROVIDER_ICON = {
  facebook: '👍', instagram: '📸', tiktok: '🎵', linkedin: '💼',
};

// O que cada rede consegue publicar hoje — mostrado na aba para evitar a
// surpresa de agendar algo que a plataforma recusa.
const NETWORK_NOTES = {
  meta: 'Publica texto e imagem no Facebook. No Instagram a imagem é obrigatória e precisa de URL pública.',
  tiktok: 'Publica apenas vídeo, baixado de uma URL pública. Enquanto o app não passar pela auditoria do TikTok, o post sai como privado (somente você).',
  linkedin: 'Publica texto e imagem no feed do próprio perfil. Vídeo não é suportado.',
};

// ─────────────────────────────────────────────────────────── views

const VIEWS = {
  posts: {
    title: 'Posts',
    sub: 'Rascunhos, agendados e publicados',
    actions: '<button class="btn btn-primary" data-act="novo-post">'
      + '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Novo post</button>',
    render: renderPosts,
  },
  agenda: {
    title: 'Agenda',
    sub: 'O que está na fila para sair',
    actions: '',
    render: renderAgenda,
  },
  contas: {
    title: 'Contas sociais',
    sub: 'Perfis e páginas conectados para publicação',
    actions: '<button class="btn btn-primary" data-act="ir-credenciais">'
      + '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Conectar conta</button>',
    render: renderContas,
  },
  credenciais: {
    title: 'Credenciais',
    sub: 'App ID e secret de cada rede — usados para conectar as contas',
    actions: '',
    render: renderCredenciais,
  },
  midia: {
    title: 'Mídia',
    sub: 'Imagens e vídeos disponíveis para os posts',
    actions: '<label class="btn btn-primary">'
      + '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>Enviar arquivo'
      + '<input type="file" id="upload-input" hidden accept="image/*,video/mp4"></label>',
    render: renderMidia,
  },
  templates: {
    title: 'Templates',
    sub: 'Prompts reutilizáveis para a geração com IA',
    actions: '<button class="btn btn-primary" data-act="novo-template">'
      + '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Novo template</button>',
    render: renderTemplates,
  },
  ia: {
    title: 'Inteligência artificial',
    sub: 'Provedor, modelo e chave usados para gerar textos',
    actions: '',
    render: renderIA,
  },
  mcp: {
    title: 'Acesso MCP',
    sub: 'Tokens e permissões para conectar assistentes ao AutoPost',
    actions: '<button class="btn btn-primary" data-act="novo-mcp-token">'
      + '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Novo token</button>',
    render: renderMcp,
  },
};

async function navigate(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  const cfg = VIEWS[view];
  $('#view-title').textContent = cfg.title;
  $('#view-sub').textContent = cfg.sub;
  $('#topbar-actions').innerHTML = cfg.actions;
  $('#content').innerHTML = '<div class="skeleton"></div>'.repeat(3);
  try {
    await cfg.render();
  } catch (e) {
    $('#content').innerHTML = `<div class="callout callout-danger">${esc(e.message)}</div>`;
  }
}

// ── posts ──────────────────────────────────────────────────

async function renderPosts() {
  const [posts, accounts] = await Promise.all([api('/posts'), api('/accounts')]);
  state.posts = posts;
  state.accounts = accounts;

  if (!posts.length) {
    $('#content').innerHTML = empty('📝', 'Nenhum post ainda',
      'Crie um rascunho, gere o texto com IA e agende para as suas contas.');
    return;
  }

  $('#content').innerHTML = `<div class="cards">${posts.map(postCard).join('')}</div>`;
}

function postCard(p) {
  const editavel = ['draft', 'scheduled', 'failed', 'missed', 'canceled'].includes(p.status);
  return `<article class="card post-card" data-id="${p.id}">
    <header class="card-head">
      ${badge(p.status)}
      <span class="card-when">${p.status === 'published'
        ? `publicado ${fmtDate(p.published_at)}`
        : p.scheduled_at ? `agendado ${fmtDate(p.scheduled_at)}` : 'sem agendamento'}</span>
    </header>
    <p class="post-text">${esc(p.texto)}</p>
    ${p.last_error ? `<p class="card-error" title="${esc(p.last_error)}">${esc(p.last_error)}</p>` : ''}
    <footer class="card-foot">
      ${p.media_id ? `<span class="chip">🖼 ${(p.media_ids ?? [p.media_id]).length} mídia(s)</span>` : ''}
      ${p.attempts ? `<span class="chip">${p.attempts} tentativa(s)</span>` : ''}
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" data-act="detalhe" data-id="${p.id}">Detalhes</button>
      ${editavel ? `<button class="btn btn-ghost btn-sm" data-act="editar" data-id="${p.id}">Editar</button>
        <button class="btn btn-soft btn-sm" data-act="agendar" data-id="${p.id}">Agendar</button>` : ''}
      ${p.status === 'scheduled' ? `<button class="btn btn-ghost btn-sm" data-act="cancelar" data-id="${p.id}">Cancelar</button>` : ''}
      ${['draft', 'canceled', 'failed', 'missed'].includes(p.status)
        ? `<button class="icon-btn danger" data-act="excluir" data-id="${p.id}" title="Excluir">
             <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>` : ''}
    </footer>
  </article>`;
}

function postForm(p = null) {
  const selecionadas = new Set(p?.media_ids ?? (p?.media_id ? [p.media_id] : []));
  const opts = [...state.media].reverse().map((m) =>
    `<option value="${m.id}" ${selecionadas.has(m.id) ? 'selected' : ''}>#${m.id} · ${m.mime}</option>`).join('');
  return `<label class="field">
      <span>Texto do post</span>
      <textarea id="post-texto" rows="7" placeholder="Escreva ou gere com IA…">${esc(p?.texto ?? '')}</textarea>
    </label>
    <div class="row">
      <label class="field grow">
        <span>Mídias (opcional, até 10; ordem exibida)</span>
        <select id="post-media" multiple size="5">${opts}</select>
      </label>
      <button class="btn btn-soft" type="button" data-act="gerar-ia">
        <svg viewBox="0 0 24 24"><path d="m12 3 2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></svg>Gerar com IA
      </button>
    </div>
    <p class="form-error" id="post-error" hidden></p>`;
}

async function openPostForm(post) {
  state.media = await api('/media').catch(() => []);
  openModal(post ? `Editar post #${post.id}` : 'Novo post', postForm(post),
    `<button class="btn btn-ghost" data-act="cancel">Cancelar</button>
     <button class="btn btn-primary" data-act="save">${post ? 'Salvar' : 'Criar'}</button>`);

  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
  $('[data-act="gerar-ia"]', $('#modal-body')).onclick = gerarComIA;
  $('[data-act="save"]', $('#modal-foot')).onclick = async () => {
    const texto = $('#post-texto').value.trim();
    if (!texto) return showFormError('#post-error', 'O texto não pode ficar vazio.');
    const media_ids = [...$('#post-media').selectedOptions].map((o) => Number(o.value));
    const body = { texto, media_ids };
    try {
      if (post) await api(`/posts/${post.id}`, { method: 'PUT', body });
      else await api('/posts', { method: 'POST', body });
      closeModal();
      toast(post ? 'Post atualizado.' : 'Post criado.');
      navigate(state.view);
    } catch (e) { showFormError('#post-error', e.message); }
  };
}

// Novo conteúdo sempre começa pelo destino. Um story é uma publicação própria:
// isso permite texto e mídia diferentes por tela, sem misturar sequência com feed.
async function openComposerStart() {
  const accounts = (await api('/accounts')).filter((account) => account.status === 'connected');
  if (!accounts.length) {
    openModal('Novo conteúdo', '<div class="callout callout-warn">Conecte uma conta social antes de criar conteúdo.</div>', '<button class="btn btn-ghost" data-act="cancel">Fechar</button>');
    $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
    return;
  }
  const networks = [...new Set(accounts.map((account) => account.provider))];
  openModal('Novo conteúdo', `<label class="field"><span>1. Rede</span><select id="composer-network">${networks.map((network) => `<option value="${network}">${esc(network)}</option>`).join('')}</select></label>
    <label class="field"><span>2. Tipo de publicação</span><select id="composer-type"><option value="feed">Feed</option><option value="story">Stories</option></select></label>
    <p class="muted">Depois escolha contas e crie conteúdo específico para este formato.</p>`,
  '<button class="btn btn-ghost" data-act="cancel">Cancelar</button><button class="btn btn-primary" data-act="abrir-compositor">Continuar</button>');
  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
  $('#composer-network').onchange = () => {
    const supportsStory = ['facebook', 'instagram'].includes($('#composer-network').value);
    $('#composer-type').innerHTML = '<option value="feed">Feed</option>' + (supportsStory ? '<option value="story">Stories</option>' : '');
  };
  $('#modal-foot [data-act="abrir-compositor"]').onclick = () => openComposer($('#composer-network').value, $('#composer-type').value, accounts);
}

async function openComposer(network, type, accounts) {
  state.media = await api('/media').catch(() => []);
  const selectedAccounts = accounts.filter((account) => account.provider === network);
  const accountChecks = selectedAccounts.map((account) => `<label class="check"><input type="checkbox" name="composer-account" value="${account.id}" checked><span class="check-box"></span><span class="check-label"><strong>${esc(account.name)}</strong><small>${esc(account.provider)}</small></span></label>`).join('');
  const mediaPicker = (id, multiple = false) => `<div class="media-picker" id="${id}" data-multiple="${multiple}">
    <label class="btn btn-soft btn-sm">Adicionar arquivo local<input class="composer-upload" type="file" ${multiple ? 'multiple' : ''} hidden accept="image/*,video/mp4"></label>
    <p class="media-file-path muted">Nenhum arquivo selecionado.</p>
    <details class="media-library"><summary>Usar mídia existente (${state.media.length})</summary><div class="media-choice-grid">${mediaChoices()}</div></details></div>`;
  const storyItem = (index) => `<section class="panel" data-story="${index}"><div class="panel-head"><h3>Story ${index + 1}</h3></div><div class="field"><span>Mídia</span>${mediaPicker(`story-picker-${index}`)}</div><label class="field"><span>Texto (opcional)</span><textarea class="story-text" rows="3" placeholder="Texto deste story"></textarea></label></section>`;
  const content = type === 'story'
    ? `<div id="story-list">${storyItem(0)}</div><button class="btn btn-ghost" type="button" data-act="adicionar-story">Adicionar story</button>`
    : `<label class="field"><span>Texto</span><textarea id="composer-text" rows="6" placeholder="Escreva conteúdo do feed"></textarea></label><div class="field"><span>Mídias (opcional)</span>${mediaPicker('feed-picker', true)}</div>`;
  openModal(`${network} · ${type === 'story' ? 'Stories' : 'Feed'}`, `<label class="field"><span>3. Publicar em</span><div class="checks">${accountChecks}</div></label>${content}
    <label class="field"><span>Agendar para</span><input type="datetime-local" id="composer-when"></label><p class="form-error" id="composer-error" hidden></p>`,
  '<button class="btn btn-primary" data-act="salvar-compositor">Agendar</button>', { closeOnlyByX: true });
  $('#modal-body [data-act="adicionar-story"]')?.addEventListener('click', () => {
    const list = $('#story-list'); list.insertAdjacentHTML('beforeend', storyItem($$('[data-story]', list).length));
  });
  $('#modal-foot [data-act="salvar-compositor"]').onclick = async () => {
    const account_ids = $$('[name="composer-account"]:checked').map((input) => Number(input.value));
    const scheduled_at = localInputToISO($('#composer-when').value);
    if (!account_ids.length || !scheduled_at) return showFormError('#composer-error', 'Selecione conta e data de agendamento.');
    const entries = type === 'story'
      ? $$('[data-story]').map((item) => ({ texto: $('.story-text', item).value.trim() || 'Story', media_ids: [Number($('.media-choice.is-selected', item)?.dataset.mediaId)] }))
      : [{ texto: $('#composer-text').value.trim(), media_ids: $$('#feed-picker .media-choice.is-selected').map((item) => Number(item.dataset.mediaId)) }];
    if (entries.some((entry) => !entry.texto || entry.media_ids.some((media) => !media))) return showFormError('#composer-error', type === 'story' ? 'Cada story precisa de mídia.' : 'Informe texto do post.');
    try {
      for (const entry of entries) { const post = await api('/posts', { method: 'POST', body: entry }); await api(`/posts/${post.id}/schedule`, { method: 'POST', body: { account_ids, placements: [type], scheduled_at } }); }
      closeModal(true); toast(type === 'story' ? `${entries.length} stories agendados.` : 'Post agendado.'); navigate('posts');
    } catch (error) { showFormError('#composer-error', error.message); }
  };
}

function mediaChoices() {
  if (!state.media.length) return '<p class="muted">Nenhuma mídia. Adicione arquivo local.</p>';
  return [...state.media].reverse().map((media) => {
    const source = `/media/${media.id}`;
    const preview = media.mime.startsWith('video/')
      ? `<video src="${source}" muted preload="metadata"></video>` : `<img src="${source}" alt="mídia #${media.id}">`;
    return `<button type="button" class="media-choice" data-act="selecionar-midia" data-media-id="${media.id}" title="Clique para selecionar; passe mouse para ampliar">${preview}<span>#${media.id}</span><span class="media-hover">${preview}</span></button>`;
  }).join('');
}

async function uploadComposerFiles(input) {
  const files = [...input.files];
  if (!files.length) return;
  const picker = input.closest('.media-picker');
  input.disabled = true;
  try {
    const uploaded = [];
    for (const file of files) { const form = new FormData(); form.append('file', file); uploaded.push({ media: await api('/uploads', { method: 'POST', form }), name: file.name }); }
    state.media.push(...uploaded.map((item) => item.media));
    $$('.media-choice-grid').forEach((grid) => { grid.innerHTML = mediaChoices(); });
    if (picker) {
      const ids = uploaded.map((item) => String(item.media.id));
      if (picker.dataset.multiple !== 'true') $$('.media-choice', picker).forEach((choice) => choice.classList.remove('is-selected'));
      ids.forEach((id) => $$('.media-choice', picker).find((choice) => choice.dataset.mediaId === id)?.classList.add('is-selected'));
      $('.media-file-path', picker).textContent = `Arquivo local: ${uploaded.map((item) => item.name).join(', ')}`;
    }
    toast(files.length > 1 ? `${files.length} arquivos adicionados.` : 'Arquivo adicionado.');
  } catch (error) { toast(error.message, 'danger'); }
  finally { input.disabled = false; input.value = ''; }
}

function showFormError(sel, msg) {
  const el = $(sel);
  el.textContent = msg;
  el.hidden = false;
}

async function gerarComIA() {
  const templates = await api('/templates').catch(() => []);
  const opts = templates.filter((t) => t.ativo)
    .map((t) => `<option value="${t.id}">${esc(t.nome)}</option>`).join('');
  const textarea = $('#post-texto');

  openModal('Gerar texto com IA',
    `<label class="field">
       <span>Template (opcional)</span>
       <select id="ia-template"><option value="">Nenhum</option>${opts}</select>
     </label>
     <label class="field">
       <span>Instrução</span>
       <textarea id="ia-prompt" rows="4" placeholder="Ex.: post curto anunciando promoção de inverno"></textarea>
     </label>
     <p class="form-error" id="ia-error" hidden></p>`,
    `<button class="btn btn-ghost" data-act="cancel">Voltar</button>
     <button class="btn btn-primary" data-act="gerar">Gerar</button>`);

  const voltar = async () => { closeModal(); await openPostFormKeeping(textarea.value); };
  $('[data-act="cancel"]', $('#modal-foot')).onclick = voltar;
  $('[data-act="gerar"]', $('#modal-foot')).onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Gerando…';
    try {
      const tplVal = $('#ia-template').value;
      const r = await api('/ai/generate', {
        method: 'POST',
        body: {
          prompt: $('#ia-prompt').value.trim() || null,
          template_id: tplVal ? Number(tplVal) : null,
        },
      });
      closeModal();
      await openPostFormKeeping(r.texto);
      toast('Texto gerado.');
    } catch (e) {
      showFormError('#ia-error', e.message);
      btn.disabled = false;
      btn.textContent = 'Gerar';
    }
  };
}

// Reabre o formulário de post preservando o texto (o post ainda não existe no banco).
async function openPostFormKeeping(texto) {
  await openPostForm(null);
  $('#post-texto').value = texto;
}

async function openAgendar(postId) {
  const [post, accounts] = await Promise.all([api(`/posts/${postId}`), api('/accounts')]);
  const conectadas = accounts.filter((a) => a.status === 'connected');

  if (!conectadas.length) {
    openModal('Agendar post',
      '<div class="callout callout-warn">Nenhuma conta conectada. Conecte uma conta em <strong>Contas</strong> antes de agendar.</div>',
      '<button class="btn btn-ghost" data-act="cancel">Fechar</button>');
    $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
    return;
  }

  const jaSelecionadas = new Set((post.targets ?? []).map((t) => t.social_account_id));
  const lista = conectadas.map((a) => `<label class="check">
      <input type="checkbox" value="${a.id}" ${jaSelecionadas.has(a.id) ? 'checked' : ''}>
      <span class="check-box"></span>
      <span class="check-label"><strong>${esc(a.name)}</strong><small>${a.provider}</small></span>
    </label>`).join('');

  openModal(`Agendar post #${postId}`,
    `<label class="field">
       <span>Data e hora (seu fuso)</span>
       <input type="datetime-local" id="ag-quando" value="${isoToLocalInput(post.scheduled_at)}">
     </label>
     <div class="field">
       <span>Publicar em</span>
       <div class="checks">${lista}</div>
     </div>
     <div class="field">
       <span>Formatos</span>
       <div class="checks">
         <label class="check"><input type="checkbox" name="placement" value="feed" checked>
           <span class="check-box"></span><span class="check-label"><strong>Feed</strong></span></label>
         <label class="check"><input type="checkbox" name="placement" value="story">
           <span class="check-box"></span><span class="check-label"><strong>Story</strong><small>Facebook e Instagram</small></span></label>
       </div>
     </div>
     <p class="form-error" id="ag-error" hidden></p>`,
    '<button class="btn btn-primary" data-act="ok">Agendar</button>',
    { closeOnlyByX: true });
  $('[data-act="ok"]', $('#modal-foot')).onclick = async () => {
    const quando = $('#ag-quando').value;
    const ids = $$('.checks input:not([name="placement"]):checked').map((i) => Number(i.value));
    const placements = $$('input[name="placement"]:checked').map((i) => i.value);
    if (!quando) return showFormError('#ag-error', 'Escolha a data e a hora.');
    if (!ids.length) return showFormError('#ag-error', 'Escolha ao menos uma conta.');
    if (!placements.length) return showFormError('#ag-error', 'Escolha ao menos um formato.');
    try {
      await api(`/posts/${postId}/schedule`, {
        method: 'POST',
        body: { scheduled_at: localInputToISO(quando), account_ids: ids, placements },
      });
      closeModal(true);
      toast('Post agendado.');
      navigate(state.view);
    } catch (e) { showFormError('#ag-error', e.message); }
  };
}

async function openDetalhe(postId) {
  const [post, accounts, history] = await Promise.all([
    api(`/posts/${postId}`), api('/accounts'), api(`/posts/${postId}/history`),
  ]);
  const nome = (id) => accounts.find((a) => a.id === id)?.name ?? `conta #${id}`;

  const alvos = (post.targets ?? []).length
    ? `<table class="table">
        <thead><tr><th>Conta</th><th>Status</th><th>ID externo</th></tr></thead>
        <tbody>${post.targets.map((t) => `<tr>
          <td>${esc(nome(t.social_account_id))} · ${esc(t.placement ?? 'feed')}</td>
          <td>${badge(t.status === 'pending' ? 'draft' : t.status === 'published' ? 'published' : 'failed')}</td>
          <td class="mono">${esc(t.external_post_id ?? '—')}</td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="muted">Nenhum destino definido.</p>';

  const hist = history.length
    ? `<table class="table">
        <thead><tr><th>Quando</th><th>Conta</th><th>Tent.</th><th>Status</th><th>Erro</th></tr></thead>
        <tbody>${history.map((h) => `<tr>
          <td class="mono">${esc(h.timestamp)}</td>
          <td>${esc(nome(h.social_account_id))}</td>
          <td>${h.tentativa}</td>
          <td>${h.status === 'published' ? '✅' : '⚠️'} ${esc(h.status)}</td>
          <td class="cell-err">${esc(h.erro ?? '—')}</td>
        </tr>`).join('')}</tbody></table>`
    : '<p class="muted">Sem tentativas registradas.</p>';

  openModal(`Post #${post.id}`,
    `<div class="detail-meta">
       ${badge(post.status)}
       <span class="muted">agendado ${fmtDate(post.scheduled_at)}</span>
       <span class="muted">publicado ${fmtDate(post.published_at)}</span>
     </div>
     <blockquote class="detail-text">${esc(post.texto)}</blockquote>
     ${post.media_id ? `<img class="detail-media" src="/media/${post.media_id}" alt="mídia do post">` : ''}
     ${post.last_error ? `<div class="callout callout-danger">${esc(post.last_error)}</div>` : ''}
     <h4>Destinos</h4>${alvos}
     <h4>Histórico de publicação</h4>${hist}`,
    '<button class="btn btn-ghost" data-act="cancel">Fechar</button>');
  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
}

// ── agenda ─────────────────────────────────────────────────

async function renderAgenda() {
  const [posts, accounts] = await Promise.all([api('/posts'), api('/accounts')]);
  state.accounts = accounts;
  const fila = posts
    .filter((p) => ['scheduled', 'publishing'].includes(p.status))
    .sort((a, b) => (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? ''));

  if (!fila.length) {
    $('#content').innerHTML = empty('🗓', 'Nada na fila',
      'Agende um post na aba Posts para vê-lo aqui.');
    return;
  }

  const grupos = new Map();
  for (const p of fila) {
    const dia = new Date(p.scheduled_at).toLocaleDateString('pt-BR',
      { weekday: 'long', day: '2-digit', month: 'long' });
    if (!grupos.has(dia)) grupos.set(dia, []);
    grupos.get(dia).push(p);
  }

  $('#content').innerHTML = [...grupos].map(([dia, items]) => `
    <section class="agenda-day">
      <h3 class="agenda-date">${esc(dia)}</h3>
      ${items.map((p) => `<div class="agenda-row" data-id="${p.id}">
        <span class="agenda-time">${new Date(p.scheduled_at)
          .toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
        <span class="agenda-text">${esc(p.texto)}</span>
        ${badge(p.status)}
        <button class="btn btn-ghost btn-sm" data-act="detalhe" data-id="${p.id}">Detalhes</button>
      </div>`).join('')}
    </section>`).join('');
}

// ── contas ─────────────────────────────────────────────────

async function renderContas() {
  const accounts = await api('/accounts');
  state.accounts = accounts;

  if (!accounts.length) {
    $('#content').innerHTML = empty('🔗', 'Nenhuma conta conectada',
      'Configure as credenciais da rede em Credenciais e depois clique em Conectar conta.');
    return;
  }

  $('#content').innerHTML = `<div class="cards">${accounts.map((a) => `
    <article class="card account-card">
      <div class="account-icon account-${a.provider}">${PROVIDER_ICON[a.provider] ?? '🔗'}</div>
      <div class="account-body">
        <strong>${esc(a.name)}</strong>
        <small class="muted">${a.provider} · ${esc(a.external_id)}</small>
        ${accountBadge(a.status)}
      </div>
      <div class="account-actions">
        <button class="btn btn-ghost btn-sm" data-act="validar-conta" data-id="${a.id}">Validar</button>
        <button class="icon-btn danger" data-act="excluir-conta" data-id="${a.id}" title="Remover">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
        </button>
      </div>
    </article>`).join('')}</div>`;
}

// ── mídia ──────────────────────────────────────────────────

async function renderMidia() {
  const media = await api('/media');
  state.media = media;

  if (!media.length) {
    $('#content').innerHTML = empty('🖼', 'Nenhum arquivo',
      'Envie imagens (jpg, png, gif, webp) ou vídeos mp4 para anexar aos posts.');
    return;
  }

  $('#content').innerHTML = `<div class="media-grid">${media.map((m) => `
    <figure class="media-item">
      ${m.mime.startsWith('image/')
        ? `<img src="/media/${m.id}" alt="mídia ${m.id}" loading="lazy">`
        : '<div class="media-video">🎬</div>'}
      <figcaption>
        <span>#${m.id}</span>
        <small>${(m.size_bytes / 1024).toFixed(0)} KB</small>
      </figcaption>
    </figure>`).join('')}</div>`;
}

// ── templates ──────────────────────────────────────────────

async function renderTemplates() {
  const templates = await api('/templates');
  state.templates = templates;

  if (!templates.length) {
    $('#content').innerHTML = empty('📋', 'Nenhum template',
      'Salve prompts que você repete — eles ficam disponíveis na geração com IA.');
    return;
  }

  $('#content').innerHTML = `<div class="cards">${templates.map((t) => `
    <article class="card">
      <header class="card-head">
        <strong>${esc(t.nome)}</strong>
        <span class="badge ${t.ativo ? 'badge-published' : 'badge-canceled'}">${t.ativo ? 'Ativo' : 'Inativo'}</span>
      </header>
      <p class="post-text">${esc(t.conteudo)}</p>
      <footer class="card-foot">
        <span class="spacer"></span>
        <button class="btn btn-ghost btn-sm" data-act="editar-template" data-id="${t.id}">Editar</button>
        <button class="icon-btn danger" data-act="excluir-template" data-id="${t.id}" title="Excluir">
          <svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>
        </button>
      </footer>
    </article>`).join('')}</div>`;
}

function openTemplateForm(tpl = null) {
  openModal(tpl ? `Editar ${tpl.nome}` : 'Novo template',
    `<label class="field"><span>Nome</span>
       <input id="tpl-nome" value="${esc(tpl?.nome ?? '')}" placeholder="Ex.: Promoção semanal"></label>
     <label class="field"><span>Conteúdo do prompt</span>
       <textarea id="tpl-conteudo" rows="6">${esc(tpl?.conteudo ?? '')}</textarea></label>
     ${tpl ? `<label class="check"><input type="checkbox" id="tpl-ativo" ${tpl.ativo ? 'checked' : ''}>
       <span class="check-box"></span><span class="check-label">Ativo</span></label>` : ''}
     <p class="form-error" id="tpl-error" hidden></p>`,
    `<button class="btn btn-ghost" data-act="cancel">Cancelar</button>
     <button class="btn btn-primary" data-act="save">Salvar</button>`);

  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
  $('[data-act="save"]', $('#modal-foot')).onclick = async () => {
    const nome = $('#tpl-nome').value.trim();
    const conteudo = $('#tpl-conteudo').value.trim();
    if (!nome || !conteudo) return showFormError('#tpl-error', 'Preencha nome e conteúdo.');
    const body = { nome, conteudo, ativo: tpl ? $('#tpl-ativo').checked : true };
    try {
      if (tpl) await api(`/templates/${tpl.id}`, { method: 'PUT', body });
      else await api('/templates', { method: 'POST', body });
      closeModal();
      toast('Template salvo.');
      navigate('templates');
    } catch (e) { showFormError('#tpl-error', e.message); }
  };
}

// ── IA ─────────────────────────────────────────────────────

async function renderIA() {
  let cfg = null;
  try { cfg = await api('/ai/settings'); } catch { /* ainda não configurado */ }

  $('#content').innerHTML = `<div class="panel">
    <div class="panel-head">
      <h3>Configuração do provedor</h3>
      <p class="muted">A chave é criptografada em repouso e nunca é devolvida pela API — só a máscara.</p>
    </div>
    <div class="row">
      <label class="field grow"><span>Provedor</span>
        <select id="ia-provider">
          <option value="anthropic" ${cfg?.provider === 'anthropic' ? 'selected' : ''}>Anthropic</option>
          <option value="openai" ${cfg?.provider === 'openai' ? 'selected' : ''}>OpenAI</option>
        </select></label>
      <label class="field grow"><span>Modelo</span>
        <input id="ia-model" value="${esc(cfg?.model ?? 'claude-opus-5')}"></label>
    </div>
    <label class="field"><span>API key ${cfg ? `<em class="muted">(atual: ${esc(cfg.api_key)})</em>` : ''}</span>
      <input id="ia-key" type="password" placeholder="${cfg ? 'deixe vazio para manter a atual' : 'cole a chave aqui'}"></label>
    <label class="field"><span>Prompt padrão (opcional)</span>
      <textarea id="ia-default" rows="3" placeholder="Instruções fixas aplicadas a toda geração">${esc(cfg?.default_prompt ?? '')}</textarea></label>
    <label class="field"><span>Temperature (opcional)</span>
      <input id="ia-temp" type="number" step="0.1" min="0" max="2" value="${cfg?.temperature ?? ''}"
             placeholder="deixe vazio — modelos Claude recentes rejeitam este parâmetro"></label>
    <p class="form-error" id="ia-cfg-error" hidden></p>
    <div class="panel-foot">
      <button class="btn btn-primary" data-act="salvar-ia">Salvar configuração</button>
    </div>
  </div>`;
}

// ── MCP ────────────────────────────────────────────────────

const MCP_SCOPES = {
  read: 'Consultar contas, templates e posts',
  generate: 'Gerar textos com IA',
  write: 'Enviar mídia e criar rascunhos',
  schedule: 'Agendar publicações',
};

async function renderMcp() {
  state.mcpTokens = await api('/mcp-tokens');
  if (!state.mcpTokens.length) {
    $('#content').innerHTML = empty('🔑', 'Nenhum token MCP',
      'Crie token com permissões mínimas para conectar Claude, ChatGPT ou outra ferramenta MCP.');
    return;
  }
  $('#content').innerHTML = `<div class="callout">Cada token pertence somente a esta conta. Segredo aparece uma vez, nunca é salvo em texto aberto.</div>
    <div class="cards">${state.mcpTokens.map((token) => {
      const expired = token.expires_at && new Date(token.expires_at) <= new Date();
      const disabled = token.revoked_at || expired;
      return `<article class="card"><header class="card-head"><div><strong>${esc(token.name)}</strong><p class="muted">${esc(token.token_prefix)}…</p></div>
        <span class="badge ${disabled ? 'badge-failed' : 'badge-published'}">${token.revoked_at ? 'Revogado' : expired ? 'Expirado' : 'Ativo'}</span></header>
        <p class="muted">Permissões: ${token.scopes.map(esc).join(', ')}</p>
        <p class="muted">Último uso: ${fmtDate(token.last_used_at)}${token.expires_at ? ` · Expira: ${fmtDate(token.expires_at)}` : ''}</p>
        ${!disabled ? `<footer class="card-foot"><span class="spacer"></span><button class="btn btn-ghost btn-sm" data-act="editar-mcp-token" data-id="${token.id}">Editar</button><button class="btn btn-ghost btn-danger btn-sm" data-act="revogar-mcp-token" data-id="${token.id}">Revogar</button></footer>` : ''}
      </article>`;
    }).join('')}</div>`;
}

function openMcpTokenForm(token = null) {
  const selected = new Set(token?.scopes ?? ['read']);
  const selectedChecks = Object.entries(MCP_SCOPES).map(([scope, label]) => `<label class="check"><input type="checkbox" name="mcp-scope" value="${scope}" ${selected.has(scope) ? 'checked' : ''}>
    <span class="check-box"></span><span class="check-label"><strong>${scope}</strong><small>${label}</small></span></label>`).join('');
  openModal(token ? 'Editar token MCP' : 'Novo token MCP', `<div class="callout callout-warn">Conceda somente permissões necessárias.${token ? '' : ' Token será exibido uma única vez.'}</div>
    <label class="field"><span>Nome</span><input id="mcp-name" maxlength="120" value="${esc(token?.name ?? '')}" placeholder="Ex.: Assistente comercial"></label>
    <label class="field"><span>Expiração (opcional)</span><input type="datetime-local" id="mcp-expiry" value="${isoToLocalInput(token?.expires_at)}"></label>
    <div class="field"><span>Permissões</span><div class="checks">${selectedChecks}</div></div>
    <p class="form-error" id="mcp-error" hidden></p>`,
  `<button class="btn btn-ghost" data-act="cancel">Cancelar</button><button class="btn btn-primary" data-act="${token ? 'salvar-mcp-token' : 'criar-mcp-token'}" data-id="${token?.id ?? ''}">${token ? 'Salvar' : 'Criar token'}</button>`);
  $('[data-act="cancel"]', $('#modal-foot')).onclick = closeModal;
}

function showMcpToken(token) {
  openModal('Copie token agora', `<div class="callout callout-warn">Ele não será mostrado novamente.</div>
    <label class="field"><span>Token MCP</span><textarea id="mcp-secret" rows="3" readonly>${esc(token)}</textarea></label>`,
  `<button class="btn btn-ghost" data-act="fechar-mcp-token">Fechar</button><button class="btn btn-primary" data-act="copiar-mcp-token">Copiar token</button>`);
}

// ── credenciais ────────────────────────────────────────────

async function renderCredenciais() {
  state.credentials = await api('/credentials');
  if (!state.credentials.some((c) => c.group === state.credentialsTab)) {
    state.credentialsTab = state.credentials[0]?.group ?? 'meta';
  }
  const cur = state.credentials.find((c) => c.group === state.credentialsTab);

  const tabs = state.credentials.map((c) => `
    <button class="tab ${c.group === state.credentialsTab ? 'is-active' : ''}"
            data-act="cred-tab" data-group="${esc(c.group)}">
      ${esc(c.label)}
      ${c.configured ? '<span class="dot dot-ok" title="configurado"></span>' : ''}
    </button>`).join('');

  const redirect = cur.redirect_uri
    ? `<label class="field"><span>URL de redirecionamento (cadastre esta URL no painel da rede)</span>
         <input value="${esc(cur.redirect_uri)}" readonly onclick="this.select()"></label>`
    : `<div class="callout callout-warn">${esc(cur.redirect_uri_error ?? 'URL de redirecionamento indisponível.')}</div>`;

  $('#content').innerHTML = `
    <div class="tabs">${tabs}</div>
    <div class="panel">
      <div class="panel-head">
        <h3>${esc(cur.label)}</h3>
        <p class="muted">${esc(NETWORK_NOTES[cur.group] ?? '')}</p>
      </div>
      <div class="callout">O secret é criptografado em repouso e nunca volta pela API — só a máscara.
        As credenciais valem apenas para esta conta; nada é herdado de configuração global.</div>
      <div class="row">
        <label class="field grow"><span>${esc(cur.field_labels.client_id)}</span>
          <input id="cred-client-id" value="${esc(cur.client_id ?? '')}" placeholder="cole aqui"></label>
        <label class="field grow">
          <span>${esc(cur.field_labels.client_secret)}
            ${cur.configured ? `<em class="muted">(atual: ${esc(cur.client_secret)})</em>` : ''}</span>
          <input id="cred-client-secret" type="password"
                 placeholder="${cur.configured ? 'deixe vazio para manter o atual' : 'cole aqui'}"></label>
      </div>
      ${redirect}
      <p class="form-error" id="cred-error" hidden></p>
      <div class="panel-foot">
        ${cur.configured
          ? `<button class="btn btn-ghost btn-danger" data-act="cred-remover" data-group="${esc(cur.group)}">Remover</button>`
          : ''}
        <button class="btn btn-primary" data-act="cred-salvar" data-group="${esc(cur.group)}">Salvar credenciais</button>
        ${cur.configured
          ? `<button class="btn" data-act="cred-conectar" data-group="${esc(cur.group)}">Conectar conta</button>`
          : ''}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────────────────── eventos

document.addEventListener('click', async (ev) => {
  const nav = ev.target.closest('.nav-item');
  if (nav) return navigate(nav.dataset.view);

  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);

  switch (btn.dataset.act) {
    case 'novo-post': return openComposerStart();
    case 'selecionar-midia': {
      const picker = btn.closest('.media-picker');
      if (!picker) return;
      if (picker.dataset.multiple !== 'true') $$('.media-choice', picker).forEach((choice) => choice.classList.remove('is-selected'));
      btn.classList.toggle('is-selected');
      const selected = $$('.media-choice.is-selected', picker).map((choice) => `Mídia #${choice.dataset.mediaId}`);
      $('.media-file-path', picker).textContent = selected.length ? selected.join(', ') : 'Nenhum arquivo selecionado.';
      return;
    }
    case 'editar': return openPostForm(state.posts.find((p) => p.id === id));
    case 'agendar': return openAgendar(id);
    case 'detalhe': return openDetalhe(id);
    case 'cancelar':
      return confirmDialog('Cancelar agendamento',
        'O post volta para a lista sem sair nas redes. Confirmar?',
        async () => { await api(`/posts/${id}/cancel`, { method: 'POST' }); toast('Agendamento cancelado.'); navigate(state.view); });
    case 'excluir':
      return confirmDialog('Excluir post', 'Esta ação não pode ser desfeita.',
        async () => { await api(`/posts/${id}`, { method: 'DELETE' }); toast('Post excluído.'); navigate(state.view); });
    case 'ir-credenciais':
      return navigate('credenciais');
    case 'cred-tab':
      state.credentialsTab = btn.dataset.group;
      return navigate('credenciais');
    case 'cred-salvar': {
      const body = {
        client_id: $('#cred-client-id').value.trim(),
        client_secret: $('#cred-client-secret').value.trim() || null,
      };
      try {
        await api(`/credentials/${btn.dataset.group}`, { method: 'PUT', body });
        toast('Credenciais salvas.');
        navigate('credenciais');
      } catch (e) { showFormError('#cred-error', e.message); }
      return;
    }
    case 'cred-conectar':
      window.location.href = `/accounts/${btn.dataset.group}/connect`;
      return;
    case 'cred-remover':
      return confirmDialog('Remover credenciais',
        'As contas já conectadas continuam funcionando, mas não será possível conectar novas nem reconectar. Confirmar?',
        async () => {
          try {
            await api(`/credentials/${btn.dataset.group}`, { method: 'DELETE' });
            toast('Credenciais removidas.');
            navigate('credenciais');
          } catch (e) { toast(e.message, 'danger'); }
        });
    case 'validar-conta':
      try {
        const r = await api(`/accounts/${id}/validate`, { method: 'POST' });
        toast(r.status === 'connected' ? 'Token válido.' : `Conta com status: ${r.status}`,
          r.status === 'connected' ? 'ok' : 'warn');
        navigate('contas');
      } catch (e) { toast(e.message, 'danger'); }
      return;
    case 'excluir-conta':
      return confirmDialog('Remover conta',
        'A conta deixa de estar disponível para novos agendamentos.',
        async () => {
          try {
            await api(`/accounts/${id}`, { method: 'DELETE' });
            toast('Conta removida.');
            navigate('contas');
          } catch (e) { toast(e.message, 'danger'); }
        });
    case 'novo-template': return openTemplateForm(null);
    case 'novo-mcp-token': return openMcpTokenForm();
    case 'editar-mcp-token': return openMcpTokenForm(state.mcpTokens.find((token) => token.id === id));
    case 'criar-mcp-token': {
      const name = $('#mcp-name').value.trim();
      const scopes = $$('[name="mcp-scope"]:checked').map((input) => input.value);
      if (!name || !scopes.length) return showFormError('#mcp-error', 'Informe nome e ao menos uma permissão.');
      try {
        const result = await api('/mcp-tokens', { method: 'POST', body: { name, scopes, expires_at: localInputToISO($('#mcp-expiry').value) || null } });
        showMcpToken(result.token);
      } catch (e) { showFormError('#mcp-error', e.message); }
      return;
    }
    case 'salvar-mcp-token': {
      const name = $('#mcp-name').value.trim();
      const scopes = $$('[name="mcp-scope"]:checked').map((input) => input.value);
      if (!name || !scopes.length) return showFormError('#mcp-error', 'Informe nome e ao menos uma permissão.');
      try { await api(`/mcp-tokens/${id}`, { method: 'PUT', body: { name, scopes, expires_at: localInputToISO($('#mcp-expiry').value) || null } }); closeModal(); toast('Token atualizado.'); navigate('mcp'); }
      catch (e) { showFormError('#mcp-error', e.message); }
      return;
    }
    case 'revogar-mcp-token': return confirmDialog('Revogar token MCP', 'Assistentes usando este token perderão acesso imediatamente.',
      async () => { try { await api(`/mcp-tokens/${id}`, { method: 'DELETE' }); toast('Token revogado.'); navigate('mcp'); } catch (e) { toast(e.message, 'danger'); } });
    case 'copiar-mcp-token':
      try { await navigator.clipboard.writeText($('#mcp-secret').value); toast('Token copiado.'); } catch { $('#mcp-secret').select(); toast('Selecione e copie token.', 'warn'); }
      return;
    case 'fechar-mcp-token': closeModal(); return;
    case 'editar-template': return openTemplateForm(state.templates.find((t) => t.id === id));
    case 'excluir-template':
      return confirmDialog('Excluir template', 'Esta ação não pode ser desfeita.',
        async () => { await api(`/templates/${id}`, { method: 'DELETE' }); toast('Template excluído.'); navigate('templates'); });
    case 'salvar-ia': {
      const temp = $('#ia-temp').value;
      const body = {
        provider: $('#ia-provider').value,
        model: $('#ia-model').value.trim(),
        api_key: $('#ia-key').value.trim() || null,
        default_prompt: $('#ia-default').value.trim() || null,
        temperature: temp === '' ? null : Number(temp),
      };
      try {
        await api('/ai/settings', { method: 'PUT', body });
        toast('Configuração salva.');
        navigate('ia');
      } catch (e) { showFormError('#ia-cfg-error', e.message); }
      return;
    }
    default:
  }
});

document.addEventListener('change', async (ev) => {
  if (ev.target.classList.contains('composer-upload')) return uploadComposerFiles(ev.target);
  if (ev.target.id !== 'upload-input') return;
  const file = ev.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('file', file);
  try {
    await api('/uploads', { method: 'POST', form });
    toast('Arquivo enviado.');
    navigate('midia');
  } catch (e) { toast(e.message, 'danger'); }
});

$('#modal-close').onclick = () => closeModal(true);
$('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });

// ─────────────────────────────────────────────────────────── tema

const applyTheme = (t) => {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('autopost-theme', t);
};
$('#theme-toggle').onclick = () =>
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
applyTheme(localStorage.getItem('autopost-theme')
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

// ─────────────────────────────────────────────────────────── sessão

$('#login-form').onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    const user = await api('/auth/login', {
      method: 'POST',
      body: { email: $('#login-email').value, senha: $('#login-senha').value },
    });
    enterApp(user);
  } catch (e) { showFormError('#login-error', e.message); }
};

$('#logout').onclick = async () => {
  await api('/auth/logout', { method: 'POST' });
  state.user = null;
  $('#app-shell').hidden = true;
  $('#login-screen').hidden = false;
};

function enterApp(user) {
  state.user = user;
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#user-name').textContent = user.nome;
  $('#user-email').textContent = user.email;
  $('#user-initial').textContent = user.nome.trim()[0]?.toUpperCase() ?? '?';
  navigate('posts');
}

try {
  enterApp(await api('/auth/me'));
} catch {
  $('#login-screen').hidden = false;
}
