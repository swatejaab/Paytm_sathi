import { EventEmitter } from 'node:events';

// In-process change feed: every persisted case update is announced here for live streams.
const bus = new EventEmitter();
bus.setMaxListeners(500);

export const announceCaseUpdate = (caseId: string): void => {
  bus.emit(caseId);
};

export function onCaseUpdate(caseId: string, listener: () => void): () => void {
  bus.on(caseId, listener);
  return () => bus.off(caseId, listener);
}
