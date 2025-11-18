import { UUID } from "crypto";

export function uuidToWebSafeBase64(uuid: UUID): string {
  return uuid.replace(/-/g, "_") + ".".repeat(44 - uuid.length);
}
