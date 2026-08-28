/**
 * Minimal type declarations for Node.js `fs` and `path` modules.
 * The Obsidian community scan sandbox may not have @types/node installed,
 * so we declare the exact API surface we use here to satisfy the linter.
 */

declare module "fs" {
  export const promises: {
    readFile(path: string): Promise<Uint8Array>;
  };
}

declare module "path" {
  export function join(...paths: string[]): string;
  export function basename(path: string): string;
}
