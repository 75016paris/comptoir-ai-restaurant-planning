import { api, type AdminPreferences, type Document, type RestrictionRequest, type WorkerChecklist, type WorkerPreferredDay, type WorkerRestriction } from "@/lib/api";

export async function loadEmployeeDetail(id: string) {
  const [usersRes, openDaysRes, docsRes, holidaysRes, replacementsRes, prefRes, restrRes, prefsRes, rreqRes, checklistRes] = await Promise.all([
    api.listUsers(),
    api.getOpenDays(),
    api.getUserDocuments(id).catch(() => ({ data: [] as Document[] })),
    api.listHolidays(),
    api.allReplacements(),
    api.getPreferredSchedule(id).catch(() => ({ data: [] as WorkerPreferredDay[] })),
    api.getRestrictions(id).catch(() => ({ data: [] as WorkerRestriction[] })),
    api.getPreferences().catch(() => ({ data: {} as Partial<AdminPreferences> })),
    api.listRestrictionRequests().catch(() => ({ data: [] as RestrictionRequest[] })),
    api.getUserChecklist(id).catch(() => ({ data: null as WorkerChecklist | null })),
  ]);
  return { usersRes, openDaysRes, docsRes, holidaysRes, replacementsRes, prefRes, restrRes, prefsRes, rreqRes, checklistRes };
}

export type EmployeeDetail = Awaited<ReturnType<typeof loadEmployeeDetail>>;
