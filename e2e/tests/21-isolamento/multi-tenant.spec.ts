import { test, expect, ApiClient, db } from '../../fixtures/index.ts';
import { registerOrg } from '../../fixtures/auth.ts';

test.describe('isolamento multi-tenant', () => {
  test('org A não vê clientes da org B em /clientes', async ({ page, request, loginAs }) => {
    const sessionA = await loginAs('isolamento-clientes-a');
    const apiA = new ApiClient(request, sessionA);
    const companyA = await db.seedCompany({ uf: 'SP' });
    await apiA.createRelationship(companyA.id, { status: 'cliente' });

    const sessionB = await registerOrg(request, 'isolamento-clientes-b');
    const apiB = new ApiClient(request, sessionB);
    const companyB = await db.seedCompany({ uf: 'RJ' });
    await apiB.createRelationship(companyB.id, { status: 'cliente' });

    await page.goto('/clientes');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText(companyA.nome_fantasia ?? companyA.razao_social, { exact: false })).toBeVisible();
    await expect(page.getByText(companyB.nome_fantasia ?? companyB.razao_social, { exact: false })).toHaveCount(0);
  });

  test('org A não acessa pedido da org B via ID direto na API', async ({ request, loginAs }) => {
    const sessionA = await loginAs('isolamento-pedidos-a');
    const sessionB = await registerOrg(request, 'isolamento-pedidos-b');
    const apiB = new ApiClient(request, sessionB);
    const companyB = await db.seedCompany({ uf: 'RJ' });
    const representedB = await apiB.createRepresented('Representada Isolamento B');
    const orderB = await apiB.createOrder({ company_id: companyB.id, represented_id: representedB.id, status: 'rascunho' });

    const res = await request.get(`/api/orders?status=rascunho`, {
      headers: { authorization: `Bearer ${sessionA.token}` },
    });
    const body = (await res.json()) as { orders: { id: number }[] };
    expect(body.orders.some((o) => o.id === orderB.id)).toBe(false);
  });

  test('org A não vê mensagens de WhatsApp da org B', async ({ request, loginAs }) => {
    const token = process.env.E2E_WHATSAPP_WEBHOOK_TOKEN ?? 'e2e-webhook-token';
    const sessionA = await loginAs('isolamento-whatsapp-a');
    const sessionB = await registerOrg(request, 'isolamento-whatsapp-b');
    // O webhook resolve instance -> org via org_whatsapp_settings, só criada após
    // a org visitar um endpoint de whatsapp — sem isso o evento seria 202/ignorado
    // e o teste passaria de forma vazia (nem a própria org B veria a mensagem).
    await request.get('/api/whatsapp/status', { headers: { authorization: `Bearer ${sessionB.token}` } });

    await request.post(`/api/webhooks/whatsapp?token=${token}`, {
      data: {
        event: 'messages.upsert',
        instance: `org_${sessionB.user.org_id}`,
        data: {
          key: { remoteJid: '5511999998888@s.whatsapp.net', fromMe: false, id: `ISOL-${Date.now()}` },
          pushName: 'Contato Isolamento B',
          message: { conversation: 'Mensagem privada da org B' },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      },
    });

    const chatsB = await request.get('/api/whatsapp/chats', { headers: { authorization: `Bearer ${sessionB.token}` } });
    const bodyB = (await chatsB.json()) as { chats: unknown[] };
    expect(bodyB.chats.length).toBe(1); // prova que a mensagem foi mesmo recebida (não é um passe vazio)

    const chatsA = await request.get('/api/whatsapp/chats', { headers: { authorization: `Bearer ${sessionA.token}` } });
    const bodyA = (await chatsA.json()) as { chats: unknown[] };
    expect(bodyA.chats.length).toBe(0);
  });

  test('prospecção não vaza relationships de outra org como "já cliente"', async ({ request, loginAs }) => {
    const sessionA = await loginAs('isolamento-prospeccao-a');
    const sessionB = await registerOrg(request, 'isolamento-prospeccao-b');
    const apiB = new ApiClient(request, sessionB);
    // municipioId (não só uf: 'SP' cobre São Paulo E Campinas no seed) garante
    // que a empresa cai exatamente no território que o /api/recommend abaixo consulta.
    const company = await db.seedCompany({ municipioId: 3550308 });
    await apiB.createRelationship(company.id, { status: 'cliente' });

    // limit alto o bastante pra cobrir todo o pool de SP do seed (~80 empresas)
    // — com limit baixo o score poderia deixar essa empresa fora do topo N,
    // o que não teria nada a ver com isolamento (é só ranking).
    const res = await request.get(
      `/api/recommend?munis=3550308&limit=20`,
      { headers: { authorization: `Bearer ${sessionA.token}` } },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { results: { id: string }[] };
    expect(body.results.some((r) => Number(r.id) === company.id)).toBe(true);
  });
});
