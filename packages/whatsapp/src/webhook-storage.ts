import { apiPostInternal } from "./api-client.js";

export async function expireOldMessages(): Promise<void> {
  await apiPostInternal("/chat/expire-old", {});
}

export async function saveUploadedDocument(input: {
  userId: string;
  restaurantId: string;
  name: string;
  filename: string;
  mimeType: string;
  size: number;
  base64: string;
  isSignedContract?: boolean;
}): Promise<void> {
  await apiPostInternal("/documents/upload", input);
}
