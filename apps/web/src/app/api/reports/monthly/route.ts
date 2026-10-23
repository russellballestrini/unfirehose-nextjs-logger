import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@unturf/unfirehose/db/schema';
import { getAllSettings } from '@unturf/unfirehose/db/ingest';
import { readProjectList } from '@unturf/unfirehose/projects-list';
import {
  buildMonthlyCostReport, costReportCsv, costReportKey, fileReport, readFiledReport,
  isValidMonth, isValidTimeZone, monthBounds, previousMonth, type MonthlyCostReport,
} from '@unturf/unfirehose/cost-report';
import { reportCurrencyCode, reportRate, rateDateFor } from '@/lib/report-currency';
import { readClaudePlanIdentity, claudePlanForReport } from '@/lib/claude-plan';
import { costReportPdf } from '@/lib/cost-report-pdf';
import { hasAny } from '@/lib/ever';

/**
 * GET /api/reports/monthly?month=2026-10&tz=America/New_York&format=json|csv|pdf
 *
 * One calendar month of spend, for an expense claim (ticket 4009). The month
 * is read in `tz` (the server's zone when absent), amounts are converted to
 * the first currency in Settings → display_currency at that month's
 * published rate, and a closed month is filed the first time it is built:
 * every later download is that document, not a rebuild against a newer
 * ledger. `rebuild=1` files it again.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const tz = q.get('tz') || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  if (!isValidTimeZone(tz)) return NextResponse.json({ error: `Unknown time zone "${tz}"` }, { status: 400 });
  const month = q.get('month') || previousMonth(tz);
  if (!isValidMonth(month)) return NextResponse.json({ error: `Not a month: "${month}" (want YYYY-MM)` }, { status: 400 });
  const format = q.get('format') ?? 'json';
  if (!['json', 'csv', 'pdf'].includes(format)) return NextResponse.json({ error: `Unknown format "${format}"`, formats: ['json', 'csv', 'pdf'] }, { status: 400 });
  if (monthBounds(month, tz).start > Date.now()) return NextResponse.json({ error: `${month} has not started` }, { status: 400 });

  let report: MonthlyCostReport;
  try {
    const settings = getAllSettings();
    const code = reportCurrencyCode(settings);
    const key = costReportKey(month, tz, code);
    const filed = q.get('rebuild') === '1' ? null : readFiledReport(key);
    if (filed) {
      report = filed;
    } else {
      const folded = readProjectList(Infinity)?.payload ?? [];
      const [currency, plan] = await Promise.all([
        reportRate(code, rateDateFor(month), { oracleDisabled: settings.mesh_currency_oracle === 'false' }),
        readClaudePlanIdentity(),
      ]);
      report = buildMonthlyCostReport(getDb(), {
        month, timeZone: tz, settings, currency,
        claudePlan: claudePlanForReport(plan),
        repoNames: folded.map((p) => p.name),
        displayNames: new Map(folded.map((p) => [p.name, p.displayName])),
      });
      // A rate that failed is not filed: the next download tries again
      // rather than keeping a dollar copy of a month asked for in euros.
      if (report.closed && !report.currency.fallbackReason) fileReport(key, report);
    }
  } catch (err) {
    return NextResponse.json({ error: 'Failed to build cost report', detail: String(err) }, { status: 500 });
  }

  const name = `unfirehose-costs-${report.month}`;
  const headers = { 'X-Computed-At': report.generatedAt, 'Cache-Control': 'no-store' };
  if (format === 'csv') {
    return new NextResponse(costReportCsv(report), {
      headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}.csv"` },
    });
  }
  if (format === 'pdf') {
    const pdf = await costReportPdf(report);
    return new NextResponse(Buffer.from(pdf), {
      headers: { ...headers, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}.pdf"` },
    });
  }
  // For the page only, never filed with the report or printed on a claim:
  // whether a month with no lines is a quiet one or a fresh install.
  return NextResponse.json({ ...report, hasAnyMessages: hasAny(getDb(), 'messages') }, { headers });
}
