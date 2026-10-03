import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { CaseRecord, CaseSummary, IntegrationStatus } from '../types';
import { CasePanel } from './CasePanel';
import { Conversation } from './Conversation';

export function CustomerWorkspace({
  integrations,
  seed,
  onSeedUsed,
}: {
  integrations: IntegrationStatus;
  seed?: { text: string; nonce: number; hint?: boolean } | null;
  onSeedUsed?: () => void;
}) {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [activeCase, setActiveCase] = useState<CaseRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCases = useCallback(async () => {
    try {
      setCases((await api.listCases()).cases);
    } catch {
      setCases([]);
    }
  }, []);

  useEffect(() => {
    void refreshCases();
  }, [refreshCases]);

  const updateCase = useCallback(
    (record: CaseRecord) => {
      setActiveCase(record);
      void refreshCases();
    },
    [refreshCases],
  );

  const submit = async (message: string, consent: boolean, language: string, ai: boolean) => {
    setBusy(true);
    setError(null);
    try {
      updateCase(await api.createCase(message, consent, language || undefined, ai));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'I could not save this case. No financial action was started.');
    } finally {
      setBusy(false);
    }
  };

  const ask = async (message: string, language: string) => {
    if (!activeCase) return;
    setBusy(true);
    setError(null);
    try {
      updateCase(await api.chat(activeCase.case_id, message, language || undefined));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Saathi AI could not answer. Your case is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const openCase = async (caseId: string) => {
    setError(null);
    try {
      setActiveCase(await api.getCase(caseId));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open the case.');
    }
  };

  return (
    <main className="workspace">
      <Conversation
        activeCase={activeCase}
        cases={cases}
        busy={busy}
        error={error}
        integrations={integrations}
        onSubmit={async (message, consent, language, ai) => {
          onSeedUsed?.();
          await submit(message, consent, language, ai);
        }}
        seed={seed}
        onAsk={ask}
        onOpenCase={openCase}
        onNewCase={() => setActiveCase(null)}
      />
      <CasePanel caseRecord={activeCase} onChange={updateCase} integrations={integrations} readOnly={false} />
    </main>
  );
}
