// Loads data/knowledge_base.json into the Cognee dataset, builds the knowledge graph, and runs a test search.
import fs from 'node:fs';
import path from 'node:path';
import { addTexts, cognify, datasetReady, entryText, searchChunks, type KnowledgeEntry } from '../src/cognee';
import { cogneeAvailable, DATA_DIR, settings } from '../src/config';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!cogneeAvailable()) throw new Error('Set COGNEE_ENABLED=true, COGNEE_API_KEY, and COGNEE_BASE_URL in .env first.');
  const kb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'knowledge_base.json'), 'utf8')) as { entries: KnowledgeEntry[] };
  const dataset = settings.cogneeDataset;
  console.log(`Adding ${kb.entries.length} entries to Cognee dataset "${dataset}"...`);
  const { dataset_id } = await addTexts(dataset, kb.entries.map(entryText));
  console.log('Building the knowledge graph (cognify)...');
  await cognify(dataset);
  for (let attempt = 0; dataset_id && attempt < 60; attempt += 1) {
    if (await datasetReady(dataset_id)) break;
    await sleep(5000);
  }
  const hits = await searchChunks('Is room rent fully covered by my health policy?', [dataset], 2);
  console.log('Test search:', hits.map((hit) => `${hit.entry_id} (${hit.title})`).join('; ') || 'no hits yet');
  console.log('Done.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
