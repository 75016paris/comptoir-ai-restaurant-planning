import { useState, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type ServiceRow } from "@/lib/api";
import { uploadReplacementDocumentFile } from "@/lib/document-upload";
import { fmtDateMed } from "@/lib/date-utils";

interface ReplacementModalProps {
  service: ServiceRow | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const labelClass = "text-[length:var(--text-xs)] tracking-wide font-bold";
const inputClass = "border-foreground/20 bg-transparent text-[length:var(--text-sm)]";

async function uploadFiles(files: File[]) {
  return Promise.all(
    files.map(async (f) => {
      const upload = await uploadReplacementDocumentFile(f);
      return {
        name: f.name,
        filename: upload.filename,
        mimeType: upload.mimeType,
        size: upload.size,
        storageKey: upload.storageKey,
      };
    }),
  );
}

export function ReplacementModal({ service, open, onClose, onSuccess }: ReplacementModalProps) {
  const { t } = useTranslation("schedule");
  const [message, setMessage] = useState("");
  const [medical, setMedical] = useState(false);
  const [medicalMode, setMedicalMode] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!service || !open) return;
    setError("");
    setSuccess(false);
    setMessage("");
    setMedical(false);
    setFiles([]);
    api.getMedicalMode().then((r) => setMedicalMode(r.data)).catch(() => setMedicalMode(false));
  }, [service, open]);

  const handleSubmit = async () => {
    if (!service) return;
    setSubmitting(true);
    setError("");
    try {
      const docs = files.length ? await uploadFiles(files) : undefined;
      await api.requestReplacement({
        requesterServiceId: service.id,
        message: message || null,
        medical: medical || undefined,
        documents: docs,
      });
      setSuccess(true);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("worker.replacementModal.submitFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  if (!service) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[length:var(--text-xl)] font-bold tracking-wide">
            {t("worker.replacementModal.title")}
          </DialogTitle>
          <DialogDescription className="text-[length:var(--text-xs)] tracking-wide">
            {fmtDateMed(service.date)} · {service.startTime.slice(0, 5)} – {service.endTime.slice(0, 5)}
          </DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="py-[var(--space-xl)] text-center">
            <p className="text-[length:var(--text-lg)] font-bold">{t("worker.replacementModal.successTitle")}</p>
            <p className="text-[length:var(--text-sm)] text-muted-foreground mt-[var(--space-sm)]">
              {t("worker.replacementModal.successBody")}
            </p>
            {medical && files.length === 0 && (
              <p className="text-[length:var(--text-xs)] text-amber-700 dark:text-amber-300 mt-[var(--space-md)]">
                {t("worker.replacementModal.ittReminder")}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-[var(--space-lg)]">
            <p className="text-[length:var(--text-sm)] text-muted-foreground">
              {t("worker.replacementModal.intro")}
            </p>

            <div className="space-y-[var(--space-xs)]">
              <Label htmlFor="replacement-message" className={labelClass}>
                {t("worker.replacementModal.reasonLabel")}
              </Label>
              <Input
                id="replacement-message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={t("worker.replacementModal.reasonPlaceholder")}
                maxLength={500}
                className={inputClass}
              />
            </div>

            {medicalMode && (
              <div className="space-y-[var(--space-sm)]">
                <button
                  type="button"
                  onClick={() => setMedical(!medical)}
                  className={`h-9 px-3 rounded-full border text-[length:var(--text-xs)] tracking-normal font-bold transition-colors ${
                    medical
                      ? "bg-foreground text-background border-foreground"
                      : "bg-transparent text-muted-foreground border-foreground/20 hover:border-foreground/40"
                  }`}
                >
                  {t("worker.replacementModal.medicalToggle")}
                </button>
                {medical && (
                  <div className="space-y-[var(--space-sm)] border-l-2 border-amber-500/40 pl-[var(--space-md)]">
                    <p className="text-[length:var(--text-xs)] text-muted-foreground leading-relaxed">
                      <Trans
                        ns="schedule"
                        i18nKey="worker.replacementModal.medicalExplanation"
                        components={{ itt: <span className="font-bold" /> }}
                      />
                    </p>
                    <FileDropZone files={files} onChange={setFiles} />
                  </div>
                )}
              </div>
            )}

            {error && (
              <p className="text-destructive text-[length:var(--text-sm)] font-bold">{error}</p>
            )}

            <Button
              onClick={handleSubmit}
              disabled={submitting}
              className="w-full tracking-wide text-[length:var(--text-xs)] font-bold h-[var(--space-2xl)]"
            >
              {submitting ? t("worker.timeclock.tapping") : t("worker.replacementModal.submit")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FileDropZone({ files, onChange }: { files: File[]; onChange: (files: File[]) => void }) {
  const { t } = useTranslation("schedule");
  const [dragActive, setDragActive] = useState(false);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files);
    onChange([...files, ...dropped].slice(0, 5));
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
      onDragLeave={() => setDragActive(false)}
      onDrop={onDrop}
      className={`border border-dashed rounded p-[var(--space-md)] text-center transition-colors ${
        dragActive ? "border-foreground bg-accent/30" : "border-foreground/20"
      }`}
    >
      <p className="text-[length:var(--text-xs)] text-muted-foreground">
        {t("worker.replacementModal.fileDropZone")}
        <label className="underline cursor-pointer">
          {t("worker.replacementModal.fileDropZoneBrowse")}
          <input
            type="file"
            multiple
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, 5))}
          />
        </label>
      </p>
      {files.length > 0 && (
        <ul className="mt-[var(--space-sm)] text-[length:var(--text-xs)] space-y-[var(--space-xs)]">
          {files.map((f, i) => (
            <li key={i} className="flex items-center justify-between gap-[var(--space-sm)]">
              <span className="truncate">{f.name}</span>
              <button
                type="button"
                onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="text-muted-foreground hover:text-destructive"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
