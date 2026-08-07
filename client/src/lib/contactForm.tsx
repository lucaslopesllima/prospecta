import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { CompanyHit, Contact, RepresentedCompany } from './types.ts';
import { Btn, inputCls, Modal } from './ui.tsx';
import { Icon } from './icons.tsx';
import { CompanySearch } from './companySearch.tsx';
import { toast } from './toast.tsx';
import { isEmail, maskPhone } from './format.ts';

// Alias histórico do campo padrão — mantido para não quebrar quem importa daqui.
export const contactInputCls = inputCls;

export type ContactForm = {
  nome: string; cargo: string; email: string; telefone: string; represented_id: string;
  company_id: number | null; company_name: string | null;
};
export const EMPTY_CONTACT: ContactForm = { nome: '', cargo: '', email: '', telefone: '', represented_id: '', company_id: null, company_name: null };
export const toContactForm = (c: Contact): ContactForm => ({
  nome: c.nome, cargo: c.cargo ?? '', email: c.email ?? '', telefone: c.telefone ?? '',
  represented_id: c.represented_id != null ? String(c.represented_id) : '',
  company_id: c.company_id ?? null, company_name: c.company_name ?? null,
});
export function contactBody(f: ContactForm): Record<string, unknown> {
  const t = (s: string): string | null => (s.trim() === '' ? null : s.trim());
  return {
    nome: f.nome.trim(), cargo: t(f.cargo), email: t(f.email), telefone: t(f.telefone),
    represented_id: f.represented_id === '' ? null : Number(f.represented_id),
    company_id: f.company_id,
  };
}

export function ContatoForm({ inputCls, reps, initial, onSave, onCancel }: {
  inputCls: string; reps: RepresentedCompany[]; initial: ContactForm;
  onSave: (f: ContactForm) => void | Promise<void>; onCancel: () => void;
}): React.JSX.Element {
  const [f, setF] = useState<ContactForm>(initial);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof ContactForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!f.nome.trim()) return;
    if (f.email.trim() && !isEmail(f.email)) { toast.error('E-mail inválido.'); return; }
    setBusy(true);
    try { await onSave(f); } finally { setBusy(false); }
  };

  const pickCompany = (c: CompanyHit): void =>
    setF((p) => ({ ...p, company_id: c.id, company_name: c.nome_fantasia || c.razao_social }));
  const clearCompany = (): void => setF((p) => ({ ...p, company_id: null, company_name: null }));

  return (
    <form onSubmit={submit} className="space-y-2.5">
      <input autoFocus value={f.nome} onChange={set('nome')} maxLength={120} placeholder="Nome *" className={inputCls} />
      <div className="grid gap-2.5 sm:grid-cols-2">
        <input value={f.cargo} onChange={set('cargo')} maxLength={120} placeholder="Cargo (ex.: Comprador)" className={inputCls} />
        <select value={f.represented_id} onChange={set('represented_id')} className={inputCls}>
          <option value="">Representada (opcional)</option>
          {reps.map((r) => <option key={r.id} value={r.id}>{r.nome}</option>)}
        </select>
        <input type="email" value={f.email} onChange={set('email')} maxLength={160} placeholder="E-mail" className={inputCls} />
        <input value={f.telefone} inputMode="tel" onChange={(e) => setF((p) => ({ ...p, telefone: maskPhone(e.target.value) }))} placeholder="Telefone" className={inputCls} />
      </div>
      <div>
        {f.company_id != null ? (
          <div className="flex items-center gap-2 rounded-xl border border-ink-200 bg-ink-50/50 px-3 py-2">
            <Icon name="building" size={16} className="shrink-0 text-ink-400" />
            <span className="min-w-0 flex-1 truncate text-sm text-ink-800">{f.company_name ?? `Empresa #${f.company_id}`}</span>
            <button type="button" onClick={clearCompany} aria-label="Remover empresa"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-ink-100"><Icon name="x" size={15} /></button>
          </div>
        ) : (
          <CompanySearch onPick={pickCompany} placeholder="Empresa-prospect (opcional) — buscar por CNPJ ou nome…" />
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" type="button" onClick={onCancel}>Cancelar</Btn>
        <Btn icon="check" type="submit" disabled={busy}>{busy ? '…' : 'Salvar'}</Btn>
      </div>
    </form>
  );
}

// Modal com o componente de criação de contatos default — usado fora da página de
// Contatos (ex.: "Adicionar aos contatos" na busca de empresas). Carrega as
// representadas por conta própria e faz o POST em /api/contacts.
export function NewContactModal({ initial, onClose, onCreated }: {
  initial: ContactForm; onClose: () => void; onCreated?: (c: Contact) => void;
}): React.JSX.Element {
  const [reps, setReps] = useState<RepresentedCompany[]>([]);
  useEffect(() => {
    void api.get<{ empresas: RepresentedCompany[] }>('/api/represented')
      .then((r) => setReps(r.empresas ?? [])).catch(() => undefined);
  }, []);

  const save = async (f: ContactForm): Promise<void> => {
    try {
      const r = await api.post<{ contact: Contact }>('/api/contacts', contactBody(f));
      toast.success('Contato criado.');
      onCreated?.(r.contact);
      onClose();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Não foi possível criar o contato.'); }
  };

  return (
    // level 1: costuma abrir POR CIMA do modal da empresa.
    <Modal onClose={onClose} width="lg" level={1}
      title={<span className="inline-flex items-center gap-2"><Icon name="users" size={17} className="text-ink-400" /> Novo contato</span>}>
      <div className="py-1">
        <ContatoForm inputCls={contactInputCls} reps={reps} initial={initial} onSave={save} onCancel={onClose} />
      </div>
    </Modal>
  );
}
