type DocumentBlobLike = {
  mimeType: string;
  data?: string;
  url?: string;
};

export function documentSrc(doc: DocumentBlobLike): string {
  if (doc.url) return doc.url;
  if (doc.data) return `data:${doc.mimeType};base64,${doc.data}`;
  return "";
}
