// Preenche contato_compartilhado (migração 075): telefones e e-mails que se
// repetem entre empresas diferentes — sinal de contato de contabilidade.
//
// Roda em minutos (varredura completa das ~29M linhas de companies + sort), por
// isso NÃO fica numa migração de boot: o healthcheck do deploy derrubaria o app
// antes de terminar. Rode junto do ETL ou sob demanda:
//   docker compose exec app node scripts/contatos-compartilhados.ts
//
// Recarrega tudo a cada execução (TRUNCATE + INSERT) dentro de uma transação:
// os dados vêm inteiros da RFB, não há atualização incremental a fazer.
import { pool } from '../src/db.ts';

// > 3 CNPJs raiz distintos. Contar raiz (e não linha) é o que separa
// contabilidade de matriz+filiais, que compartilham telefone legitimamente.
const LIMITE = 3;

// Placeholders da RFB batem o limite com folga mas não são contato de ninguém —
// entrar aqui viraria um "provável contabilidade" mentiroso. Os campeões da base
// são 000000000000 (1,2M empresas), 1199999999 (39k), 2122222222, 1100000000 e
// fragmentos como '110'/'210'.
//
// Duas regras pegam todos sem tocar em número real: curto demais para ser
// telefone, ou corpo (pós-DDD) de um dígito só repetido. Confere: 4197880145 e
// 1130034828 passam; 2199999999 e 1100000000 caem.
const NAO_PLACEHOLDER = "length(valor) >= 10 AND substr(valor, 3) !~ '^(.)\\1*$'";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('==> recalculando contato_compartilhado (varredura completa; alguns minutos)');
    const t0 = Date.now();
    await client.query('BEGIN');
    // O pool corta query em 30s (db.ts); a varredura das ~29M linhas leva
    // minutos. LOCAL: volta ao normal no COMMIT, sem contaminar a conexão que
    // retorna pro pool.
    await client.query('SET LOCAL statement_timeout = 0');
    await client.query('TRUNCATE contato_compartilhado');

    // telefone1 e telefone2 entram no mesmo balde: o mesmo número pode estar
    // como principal numa empresa e secundário em outra.
    const tel = await client.query(
      `INSERT INTO contato_compartilhado (tipo, valor, empresas)
       SELECT 'telefone', valor, count(DISTINCT cnpj_base)
         FROM (
           SELECT telefone1 AS valor, left(cnpj, 8) AS cnpj_base FROM companies
             WHERE telefone1 IS NOT NULL AND telefone1 <> '' AND source <> 'demo'
           UNION ALL
           SELECT telefone2, left(cnpj, 8) FROM companies
             WHERE telefone2 IS NOT NULL AND telefone2 <> '' AND source <> 'demo'
         ) t
        WHERE ${NAO_PLACEHOLDER}
        GROUP BY 1, 2
       HAVING count(DISTINCT cnpj_base) > $1`,
      [LIMITE],
    );
    console.log(`    telefones compartilhados: ${tel.rowCount}`);

    const mail = await client.query(
      `INSERT INTO contato_compartilhado (tipo, valor, empresas)
       SELECT 'email', lower(email), count(DISTINCT left(cnpj, 8))
         FROM companies
        WHERE email IS NOT NULL AND email <> '' AND source <> 'demo'
        GROUP BY 1, 2
       HAVING count(DISTINCT left(cnpj, 8)) > $1`,
      [LIMITE],
    );
    console.log(`    e-mails compartilhados: ${mail.rowCount}`);

    await client.query('COMMIT');
    await client.query('ANALYZE contato_compartilhado');
    console.log(`==> pronto em ${Math.round((Date.now() - t0) / 1000)}s`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
