declare module "*octri_parser.js" {
  export default function init(input?: unknown): Promise<unknown>;
  export function execute(request: string): string;
  export function execute_document(request: string): string;
  export function serialize_document(
    document: string,
    format: string,
    limits: string,
  ): string;
}
