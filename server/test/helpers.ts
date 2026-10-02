import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app';
import type { CaseRecord } from '../src/types';

export const app = createApp();
export const api = () => request(app);

export const HOSPITAL_MESSAGE = 'Papa hospital mein hain. Bill INR 80,000 hai. Insurance hai, ab kya karun?';
export const UPI_MESSAGE = 'Mere account se INR 8,500 ka UPI payment hua jo maine nahi kiya. Kya karun?';

export async function login(userId = 'demo-customer-01', passcode = '2468'): Promise<string> {
  const response = await api().post('/api/auth/login').send({ user_id: userId, passcode });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.access_token as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function createCase(token: string, message = HOSPITAL_MESSAGE, consent = true): Promise<CaseRecord> {
  const response = await api()
    .post('/api/cases/intake')
    .set(bearer(token))
    .send({ message, consent_to_read_case_data: consent });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as CaseRecord;
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for condition');
}

export function buildPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
