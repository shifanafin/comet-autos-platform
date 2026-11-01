import Link from 'next/link';
import { ArrowRight, CheckCircle2, Package, ShieldCheck, Wrench, XCircle } from 'lucide-react';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import type { RepairWorkspace } from '@/lib/workshop/repair';
import type { JobWorkspace } from '@/lib/workshop/workspace';
import { StagePhotosPanel } from '@/components/media/stage-photos-panel';
import { employeeName } from '@/lib/workshop/assignment';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  formatMilli,
  milliToString,
  multiplyQuantity,
  filsToString,
  signedToMilli,
} from '@/lib/money';
import { Panel, Section, Stack } from '@/components/layout/primitives';
import { StatusPill } from '@/components/shared/status-pill';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { InlineForm } from '@/components/shared/inline-form';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import type { EmployeeOption } from '@/components/workshop/technician-form';
import { cn } from '@/lib/utils';
import {
  AdditionalWorkForm,
  LabourForm,
  PartUsageForm,
  QualityCheckForm,
  ReturnPartButton,
} from './repair-forms';

const PROGRESS = {
  NOT_STARTED: { tone: 'neutral', label: 'To do' },
  PARTLY_DONE: { tone: 'warning', label: 'Partly done' },
  DONE: { tone: 'success', label: 'Done' },
} as const;

function NotApprovedPill() {
  return <StatusPill tone="warning">Additional · not approved</StatusPill>;
}

/** The repair workspace of the job card: shown from APPROVED onwards. */
const LINE_TYPE_LABEL: Record<string, string> = { PART: 'Part', LABOUR: 'Labour', OTHER: 'Other' };

