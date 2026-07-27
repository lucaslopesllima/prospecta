// Organização de demonstração (organizations.demo — migração 072).
//
// A org de demo tem dados fictícios completos (docs/DEMO_DATA.md) mas nenhuma
// integração externa por trás. Para o WhatsApp isso é um problema: a tela só
// abre com a conta conectada e o front confirma o estado real na Evolution.
// Em org demo o app roda o WhatsApp em CIRCUITO FECHADO — a UI enxerga a conta
// como conectada, o envio grava a mensagem localmente e nenhuma chamada sai
// para a Evolution (não há instância real para atender). Efeito colateral
// desejado: o visitante pode digitar e enviar à vontade sem que nada chegue a
// um número de verdade.
import { one } from './db.ts';

// Cache com TTL: a flag só muda quando o seed roda, e o seed é outro processo
// (não dá para invalidar de dentro do app). 60s é curto o bastante para o seed
// passar a valer sem reinício e longo o bastante para tirar a consulta do
// caminho quente do WhatsApp, que é chamado a cada mensagem.
const TTL_MS = 60_000;
const cache = new Map<number, { demo: boolean; at: number }>();

export async function isDemoOrg(orgId: number | string): Promise<boolean> {
  const id = Number(orgId);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.demo;
  const row = await one<{ demo: boolean }>('SELECT demo FROM organizations WHERE id = $1', [id]);
  const demo = row?.demo === true;
  cache.set(id, { demo, at: Date.now() });
  return demo;
}

// Só para os testes: zera o cache entre cenários (uma org vira demo no meio).
export function resetDemoCache(): void {
  cache.clear();
}
