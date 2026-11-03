import type { AnalyticsRange, OverviewAnalytics } from "../repositories/centralActivityRepository.js";

/** Executa SQL (SQLite ou MySQL) e devolve as linhas. Os dois dialetos aceitam este SQL (somente substr/COUNT/GROUP BY). */
export type QueryFn = (sql: string, params: Array<string | number>) => Promise<Array<Record<string, unknown>>>;

export interface Point {
  label: string;
  value: number;
}

export interface MarketingSummary {
  generatedAt: string;
  range: { from: string; to: string };
  /** Clientes que entram na Central do Cliente (mesmos numeros do Analytics do admin). */
  customers: {
    accesses: number;
    uniqueClients: number;
    newClients: number;
    returningClients: number;
    accessesToday: number;
    uniqueClientsToday: number;
    uniqueClients7d: number;
    uniqueClients30d: number;
    accessesByDay: Point[];
    uniqueClientsByDay: Point[];
    accessesByHour: Point[];
    devices: Point[];
    pages: Point[];
  };
  /** Sessoes de login na Central do Cliente. */
  sessions: {
    inRange: number;
    total: number;
    averageSeconds: number | null;
    loginsByDay: Point[];
  };
  /** Contas de cliente criadas (primeiro acesso a Central). */
  accounts: {
    total: number;
    createdInRange: number;
    firstAccessCompleted: number;
    createdByDay: Point[];
  };
  /** Chamados abertos pelo site (Central do Cliente) e outras acoes de autoatendimento. */
  tickets: {
    openedInRange: number;
    openedByDay: Point[];
    secondCopies: number;
    invoiceQueries: number;
    connectionQueries: number;
    paymentPromises: number;
  };
  /** Contratacao online. */
  contracts: {
    total: number;
    marketingOptIn: number;
    byStatus: Point[];
    byPlan: Point[];
    byCity: Point[];
    byDay: Point[];
  };
  /** Interesse em planos (formulario de plano). */
  planLeads: { total: number; byPlan: Point[]; byDay: Point[] };
  /** Wi-Fi publico (AcessaNet Connect): visitantes e sessoes. */
  wifi: {
    visitorsTotal: number;
    visitorsInRange: number;
    marketingLeads: number;
    sessionsInRange: number;
    sessionsByDay: Point[];
  };
  /** Outros formularios do site. */
  forms: { jobApplications: number; bugReports: number; bugReportsByStatus: Point[] };
}

const DAY = "substr(created_at, 1, 10)";

export class MarketingStatsRepository {
  constructor(private readonly run: QueryFn) {}

  /** Tabela ausente (por exemplo, Wi-Fi ainda nao usado) vira zero, nunca derruba o resumo inteiro. */
  private async rows(sql: string, params: Array<string | number> = []) {
    try {
      return await this.run(sql, params);
    } catch {
      return [];
    }
  }

