/** Reads a `SYMBRA_<name>` environment variable. */
export function envFlag(name: string): string | undefined {
  return process.env[`SYMBRA_${name}`];
}
