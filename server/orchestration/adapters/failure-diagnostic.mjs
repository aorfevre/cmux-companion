/** Persist structured error identity, never exception messages, argv, environment,
 * response bodies or stacks that may contain credentials or private model text.
 * @param {unknown} error @param {string} phase */
export function failureDiagnostic(error, phase) {
  const value = /** @type {{name?:unknown;code?:unknown;cause?:{code?:unknown}} | null} */ (error);
  /** @param {unknown} code */
  const safeCode = code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : typeof code === 'number' && Number.isSafeInteger(code) ? code : null;
  return { phase, name: ['Error', 'TypeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'DomainError'].includes(String(value?.name)) ? String(value?.name) : 'Error',
    code: safeCode(value?.code), causeCode: safeCode(value?.cause?.code) };
}
