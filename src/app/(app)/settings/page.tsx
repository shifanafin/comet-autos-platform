import Link from 'next/link';
import { Building2, ChevronRight, Info, ShieldCheck } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getOrganizationSettings } from '@/lib/organization/settings';
import { formatDateTime } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { OrganizationForm } from '@/components/settings/organization-form';
import { JobCardStyleForm } from '@/components/settings/job-card-style-form';
import { MenusForm } from '@/components/settings/menus-form';

export default async function SettingsPage() {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.view')) {
    return <AccessDenied what="the workshop's settings" />;
  }
  const settings = await getOrganizationSettings(user);
  const canEdit = hasPermission(user, 'accounting.edit');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Settings"
        title="Workshop"
        description="The details that appear on customer documents, and how VAT is charged."
      />

      <Section
        title="Workshop details"
        description={`Last changed ${formatDateTime(settings.updatedAt)}.`}
      >
        <Panel className="max-w-3xl">
          {canEdit ? (
            <OrganizationForm settings={settings} />
          ) : (
            <ReadOnlySettings settings={settings} />
          )}
        </Panel>
      </Section>

      <Section
        title="Job card"
        description="How much a work order asks for. Choose the minimal job card while one person does everything; switch to standard once there is a team to share the steps."
      >
        <div className="max-w-3xl">
          <JobCardStyleForm detailed={settings.detailedJobCards} canEdit={canEdit} />
        </div>
      </Section>

      <Section
        title="Menus"
        description="Show only the menus the workshop uses. Hiding a menu doesn't remove anything or change what anyone is allowed to do."
      >
        <div className="max-w-3xl">
          <MenusForm
            hiddenMenus={settings.hiddenMenus}
            detailedJobCards={settings.detailedJobCards}
            canEdit={canEdit}
          />
        </div>
      </Section>

      {hasPermission(user, 'user.view') ? (
        <Section title="Access" description="Who can sign in, and what they are allowed to do.">
          <Link
            href="/settings/users"
            className="flex max-w-3xl items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 transition-colors hover:bg-muted/50 active:bg-muted sm:px-6"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <ShieldCheck className="size-5" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">Users &amp; roles</span>
              <span className="text-sm text-muted-foreground">
                Add logins, assign roles, and see exactly what each role allows.
              </span>
            </span>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
          </Link>
        </Section>
      ) : null}

      <Section title="Currency" description="What every amount in the system is recorded in.">
        <Panel className="flex max-w-3xl items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Building2 className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">{settings.baseCurrency}</p>
            <p className="text-sm text-muted-foreground">
              The base currency cannot be changed here. Every amount already recorded is in it, and
              re-labelling them would misstate what was actually charged and paid.
            </p>
          </div>
        </Panel>
      </Section>
    </Stack>
  );
}

/** What someone who may see the settings but not change them gets. */
function ReadOnlySettings({
  settings,
}: {
  settings: Awaited<ReturnType<typeof getOrganizationSettings>>;
}) {
  const rows: [string, string][] = [
    ['Workshop name', settings.name],
    ['Legal name', settings.legalName ?? '—'],
    ['Address', settings.address ?? '—'],
    ['Phone', settings.phone ?? '—'],
    ['Email', settings.email ?? '—'],
    ['VAT', settings.isVatRegistered ? `Registered at ${settings.vatRate}%` : 'Not registered'],
    ['TRN', settings.taxNumber ?? '—'],
  ];
  return (
    <div className="flex flex-col gap-6">
      <dl className="flex flex-col gap-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="flex items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        Your role can see these but not change them. Ask the workshop owner.
      </p>
    </div>
  );
}
