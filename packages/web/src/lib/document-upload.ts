import { api, type PresignResult } from "./api";

export interface UploadedFileMeta {
  filename: string;
  mimeType: string;
  size: number;
  storageKey: string;
}

async function presignedUpload(
  file: File,
  presign: () => Promise<{ data: PresignResult }>,
): Promise<UploadedFileMeta> {
  const { data: presigned } = await presign();
  const put = await fetch(presigned.uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
  if (!put.ok) {
    throw new Error(`Upload failed (${put.status})`);
  }
  return {
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    storageKey: presigned.storageKey,
  };
}

export function uploadUserDocumentFile(userId: string, file: File): Promise<UploadedFileMeta> {
  return presignedUpload(file, () =>
    api.presignUserDocument(userId, { filename: file.name, mimeType: file.type, size: file.size }),
  );
}

export function uploadHolidayDocumentFile(file: File): Promise<UploadedFileMeta> {
  return presignedUpload(file, () =>
    api.presignHolidayDocument({ filename: file.name, mimeType: file.type, size: file.size }),
  );
}

export function uploadReplacementDocumentFile(file: File): Promise<UploadedFileMeta> {
  return presignedUpload(file, () =>
    api.presignReplacementDocument({ filename: file.name, mimeType: file.type, size: file.size }),
  );
}