  private async count(sql: string, params: Array<string | number> = []) {
    const [row] = await this.rows(sql, params);
    const n = Number(row?.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  private async points(sql: string, params: Array<string | number> = []): Promise<Point[]> {
    const rows = await this.rows(sql, params);
    return rows.map((r) => ({ label: String(r.label ?? "—"), value: Number(r.value ?? 0) }));
  }

  async summary(range: AnalyticsRange, overview: OverviewAnalytics): Promise<MarketingSummary> {
    const p: Array<string | number> = [range.from.toISOString(), range.to.toISOString()];
    const between = "created_at >= ? AND created_at < ?";
    const grouped = (table: string, where = "") => this.points(`SELECT ${DAY} AS label, COUNT(*) AS value FROM ${table} WHERE ${between}${where} GROUP BY label ORDER BY label ASC`, p);
    const top = (table: string, column: string, limit = 8) =>
      this.points(`SELECT COALESCE(NULLIF(${column}, ''), '—') AS label, COUNT(*) AS value FROM ${table} WHERE ${between} GROUP BY label ORDER BY value DESC LIMIT ${limit}`, p);
    const events = new Map(overview.charts.events.map((e) => [e.label, e.value]));

    const [
      accountsTotal, accountsInRange, firstAccess, accountsByDay,
      loginsByDay, openedByDay,
      contractsTotal, contractsOptIn, contractsByStatus, contractsByPlan, contractsByCity, contractsByDay,
      leadsTotal, leadsByPlan, leadsByDay,
      wifiTotal, wifiInRange, wifiLeads, wifiSessions, wifiSessionsByDay,
      jobs, bugs, bugsByStatus
    ] = await Promise.all([
      this.count("SELECT COUNT(*) AS value FROM customer_auth_profiles"),
      this.count(`SELECT COUNT(*) AS value FROM customer_auth_profiles WHERE ${between}`, p),
      this.count("SELECT COUNT(*) AS value FROM customer_auth_profiles WHERE first_access_completed = 1"),
      grouped("customer_auth_profiles"),
      grouped("central_activity_logs", " AND event_type = 'LOGIN'"),
      grouped("central_activity_logs", " AND event_type = 'OPEN_TICKET'"),
      this.count(`SELECT COUNT(*) AS value FROM contract_requests WHERE ${between}`, p),
      this.count(`SELECT COUNT(*) AS value FROM contract_requests WHERE ${between} AND marketing_opt_in = 1`, p),
      top("contract_requests", "status"),
      top("contract_requests", "plan_name"),
      top("contract_requests", "city"),
      grouped("contract_requests"),
      this.count(`SELECT COUNT(*) AS value FROM plan_leads WHERE ${between}`, p),
      top("plan_leads", "plan_name"),
      grouped("plan_leads"),
      this.count("SELECT COUNT(*) AS value FROM wifi_visitors"),
      this.count(`SELECT COUNT(*) AS value FROM wifi_visitors WHERE ${between}`, p),
      this.count(
        `SELECT COUNT(*) AS value FROM wifi_visitors v WHERE (SELECT c.granted FROM wifi_consents c WHERE c.visitor_id = v.id AND c.purpose = 'marketing' ORDER BY c.id DESC LIMIT 1) = 1`
      ),
      this.count(`SELECT COUNT(*) AS value FROM wifi_sessions WHERE ${between}`, p),
      grouped("wifi_sessions"),
      this.count(`SELECT COUNT(*) AS value FROM job_applications WHERE ${between}`, p),
      this.count(`SELECT COUNT(*) AS value FROM bug_reports WHERE ${between}`, p),
      top("bug_reports", "status")
    ]);

    return {
      generatedAt: new Date().toISOString(),
      range: overview.range,
      customers: {
        accesses: overview.totals.accesses,
        uniqueClients: overview.totals.uniqueClients,
        newClients: overview.totals.newClients,
        returningClients: overview.totals.returningClients,
        accessesToday: overview.cards.accessesToday,
        uniqueClientsToday: overview.cards.uniqueClientsToday,
        uniqueClients7d: overview.cards.uniqueClients7d,
        uniqueClients30d: overview.cards.uniqueClients30d,
        accessesByDay: overview.charts.accessesByDay,
        uniqueClientsByDay: overview.charts.uniqueClientsByDay,
        accessesByHour: overview.charts.accessesByHour,
        devices: overview.charts.devices,
        pages: overview.charts.pages
      },
      sessions: {
        inRange: overview.totals.sessions,
        total: overview.cards.totalSessions,
        averageSeconds: overview.totals.averageSessionSeconds,
        loginsByDay
      },
      accounts: { total: accountsTotal, createdInRange: accountsInRange, firstAccessCompleted: firstAccess, createdByDay: accountsByDay },
      tickets: {
        openedInRange: overview.cards.ticketsOpened,
        openedByDay,
        secondCopies: overview.cards.secondCopiesGenerated,
        invoiceQueries: overview.cards.invoiceQueries,
        connectionQueries: overview.cards.connectionQueries,
        paymentPromises: events.get("REQUEST_PAYMENT_PROMISE") ?? 0
      },
      contracts: { total: contractsTotal, marketingOptIn: contractsOptIn, byStatus: contractsByStatus, byPlan: contractsByPlan, byCity: contractsByCity, byDay: contractsByDay },
      planLeads: { total: leadsTotal, byPlan: leadsByPlan, byDay: leadsByDay },
      wifi: { visitorsTotal: wifiTotal, visitorsInRange: wifiInRange, marketingLeads: wifiLeads, sessionsInRange: wifiSessions, sessionsByDay: wifiSessionsByDay },
      forms: { jobApplications: jobs, bugReports: bugs, bugReportsByStatus: bugsByStatus }
    };
  }
}
