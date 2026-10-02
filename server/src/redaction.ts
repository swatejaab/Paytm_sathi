export function redactContactIdentifiers(text: string): string {
  return text
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(?<!\d)(?:\+?91[\s-]?)?[6-9]\d{9}(?!\d)/g, '[REDACTED_PHONE]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[REDACTED_ID]')
    .replace(/(?<!\d)(?:\d[ -]?){11,18}\d(?!\d)/g, '[REDACTED_ID]');
}
