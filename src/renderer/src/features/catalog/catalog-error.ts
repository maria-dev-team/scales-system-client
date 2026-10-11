export function catalogErrorMessage(error: unknown): string {
  const text =
    error instanceof Error ? error.message : 'Не удалось выполнить действие.';
  return text.replace(
    /^Error invoking remote method ['"]catalog:request['"]:\s*(?:Error:\s*)?/,
    '',
  );
}