export function RepairSections({
  workspace,
  repair,
  status,
  canEdit,
  canIssueParts,
  employees,
}: {
  workspace: JobWorkspace;
  repair: RepairWorkspace;
  status: WorkflowStatus;
  canEdit: boolean;
  canIssueParts: boolean;
  employees: EmployeeOption[];
}) {
  const { jobCard, primaryTechnician } = workspace;
  const inRepair = status === 'REPAIR';
  const qcOpen = status === 'REPAIR' || status === 'QUALITY_CHECK';
  const partLines = repair.approvedLines.filter((l) => l.itemType === 'PART');
  const labourLines = repair.approvedLines.filter((l) => l.itemType !== 'PART');
  const doneCount = repair.approvedLines.length - repair.remainingLines.length;
  const defaultTech = primaryTechnician?.id ?? null;
  const base = `/job-cards/${jobCard.id}`;
  const latestQc = repair.latestQualityCheck;

  return (
    <Stack gap="2xl">
      {status === 'READY' ||
      status === 'INVOICED' ||
      status === 'PAID' ||
      status === 'DELIVERED' ? (
        <JobSummary workspace={workspace} repair={repair} status={status} />
      ) : null}

      {/* 1. Approved work */}
      <div id="approved-work" className="-mb-10 scroll-mt-24" aria-hidden />
      <Section
        step={1}
        title="Approved work"
        description={
          repair.approvedLines.length
            ? `${doneCount} of ${repair.approvedLines.length} approved lines done · approved value ${formatMoney(repair.totals.approved)} excl. VAT`
            : 'No approved work yet.'
        }
      >
        <Panel padding="none" className="overflow-hidden">
          <RecordList>
            {repair.approvedLines.map((line) => (
              <RecordCard
                key={line.id}
                title={line.description}
                subtitle={`${line.estimateNumber}${line.kind === 'ADDITIONAL' ? ' · approved additional work' : ''}`}
                status={
                  <StatusPill tone={PROGRESS[line.progress].tone}>
                    {PROGRESS[line.progress].label}
                  </StatusPill>
                }
                details={[
                  { label: 'Type', value: LINE_TYPE_LABEL[line.itemType] ?? 'Part' },
                  {
                    label: 'Approved',
                    value: `${formatMilli(line.approvedQuantity)}${line.itemType === 'LABOUR' ? ' h' : ''}`,
                  },
                  {
                    label: 'Done',
                    value: `${formatMilli(line.doneQuantity)}${line.itemType === 'LABOUR' ? ' h' : ''}`,
                  },
                ]}
              />
            ))}
          </RecordList>
          <TableWrap>
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-4 pl-6">Work</th>
                  <th className="px-2 py-4">Type</th>
                  <th className="w-28 px-2 py-3 text-right">Approved</th>
                  <th className="w-28 px-2 py-3 text-right">Done</th>
                  <th className="w-32 px-4 py-3 pr-6">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {repair.approvedLines.map((line) => (
                  <tr key={line.id}>
                    <td className="px-4 py-4 pl-6">
                      <span className="font-medium">{line.description}</span>
                      <span className="block text-xs text-muted-foreground">
                        {line.estimateNumber}
                        {line.kind === 'ADDITIONAL' ? ' · approved additional work' : ''}
                      </span>
                    </td>
                    <td className="px-2 py-4 text-muted-foreground">
                      {LINE_TYPE_LABEL[line.itemType] ?? 'Part'}
                    </td>
                    <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                      {formatMilli(line.approvedQuantity)}
                      {line.itemType === 'LABOUR' ? ' h' : ''}
                    </td>
                    <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                      {formatMilli(line.doneQuantity)}
                      {line.itemType === 'LABOUR' ? ' h' : ''}
                    </td>
                    <td className="px-4 py-4 pr-6">
                      <StatusPill tone={PROGRESS[line.progress].tone}>
                        {PROGRESS[line.progress].label}
                      </StatusPill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
          {repair.remainingLines.length > 0 ? (
            <p className="border-t border-border px-4 py-3 text-sm text-muted-foreground sm:px-6">
              Remaining: {repair.remainingLines.map((l) => l.description).join(' · ')}
            </p>
          ) : repair.approvedLines.length ? (
            <p className="flex items-center gap-2 border-t border-border px-4 py-3 text-sm text-success sm:px-6">
              <CheckCircle2 className="size-4" />
              All approved work is recorded.
            </p>
          ) : null}
        </Panel>
      </Section>

      {/* 2. Parts used */}
      <div id="parts" className="-mb-10 scroll-mt-24" aria-hidden />
      <Section
        step={2}
        title="Parts used"
        description={`${repair.partUsages.length} recorded · approved parts ${formatMoney(repair.totals.parts)} at usage price`}
      >
        <Panel padding="none" className="overflow-hidden">
          {repair.partUsages.length > 0 ? (
            <>
              <RecordList>
                {repair.partUsages.map((usage) => (
                  <RecordCard
                    key={usage.id}
                    className={cn(
                      !usage.estimateItemId && 'bg-warning/5',
                      usage.netMilli === 0 && 'text-muted-foreground',
                    )}
                    title={usage.part.name}
                    subtitle={<span className="font-mono">{usage.part.sku}</span>}
                    amount={formatMoney(
                      filsToString(
                        multiplyQuantity(milliToString(usage.netMilli), usage.unitPrice.toString()),
                      ),
                    )}
                    status={!usage.estimateItemId ? <NotApprovedPill /> : null}
                    details={[
                      {
                        label: 'For',
                        value: usage.estimateItem ? usage.estimateItem.description : 'Not approved',
                      },
                      {
                        label: 'Quantity',
                        value: (
                          <>
                            {formatMilli(usage.netMilli)} {usage.part.unitOfMeasure}
                            {usage.returnedMilli > 0 ? (
                              <span className="block text-muted-foreground">
                                {formatMilli(signedToMilli(usage.quantity))} fitted ·{' '}
                                {formatMilli(usage.returnedMilli)} taken back
                              </span>
                            ) : null}
                          </>
                        ),
                      },
                      { label: 'Price', value: formatMoney(usage.unitPrice) },
                    ]}
                    footer={`${employeeName(usage.usedByEmployee)} · ${formatDateTime(usage.usedAt)}`}
                  >
                    {inRepair && canEdit && canIssueParts ? (
                      usage.netMilli > 0 ? (
                        <ReturnPartButton
                          jobCardId={jobCard.id}
                          partUsageId={usage.id}
                          partName={usage.part.name}
                          onJobMilli={usage.netMilli}
                          unit={usage.part.unitOfMeasure}
                        />
                      ) : (
                        <StatusPill tone="neutral">Taken back</StatusPill>
                      )
                    ) : null}
                  </RecordCard>
                ))}
              </RecordList>
              <TableWrap>
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <tr>
                      {/* Part and the approved line it fulfils share one cell: seven
                          columns starved the part name to 80px. */}
                      <th className="min-w-[13rem] px-4 py-4 pl-6">Part</th>
                      <th className="w-20 px-2 py-3 text-right">Qty</th>
                      <th className="w-24 px-2 py-3 text-right">Price</th>
                      <th className="w-24 px-2 py-3 text-right">Amount</th>
                      <th className="w-36 px-4 py-4 pr-6">Fitted</th>
                      {inRepair && canEdit && canIssueParts ? (
                        <th className="w-0 px-2 py-3" />
                      ) : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {repair.partUsages.map((usage) => (
                      <tr
                        key={usage.id}
                        className={cn(
                          !usage.estimateItemId && 'bg-warning/5',
                          usage.netMilli === 0 && 'text-muted-foreground',
                        )}
                      >
                        <td className="px-4 py-4 pl-6">
                          <span className="font-medium">{usage.part.name}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span className="font-mono">{usage.part.sku}</span>
                            {usage.estimateItem ? (
                              <>
                                <span aria-hidden>·</span>
                                <span>for {usage.estimateItem.description}</span>
                              </>
                            ) : (
                              <NotApprovedPill />
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {formatMilli(usage.netMilli)} {usage.part.unitOfMeasure}
                          {usage.returnedMilli > 0 ? (
                            <span
                              className="block text-xs text-muted-foreground"
                              title={usage.returns.map((r) => r.note).join(' · ')}
                            >
                              {formatMilli(signedToMilli(usage.quantity))} fitted ·{' '}
                              {formatMilli(usage.returnedMilli)} taken back
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {formatMoney(usage.unitPrice)}
                        </td>
                        <td className="px-2 py-4 text-right font-semibold tabular-nums whitespace-nowrap">
                          {formatMoney(
                            filsToString(
                              multiplyQuantity(
                                milliToString(usage.netMilli),
                                usage.unitPrice.toString(),
                              ),
                            ),
                          )}
                        </td>
                        <td className="px-4 py-4 pr-6 text-xs whitespace-nowrap text-muted-foreground">
                          {employeeName(usage.usedByEmployee)}
                          <span className="block">{formatDateTime(usage.usedAt)}</span>
                        </td>
                        {inRepair && canEdit && canIssueParts ? (
                          <td className="px-2 py-4 text-right">
                            {usage.netMilli > 0 ? (
                              <ReturnPartButton
                                jobCardId={jobCard.id}
                                partUsageId={usage.id}
                                partName={usage.part.name}
                                onJobMilli={usage.netMilli}
                                unit={usage.part.unitOfMeasure}
                              />
                            ) : (
                              <StatusPill tone="neutral">Taken back</StatusPill>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          ) : (
            <p className="flex items-center gap-3 px-4 py-5 text-sm text-muted-foreground sm:px-6">
              <Package className="size-4" />
              No parts recorded yet.
            </p>
          )}
          {inRepair && canEdit && canIssueParts ? (
            <InlineForm
              label="Record a part used"
              hint="Fitted to this vehicle — taken from stock."
              icon={<Package className="size-4" />}
              defaultOpen={repair.partUsages.length === 0}
            >
              <PartUsageForm
                jobCardId={jobCard.id}
                parts={repair.partsCatalog}
                employees={employees}
                defaultEmployeeId={defaultTech}
                approvedLines={partLines.map((l) => ({
                  id: l.id,
                  description: l.description,
                  estimateNumber: l.estimateNumber,
                  remaining: formatMilli(Math.max(l.approvedQuantity - l.doneQuantity, 0)),
                  unitPrice: l.unitPrice,
                  done: l.progress === 'DONE',
                }))}
              />
            </InlineForm>
          ) : null}
        </Panel>
      </Section>

      {/* 3. Labour */}
      <div id="labour" className="-mb-10 scroll-mt-24" aria-hidden />
      <Section
        step={3}
        title="Labour"
        description={`${repair.labours.length} recorded · approved labour ${formatMoney(repair.totals.labour)}`}
      >
        <Panel padding="none" className="overflow-hidden">
          {repair.labours.length > 0 ? (
            <>
              <RecordList>
                {repair.labours.map((labour) => (
                  <RecordCard
                    key={labour.id}
                    className={cn(!labour.estimateItemId && 'bg-warning/5')}
                    title={labour.description}
                    amount={formatMoney(labour.amount)}
                    status={!labour.estimateItemId ? <NotApprovedPill /> : null}
                    details={[
                      {
                        label: 'For',
                        value: labour.estimateItem
                          ? labour.estimateItem.description
                          : 'Not approved',
                      },
                      { label: 'Hours', value: labour.hours.toString() },
                      { label: 'Rate', value: formatMoney(labour.rate) },
                    ]}
                    footer={`${employeeName(labour.performedByEmployee)} · ${formatDateTime(labour.performedAt)}`}
                  />
                ))}
              </RecordList>
              <TableWrap>
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <tr>
                      <th className="min-w-[13rem] px-4 py-4 pl-6">Work performed</th>
                      <th className="w-20 px-2 py-3 text-right">Hours</th>
                      <th className="w-24 px-2 py-3 text-right">Rate</th>
                      <th className="w-24 px-2 py-3 text-right">Amount</th>
                      <th className="w-36 px-4 py-4 pr-6">Technician</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {repair.labours.map((labour) => (
                      <tr key={labour.id} className={cn(!labour.estimateItemId && 'bg-warning/5')}>
                        <td className="px-4 py-4 pl-6">
                          <span className="font-medium">{labour.description}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {labour.estimateItem ? (
                              `for ${labour.estimateItem.description}`
                            ) : (
                              <NotApprovedPill />
                            )}
                          </span>
                        </td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {labour.hours.toString()}
                        </td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {formatMoney(labour.rate)}
                        </td>
                        <td className="px-2 py-4 text-right font-semibold tabular-nums whitespace-nowrap">
                          {formatMoney(labour.amount)}
                        </td>
                        <td className="px-4 py-4 pr-6 text-xs whitespace-nowrap text-muted-foreground">
                          {employeeName(labour.performedByEmployee)}
                          <span className="block">{formatDateTime(labour.performedAt)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </>
          ) : (
            <p className="flex items-center gap-3 px-4 py-5 text-sm text-muted-foreground sm:px-6">
              <Wrench className="size-4" />
              No labour recorded yet.
            </p>
          )}
          {inRepair && canEdit ? (
            <InlineForm
              label="Record labour"
              hint="Hours worked against an approved line."
              icon={<Wrench className="size-4" />}
              defaultOpen={repair.labours.length === 0}
            >
              <LabourForm
                jobCardId={jobCard.id}
                employees={employees}
                defaultEmployeeId={defaultTech}
                approvedLines={labourLines.map((l) => ({
                  id: l.id,
                  description: l.description,
                  estimateNumber: l.estimateNumber,
                  remaining: formatMilli(l.approvedQuantity),
                  unitPrice: l.unitPrice,
                  done: l.progress === 'DONE',
                }))}
              />
            </InlineForm>
          ) : null}
        </Panel>
      </Section>

      {/* Photographing the repair, where the repair is recorded. */}
      <StagePhotosPanel
        jobCardId={jobCard.id}
        branchId={jobCard.branchId}
        status={jobCard.status}
        stage="REPAIR"
        hint="Worn parts, the work in progress, the part fitted."
      />

      {/* 4. Additional work / approval */}
      <div id="additional-work" className="-mb-10 scroll-mt-24" aria-hidden />
      <Section
        step={4}
        title="Additional work"
        description="Extra work found during the repair is quoted and approved separately — never added to the approved quotation."
      >
        <Panel className="flex flex-col gap-6">
          {repair.totals.unapproved !== '0.00' ? (
            <p className="rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm text-warning">
              {formatMoney(repair.totals.unapproved)} of parts and labour is recorded as additional
              work without customer approval. It is not charged. Request approval below if it should
              be.
            </p>
          ) : null}
          {repair.additionalEstimates.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {repair.additionalEstimates.map((estimate) => (
                <li key={estimate.id}>
                  <Link
                    href={`${base}/additional/${estimate.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-muted/60"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {estimate.estimateNumber} · {formatMoney(estimate.totalAmount)}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {estimate.notes}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      <EstimateStatusPill status={estimate.status} />
                      <ArrowRight className="size-4 text-muted-foreground" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No additional work requested.</p>
          )}
          {inRepair && canEdit && !repair.pendingAdditional ? (
            <InlineForm
              variant="inset"
              label="Request approval for extra work"
              hint="Quoted separately — the customer decides before it is charged."
            >
              <AdditionalWorkForm jobCardId={jobCard.id} />
            </InlineForm>
          ) : null}
          {repair.pendingAdditional ? (
            <p className="text-sm text-muted-foreground">
              Waiting for the customer to answer {repair.pendingAdditional.estimateNumber}.
            </p>
          ) : null}
        </Panel>
      </Section>

      {/* 5. Quality check */}
      <section id="quality-check" className="flex scroll-mt-24 flex-col gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-[12px] font-semibold text-accent-foreground tabular-nums"
          >
            5
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="text-[17px] leading-tight font-semibold tracking-[-0.011em]">
              Quality check
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {qcOpen
                ? 'Check the finished work. Passing it marks the vehicle ready for collection.'
                : 'Every check is kept, including failed ones.'}
            </p>
          </div>
        </div>
        <Panel className="flex flex-col gap-6">
          {latestQc?.status === 'FAILED' && inRepair ? (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
              <p className="font-semibold text-danger">
                Last check failed — correct this before re-checking:
              </p>
              <p className="mt-1 whitespace-pre-wrap">{latestQc.correctionsRequired}</p>
            </div>
          ) : null}
          {qcOpen && canEdit ? (
            <InlineForm
              variant="inset"
              label="Record the quality check"
              hint="Passing it marks the vehicle ready for collection."
              icon={<ShieldCheck className="size-4" />}
              tone={status === 'QUALITY_CHECK' ? 'primary' : 'default'}
              defaultOpen={status === 'QUALITY_CHECK'}
            >
              <QualityCheckForm
                jobCardId={jobCard.id}
                employees={employees}
                defaultEmployeeId={defaultTech}
                remainingCount={repair.remainingLines.length}
              />
            </InlineForm>
          ) : null}
          {repair.qualityChecks.length > 0 ? (
            <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {repair.qualityChecks.map((check) => (
                <li key={check.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                  {check.status === 'PASSED' ? (
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-medium">
                      {check.status === 'PASSED' ? 'Passed' : 'Failed'}
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        · {formatDateTime(check.checkedAt)} · checked by{' '}
                        {employeeName(check.checkedByEmployee)}
                      </span>
                    </p>
                    {check.correctionsRequired ? (
                      <p>To correct: {check.correctionsRequired}</p>
                    ) : null}
                    {check.notes ? <p className="text-muted-foreground">{check.notes}</p> : null}
                  </div>
                </li>
              ))}
            </ol>
          ) : !qcOpen ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="size-4" />
              The quality check happens after the repair.
            </p>
          ) : null}
        </Panel>

        <StagePhotosPanel
          jobCardId={jobCard.id}
          branchId={jobCard.branchId}
          status={jobCard.status}
          stage="QUALITY_CHECK"
          hint="The finished work, as it was signed off."
        />
      </section>
    </Stack>
  );
}

/** 6. The READY summary: everything the service advisor needs at handover. */
function JobSummary({
  workspace,
  repair,
  status,
}: {
  workspace: JobWorkspace;
  repair: RepairWorkspace;
  status: WorkflowStatus;
}) {
  const { jobCard } = workspace;
  const passed = repair.qualityChecks.find((c) => c.status === 'PASSED');
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold tracking-tight">
          {status === 'READY' ? 'Ready for collection' : 'Job summary'}
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything done on this visit, for the handover to the customer.
        </p>
      </div>
      <Panel className="flex flex-col gap-6 border-success/30">
        <div className="flex flex-wrap items-center gap-4">
          <VehiclePlate plateNumber={jobCard.vehicle.plateNumber} />
          <div className="min-w-0">
            <p className="font-medium">
              {jobCard.vehicle.make} {jobCard.vehicle.model} {jobCard.vehicle.year ?? ''} · Job{' '}
              {jobCard.jobNumber}
            </p>
            <p className="text-sm text-muted-foreground">
              {jobCard.customer.name} · {jobCard.customer.phone}
            </p>
          </div>
          {passed ? (
            <StatusPill tone="success" className="ml-auto">
              QC passed {formatDateTime(passed.checkedAt)}
            </StatusPill>
          ) : null}
        </div>
        <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Approved work</dt>
            <dd>
              {repair.approvedLines.length} lines · {formatMoney(repair.totals.approved)} excl. VAT
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Work completed</dt>
            <dd>
              {repair.approvedLines.length - repair.remainingLines.length} of{' '}
              {repair.approvedLines.length} approved lines
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Parts used</dt>
            <dd>{repair.partUsages.map((u) => u.part.name).join(', ') || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Labour performed</dt>
            <dd>
              {repair.labours.map((l) => `${l.description} (${l.hours.toString()} h)`).join(', ') ||
                '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Quality check</dt>
            <dd>
              {passed ? `Passed by ${employeeName(passed.checkedByEmployee)}` : '—'}
              {repair.qualityChecks.length > 1
                ? ` after ${repair.qualityChecks.length - 1} failed check(s)`
                : ''}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd>{passed?.notes ?? '—'}</dd>
          </div>
        </dl>
        {repair.totals.unapproved !== '0.00' ? (
          <p className="text-sm text-warning">
            {formatMoney(repair.totals.unapproved)} of additional work was recorded without approval
            and is not chargeable.
          </p>
        ) : null}
      </Panel>
    </section>
  );
}
