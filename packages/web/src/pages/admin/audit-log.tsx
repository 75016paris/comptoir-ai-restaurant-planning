import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api, type AuditLogEntry } from "@/lib/api";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fmtTime } from "@/lib/date-utils";
import { ArrowRight, ChevronDown, ChevronUp, Filter, RefreshCw } from "lucide-react";

const TABLE_KEYS = ["services", "holiday_requests", "replacement_requests", "restaurant_closures", "restaurants"] as const;
const SOURCE_KEYS = ["dashboard", "bot:admin", "bot:worker", "auto-scheduler", "cron"] as const;
const ACTION_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  insert: "default",
  update: "secondary",
  delete: "destructive",
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  // Day + month (numeric, locale-aware) — kept inline for compactness
  const datePart = new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "2-digit" }).format(d);
  return `${datePart} ${fmtTime(d)}`;
}

function ChangesDetail({ changes, t }: { changes: Record<string, { old?: unknown; new?: unknown }> | null; t: ReturnType<typeof useTranslation>["t"] }) {
  if (!changes) return null;
  const entries = Object.entries(changes);
  if (entries.length === 0) return null;

  return (
    <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
      {entries.slice(0, 6).map(([field, vals]) => (
        <div key={field} className="flex gap-1 flex-wrap">
          <span className="font-medium">{field}:</span>
          {vals.old !== undefined && (
            <span className="line-through text-red-500/70">{String(vals.old ?? "∅")}</span>
          )}
          {vals.old !== undefined && vals.new !== undefined && <ArrowRight className="size-3 inline" />}
          {vals.new !== undefined && (
            <span className="text-green-600 dark:text-green-400">{String(vals.new ?? "∅")}</span>
          )}
        </div>
      ))}
      {entries.length > 6 && (
        <div className="text-muted-foreground/60">{t("moreFields", { count: entries.length - 6 })}</div>
      )}
    </div>
  );
}

export function AuditLogPage() {
  const { t } = useTranslation("audit");
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [fromDate, setFromDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [tableFilter, setTableFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getAuditLogs({
        from: fromDate,
        to: toDate,
        tableName: tableFilter || undefined,
        action: actionFilter || undefined,
        source: sourceFilter || undefined,
        limit: 100,
      });
      setLogs(res.data);
    } catch (e) {
      console.error("Failed to load audit logs", e);
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, tableFilter, actionFilter, sourceFilter]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const tableLabel = (k: string) => t(`tables.${k}`, { defaultValue: k });
  const actionLabel = (k: string) => t(`actions.${k}`, { defaultValue: k });
  const sourceLabel = (k: string) => t(`sources.${k}`, { defaultValue: k });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">{t("title")}</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
          >
            <Filter className="h-4 w-4 mr-1" />
            {t("buttons.filters")}
          </Button>
          <Button variant="outline" size="sm" onClick={fetchLogs} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
            {t("buttons.refresh")}
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-3 p-3 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t("filters.from")}</label>
            <Input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="h-8 w-36 text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">{t("filters.to")}</label>
            <Input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="h-8 w-36 text-xs"
            />
          </div>
          <select
            value={tableFilter}
            onChange={(e) => setTableFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t("filters.allTables")}</option>
            {TABLE_KEYS.map((k) => (
              <option key={k} value={k}>{tableLabel(k)}</option>
            ))}
          </select>
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t("filters.allActions")}</option>
            <option value="insert">{actionLabel("insert")}</option>
            <option value="update">{actionLabel("update")}</option>
            <option value="delete">{actionLabel("delete")}</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            <option value="">{t("filters.allSources")}</option>
            {SOURCE_KEYS.map((k) => (
              <option key={k} value={k}>{sourceLabel(k)}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-muted-foreground py-12">{t("loading")}</div>
      ) : logs.length === 0 ? (
        <div className="text-center text-sm text-muted-foreground py-12">{t("empty")}</div>
      ) : (
        <div className="border rounded-lg overflow-x-auto scrollbar-none">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">{t("table.headers.date")}</TableHead>
                <TableHead className="w-[100px]">{t("table.headers.table")}</TableHead>
                <TableHead className="w-[80px]">{t("table.headers.action")}</TableHead>
                <TableHead className="w-[100px] hidden sm:table-cell">{t("table.headers.source")}</TableHead>
                <TableHead className="w-[120px] hidden sm:table-cell">{t("table.headers.actor")}</TableHead>
                <TableHead>{t("table.headers.summary")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const variant = ACTION_VARIANTS[log.action] ?? "outline";
                const isExpanded = expandedId === log.id;

                return (
                  <TableRow
                    key={log.id}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDateTime(log.createdAt)}
                    </TableCell>
                    <TableCell>
                      <span className="text-xs">{tableLabel(log.tableName)}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={variant} className="text-[10px]">
                        {actionLabel(log.action)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="text-xs text-muted-foreground">
                        {sourceLabel(log.source)}
                      </span>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <span className="text-xs">{log.actorName || t("system")}</span>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        {log.summary || t("summaryDash")}
                        {isExpanded && <ChangesDetail changes={log.changes} t={t} />}
                      </div>
                      {log.changes && (
                        isExpanded
                          ? <ChevronUp className="inline h-3 w-3 ml-1 text-muted-foreground" />
                          : <ChevronDown className="inline h-3 w-3 ml-1 text-muted-foreground" />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {!loading && logs.length >= 100 && (
        <div className="text-center text-xs text-muted-foreground">
          {t("limitedNote")}
        </div>
      )}
    </div>
  );
}
