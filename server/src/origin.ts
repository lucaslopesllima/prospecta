import { one, query } from './db.ts';
import { geocodeAddr } from './geocode.ts';

export interface OrgOrigin {
  lat: number;
  lon: number;
  cached: boolean;
  precisao?: string;
}

// Fonte única da origem da conta. Mantém recomendação, traçado individual e
// planejador usando exatamente as mesmas coordenadas.
export async function resolveOrgOrigin(orgId: number): Promise<OrgOrigin | null> {
  const org = await one<{
    logradouro: string | null; numero: string | null; bairro: string | null;
    cep: string | null; cidade: string | null; uf: string | null;
    origem_lat: number | null; origem_lon: number | null;
  }>(
    `SELECT logradouro, numero, bairro, cep, cidade, uf, origem_lat, origem_lon
     FROM organizations WHERE id = $1`, [orgId],
  );
  if (!org) return null;
  if (org.origem_lat != null && org.origem_lon != null) {
    return { lat: org.origem_lat, lon: org.origem_lon, cached: true };
  }
  if (!org.logradouro && !org.cep && !org.cidade) return null;
  const g = await geocodeAddr(org);
  if (!g) return null;
  await query('UPDATE organizations SET origem_lat = $1, origem_lon = $2 WHERE id = $3', [g.lat, g.lon, orgId]);
  return { lat: g.lat, lon: g.lon, precisao: g.precisao, cached: false };
}
