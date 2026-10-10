import { notFound } from 'next/navigation';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getEmployeeForEdit, getEmployeeFormOptions } from '@/lib/hr/employees';
import { NotFoundError } from '@/lib/errors';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmployeeForm } from '@/components/hr/employee-form';
import { updateEmployeeAction } from '../../../actions';

const isoDate = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export default async function EditEmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!hasPermission(user, 'employee.edit')) return <AccessDenied what="editing employees" />;
  const { id } = await params;

  let employee;
  try {
    employee = await getEmployeeForEdit(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const options = await getEmployeeFormOptions(user, id);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Team"
        title={`${employee.firstName} ${employee.lastName}`}
        description="Changes are recorded in the audit log. Work already attributed to this person is untouched."
      />
      <Panel>
        <EmployeeForm
          action={updateEmployeeAction.bind(null, employee.id)}
          options={options}
          initial={{
            firstName: employee.firstName,
            lastName: employee.lastName,
            employeeCode: employee.employeeCode,
            jobTitle: employee.jobTitle,
            designationId: employee.designationId,
            phone: employee.phone,
            email: employee.email,
            department: employee.department,
            hireDate: isoDate(employee.hireDate) ?? '',
            terminationDate: isoDate(employee.terminationDate),
            probationEndDate: isoDate(employee.probationEndDate),
            normalHoursPerDay: employee.normalHoursPerDay.toString(),
            leaveOpeningDays: employee.leaveOpeningDays?.toString() ?? null,
            leaveOpeningAsOf: isoDate(employee.leaveOpeningAsOf),
            branchId: employee.branchId,
            userId: employee.userId,
            isActive: employee.isActive,
          }}
          cancelHref={`/hr/employees/${employee.id}`}
        />
      </Panel>
    </Stack>
  );
}
