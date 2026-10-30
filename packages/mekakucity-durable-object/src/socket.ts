import type { ActorSocketResultSuccess } from "@mekakucity/actors";

export const socketAttachmentScope = async (scope: string): Promise<string> => {
  const bytes = new TextEncoder().encode(scope);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

export interface ActorHostSocketOptions<Attachment = unknown, Carried = unknown> {
  accept(request: Request): { readonly attachment: Attachment; readonly scope: string } | Response
    | Promise<{ readonly attachment: Attachment; readonly scope: string } | Response>;
  carried(attachment: Attachment): Carried;
}

export interface StoredSocketCallResult {
  readonly expiresAt: number;
  readonly result: ActorSocketResultSuccess;
}

export interface ActorHostSocketAttachment<Attachment = unknown> {
  readonly user: Attachment;
  readonly scope: string;
  readonly keys: string[];
}

export interface StoredSocketLiveValue {
  readonly value: unknown;
  readonly version: number;
}
